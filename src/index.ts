// @input:  ./config, ./opencode/*, ./qq/*, ./bridge, @opencode-ai/sdk (createOpencodeServer)
// @output: (side-effect) 启动 Bot 进程
// @pos:    根层 - 入口: 启动编排 + 优雅关闭
import { loadConfig, ensureConfig } from "./config.js"
import { createClient, healthCheck } from "./opencode/client.js"
import { EventRouter } from "./opencode/events.js"
import { SessionManager } from "./opencode/sessions.js"
import { startGateway } from "./qq/gateway.js"
import { startBackgroundTokenRefresh, stopBackgroundTokenRefresh } from "./qq/token.js"
import { createBridge } from "./bridge.js"

async function main(): Promise<void> {
  await ensureConfig()
  const config = loadConfig()

  let serverClose: (() => void) | null = null

  const startEmbeddedServer = async (): Promise<void> => {
    const { createOpencodeServer } = await import("@opencode-ai/sdk")
    const server = await createOpencodeServer({ port: 4096 })
    config.opencode.baseUrl = server.url
    serverClose = server.close
    console.log(`[index] opencode serve 已启动: ${server.url}`)
  }

  if (!config.opencode.externalUrl) {
    await startEmbeddedServer()
  }

  const client = createClient(config.opencode.baseUrl)
  try {
    await healthCheck(client)
  } catch (error) {
    if (config.opencode.externalUrl) {
      throw new Error(
        `外部 OpenCode 不可达：${toErrorMessage(error)}\n` +
        `当前配置的 OPENCODE_BASE_URL=${config.opencode.baseUrl}\n` +
        `请先确认该地址上已经启动可访问的 OpenCode server，再重新运行 openqq。`,
      )
    }
    throw error
  }

  startBackgroundTokenRefresh(config.qq.appId, config.qq.clientSecret)

  const router = new EventRouter(client)
  await router.start()

  const sessions = new SessionManager(client)
  const bridge = createBridge(config, client, router, sessions)

  const gateway = await startGateway({
    appId: config.qq.appId,
    clientSecret: config.qq.clientSecret,
    onMessage: bridge.handleMessage,
    onReady: () => {
      console.log("[index] QQ Gateway 已就绪")
    },
  })

  console.log("[index] OpenCode QQ Bot 已启动")

  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[index] 收到 ${signal}，开始退出...`)
    gateway.stop()
    router.stop()
    stopBackgroundTokenRefresh()
    serverClose?.()
    setTimeout(() => process.exit(0), 0)
  }

  process.once("SIGINT", () => shutdown("SIGINT"))
  process.once("SIGTERM", () => shutdown("SIGTERM"))
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

main().catch((error) => {
  console.error("[index] 启动失败:", error)
  stopBackgroundTokenRefresh()
  process.exit(1)
})
