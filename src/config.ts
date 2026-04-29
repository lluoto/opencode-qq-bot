// @input:  process.env, ~/.openqq/.env
// @output: Config, AppConfig, loadConfig, ensureConfig
// @pos:    根层 - 环境变量加载 + 首次运行交互式引导
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { createInterface } from "readline"

export interface ModelConfig {
  providerId: string
  modelId: string
}

export interface Config {
  id: string
  qq: {
    appId: string
    clientSecret: string
    sandbox: boolean
  }
  opencode: {
    baseUrl: string
    externalUrl: boolean
    defaultModel?: ModelConfig
  }
  allowedUsers: string[]
  maxReplyLength: number
}

export interface AppConfig {
  bots: Config[]
}

interface MultiBotEnvConfig {
  id?: string
  appId?: string
  clientSecret?: string
  sandbox?: boolean
  opencodeBaseUrl?: string
  defaultModel?: string
  allowedUsers?: string[] | string
  maxReplyLength?: number
}

const CONFIG_DIR = join(homedir(), ".openqq")
const ENV_FILE = join(CONFIG_DIR, ".env")

function askTwo(q1: string, q2: string): Promise<[string, string]> {
  return new Promise((resolve, reject) => {
    let done = false
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.on("close", () => { if (!done) reject(new Error("输入被中断")) })
    rl.question(q1, (a1) => {
      rl.question(q2, (a2) => {
        done = true
        rl.close()
        resolve([a1.trim(), a2.trim()])
      })
    })
  })
}

export async function ensureConfig(): Promise<void> {
  if (hasConfigFromEnv()) return

  if (existsSync(ENV_FILE)) {
    loadEnvFile(ENV_FILE)
    if (hasConfigFromEnv()) return
  }

  const localEnv = join(process.cwd(), ".env")
  if (existsSync(localEnv)) {
    loadEnvFile(localEnv)
    if (hasConfigFromEnv()) return
  }

  console.log("首次运行，需要配置 QQ 机器人凭证")
  console.log("(从 https://q.qq.com 机器人管理 -> 开发设置 获取)\n")

  const [appId, appSecret] = await askTwo("QQ App ID: ", "QQ App Secret: ")

  if (!appId || !appSecret) {
    throw new Error("App ID 和 App Secret 不能为空")
  }

  mkdirSync(CONFIG_DIR, { recursive: true })
  const envContent = [
    `QQ_APP_ID=${appId}`,
    `QQ_APP_SECRET=${appSecret}`,
    `QQ_SANDBOX=false`,
    `# OPENCODE_BASE_URL=http://localhost:4096`,
    `# OPENCODE_DEFAULT_MODEL=openai/gpt-5.4`,
    `# QQ_BOTS_JSON=[]`,
    `ALLOWED_USERS=`,
    `MAX_REPLY_LENGTH=3000`,
  ].join("\n") + "\n"

  writeFileSync(ENV_FILE, envContent)
  console.log(`\n配置已保存到 ${ENV_FILE}`)

  process.env.QQ_APP_ID = appId
  process.env.QQ_APP_SECRET = appSecret
}

function hasConfigFromEnv(): boolean {
  return !!process.env.QQ_BOTS_JSON?.trim() || !!(process.env.QQ_APP_ID && process.env.QQ_APP_SECRET)
}

function loadEnvFile(path: string): void {
  const content = readFileSync(path, "utf-8")
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eqIdx = trimmed.indexOf("=")
    if (eqIdx < 0) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim()
    if (!process.env[key]) {
      process.env[key] = val
    }
  }
}

export function loadConfig(): AppConfig {
  const globalAllowedUsers = parseAllowedUsers(process.env.ALLOWED_USERS)
  const globalMaxReplyLength = parseMaxReplyLength(process.env.MAX_REPLY_LENGTH)
  const multiBotRaw = process.env.QQ_BOTS_JSON?.trim()

  if (multiBotRaw) {
    return {
      bots: parseMultiBotConfig(multiBotRaw, globalAllowedUsers, globalMaxReplyLength),
    }
  }

  const appId = process.env.QQ_APP_ID
  const clientSecret = process.env.QQ_APP_SECRET

  if (!appId) throw new Error("缺少 QQ_APP_ID，运行 openqq 重新配置")
  if (!clientSecret) throw new Error("缺少 QQ_APP_SECRET，运行 openqq 重新配置")

  return {
    bots: [
      {
        id: appId,
        qq: {
          appId,
          clientSecret,
          sandbox: process.env.QQ_SANDBOX === "true",
        },
        opencode: {
          baseUrl: process.env.OPENCODE_BASE_URL?.trim() || "",
          externalUrl: !!process.env.OPENCODE_BASE_URL?.trim(),
          defaultModel: parseModelId(process.env.OPENCODE_DEFAULT_MODEL),
        },
        allowedUsers: globalAllowedUsers,
        maxReplyLength: globalMaxReplyLength,
      },
    ],
  }
}

function parseMultiBotConfig(raw: string, globalAllowedUsers: string[], globalMaxReplyLength: number): Config[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`QQ_BOTS_JSON 不是合法 JSON：${toErrorMessage(error)}`)
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("QQ_BOTS_JSON 必须是非空数组")
  }

  return parsed.map((item, index) => toBotConfig(item, index, globalAllowedUsers, globalMaxReplyLength))
}

function toBotConfig(item: unknown, index: number, globalAllowedUsers: string[], globalMaxReplyLength: number): Config {
  if (!item || typeof item !== "object") {
    throw new Error(`QQ_BOTS_JSON[${index}] 必须是对象`)
  }

  const bot = item as MultiBotEnvConfig
  const appId = typeof bot.appId === "string" ? bot.appId.trim() : ""
  const clientSecret = typeof bot.clientSecret === "string" ? bot.clientSecret.trim() : ""
  if (!appId) {
    throw new Error(`QQ_BOTS_JSON[${index}] 缺少 appId`)
  }
  if (!clientSecret) {
    throw new Error(`QQ_BOTS_JSON[${index}] 缺少 clientSecret`)
  }

  const baseUrl = typeof bot.opencodeBaseUrl === "string" ? bot.opencodeBaseUrl.trim() : ""
  const defaultModel = parseModelId(bot.defaultModel)
  const allowedUsers = bot.allowedUsers === undefined
    ? globalAllowedUsers
    : parseAllowedUsers(bot.allowedUsers)
  const maxReplyLength = typeof bot.maxReplyLength === "number"
    ? bot.maxReplyLength
    : globalMaxReplyLength

  return {
    id: typeof bot.id === "string" && bot.id.trim() ? bot.id.trim() : appId,
    qq: {
      appId,
      clientSecret,
      sandbox: bot.sandbox === true,
    },
    opencode: {
      baseUrl,
      externalUrl: !!baseUrl,
      defaultModel,
    },
    allowedUsers,
    maxReplyLength,
  }
}

function parseAllowedUsers(value: string[] | string | undefined): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean)
  }
  const raw = value?.trim() ?? ""
  return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : []
}

function parseMaxReplyLength(value: string | undefined): number {
  const parsed = parseInt(value ?? "3000", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3000
}

function parseModelId(value: string | undefined): ModelConfig | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  const slashIndex = trimmed.indexOf("/")
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    throw new Error(`模型格式不对：${trimmed}，请使用 provider/model`)
  }
  return {
    providerId: trimmed.slice(0, slashIndex).trim(),
    modelId: trimmed.slice(slashIndex + 1).trim(),
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
