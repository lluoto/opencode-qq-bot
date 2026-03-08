import type { Config } from "./config.js"
import type { MessageContext } from "./qq/types.js"
import type { OpencodeClient } from "./opencode/client.js"
import { SessionManager } from "./opencode/sessions.js"
import {
  abortSession,
  listProviderModels,
  listAgents as adapterListAgents,
  updateSessionTitle,
  healthCheck,
} from "./opencode/adapter.js"

const SELECTION_TTL_MS = 60_000

export interface CommandContext {
  config: Config
  client: OpencodeClient
  sessions: SessionManager
  getAccessToken: () => Promise<string>
  pendingSelections: Map<string, PendingSelection>
}

export interface PendingSelection {
  type: "session" | "model"
  items: Array<{ id: string; label: string }>
  expiresAt: number
}

interface ParsedCommand {
  name: string
  args: string
}

const SHORT_ALIASES: Record<string, string> = {
  nw: "new",
  st: "stop",
  ss: "status",
  sn: "sessions",
  hp: "help",
  md: "model",
  ag: "agent",
  rn: "rename",
}

export function isCommand(content: string): boolean {
  const trimmed = content.trim()
  if (trimmed.startsWith("/")) return true
  const firstToken = trimmed.split(/\s+/)[0]?.toLowerCase()
  return firstToken !== undefined && firstToken in SHORT_ALIASES
}

export async function handleCommand(ctx: MessageContext, cmdCtx: CommandContext): Promise<string> {
  cmdCtx.pendingSelections.delete(ctx.userId)

  const parsed = parseCommand(ctx.content)
  if (!parsed) {
    return "不是有效命令"
  }

  switch (parsed.name) {
    case "new":
      return handleNew(ctx, cmdCtx)
    case "stop":
      return handleStop(ctx, cmdCtx)
    case "status":
      return handleStatus(ctx, cmdCtx)
    case "sessions":
      return handleSessions(ctx, cmdCtx)
    case "help":
      return buildHelpText()
    case "model":
      return handleModel(ctx, parsed.args, cmdCtx)
    case "agent":
      return handleAgent(ctx, parsed.args, cmdCtx)
    case "rename":
      return handleRename(ctx, parsed.args, cmdCtx)
    default:
      return `不支持的命令：${parsed.name}\n发送 hp 或 /help 查看可用命令`
  }
}

export async function handlePendingSelection(
  userId: string,
  selection: number,
  cmdCtx: CommandContext,
): Promise<string | null> {
  const pending = cmdCtx.pendingSelections.get(userId)
  if (!pending) return null

  if (pending.expiresAt <= Date.now()) {
    cmdCtx.pendingSelections.delete(userId)
    return null
  }

  const item = pending.items[selection - 1]
  if (!item) {
    return `序号无效，请回复 1-${pending.items.length}`
  }

  cmdCtx.pendingSelections.delete(userId)

  if (pending.type === "session") {
    cmdCtx.sessions.switchSession(userId, item.id, item.label)
    return `已切换到会话：${item.label}`
  }

  const model = splitModelId(item.id)
  if (!model) {
    return `模型项无效：${item.label}`
  }

  await ensureSession(userId, cmdCtx)
  cmdCtx.sessions.setModel(userId, model.providerId, model.modelId)
  return `已切换模型：${item.label}`
}

function parseCommand(content: string): ParsedCommand | null {
  const trimmed = content.trim()

  if (trimmed.startsWith("/")) {
    const [rawName, ...rest] = trimmed.slice(1).split(/\s+/)
    const name = rawName?.toLowerCase()
    if (!name) return null
    return { name, args: rest.join(" ").trim() }
  }

  const [firstToken, ...rest] = trimmed.split(/\s+/)
  const alias = firstToken?.toLowerCase()
  if (!alias || !(alias in SHORT_ALIASES)) return null
  return { name: SHORT_ALIASES[alias], args: rest.join(" ").trim() }
}

async function handleNew(ctx: MessageContext, cmdCtx: CommandContext): Promise<string> {
  const session = await cmdCtx.sessions.createNew(ctx.userId)
  return [
    "已创建新会话",
    `标题：${session.title ?? "未命名会话"}`,
    `ID：${session.sessionId}`,
  ].join("\n")
}

async function handleStop(ctx: MessageContext, cmdCtx: CommandContext): Promise<string> {
  const session = cmdCtx.sessions.getSession(ctx.userId)
  if (!session) {
    return "当前还没有会话可停止"
  }

  await abortSession(cmdCtx.client, session.sessionId)
  return `已发送停止请求：${session.title ?? session.sessionId}`
}

async function handleStatus(ctx: MessageContext, cmdCtx: CommandContext): Promise<string> {
  const session = cmdCtx.sessions.getSession(ctx.userId)
  const { providerId, modelId } = cmdCtx.sessions.getModel(ctx.userId)
  const agentId = cmdCtx.sessions.getAgent(ctx.userId)

  let openCodeStatus: string
  try {
    await healthCheck(cmdCtx.client)
    openCodeStatus = "运行中"
  } catch {
    openCodeStatus = "异常"
  }

  let qqStatus: string
  try {
    await cmdCtx.getAccessToken()
    qqStatus = "正常"
  } catch {
    qqStatus = "异常"
  }

  return [
    "OpenCode 状态",
    `服务器：${openCodeStatus}`,
    `QQ 鉴权：${qqStatus}`,
    `会话：${session ? `${session.title ?? "未命名会话"} (${session.sessionId})` : "未创建"}`,
    `模型：${providerId && modelId ? `${providerId} / ${modelId}` : "默认"}`,
    `Agent：${agentId ?? "默认"}`,
  ].join("\n")
}

async function handleSessions(ctx: MessageContext, cmdCtx: CommandContext): Promise<string> {
  const sessions = cmdCtx.sessions.getUserSessions(ctx.userId)
  if (sessions.length === 0) {
    return "当前没有可切换的历史会话"
  }

  const currentSessionId = cmdCtx.sessions.getSession(ctx.userId)?.sessionId
  cmdCtx.pendingSelections.set(ctx.userId, {
    type: "session",
    items: sessions.map((s) => ({ id: s.id, label: s.title })),
    expiresAt: Date.now() + SELECTION_TTL_MS,
  })

  const lines = sessions.map((s, index) => {
    const prefix = s.id === currentSessionId ? "[当前] " : ""
    return `${index + 1}. ${prefix}${s.title}`
  })

  return ["会话列表：", ...lines, "回复序号切换会话（60 秒内有效）"].join("\n")
}

async function handleModel(ctx: MessageContext, args: string, cmdCtx: CommandContext): Promise<string> {
  if (!args) {
    const models = await listProviderModels(cmdCtx.client)
    if (models.length === 0) {
      return "当前没有可用模型"
    }

    const current = cmdCtx.sessions.getModel(ctx.userId)
    cmdCtx.pendingSelections.set(ctx.userId, {
      type: "model",
      items: models.map((m) => ({ id: m.id, label: m.label })),
      expiresAt: Date.now() + SELECTION_TTL_MS,
    })

    const lines = models.map((m, index) => {
      const isCurrent = current.providerId && current.modelId && `${current.providerId}/${current.modelId}` === m.id
      return `${index + 1}. ${isCurrent ? "[当前] " : ""}${m.label}`
    })

    return ["可用模型：", ...lines, "回复序号或 md <provider/model> 切换（60 秒内有效）"].join("\n")
  }

  if (/^\d+$/.test(args)) {
    const result = await handlePendingSelection(ctx.userId, Number(args), cmdCtx)
    return result ?? "没有待选择的模型列表，请先发送 md 或 /model"
  }

  const model = splitModelId(args)
  if (!model) {
    return "模型格式不对，请使用 md <provider/model>"
  }

  await ensureSession(ctx.userId, cmdCtx)
  cmdCtx.sessions.setModel(ctx.userId, model.providerId, model.modelId)
  return `已切换模型：${model.providerId} / ${model.modelId}`
}

async function handleAgent(ctx: MessageContext, args: string, cmdCtx: CommandContext): Promise<string> {
  const agents = await adapterListAgents(cmdCtx.client)
  if (!args) {
    if (agents.length === 0) {
      return "当前没有可用 Agent"
    }

    const currentAgent = cmdCtx.sessions.getAgent(ctx.userId)
    const lines = agents.map((agent, index) => {
      const isCurrent = currentAgent === agent.id
      return `${index + 1}. ${isCurrent ? "[当前] " : ""}${agent.label}`
    })

    return ["可用 Agent：", ...lines, "回复 ag <name> 切换"].join("\n")
  }

  const normalized = args.trim().toLowerCase()
  const matched = agents.find((agent) => agent.id.toLowerCase() === normalized)
  if (!matched) {
    return `未找到 Agent：${args}`
  }

  await ensureSession(ctx.userId, cmdCtx)
  cmdCtx.sessions.setAgent(ctx.userId, matched.id)
  return `已切换 Agent：${matched.id}`
}

async function handleRename(ctx: MessageContext, args: string, cmdCtx: CommandContext): Promise<string> {
  const title = args.trim()
  if (!title) {
    return "用法：rn <新名称>"
  }

  const session = cmdCtx.sessions.getSession(ctx.userId)
  if (!session) {
    return "当前还没有会话可重命名"
  }

  try {
    await updateSessionTitle(cmdCtx.client, session.sessionId, title)
  } catch {
    // 服务端更新失败时仍更新本地，保证用户体验
  }
  cmdCtx.sessions.updateSessionTitle(ctx.userId, session.sessionId, title)
  return `已重命名当前会话：${title}`
}

async function ensureSession(userId: string, cmdCtx: CommandContext): Promise<void> {
  await cmdCtx.sessions.getOrCreate(userId)
}

function splitModelId(value: string): { providerId: string; modelId: string } | null {
  const trimmed = value.trim()
  const slashIndex = trimmed.indexOf("/")
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) return null
  const providerId = trimmed.slice(0, slashIndex).trim()
  const modelId = trimmed.slice(slashIndex + 1).trim()
  if (!providerId || !modelId) return null
  return { providerId, modelId }
}

export function buildHelpText(): string {
  return [
    "可用命令（短别名 或 /全称）：",
    "nw | /new - 创建新会话",
    "st | /stop - 停止当前 AI 运行",
    "ss | /status - 查看状态",
    "sn | /sessions - 历史会话，回复序号切换",
    "hp | /help - 查看帮助",
    "md | /model - 列出/切换模型",
    "ag | /agent - 列出/切换 Agent",
    "rn | /rename <name> - 重命名会话",
  ].join("\n")
}
