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
  hasActiveRequests: () => boolean
}

interface PromptOptions {
  model?: {
    providerID: string
    modelID: string
  }
  agent?: string
}

interface PendingPermissionRequest {
  sessionId: string
  permissionId: string
  title: string
  pattern?: string | string[]
  expiresAt: number
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
  const pendingPermissions = new Map<string, PendingPermissionRequest>()
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

      const permissionReply = await maybeHandlePendingPermission(ctx, client, pendingPermissions)
      if (permissionReply !== null) {
        await sendReply(ctx, permissionReply)
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
        processingTimer = setTimeout(() => {
          sentProcessingReply = true
          void sendReply(ctx, "正在处理中，完成后继续回复，请稍候。")
        }, 2000)

        const session = await sessions.getOrCreate(ctx.userId)
        const promptOptions = buildPromptOptions(ctx.userId, sessions)
        const replyText = await waitForSessionReply(client, router, session.sessionId, () => {
          void startSessionPrompt(client, session.sessionId, content, promptOptions)
        }, async (progressText) => {
          await sendReply(ctx, progressText)
        }, async (permission) => {
          pendingPermissions.set(ctx.userId, permission)
          await sendReply(ctx, formatPermissionRequest(permission))
        })
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

async function maybeHandlePendingPermission(
  ctx: MessageContext,
  client: OpencodeClient,
  pendingPermissions: Map<string, PendingPermissionRequest>,
): Promise<string | null> {
  const pending = pendingPermissions.get(ctx.userId)
  if (!pending) {
    return null
  }

  if (pending.expiresAt <= Date.now()) {
    pendingPermissions.delete(ctx.userId)
    return "权限请求已过期，请重新发送任务"
  }

  const response = parsePermissionResponse(ctx.content)
  if (!response) {
    return "当前有权限请求待确认。请回复 1(允许一次) / 2(总是允许) / 3(拒绝)"
  }

  await (client as any).postSessionIdPermissionsPermissionId({
    path: { id: pending.sessionId, permissionID: pending.permissionId },
    body: { response },
  })
  pendingPermissions.delete(ctx.userId)

  if (response === "reject") {
    return `已拒绝权限请求：${pending.title}`
  }
  if (response === "always") {
    return `已永久允许：${pending.title}`
  }
  return `已允许一次：${pending.title}`
}

function parsePermissionResponse(content: string): "once" | "always" | "reject" | null {
  const normalized = content.trim().toLowerCase()
  if (["1", "once", "allow", "允许", "允许一次", "y", "yes"].includes(normalized)) {
    return "once"
  }
  if (["2", "always", "总是允许", "始终允许"].includes(normalized)) {
    return "always"
  }
  if (["3", "reject", "deny", "拒绝", "n", "no"].includes(normalized)) {
    return "reject"
  }
  return null
}

function formatPermissionRequest(permission: PendingPermissionRequest): string {
  const pattern = Array.isArray(permission.pattern)
    ? permission.pattern.join(", ")
    : permission.pattern ?? "(未提供路径)"

  return [
    "OpenCode 需要权限确认",
    `操作：${permission.title}`,
    `路径：${pattern}`,
    "回复 1 允许一次 / 2 总是允许 / 3 拒绝",
  ].join("\n")
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
  startPrompt: () => Promise<void>,
  onProgress?: (text: string) => Promise<void>,
  onPermission?: (permission: PendingPermissionRequest) => Promise<void>,
): Promise<string> {
  let settled = false
  let latestText = ""
  let events: any[] = []
  let assistantMessageId = ""
  let connectRetryCount = 0
  let lastProgressText = ""
  let lastProgressAt = 0

  return new Promise<string>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      console.log("[bridge] TIMEOUT! Collected events:", JSON.stringify(events, null, 2))
      console.log("[bridge] latestText so far:", latestText)
      void abortSession(client, sessionId)
      if (latestText.trim()) {
        finish(() => resolve(`${latestText}\n\n[任务仍在继续，QQ 等待窗口已到上限。可在 OpenCode attach/TUI 中继续查看，或稍后再发消息继续。]`))
        return
      }
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

      if (event.type === "message.updated") {
        const info = event.properties.info as any
        if (info?.role === "assistant" && info?.id) {
          assistantMessageId = info.id
        }
        return
      }
      
      if (event.type === "message.part.updated") {
        const part = event.properties.part as any
        if (part.type === "text" && part.messageID === assistantMessageId) {
          latestText = part.text
          console.log("[bridge] Text updated:", latestText.substring(0, 100))

          const now = Date.now()
          const hasMeaningfulDelta = latestText.trim().length >= 40 && latestText !== lastProgressText
          const canPushProgress = now - lastProgressAt >= 15000
          if (onProgress && hasMeaningfulDelta && canPushProgress) {
            lastProgressText = latestText
            lastProgressAt = now
            void onProgress(`${latestText}\n\n[处理中，任务仍在继续...]`).catch((error) => {
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

      if (event.type === "permission.updated") {
        const permission = event.properties as any
        if (onPermission) {
          void onPermission({
            sessionId: permission.sessionID,
            permissionId: permission.id,
            title: permission.title,
            pattern: permission.pattern,
            expiresAt: Date.now() + 10 * 60 * 1000,
          }).catch((error) => {
            console.error("[bridge] failed to send permission request:", error)
          })
        }
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
    parts: [{
      type: "text",
      text: [
        "Execution constraints:",
        "- Use only the current workspace or C:\\Users\\lluoto\\.local\\share\\opencode\\tool-output for temporary local files.",
        "- Do not create or modify temporary files under C:\\code or any other external local directory.",
        "- If a local temporary helper file is needed, place it under C:\\Users\\lluoto\\.local\\share\\opencode\\tool-output.",
        "",
        text,
      ].join("\n"),
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

async function abortSession(client: OpencodeClient, sessionId: string): Promise<void> {
  try {
    await client.session.abort({ path: { id: sessionId } })
    console.log("[bridge] Aborted timed-out session:", sessionId)
  } catch (error) {
    console.error("[bridge] Failed to abort session:", sessionId, error)
  }
}
