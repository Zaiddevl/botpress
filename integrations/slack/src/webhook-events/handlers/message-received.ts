import { slackToMarkdown } from '@bpinternal/slackdown'
import { AllMessageEvents } from '@slack/types'
import { getBotpressConversationFromSlackThread, getBotpressUserFromSlackUser } from 'src/misc/utils'
import { SlackClient } from 'src/slack-api'
import * as bp from '.botpress'

export const handleEvent = async ({
  slackEvent,
  client,
  ctx,
  logger,
}: {
  slackEvent: AllMessageEvents
  client: bp.Client
  ctx: bp.Context
  logger: bp.Logger
}) => {
  // do not handle notification-type messages such as channel_join, channel_leave, etc:
  if (slackEvent.subtype) {
    return
  }

  // Prevent the bot from answering to other Slack bots:
  if (slackEvent.bot_id) {
    return
  }

  const { botpressConversation } = await getBotpressConversationFromSlackThread(
    { slackChannelId: slackEvent.channel, slackThreadId: slackEvent.thread_ts },
    client
  )
  const { botpressUser } = await getBotpressUserFromSlackUser({ slackUserId: slackEvent.user }, client)

  if (!botpressUser.pictureUrl || !botpressUser.name) {
    try {
      const slackClient = await SlackClient.createFromStates({ ctx, client, logger })
      const userProfile = await slackClient.getUserProfile({ userId: slackEvent.user })
      const fieldsToUpdate = {
        pictureUrl: userProfile?.image_192,
        name: userProfile?.real_name,
      }
      logger.forBot().debug('Fetched latest Slack user profile: ', fieldsToUpdate)
      if (fieldsToUpdate.pictureUrl || fieldsToUpdate.name) {
        await client.updateUser({ ...botpressUser, ...fieldsToUpdate })
      }
    } catch (error) {
      logger.forBot().error('Error while fetching user profile from Slack:', error)
    }
  }

  if (slackEvent.text === undefined || typeof slackEvent.text !== 'string' || !slackEvent.text?.length) {
    logger.forBot().debug('No text was received, so the message was ignored')
    return
  }

  const mentionsBot = await _isBotMentionedInMessage({ slackEvent, client, ctx })

  const textAsCommonmark = slackToMarkdown(slackEvent.text)

  await client.getOrCreateMessage({
    tags: {
      ts: slackEvent.ts,
      userId: slackEvent.user,
      channelId: slackEvent.channel,
      mentionsBot: mentionsBot ? 'true' : undefined,
    },
    discriminateByTags: ['ts', 'channelId'],
    type: 'text',
    payload: {
      text: textAsCommonmark,

      // TODO: declare in definition
      // targets: {
      //   dm: { id: slackEvent.user },
      //   thread: { id: slackEvent.channel || slackEvent.user, thread: slackEvent.thread_ts || slackEvent.ts },
      //   channel: { id: slackEvent.channel },
      // },
    },
    userId: botpressUser.id,
    conversationId: botpressConversation.id,
  })

  const isSentInChannel = slackEvent.channel_type === 'channel'
  const isThreadingEnabled = ctx.configuration.createReplyThread?.enabled ?? false
  const threadingRequiresMention = ctx.configuration.createReplyThread?.onlyOnBotMention ?? false

  const shouldForkToReplyThread = isSentInChannel && isThreadingEnabled && (!threadingRequiresMention || mentionsBot)

  if (shouldForkToReplyThread) {
    const { conversation: threadConversation } = await client.getOrCreateConversation({
      channel: 'thread',
      tags: { id: slackEvent.channel, thread: slackEvent.ts, isBotReplyThread: 'true' },
      discriminateByTags: ['id', 'thread'],
    })

    await client.getOrCreateMessage({
      tags: {
        ts: slackEvent.ts,
        userId: slackEvent.user,
        channelId: slackEvent.channel,
        mentionsBot: mentionsBot ? 'true' : undefined,
        forkedToThread: 'true',
      },
      discriminateByTags: ['ts', 'channelId', 'forkedToThread'],
      type: 'text',
      payload: {
        text: textAsCommonmark,
      },
      userId: botpressUser.id,
      conversationId: threadConversation.id,
    })
  }
}

const _isBotMentionedInMessage = async ({
  slackEvent,
  client,
  ctx,
}: {
  slackEvent: AllMessageEvents
  client: bp.Client
  ctx: bp.Context
}) => {
  if (slackEvent.subtype || !slackEvent.text) {
    return false
  }

  const slackBotId = await _getSlackBotIdFromStates(client, ctx)

  if (!slackBotId) {
    return false
  }

  return (
    slackEvent.text.includes(`<@${slackBotId}>`) ||
    (slackEvent.blocks?.some(
      (block) =>
        'elements' in block &&
        block.elements.some(
          (element) =>
            'elements' in element &&
            element.elements.some((subElement) => subElement.type === 'user' && subElement.user_id === slackBotId)
        )
    ) ??
      false)
  )
}

const _getSlackBotIdFromStates = async (client: bp.Client, ctx: bp.Context) => {
  try {
    const { state } = await client.getState({
      type: 'integration',
      name: 'oAuthCredentialsV2',
      id: ctx.integrationId,
    })
    return state.payload.botUserId
  } catch {}
  return
}
