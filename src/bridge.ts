import type { Config } from "./config.js"
import type { MessageContext } from "./qq/types.js"
import { getAccessToken } from "./qq/token.js"
import { replyToQQ } from "./qq/sender.js"
import type { OpencodeClient } from "./opencode/client.js"
import { promptAsync } from "./opencode/adapter.js"
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
} from "./commands/index.js"

const RESPONSE_TIMEOUT_MS = 5 * 60 * 1000

interface Bridge {
  handleMessage: (ctx: MessageContext) => Promise<void>
}

interface PendingPermissionRequest {
  sessionId: string
  permissionId: string
  title: string
  pattern?: string | string[]
  expiresAt: number
}

interface PendingConfirmationRequest {
  sessionId: string
  prompt: string
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
  const pendingConfirmations = new Map<string, PendingConfirmationRequest>()
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

      const permissionReply = await maybeHandlePendingPermission(ctx, client, pendingPermissions)
      if (permissionReply !== null) {
        await sendReply(ctx, permissionReply)
        return
      }

      const confirmationReply = await maybeHandlePendingConfirmation(
        ctx,
        client,
        router,
        sessions,
        busyUsers,
        pendingConfirmations,
      )
      if (confirmationReply !== null) {
        await sendReply(ctx, confirmationReply)
        return
      }

      if (looksLikePermissionResponse(content)) {
        await sendReply(ctx, "当前没有待确认的权限请求。若要测试权限流程，请先 /new 后再发送目标操作。")
        return
      }

      if (busyUsers.has(ctx.userId)) {
        await sendReply(ctx, "上一条消息还在处理中，请稍候再试")
        return
      }

      busyUsers.add(ctx.userId)

      try {
        const session = await sessions.getOrCreate(ctx.userId)
        const model = sessions.getModel(ctx.userId)
        const agent = sessions.getAgent(ctx.userId)

        const replyText = await waitForSessionReply(router, session.sessionId, () => {
          void promptAsync(client, {
            sessionId: session.sessionId,
            text: content,
            model: model.providerId && model.modelId
              ? { providerID: model.providerId, modelID: model.modelId }
              : undefined,
            agent,
          })
        }, async (permission) => {
          pendingPermissions.set(ctx.userId, permission)
          await sendReply(ctx, formatPermissionRequest(permission))
        })

        if (replyText.trim()) {
          if (looksLikeConfirmationPrompt(replyText)) {
            pendingConfirmations.set(ctx.userId, {
              sessionId: session.sessionId,
              prompt: replyText,
              expiresAt: Date.now() + 10 * 60 * 1000,
            })
            await sendReply(ctx, formatConfirmationRequest(replyText))
            return
          }
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

  const permissionLabel = pending.title || formatPermissionPattern(pending.pattern)
  if (response === "reject") {
    return `已拒绝权限请求：${permissionLabel}`
  }
  if (response === "always") {
    return `已永久允许：${permissionLabel}`
  }
  return `已允许一次：${permissionLabel}`
}

async function maybeHandlePendingConfirmation(
  ctx: MessageContext,
  client: OpencodeClient,
  router: EventRouter,
  sessions: SessionManager,
  busyUsers: Set<string>,
  pendingConfirmations: Map<string, PendingConfirmationRequest>,
): Promise<string | null> {
  const pending = pendingConfirmations.get(ctx.userId)
  if (!pending) {
    return null
  }

  if (pending.expiresAt <= Date.now()) {
    pendingConfirmations.delete(ctx.userId)
    return "确认请求已过期，请重新发送任务"
  }

  const response = parseConfirmationResponse(ctx.content)
  if (!response) {
    pendingConfirmations.delete(ctx.userId)
    return null
  }

  pendingConfirmations.delete(ctx.userId)
  if (response === "reject") {
    return "已取消本次操作"
  }

  if (busyUsers.has(ctx.userId)) {
    return "上一条消息还在处理中，请稍候再试"
  }

  busyUsers.add(ctx.userId)
  try {
    const session = await sessions.getOrCreate(ctx.userId)
    const model = sessions.getModel(ctx.userId)
    const agent = sessions.getAgent(ctx.userId)

    return await waitForSessionReply(router, pending.sessionId || session.sessionId, () => {
      void promptAsync(client, {
        sessionId: pending.sessionId || session.sessionId,
        text: "Yes, confirm. Proceed exactly as previously requested, and do not use any other path.",
        model: model.providerId && model.modelId
          ? { providerID: model.providerId, modelID: model.modelId }
          : undefined,
        agent,
      })
    })
  } finally {
    busyUsers.delete(ctx.userId)
  }
}

function isAllowedUser(userId: string, allowedUsers: string[]): boolean {
  return allowedUsers.length === 0 || allowedUsers.includes(userId)
}

function waitForSessionReply(
  router: EventRouter,
  sessionId: string,
  startPrompt: () => void,
  onPermission?: (permission: PendingPermissionRequest) => Promise<void>,
): Promise<string> {
  let settled = false
  let latestText = ""

  return new Promise<string>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      finish(() => reject(new Error("AI 响应超时（5 分钟）")))
    }, RESPONSE_TIMEOUT_MS)

    const finish = (done: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeoutId)
      router.unregister(sessionId)
      done()
    }

    router.unregister(sessionId)
    router.register(sessionId, (event: Event) => {
      if (event.type === "message.part.updated") {
        const part = event.properties.part
        if (part.type === "text") {
          latestText = part.text
        }
        return
      }

      if (event.type === "permission.asked" || event.type === "permission.updated") {
        if (onPermission) {
          const permission = event.properties as any
          const extracted = extractPermissionDetails(permission)
          void onPermission({
            sessionId: permission.sessionID ?? permission.sessionId ?? sessionId,
            permissionId: permission.id ?? permission.permissionID ?? permission.permissionId,
            title: extracted.title,
            pattern: extracted.pattern,
            expiresAt: Date.now() + 10 * 60 * 1000,
          })
        }
        return
      }

      if (event.type === "session.idle") {
        finish(() => resolve(latestText || "(AI 未返回内容)"))
        return
      }

      if (event.type === "session.error") {
        finish(() => reject(new Error(toErrorMessage(event.properties.error) || "未知错误")))
      }
    })

    try {
      startPrompt()
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))))
    }
  })
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

function looksLikePermissionResponse(content: string): boolean {
  return parsePermissionResponse(content) !== null
}

function parseConfirmationResponse(content: string): "confirm" | "reject" | null {
  const normalized = content.trim().toLowerCase()
  if (["1", "yes", "y", "confirm", "ok", "是", "确认", "继续"].includes(normalized)) {
    return "confirm"
  }
  if (["3", "no", "n", "reject", "cancel", "否", "取消", "拒绝"].includes(normalized)) {
    return "reject"
  }
  return null
}

function looksLikeConfirmationPrompt(content: string): boolean {
  const normalized = content.trim().toLowerCase()
  return normalized.startsWith("confirm you want me") || normalized.includes("请确认") || normalized.includes("确认你要我")
}

function formatPermissionRequest(permission: PendingPermissionRequest): string {
  const title = permission.title || inferPermissionTitle(permission.pattern)
  const pattern = formatPermissionPattern(permission.pattern)

  return [
    "OpenCode 需要权限确认",
    `操作：${title}`,
    `路径：${pattern}`,
    "下一步：回复 1 允许一次 / 2 总是允许 / 3 拒绝",
  ].join("\n")
}

function inferPermissionTitle(pattern?: string | string[]): string {
  const formatted = formatPermissionPattern(pattern)
  if (formatted === "(未提供路径)") {
    return "需要额外权限的操作"
  }
  return "访问指定路径"
}

function formatPermissionPattern(pattern?: string | string[]): string {
  if (Array.isArray(pattern)) {
    return pattern.length > 0 ? pattern.join(", ") : "(未提供路径)"
  }
  return pattern || "(未提供路径)"
}

function formatConfirmationRequest(prompt: string): string {
  return [
    "OpenCode 需要操作确认",
    prompt,
    "回复 1 确认继续 / 3 取消",
  ].join("\n")
}

function extractPermissionDetails(permission: any): { title: string; pattern?: string | string[] } {
  const pattern = permission.pattern
    ?? permission.path
    ?? permission.paths
    ?? permission.file
    ?? permission.files
    ?? permission.args?.pattern
    ?? permission.args?.path
    ?? permission.args?.paths

  const title = permission.title
    ?? permission.permission
    ?? permission.name
    ?? inferPermissionTitle(pattern)

  return { title, pattern }
}
