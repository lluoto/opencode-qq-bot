// @input:  ./config, ./opencode/*, ./qq/*, ./bridge, @opencode-ai/sdk (createOpencodeServer)
// @output: (side-effect) 启动 Bot 进程
// @pos:    根层 - 入口: 启动编排 + 优雅关闭
import type { Config } from "./config.js"
import { loadConfig, ensureConfig } from "./config.js"
import { createClient, healthCheck } from "./opencode/client.js"
import { EventRouter } from "./opencode/events.js"
import { SessionManager } from "./opencode/sessions.js"
import { startGateway } from "./qq/gateway.js"
import { startBackgroundTokenRefresh, stopBackgroundTokenRefresh } from "./qq/token.js"
import { createBridge } from "./bridge.js"

interface RuntimeControl {
  botId: string
  stop: () => void
}

async function main(): Promise<void> {
  await ensureConfig()
  const appConfig = loadConfig()

  let serverClose: (() => void) | null = null
  let embeddedBaseUrl = ""

  const startEmbeddedServer = async (): Promise<void> => {
    const { createOpencodeServer } = await import("@opencode-ai/sdk")
    const server = await createOpencodeServer({ port: 4096 })
    embeddedBaseUrl = server.url
    serverClose = server.close
    console.log(`[index] opencode serve 已启动: ${server.url}`)
  }

  if (appConfig.bots.some((bot) => !bot.opencode.externalUrl)) {
    await startEmbeddedServer()
  }

  const runtimes: RuntimeControl[] = []

  for (const botConfig of appConfig.bots) {
    const runtime = await startBotRuntime(botConfig, embeddedBaseUrl)
    runtimes.push(runtime)
  }

  console.log(`[index] OpenCode QQ Bot 已启动，共 ${runtimes.length} 个机器人实例`)

  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[index] 收到 ${signal}，开始退出...`)

    for (const runtime of runtimes) {
      runtime.stop()
    }

    serverClose?.()
    setTimeout(() => process.exit(0), 0)
  }

  process.once("SIGINT", () => shutdown("SIGINT"))
  process.once("SIGTERM", () => shutdown("SIGTERM"))
}

async function startBotRuntime(config: Config, embeddedBaseUrl: string): Promise<RuntimeControl> {
  const baseUrl = config.opencode.externalUrl ? config.opencode.baseUrl : embeddedBaseUrl
  if (!baseUrl) {
    throw new Error(`[${config.id}] 未找到可用的 OpenCode server 地址`)
  }

  const client = createClient(baseUrl)
  try {
    await healthCheck(client)
  } catch (error) {
    if (config.opencode.externalUrl) {
      throw new Error(
        `[${config.id}] 外部 OpenCode 不可达：${toErrorMessage(error)}\n` +
        `当前配置的 OPENCODE_BASE_URL=${baseUrl}\n` +
        `请先确认该地址上已经启动可访问的 OpenCode server，再重新运行 openqq。`,
      )
    }
    throw error
  }

  startBackgroundTokenRefresh(config.qq.appId, config.qq.clientSecret)

  const router = new EventRouter(client)
  await router.start()

  const sessions = new SessionManager(client, config.opencode.defaultModel)
  const bridge = createBridge(config, client, router, sessions)

  const gateway = await startGateway({
    appId: config.qq.appId,
    clientSecret: config.qq.clientSecret,
    onMessage: bridge.handleMessage,
    onReady: () => {
      console.log(`[index][${config.id}] QQ Gateway 已就绪`)
    },
  })

  console.log(`[index][${config.id}] Bot runtime 已启动，OpenCode=${baseUrl}`)

  return {
    botId: config.id,
    stop: () => {
      gateway.stop()
      router.stop()
      stopBackgroundTokenRefresh(config.qq.appId)
    },
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

main().catch((error) => {
  console.error("[index] 启动失败:", error)
  stopBackgroundTokenRefresh()
  process.exit(1)
})
