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
  handleCommand,
  handlePendingSelection,
  isCommand,
  type CommandContext,
  type PendingSelection,
} from "./commands.js"
import { deriveStateKey } from "./state-key.js"

const RESPONSE_TIMEOUT_MS = 2 * 60 * 1000

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

interface QuestionOption {
  label: string
  description?: string
}

interface QuestionInfo {
  question: string
  header?: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean
}

interface PendingQuestion {
  requestId: string
  sessionId: string
  questions: QuestionInfo[]
  questionIndex: number
  answers: string[][]
}

export function createBridge(
  config: Config,
  client: OpencodeClient,
  router: EventRouter,
  sessions: SessionManager,
  botConfig?: { appId: string; clientSecret: string; sandbox: boolean },
): Bridge {
  const busyUsers = new Set<string>()
  const activeControllers = new Map<string, AbortController>()
  const pendingSelections = new Map<string, PendingSelection>()
  const pendingQuestions = new Map<string, PendingQuestion>()
  const processedMessages = new Map<string, number>()
  const botAppId = botConfig?.appId ?? config.qq.appId
  const botClientSecret = botConfig?.clientSecret ?? config.qq.clientSecret
  const botSandbox = botConfig?.sandbox ?? config.qq.sandbox
  const commandContext: CommandContext = {
    config,
    client,
    sessions,
    getAccessToken: () => getAccessToken(botAppId, botClientSecret),
    pendingSelections,
    stopActiveRequest: (stateKey) => {
      const controller = activeControllers.get(stateKey)
      controller?.abort()
      return controller !== undefined
    },
  }

  const handleMessage = async (ctx: MessageContext): Promise<void> => {
    try {
      const stateKey = deriveStateKey(ctx.botId, ctx.userId, ctx.groupId)
      const messageKey = `${stateKey}:${ctx.msgId}`
      pruneProcessedMessages(processedMessages)
      if (processedMessages.has(messageKey)) {
        console.log("[bridge] Skip duplicated QQ message:", ctx.msgId)
        return
      }
      processedMessages.set(messageKey, Date.now())

      if (!isAllowedUser(ctx.userId, config.allowedUsers)) {
        await sendReply(ctx, "你不在允许使用的名单里")
        return
      }

      const content = ctx.content.trim()
      if (!content) {
        return
      }

      if (isCommand(content)) {
        if (/^[\\/](?:stop|x)(?:\s|$)/i.test(content)) {
          const pendingQuestion = pendingQuestions.get(stateKey)
          if (pendingQuestion) {
            pendingQuestions.delete(stateKey)
            void rejectQuestion(config.opencode.baseUrl, pendingQuestion.requestId).catch((error) => {
              console.error("[bridge] failed to reject pending question:", error)
            })
          }
        }
        const reply = await handleCommand(ctx, commandContext)
        await sendReply(ctx, reply)
        return
      }

      const questionReply = await maybeHandlePendingQuestion(
        ctx,
        stateKey,
        pendingQuestions,
        config.opencode.baseUrl,
      )
      if (questionReply !== null) {
        await sendReply(ctx, questionReply)
        return
      }

      const pendingReply = await maybeHandlePendingSelection(ctx, commandContext)
      if (pendingReply !== null) {
        await sendReply(ctx, pendingReply)
        return
      }

      if (busyUsers.has(stateKey)) {
        await sendReply(ctx, "上一条消息还在处理中，请稍候再试")
        return
      }

      busyUsers.add(stateKey)
      const abortController = new AbortController()
      activeControllers.set(stateKey, abortController)

      let processingTimer: ReturnType<typeof setTimeout> | null = null
      let promptModel: PromptOptions["model"] | undefined
      try {
        let sentProcessingReply = false

        let session = await sessions.getOrCreate(ctx.userId)
        const promptOptions = buildPromptOptions(ctx.userId, sessions)
        promptModel = promptOptions.model
        console.log("[bridge] Model override for prompt:", JSON.stringify(promptOptions.model))

        const runOnce = async (sessionId: string): Promise<string> => {
          return waitForSessionReply(client, router, sessionId, abortController.signal, config.opencode.baseUrl, () => {
            return startSessionPrompt(client, sessionId, content, promptOptions)
          }, async (progressText) => {
            await sendReply(ctx, progressText)
          }, async (pendingQuestion) => {
            pendingQuestions.set(stateKey, pendingQuestion)
            await sendReply(ctx, formatQuestionPrompt(pendingQuestion))
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
        if (processingTimer !== null) {
          clearTimeout(processingTimer)
        }
        processingTimer = null

        if (replyText.trim()) {
          await sendReply(ctx, replyText)
        } else if (!sentProcessingReply && !abortController.signal.aborted) {
          await sendReply(ctx, "(AI 未返回内容)")
        }
      } catch (error) {
        if (processingTimer) {
          clearTimeout(processingTimer)
        }
        await sendReply(ctx, `处理失败：${toUserFacingError(error, promptModel)}`)
      } finally {
        pendingQuestions.delete(stateKey)
        busyUsers.delete(stateKey)
        activeControllers.delete(stateKey)
      }
    } catch (error) {
      console.error("[bridge] handleMessage failed:", error)
      try {
        await sendReply(ctx, `处理消息失败：${toUserFacingError(error)}`)
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

async function maybeHandlePendingQuestion(
  ctx: MessageContext,
  stateKey: string,
  pendingQuestions: Map<string, PendingQuestion>,
  baseUrl: string,
): Promise<string | null> {
  const pending = pendingQuestions.get(stateKey)
  if (!pending) return null

  const question = pending.questions[pending.questionIndex]
  if (!question) {
    pendingQuestions.delete(stateKey)
    return null
  }

  const parsed = parseQuestionAnswer(ctx.content, question)
  if (typeof parsed === "string") return parsed

  pending.answers.push(parsed)
  pending.questionIndex += 1

  if (pending.questionIndex < pending.questions.length) {
    return formatQuestionPrompt(pending)
  }

  pendingQuestions.delete(stateKey)
  await replyToQuestion(baseUrl, pending.requestId, pending.answers)
  return "已提交选择，模型继续执行"
}

function parseQuestionAnswer(content: string, question: QuestionInfo): string[] | string {
  const trimmed = content.trim()
  const numeric = /^\d+(?:\s*[,，]\s*\d+)*$/.test(trimmed)
  if (numeric) {
    const indexes = trimmed.split(/[,，]/).map((value) => Number(value.trim()))
    if (!question.multiple && indexes.length !== 1) {
      return "这是单选题，请只回复一个序号"
    }
    if (indexes.some((index) => index < 1 || index > question.options.length)) {
      return `序号无效，请回复 1-${question.options.length}${question.multiple ? "，多选用逗号分隔" : ""}`
    }
    return [...new Set(indexes)].map((index) => question.options[index - 1]!.label)
  }

  if (question.custom !== false && trimmed) return [trimmed]
  return `请回复 1-${question.options.length}${question.multiple ? "，多选用逗号分隔" : ""}`
}

function formatQuestionPrompt(pending: PendingQuestion): string {
  const question = pending.questions[pending.questionIndex]!
  const title = question.header ? `【${question.header}】` : "【模型需要选择】"
  const options = question.options.map((option, index) => {
    const description = option.description?.trim()
    return `${index + 1}. ${option.label}${description ? ` - ${description}` : ""}`
  })
  const instructions = question.multiple
    ? "回复序号，多选用逗号分隔（如 1,3）"
    : "回复一个序号"
  const custom = question.custom !== false ? "；也可直接回复自定义答案" : ""
  return [
    `${title} (${pending.questionIndex + 1}/${pending.questions.length})`,
    question.question,
    ...options,
    `${instructions}${custom}。发送 /stop 可中止。`,
  ].join("\n")
}

async function replyToQuestion(baseUrl: string, requestId: string, answers: string[][]): Promise<void> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/question/${encodeURIComponent(requestId)}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answers }),
  })
  if (!response.ok) throw new Error(`提交模型选择失败：HTTP ${response.status}`)
}

async function rejectQuestion(baseUrl: string, requestId: string): Promise<void> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/question/${encodeURIComponent(requestId)}/reject`, {
    method: "POST",
  })
  if (!response.ok && response.status !== 404) {
    throw new Error(`中止模型选择失败：HTTP ${response.status}`)
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
  const stateKey = deriveStateKey(ctx.botId, ctx.userId, ctx.groupId)
  const pending = commandContext.pendingSelections.get(stateKey)
  if (!pending) {
    return null
  }

  if (pending.expiresAt <= Date.now()) {
    commandContext.pendingSelections.delete(stateKey)
    return null
  }

  if (!/^\d+$/.test(ctx.content.trim())) {
    commandContext.pendingSelections.delete(stateKey)
    return null
  }

  return handlePendingSelection(ctx, Number(ctx.content.trim()), commandContext)
}

function isAllowedUser(userId: string, allowedUsers: string[]): boolean {
  return allowedUsers.length === 0 || allowedUsers.includes(userId)
}

function buildPromptOptions(stateKey: string, sessions: SessionManager): PromptOptions {
  const model = sessions.getModel(stateKey)
  const agent = sessions.getAgent(stateKey)

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
  abortSignal: AbortSignal,
  baseUrl: string,
  startPrompt: () => Promise<any>,
  onProgress?: (text: string) => Promise<void>,
  onQuestion?: (question: PendingQuestion) => Promise<void>,
): Promise<string> {
  let settled = false
  let latestText = ""
  let lastForwardedProgressText = ""
  let assistantMessageId = ""
  let connectRetryCount = 0
  let lastProgressText = ""
  let lastProgressAt = 0
  let thinkCount = 0
  const forwardedQuestionIds = new Set<string>()
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
    // 总时长不设上限；诊断超时只记录日志，不会终止会话。
    // 正常完成由 session.idle / session.error / prompt().then() 驱动。
    // 心跳每5分钟推 [运行中 +MM:SS] 告知用户"还在运行"

    let currentTimeoutId: ReturnType<typeof setTimeout> | null = null
    let graceTimerId: ReturnType<typeof setTimeout> | null = null
    let questionPollId: ReturnType<typeof setInterval> | null = null
    // /stop 与 startPrompt() 的真实完成经常在毫秒级别内竞争到达（服务器已经算完并计费，
    // 只是 abort 信号恰好先一步 resolve）。给 abort 一个短暂宽限期，
    // 避免把刚好算完、已经产生费用的合法结果当成"迟到"直接丢弃。
    const ABORT_GRACE_MS = 8000

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

    const noteActivity = (): void => {
      timeoutCount = 0
      scheduleTimeout()
    }

    const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000
    let heartbeatId: ReturnType<typeof setInterval> | null = setInterval(() => {
      if (settled) return
      const elapsed = Date.now() - thinkStartTime
      const mins = Math.floor(elapsed / 60000)
      const secs = Math.floor((elapsed % 60000) / 1000)
      const ts = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`

      if (onProgress) {
        if (latestText.trim()) {
          void onProgress(formatProgress(`${latestText}\n\n[运行中 +${ts}]`)).catch(() => {})
        } else {
          void onProgress(formatProgress(`[运行中 +${ts} — 等待模型响应...]`)).catch(() => {})
        }
      }
    }, HEARTBEAT_INTERVAL_MS)

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
      if (graceTimerId !== null) {
        clearTimeout(graceTimerId)
        graceTimerId = null
      }
      if (questionPollId !== null) {
        clearInterval(questionPollId)
        questionPollId = null
      }
      router.unregister(sessionId)
      abortSignal.removeEventListener("abort", stop)
      console.log("[bridge] Session finished with text:", latestText.substring(0, 200))
      done()
    }

    const stop = (): void => {
      if (settled) return
      // 停止后不再需要心跳/诊断超时提示，但先不 resolve —— 给正在飞行中的
      // startPrompt() 一个宽限期，让它有机会把已经算完的真实结果交回来。
      if (heartbeatId !== null) {
        clearInterval(heartbeatId)
        heartbeatId = null
      }
      if (currentTimeoutId !== null) {
        clearTimeout(currentTimeoutId)
        currentTimeoutId = null
      }
      console.log(`[bridge] Stop requested, waiting up to ${ABORT_GRACE_MS}ms for in-flight result before discarding`)
      graceTimerId = setTimeout(() => {
        console.log("[bridge] Grace period expired after stop, resolving empty")
        finish(() => resolve(""))
      }, ABORT_GRACE_MS)
    }
    if (abortSignal.aborted) {
      stop()
    } else {
      abortSignal.addEventListener("abort", stop, { once: true })
    }

    router.unregister(sessionId)

    const forwardQuestion = (requestId: string, rawQuestions: unknown): void => {
      if (forwardedQuestionIds.has(requestId) || !Array.isArray(rawQuestions) || rawQuestions.length === 0) return
      const questions = rawQuestions.map(toQuestionInfo).filter((question): question is QuestionInfo => question !== null)
      if (questions.length === 0) return
      forwardedQuestionIds.add(requestId)
      if (onQuestion) {
        void onQuestion({ requestId, sessionId, questions, questionIndex: 0, answers: [] }).catch((error) => {
          forwardedQuestionIds.delete(requestId)
          console.error("[bridge] failed to forward question:", error)
        })
      }
    }

    const pollQuestions = async (): Promise<void> => {
      try {
        const response = await fetch(`${baseUrl.replace(/\/$/, "")}/question`)
        if (!response.ok) return
        const requests = await response.json()
        if (!Array.isArray(requests)) return
        for (const value of requests) {
          const request = asRecord(value)
          if (getStringProperty(request, "sessionID") !== sessionId) continue
          const requestId = getStringProperty(request, "id")
          if (requestId) forwardQuestion(requestId, request.questions)
        }
      } catch {}
    }

    questionPollId = setInterval(() => { void pollQuestions() }, 3_000)
    void pollQuestions()

    router.register(sessionId, (event: Event) => {
      const eventType = String(event.type)
      console.log("[bridge] Event received:", eventType)
      noteActivity()

      const properties = asRecord(event.properties)

      if (eventType === "message.updated") {
        const info = asRecord(properties.info)
        const role = getStringProperty(info, "role")
        const messageId = getStringProperty(info, "id")
        if (role === "assistant" && messageId) {
          assistantMessageId = messageId
        }
        return
      }

      if (eventType === "message.part.updated") {
        const part = asRecord(properties.part)
        const partType = getStringProperty(part, "type")
        const partId = getStringProperty(part, "id")
        const messageId = getStringProperty(part, "messageID")
        const text = getStringProperty(part, "text") ?? ""
        const delta = getStringProperty(properties, "delta") ?? ""

        // RetryPart：服务器通过 message.part.updated (type:"retry") 推送 LLM 调用重试。
        // 免费额度耗尽 / 429 rate limit 会走这条通道（error: ApiError.data.message）。
        // 若忽略它，prompt() 会一直在服务器内部重试而永不返回 → bridge 无限心跳"思考+计时"。
        if (partType === "retry") {
          const retryMessage = getRetryPartErrorMessage(part)
          console.log("[bridge] Part updated: retry, attempt:", getStringProperty(part, "attempt"), "err:", retryMessage?.substring(0, 120))
          if (retryMessage && isQuotaRetryMessage(retryMessage)) {
            finish(() => reject(new Error(retryMessage)))
            return
          }
          // 非额度类重试（瞬时错误）：服务器仍在活动，刷新超时即可
          return
        }

        if ((partType === "text" || partType === "reasoning") && partId) {
          // Capture ALL text/reasoning parts — sub-agents have different messageIDs
          // than the primary assistant message, so filtering by messageID drops them
          if (!assistantMessageId && messageId) {
            assistantMessageId = messageId
          }
          console.log("[bridge] Part updated:", partType, "msgID:", messageId, "text:", text.substring(0, 80))

          // 记录 part 类型/全量文本，供 message.part.delta 累积使用
          const existing = partTexts.get(partId)
          if (existing) {
            existing.type = partType
            // part.updated 可能同时携带流式 delta；完整 text 到达时优先使用完整内容。
            existing.text = mergePartText(existing.text, text, delta)
          } else {
            partTexts.set(partId, { type: partType, text: mergePartText("", text, delta) })
          }

          const accumulatedText = partTexts.get(partId)?.text ?? ""
          if (accumulatedText.trim()) {
            latestText = accumulatedText
            pushProgressIfNeeded(accumulatedText)
          }
        }
        return
      }

      // 流式增量文本（opencode 服务器 1.18+）：
      // message.part.updated 只在 part 创建(空)和完成(全量)时触发，
      // 中间的 token 全部通过 message.part.delta 按 partID 推送。
      // 若未累积这里，reasoning/正文在流式期间永远拿不到 → 595 分钟只有心跳。
      if (eventType === "message.part.delta") {
        const props = properties
        const field = getStringProperty(props, "field")
        const partId = getStringProperty(props, "partID")
        const delta = getStringProperty(props, "delta") ?? ""
        if (field === "text" && partId) {
          const entry = partTexts.get(partId)
          if (entry && (entry.type === "text" || entry.type === "reasoning")) {
            entry.text = entry.text + delta
            latestText = entry.text
            console.log("[bridge] Part delta:", entry.type, "len:", entry.text.length)
            pushProgressIfNeeded(entry.text)
          } else if (!entry) {
            // delta 先于 part.updated 到达（罕见）：先按 text 累积，等 part.updated 再纠正类型
            partTexts.set(partId, { type: "text", text: delta })
            latestText = delta
            pushProgressIfNeeded(latestText)
          }
        }
        return
      }

      if (eventType === "session.status") {
        const statusValue = properties.status
        console.log("[bridge] Session status:", statusValue)

        const status = asRecord(statusValue)
        const statusType = getStringProperty(status, "type")
        const statusMessage = getStringProperty(status, "message")
        if (statusType === "retry" && statusMessage) {
          if (isQuotaRetryMessage(statusMessage)) {
            finish(() => reject(new Error(statusMessage)))
            return
          }
          if (/Cannot connect to API/i.test(statusMessage)) {
            connectRetryCount += 1
            if (connectRetryCount >= 2) {
              finish(() => reject(new Error("AI 服务连接失败，请检查 OPENAI_BASE_URL / 代理配置")))
              return
            }
          }
        }
        return
      }

      if (eventType === "permission.asked" || eventType === "permission.updated") {
        // Permission handled by OMO server-side — no user confirmation needed
        return
      }

      if (eventType === "question.asked") {
        const requestId = getStringProperty(properties, "id")
        if (requestId) forwardQuestion(requestId, properties.questions)
        return
      }

      if (eventType === "session.idle") {
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

      if (eventType === "session.error") {
        const errorValue = properties.error
        console.log("[bridge] Session error:", errorValue)
        finish(() => reject(new Error(toErrorMessage(errorValue) || "未知错误")))
      }
    })

    scheduleTimeout()

    // OpenCode versions differ in whether the global stream includes session events.
    // Either the event stream or prompt result can complete the request.
    Promise.resolve()
      .then(() => {
        noteActivity()
        return startPrompt()
      })
      .then(async (result) => {
        console.log("[bridge] Prompt completed for session:", sessionId)
        const promptError = getPromptError(result)
        if (promptError) {
          finish(() => reject(new Error(toErrorMessage(promptError))))
          return
        }

        // Extract text from prompt result - this is the primary data source
        const parts = result?.data?.parts
        const textParts = Array.isArray(parts) ? parts.filter((p: any) => p.type === "text" && p.text) : []
        const reasoningParts = Array.isArray(parts) ? parts.filter((p: any) => p.type === "reasoning" && p.text) : []
        const extracted = textParts.length > 0
          ? textParts.map((p: any) => p.text).join("\n")
          : reasoningParts.map((p: any) => p.text).join("\n")

        if (settled) {
          // 只应在 stop 后的 ABORT_GRACE_MS 宽限期都等不到结果时发生（真正的迟到）。
          console.log("[bridge] Discarding result after request already settled (arrived after grace period)")
          return
        }

        // Use extracted text directly from prompt result (SSE events are unreliable)
        let finalText = extracted.trim() || latestText.trim() || getBestAccumulatedText().trim()
        if (!finalText) {
          finalText = await getLatestAssistantText(client, sessionId)
          if (finalText) {
            console.log("[bridge] Using latest assistant message text")
          }
        }
        console.log("[bridge] Final text length:", finalText.length)
        finish(() => resolve(finalText || "(AI 未返回内容)"))
      })
      .catch((error) => {
        console.error("[bridge] startPrompt threw:", error)
        if (abortSignal.aborted) {
          // 用户主动 /stop 导致服务端中止 prompt() 抛错：这是预期行为，
          // 不应该当作"处理失败"抛给用户（/stop 命令自身已经回复过了）。
          finish(() => resolve(""))
          return
        }
        finish(() => reject(error instanceof Error ? error : new Error(String(error))))
      })
  })
}

function toQuestionInfo(value: unknown): QuestionInfo | null {
  const record = asRecord(value)
  const question = getStringProperty(record, "question")
  if (!question || !Array.isArray(record.options)) return null
  const options = record.options.map((value): QuestionOption | null => {
    const option = asRecord(value)
    const label = getStringProperty(option, "label")
    if (!label) return null
    return { label, description: getStringProperty(option, "description") }
  }).filter((option): option is QuestionOption => option !== null)
  if (options.length === 0) return null
  return {
    question,
    header: getStringProperty(record, "header"),
    options,
    multiple: record.multiple === true,
    custom: record.custom !== false,
  }
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

function asRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value
  return {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function getStringProperty(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === "string" ? value : undefined
}

export function getPromptError(result: unknown): unknown {
  if (typeof result !== "object" || result === null) {
    return undefined
  }

  const response = result as any
  return response.error ?? response.data?.error ?? response.data?.info?.error
}

async function getLatestAssistantText(client: OpencodeClient, sessionId: string): Promise<string> {
  try {
    const result = await client.session.messages({ path: { id: sessionId }, query: { limit: 20 } })
    const messages = Array.isArray(result.data) ? result.data : []
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index] as any
      if (message?.info?.role !== "assistant") continue
      const parts = Array.isArray(message.parts) ? message.parts : []
      const text = parts
        .filter((part: any) => part?.type === "text" && typeof part.text === "string" && part.text.trim())
        .map((part: any) => part.text)
        .join("\n")
      if (text.trim()) return text
    }
  } catch (error) {
    console.error("[bridge] failed to read latest assistant message:", error)
  }
  return ""
}

export function toUserFacingError(error: unknown, model?: PromptOptions["model"]): string {
  const message = toErrorMessage(error)
  const normalized = message.toLowerCase()
  const isFreeModel = model?.providerID === "opencode" && model.modelID === "deepseek-v4-flash-free"
  const isQuotaError = normalized.includes("quota exceeded") || normalized.includes("quota exhausted") || normalized.includes("rate limit") || normalized.includes("免费额度")
  if (
    isQuotaError ||
    (isFreeModel && (normalized.includes("insufficient balance") || normalized.includes("余额不足")))
  ) {
    return "免费模型今日额度已用尽，请明天再试"
  }
  if (normalized.includes("endpoint is unavailable") || normalized.includes("upstream request failed")) {
    return "当前模型上游服务不可用，请稍后重试或切换模型"
  }
  return message
}

export function isQuotaRetryMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return normalized.includes("quota") ||
    normalized.includes("rate limit") ||
    normalized.includes("insufficient balance") ||
    normalized.includes("免费额度") ||
    normalized.includes("余额不足")
}

// RetryPart (type:"retry") 的 error 是 ApiError: { name:"APIError", data:{ message, statusCode?, isRetryable } }。
// 按该形状提取 message；不用 toErrorMessage（其 String() 回退会把空对象变成 "[object Object]"）。
export function getRetryPartErrorMessage(part: Record<string, unknown>): string | undefined {
  if (getStringProperty(part, "type") !== "retry") return undefined
  const error = asRecord(part.error)
  const data = asRecord(error.data)
  const message = getStringProperty(data, "message") ?? getStringProperty(error, "message")
  return message || undefined
}

export function mergePartText(existingText: string, completeText: string, delta: string): string {
  return completeText.trim() ? completeText : existingText + delta
}

function isSessionNotFoundError(error: unknown): boolean {
  const message = toErrorMessage(error)
  return /session not found/i.test(message)
}

// Permission confirmation removed — OMO handles permissions server-side
