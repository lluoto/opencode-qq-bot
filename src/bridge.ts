// @input:  ./config, ./qq/* (types, api, sender), ./opencode/* (client, events, sessions), ./commands
// @output: createBridge
// @pos:    根层 - 核心桥接: QQ 消息 -> OpenCode -> QQ 回复
import type { Config } from "./config.js"
import type { MessageContext } from "./qq/types.js"
import { getAccessToken } from "./qq/api.js"
import { replyToQQ } from "./qq/sender.js"
import type { OpencodeClient } from "./opencode/client.js"
import { EventRouter } from "./opencode/events.js"
import { SessionManager } from "./opencode/sessions.js"
import type { Event } from "@opencode-ai/sdk"
import {
  buildHelpText,
  handleCommand,
  handlePendingSelection,
  isCommand,
  type CommandContext,
  type PendingSelection,
} from "./commands.js"

const RESPONSE_TIMEOUT_MS = 5 * 60 * 1000

interface Bridge {
  handleMessage: (ctx: MessageContext) => Promise<void>
}

interface PromptOptions {
  model?: {
    providerID: string
    modelID: string
  }
  agent?: string
}

export function createBridge(
  config: Config,
  client: OpencodeClient,
  router: EventRouter,
  sessions: SessionManager,
): Bridge {
  const busyUsers = new Set<string>()
  const greeted = new Set<string>()
  const pendingSelections = new Map<string, PendingSelection>()
  const commandContext: CommandContext = {
    config,
    client,
    sessions,
    getAccessToken: () => getAccessToken(config.qq.appId, config.qq.clientSecret),
    pendingSelections,
  }

  const handleMessage = async (ctx: MessageContext): Promise<void> => {
    try {
      if (!isAllowedUser(ctx.userId, config.allowedUsers)) {
        await sendReply(ctx, "你不在允许使用的名单里")
        return
      }

      const content = ctx.content.trim()
      if (!content) {
        return
      }

      if (!greeted.has(ctx.userId)) {
        greeted.add(ctx.userId)
        await sendReply(ctx, buildHelpText())
      }

      if (isCommand(content)) {
        const reply = await handleCommand(ctx, commandContext)
        await sendReply(ctx, reply)
        return
      }

      const pendingReply = await maybeHandlePendingSelection(ctx, commandContext)
      if (pendingReply !== null) {
        await sendReply(ctx, pendingReply)
        return
      }

      if (busyUsers.has(ctx.userId)) {
        await sendReply(ctx, "上一条消息还在处理中，请稍候再试")
        return
      }

      busyUsers.add(ctx.userId)

      try {
        const session = await sessions.getOrCreate(ctx.userId)
        const promptOptions = buildPromptOptions(ctx.userId, sessions)
        const replyText = await waitForSessionReply(router, session.sessionId, () => {
          void startSessionPrompt(client, session.sessionId, content, promptOptions)
        })

        if (replyText.trim()) {
          await sendReply(ctx, replyText)
        }
      } catch (error) {
        await sendReply(ctx, `处理失败：${toErrorMessage(error)}`)
      } finally {
        busyUsers.delete(ctx.userId)
      }
    } catch (error) {
      console.error("[bridge] handleMessage failed:", error)
      try {
        await sendReply(ctx, `处理消息失败：${toErrorMessage(error)}`)
      } catch (replyError) {
        console.error("[bridge] failed to send error reply:", replyError)
      }
    }
  }

  async function sendReply(ctx: MessageContext, text: string): Promise<void> {
    const accessToken = await getAccessToken(config.qq.appId, config.qq.clientSecret)
    await replyToQQ(accessToken, ctx, text, config.maxReplyLength)
  }

  return { handleMessage }
}

async function maybeHandlePendingSelection(
  ctx: MessageContext,
  commandContext: CommandContext,
): Promise<string | null> {
  const pending = commandContext.pendingSelections.get(ctx.userId)
  if (!pending) {
    return null
  }

  if (pending.expiresAt <= Date.now()) {
    commandContext.pendingSelections.delete(ctx.userId)
    return null
  }

  if (!/^\d+$/.test(ctx.content.trim())) {
    commandContext.pendingSelections.delete(ctx.userId)
    return null
  }

  return handlePendingSelection(ctx.userId, Number(ctx.content.trim()), commandContext)
}

function isAllowedUser(userId: string, allowedUsers: string[]): boolean {
  return allowedUsers.length === 0 || allowedUsers.includes(userId)
}

function buildPromptOptions(userId: string, sessions: SessionManager): PromptOptions {
  const model = sessions.getModel(userId)
  const agent = sessions.getAgent(userId)

  return {
    model: model.providerId && model.modelId
      ? { providerID: model.providerId, modelID: model.modelId }
      : undefined,
    agent,
  }
}

async function waitForSessionReply(
  router: EventRouter,
  sessionId: string,
  startPrompt: () => Promise<void>,
): Promise<string> {
  let settled = false
  let latestText = ""
  let events: any[] = []

  return new Promise<string>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      console.log("[bridge] TIMEOUT! Collected events:", JSON.stringify(events, null, 2))
      console.log("[bridge] latestText so far:", latestText)
      finish(() => reject(new Error("AI 响应超时（5 分钟）")))
    }, 5 * 60 * 1000)

    const finish = (done: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeoutId)
      router.unregister(sessionId)
      console.log("[bridge] Session finished with text:", latestText.substring(0, 200))
      done()
    }

    router.unregister(sessionId)
    router.register(sessionId, (event: Event) => {
      events.push(event)
      console.log("[bridge] Event received:", event.type)
      
      if (event.type === "message.part.updated") {
        const part = event.properties.part
        if (part.type === "text") {
          latestText = part.text
          console.log("[bridge] Text updated:", latestText.substring(0, 100))
        }
        return
      }

      if (event.type === "session.status") {
        console.log("[bridge] Session status:", event.properties.status)
        return
      }

      if (event.type === "session.idle") {
        console.log("[bridge] Session idle received!")
        finish(() => resolve(latestText || "(AI 未返回内容)"))
        return
      }

      if (event.type === "session.error") {
        console.log("[bridge] Session error:", event.properties.error)
        finish(() => reject(new Error(toErrorMessage(event.properties.error) || "未知错误")))
      }
    })

    try {
      startPrompt()
      console.log("[bridge] Prompt started for session:", sessionId)
    } catch (error) {
      console.error("[bridge] startPrompt threw:", error)
      finish(() => reject(error instanceof Error ? error : new Error(String(error))))
    }
  })
}

async function startSessionPrompt(
  client: OpencodeClient,
  sessionId: string,
  text: string,
  options: PromptOptions,
): Promise<void> {
  const body: {
    parts: Array<{ type: "text"; text: string }>
    model?: { providerID: string; modelID: string }
    agent?: string
  } = {
    parts: [{ type: "text", text }],
  }

  if (options.model) {
    body.model = options.model
  }
  if (options.agent) {
    body.agent = options.agent
  }

  // Direct SDK call - don't use Reflect.get()
  console.log("[bridge] Sending prompt to session:", sessionId)
  console.log("[bridge] Body:", JSON.stringify(body, null, 2))
  
  try {
    const result = await client.session.prompt({
      path: { id: sessionId },
      body,
    })
    console.log("[bridge] Prompt result:", JSON.stringify(result, null, 2))
  } catch (error) {
    console.error("[bridge] Prompt failed:", error)
    throw error
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null) {
    const e = error as any
    if (e.data?.message) return e.data.message
    if (e.message) return e.message
  }
  return String(error)
}
