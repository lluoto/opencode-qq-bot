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
  botConfig?: { appId: string; clientSecret: string; sandbox: boolean },
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

  const botAppId = botConfig?.appId ?? config.qq.appId
  const botClientSecret = botConfig?.clientSecret ?? config.qq.clientSecret
  const botSandbox = botConfig?.sandbox ?? config.qq.sandbox

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
    const accessToken = await getAccessToken(botAppId, botClientSecret)
    await replyToQQ(accessToken, ctx, text, config.maxReplyLength, botSandbox)
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
  let assistantMessageId = ""
  let connectRetryCount = 0
  let lastProgressText = ""
  let lastProgressAt = 0
  let thinkCount = 0
  const thinkStartTime = Date.now()

  function formatProgress(text: string): string {
    thinkCount++
    const elapsed = Math.floor((Date.now() - thinkStartTime) / 1000)
    const mins = Math.floor(elapsed / 60)
    const secs = elapsed % 60
    const ts = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    return `[思考 #${thinkCount} +${ts}]\n${text}`
  }

  // 追踪每个 text/reasoning part 的累积文本。
  // 服务器 1.18+ 的 message.part.updated 只在 part 创建(空文本)和完成(全量)时触发，
  // 流式 token 全部通过 message.part.delta 推送，必须按 partID 累积。
  const partTexts = new Map<string, { type: string; text: string }>()

  const pushProgressIfNeeded = (text: string): void => {
    const now = Date.now()
    const hasMeaningfulDelta = text.trim().length >= 30 && text !== lastProgressText
    const canPushProgress = now - lastProgressAt >= 8000
    if (!onProgress || !hasMeaningfulDelta || !canPushProgress) return
    lastProgressText = text
    lastForwardedProgressText = text
    lastProgressAt = now
    const nowElapsed = Math.floor((Date.now() - thinkStartTime) / 1000)
    const nowMins = Math.floor(nowElapsed / 60)
    const nowSecs = nowElapsed % 60
    const nowTs = `${String(nowMins).padStart(2, "0")}:${String(nowSecs).padStart(2, "0")}`
    void onProgress(formatProgress(`${text}\n\n[运行中 +${nowTs}]`)).catch((error) => {
      console.error("[bridge] failed to send progress reply:", error)
    })
  }

  // 从所有已累积 part 中选出最完整的文本作为最终结果：
  // text 优先于 reasoning，同类型取长度最大者
  const getBestAccumulatedText = (): string => {
    let best: { type: string; text: string } | null = null
    for (const entry of partTexts.values()) {
      if (!entry.text.trim()) continue
      if (!best) {
        best = entry
        continue
      }
      const entryScore = entry.type === "text" ? 1 : 0
      const bestScore = best.type === "text" ? 1 : 0
      if (entryScore > bestScore || (entryScore === bestScore && entry.text.length > best.text.length)) {
        best = entry
      }
    }
    return best?.text ?? ""
  }

  return new Promise<string>((resolve, reject) => {
    let timeoutCount = 0
    // 超时仅作保底 log，不截断 resolve
    // 正常完成由 session.idle / session.error / prompt().then() 驱动
    // 心跳每60s推 [运行中 +MM:SS] 告知用户"还在运行"

    let currentTimeoutId: ReturnType<typeof setTimeout> | null = null

    const scheduleTimeout = () => {
      if (currentTimeoutId !== null) {
        clearTimeout(currentTimeoutId)
      }
      currentTimeoutId = setTimeout(() => {
        timeoutCount++
        if (timeoutCount <= 15) {
          // 0~30分钟：前3轮静默，之后每2分钟log一次
          if (timeoutCount > 3) {
            console.log(`[bridge] Timeout round ${timeoutCount} (${timeoutCount * 2}min)`)
          }
        } else {
          // 30分钟以上：每5轮（10分钟）log一次
          if (timeoutCount % 5 === 0) {
            console.log(`[bridge] Timeout round ${timeoutCount} (${timeoutCount * 2}min) — still waiting for AI...`)
          }
        }
        scheduleTimeout()
      }, RESPONSE_TIMEOUT_MS)
    }

    // Heartbeat: send periodic status to keep user informed
    // 0~30分钟：每60秒一次；30分钟以上：每10分钟一次（降低刷屏）
    const HEARTBEAT_FAST = 60_000
    const HEARTBEAT_SLOW = 600_000
    const SLOW_AFTER_MS = 30 * 60 * 1000
    let heartbeatId: ReturnType<typeof setInterval> | null = null
    let heartbeatInterval = HEARTBEAT_FAST

    const scheduleHeartbeat = () => {
      if (heartbeatId !== null) {
        clearInterval(heartbeatId)
      }
      heartbeatId = setInterval(() => {
        if (settled) return
        const elapsed = Date.now() - thinkStartTime
        const mins = Math.floor(elapsed / 60000)
        const secs = Math.floor((elapsed % 60000) / 1000)
        const ts = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`

        // 30分钟后切到10分钟间隔
        if (heartbeatInterval === HEARTBEAT_FAST && elapsed >= SLOW_AFTER_MS) {
          heartbeatInterval = HEARTBEAT_SLOW
          scheduleHeartbeat()
          console.log(`[bridge] Heartbeat slowed to 10min interval (elapsed ${ts})`)
          return  // let the new interval fire
        }

        if (onProgress) {
          if (latestText.trim()) {
            void onProgress(formatProgress(`${latestText}\n\n[运行中 +${ts}]`)).catch(() => {})
          } else {
            void onProgress(formatProgress(`[运行中 +${ts} — 等待模型响应...]`)).catch(() => {})
          }
        }
      }, heartbeatInterval)
    }
    scheduleHeartbeat()

    const resetActivityTimeout = () => {
      timeoutCount = 0
      if (currentTimeoutId !== null) {
        clearTimeout(currentTimeoutId)
        currentTimeoutId = setTimeout(() => {
          timeoutCount++
          if (timeoutCount <= 15) {
            if (timeoutCount > 3) {
              console.log(`[bridge] Timeout round ${timeoutCount} (${timeoutCount * 2}min)`)
            }
          } else {
            if (timeoutCount % 5 === 0) {
              console.log(`[bridge] Timeout round ${timeoutCount} (${timeoutCount * 2}min) — still waiting for AI...`)
            }
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
      if (heartbeatId !== null) {
        clearInterval(heartbeatId)
        heartbeatId = null
      }
      router.unregister(sessionId)
      console.log("[bridge] Session finished with text:", latestText.substring(0, 200))
      done()
    }

    router.unregister(sessionId)
    router.register(sessionId, (event: Event) => {
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
        if (part.type === "text" || part.type === "reasoning") {
          // Capture ALL text/reasoning parts — sub-agents have different messageIDs
          // than the primary assistant message, so filtering by messageID drops them
          if (!assistantMessageId) {
            assistantMessageId = part.messageID
          }
          const text = part.text || ""
          console.log("[bridge] Part updated:", part.type, "msgID:", part.messageID, "text:", text.substring(0, 80))
          resetActivityTimeout()

          // 记录 part 类型/全量文本，供 message.part.delta 累积使用
          const existing = partTexts.get(part.id)
          if (existing) {
            existing.type = part.type
            // part.updated 在创建(空)和完成(全量)时触发；若已有 delta 累积，用全量覆盖
            if (text.trim()) {
              existing.text = text
            }
          } else {
            partTexts.set(part.id, { type: part.type, text })
          }

          if (text.trim()) {
            latestText = text
            pushProgressIfNeeded(text)
          }
        }
        return
      }

      // 流式增量文本（opencode 服务器 1.18+）：
      // message.part.updated 只在 part 创建(空)和完成(全量)时触发，
      // 中间的 token 全部通过 message.part.delta 按 partID 推送。
      // 若未累积这里，reasoning/正文在流式期间永远拿不到 → 595 分钟只有心跳。
      if ((event as any).type === "message.part.delta") {
        const props = event.properties as any
        if (props?.field === "text" && props?.partID) {
          const entry = partTexts.get(props.partID)
          if (entry && (entry.type === "text" || entry.type === "reasoning")) {
            entry.text = (entry.text || "") + (props.delta || "")
            latestText = entry.text
            console.log("[bridge] Part delta:", entry.type, "len:", entry.text.length)
            resetActivityTimeout()
            pushProgressIfNeeded(entry.text)
          } else if (!entry) {
            // delta 先于 part.updated 到达（罕见）：先按 text 累积，等 part.updated 再纠正类型
            partTexts.set(props.partID, { type: "text", text: props.delta || "" })
            latestText = props.delta || ""
            resetActivityTimeout()
            pushProgressIfNeeded(latestText)
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
        // 优先用 partTexts 中最完整的累积文本（text 优先于 reasoning，长度最大者）
        const accumulated = getBestAccumulatedText()
        if (accumulated.trim()) {
          latestText = accumulated
        }
        if (!latestText.trim()) {
          // Don't resolve yet — wait for message.part.updated to deliver text
          // The 2-second timer from startPrompt().then() will handle eventual timeout
          console.log("[bridge] Idle with empty text, waiting for content...")
          return
        }
        const finalText = latestText === lastForwardedProgressText ? "" : latestText
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
        // Extract text from prompt result
        const parts = result?.data?.parts
        const textParts = Array.isArray(parts) ? parts.filter((p: any) => p.type === "text" && p.text) : []
        const reasoningParts = Array.isArray(parts) ? parts.filter((p: any) => p.type === "reasoning" && p.text) : []
        const extracted = textParts.length > 0
          ? textParts.map((p: any) => p.text).join("\n")
          : reasoningParts.map((p: any) => p.text).join("\n")

        if (settled) {
          // Timeout fired first — promise already resolved. Send result as follow-up message.
          if (extracted.trim() && onProgress) {
            console.log("[bridge] Timeout already resolved, sending late result as progress")
            void onProgress(formatProgress(`${extracted}\n\n[处理完成]`)).catch((error) => {
              console.error("[bridge] failed to send late result:", error)
            })
          }
          return
        }

        // 优先用 partTexts 中最完整的累积文本
        const accumulated = getBestAccumulatedText()
        if (!latestText.trim() && accumulated.trim()) {
          latestText = accumulated
          console.log("[bridge] Using accumulated part text as latestText")
        }
        if (!latestText.trim() && extracted.trim()) {
          latestText = extracted
          console.log("[bridge] Extracted text from prompt result (no events received)")
        }
        // Wait up to 2s for event-sourced text to arrive, then resolve
        let resolved = false
        const resolveNow = (text: string) => {
          if (resolved) return
          resolved = true
          finish(() => resolve(latestText || "(AI 未返回内容)"))
        }
        setTimeout(() => resolveNow(), 2000)
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
