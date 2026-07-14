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

const RESPONSE_TIMEOUT_MS = 2 * 60 * 1000
const TIMEOUT_MINUTES = RESPONSE_TIMEOUT_MS / 60_000

interface Bridge {
  handleMessage: (ctx: MessageContext) => Promise<void>
  hasActiveRequests: () => boolean
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
  const processedMessages = new Map<string, number>()
  const commandContext: CommandContext = {
    config,
    client,
    sessions,
    getAccessToken: () => getAccessToken(config.qq.appId, config.qq.clientSecret),
    pendingSelections,
  }

  const handleMessage = async (ctx: MessageContext): Promise<void> => {
    try {
      pruneProcessedMessages(processedMessages)
      if (processedMessages.has(ctx.msgId)) {
        console.log("[bridge] Skip duplicated QQ message:", ctx.msgId)
        return
      }
      processedMessages.set(ctx.msgId, Date.now())

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

      let processingTimer: ReturnType<typeof setTimeout> | null = null
      try {
        let sentProcessingReply = false

      let session = await sessions.getOrCreate(ctx.userId)
      const promptOptions = buildPromptOptions(ctx.userId, sessions)
      console.log("[bridge] Model for prompt:", JSON.stringify(promptOptions.model))

        const runOnce = async (sessionId: string): Promise<string> => {
          return waitForSessionReply(client, router, sessionId, () => {
            return startSessionPrompt(client, sessionId, content, promptOptions)
          }, async (progressText) => {
            await sendReply(ctx, progressText)
          })
        }

        let replyText: string
        try {
          replyText = await runOnce(session.sessionId)
        } catch (error) {
          if (isSessionNotFoundError(error)) {
            console.log("[bridge] Session missing, creating a fresh one:", session.sessionId)
            session = await sessions.createNew(ctx.userId)
            replyText = await runOnce(session.sessionId)
          } else {
            throw error
          }
        }
        clearTimeout(processingTimer)
        processingTimer = null

        if (replyText.trim()) {
          await sendReply(ctx, replyText)
        } else if (!sentProcessingReply) {
          await sendReply(ctx, "(AI 未返回内容)")
        }
      } catch (error) {
        if (processingTimer) {
          clearTimeout(processingTimer)
        }
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

  return {
    handleMessage,
    hasActiveRequests: () => busyUsers.size > 0,
  }
}

function pruneProcessedMessages(processedMessages: Map<string, number>): void {
  const cutoff = Date.now() - 10 * 60 * 1000
  for (const [msgId, time] of processedMessages) {
    if (time < cutoff) {
      processedMessages.delete(msgId)
    }
  }
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
  client: OpencodeClient,
  router: EventRouter,
  sessionId: string,
  startPrompt: () => Promise<any>,
  onProgress?: (text: string) => Promise<void>,
): Promise<string> {
  let settled = false
  let latestText = ""
  let lastForwardedProgressText = ""
  let events: any[] = []
  let assistantMessageId = ""
  let connectRetryCount = 0
  let lastProgressText = ""
  let lastProgressAt = 0

  return new Promise<string>((resolve, reject) => {
    let timeoutCount = 0
    const maxTimeoutCount = 3

    let currentTimeoutId: ReturnType<typeof setTimeout> | null = null

    const scheduleTimeout = () => {
      if (currentTimeoutId !== null) {
        clearTimeout(currentTimeoutId)
      }
      currentTimeoutId = setTimeout(() => {
        timeoutCount++
        if (timeoutCount >= maxTimeoutCount) {
          console.log("[bridge] TIMEOUT! latestText so far:", latestText.substring(0, 200))
          // Don't abort — let model finish. Just resolve with what we have
          finish(() => resolve(latestText.trim() || "(AI 思考时间过长，请稍后再试或切换更快的模型)"))
          return
        }
        console.log(`[bridge] Timeout round ${timeoutCount}/${maxTimeoutCount}, sending progress note`)
        if (onProgress && latestText.trim()) {
          void onProgress(`${latestText}\n\n[处理中，已等待 ${TIMEOUT_MINUTES} 分钟，任务仍在继续...]`)
        }
        scheduleTimeout()
      }, RESPONSE_TIMEOUT_MS)
    }

    const resetActivityTimeout = () => {
      timeoutCount = 0
      if (currentTimeoutId !== null) {
        clearTimeout(currentTimeoutId)
        currentTimeoutId = setTimeout(() => {
          timeoutCount++
          if (timeoutCount >= maxTimeoutCount) {
            console.log("[bridge] TIMEOUT! latestText so far:", latestText.substring(0, 200))
            // Don't abort — let model finish. Just resolve with what we have
            finish(() => resolve(latestText.trim() || "(AI 思考时间过长，请稍后再试或切换更快的模型)"))
            return
          }
          console.log(`[bridge] Timeout round ${timeoutCount}/${maxTimeoutCount}, sending progress note`)
          if (onProgress && latestText.trim()) {
            void onProgress(`${latestText}\n\n[处理中，已等待 ${TIMEOUT_MINUTES} 分钟，任务仍在继续...]`)
          }
          scheduleTimeout()
        }, RESPONSE_TIMEOUT_MS)
      }
    }

    const finish = (done: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      if (currentTimeoutId !== null) {
        clearTimeout(currentTimeoutId)
        currentTimeoutId = null
      }
      router.unregister(sessionId)
      console.log("[bridge] Session finished with text:", latestText.substring(0, 200))
      done()
    }

    router.unregister(sessionId)
    router.register(sessionId, (event: Event) => {
      events.push(event)
      console.log("[bridge] Event received:", event.type)

      if (event.type === "message.updated") {
        const info = event.properties.info as any
        if (info?.role === "assistant" && info?.id) {
          assistantMessageId = info.id
        }
        return
      }
      
      if (event.type === "message.part.updated") {
        const part = event.properties.part as any
        if ((part.type === "text" || part.type === "reasoning") && part.messageID === assistantMessageId) {
          latestText = part.text
          console.log("[bridge] Text updated:", latestText.substring(0, 100))
          resetActivityTimeout()

          const now = Date.now()
          const hasMeaningfulDelta = latestText.trim().length >= 30 && latestText !== lastProgressText
          const canPushProgress = now - lastProgressAt >= 8000
          if (onProgress && hasMeaningfulDelta && canPushProgress) {
            lastProgressText = latestText
            lastForwardedProgressText = latestText
            lastProgressAt = now
            void onProgress(`${latestText}\n\n[处理中...]`).catch((error) => {
              console.error("[bridge] failed to send progress reply:", error)
            })
          }
        }
        return
      }

      if (event.type === "session.status") {
        console.log("[bridge] Session status:", event.properties.status)

        const status = event.properties.status as any
        if (status?.type === "retry" && typeof status.message === "string") {
          if (/Cannot connect to API/i.test(status.message)) {
            connectRetryCount += 1
            if (connectRetryCount >= 2) {
              finish(() => reject(new Error("AI 服务连接失败，请检查 OPENAI_BASE_URL / 代理配置")))
              return
            }
          }
        }
        return
      }

      if (event.type === "permission.asked" || event.type === "permission.updated") {
        resetActivityTimeout()
        // Permission handled by OMO server-side — no user confirmation needed
        return
      }

      if (event.type === "session.idle") {
        console.log("[bridge] Session idle received!")
        const finalText = latestText === lastForwardedProgressText ? "" : (latestText || "(AI 未返回内容)")
        finish(() => resolve(finalText))
        return
      }

      if (event.type === "session.error") {
        console.log("[bridge] Session error:", event.properties.error)
        finish(() => reject(new Error(toErrorMessage(event.properties.error) || "未知错误")))
      }
    })

    scheduleTimeout()

    Promise.resolve()
      .then(() => startPrompt())
      .then((result) => {
        console.log("[bridge] Prompt started for session:", sessionId)
        // Extract text from prompt result — fallback if events never fire (session.idle missing)
        if (!latestText.trim() && result?.data?.parts) {
          const textParts = result.data.parts.filter((p: any) => p.type === "text" && p.text)
          const reasoningParts = result.data.parts.filter((p: any) => p.type === "reasoning" && p.text)
          const extracted = textParts.length > 0
            ? textParts.map((p: any) => p.text).join("\n")
            : reasoningParts.map((p: any) => p.text).join("\n")
          if (extracted.trim()) {
            latestText = extracted
            console.log("[bridge] Extracted text from prompt result (no events received)")
            // Send extracted text as progress to QQ immediately
            if (onProgress && reasoningParts.length > 0 && textParts.length === 0) {
              void onProgress(`思考：${reasoningParts.map((p: any) => p.text).join("\n")}\n\n[处理中...]`)
            }
          }
        }
        // Wait up to 2s for event-sourced text to arrive, then resolve
        let resolved = false
        const tryResolve = () => {
          if (resolved) return
          resolved = true
          finish(() => resolve(latestText || "(AI 未返回内容)"))
        }
        setTimeout(tryResolve, 2000)
      })
      .catch((error) => {
        console.error("[bridge] startPrompt threw:", error)
        finish(() => reject(error instanceof Error ? error : new Error(String(error))))
      })
  })
}

async function startSessionPrompt(
  client: OpencodeClient,
  sessionId: string,
  text: string,
  options: PromptOptions,
): Promise<any> {
  const body: {
    parts: Array<{ type: "text"; text: string }>
    model?: { providerID: string; modelID: string }
    agent?: string
  } = {
    parts: [{
      type: "text",
      text,
    }],
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
    return result
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

function isSessionNotFoundError(error: unknown): boolean {
  const message = toErrorMessage(error)
  return /session not found/i.test(message)
}

async function abortSession(client: OpencodeClient, sessionId: string): Promise<void> {
  try {
    await client.session.abort({ path: { id: sessionId } })
    console.log("[bridge] Aborted timed-out session:", sessionId)
  } catch (error) {
    console.error("[bridge] Failed to abort session:", sessionId, error)
  }
}

// Permission confirmation removed — OMO handles permissions server-side
