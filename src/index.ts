// @input:  ./config, ./opencode/*, ./qq/*, ./bridge
// @output: (side-effect) 启动 Bot 进程
// @pos:    根层 - 入口: 启动编排 + 优雅关闭
import { loadConfig, ensureConfig } from "./config.js"
import { createClient, healthCheck } from "./opencode/client.js"
import { EventRouter } from "./opencode/events.js"
import { SessionManager } from "./opencode/sessions.js"
import { startGateway } from "./qq/gateway.js"
import { startBackgroundTokenRefresh, stopBackgroundTokenRefresh } from "./qq/api.js"
import { createBridge } from "./bridge.js"
import { createOpencodeServer } from "./opencode/embedded-server.js"

let serverClose: (() => void) | null = null
let client: any = null
let router: EventRouter | null = null
let sessions: SessionManager | null = null
let config: any = null
let gateway: any = null
let isShuttingDown = false
let consecutiveFailures = 0

async function startServer(): Promise<boolean> {
  if (isShuttingDown) return false
  
  try {
    console.log("[index] 启动 OpenCode 服务器...")
    const server = await createOpencodeServer({ port: 4096 })
    config.opencode.baseUrl = server.url
    serverClose = server.close
    console.log(`[index] OpenCode 服务器已启动: ${server.url}`)
    
    client = createClient(config.opencode.baseUrl)
    
    for (let i = 0; i < 10; i++) {
      try {
        await healthCheck(client, 3000)
        break
      } catch (e) {
        if (i === 9) throw e
        console.log(`[index] 等待服务器就绪 (${i + 1}/10)...`)
        await new Promise(r => setTimeout(r, 2000))
      }
    }
    console.log("[index] OpenCode 连接成功")

    router = new EventRouter(client)
    await router.start()

    sessions = new SessionManager(client)
    const bridge = createBridge(config, client, router, sessions)

    gateway = await startGateway({
      appId: config.qq.appId,
      clientSecret: config.qq.clientSecret,
      onMessage: bridge.handleMessage,
      onReady: () => {
        console.log("[index] QQ Gateway 已就绪")
      },
    })

    consecutiveFailures = 0
    console.log("[index] OpenCode QQ Bot 已启动")
    return true
  } catch (error) {
    console.error("[index] 启动失败:", error)
    consecutiveFailures++
    return false
  }
}

async function restartServer(): Promise<void> {
  if (isShuttingDown) return
  
  console.log("[index] 准备重启...")
  
  try {
    if (gateway) { gateway.stop(); gateway = null }
    if (router) { router.stop(); router = null }
    if (serverClose) { serverClose(); serverClose = null }
    client = null
  } catch (e) {
    console.error("[index] 清理失败:", e)
  }
  
  const delay = Math.min(5000 * consecutiveFailures, 30000)
  console.log(`[index] ${delay}ms 后重启...`)
  await new Promise(r => setTimeout(r, delay))
  
  consecutiveFailures++
  await startServer()
}

async function main(): Promise<void> {
  await ensureConfig()
  config = loadConfig()

  const started = await startServer()
  if (!started) {
    console.error("[index] 初始启动失败，5秒后重试...")
    await new Promise(r => setTimeout(r, 5000))
    await startServer()
  }

  startBackgroundTokenRefresh(config.qq.appId, config.qq.clientSecret)

  isShuttingDown = false
  const shutdown = (signal: string): void => {
    if (isShuttingDown) return
    isShuttingDown = true
    console.log(`[index] 收到 ${signal}，开始退出...`)
    if (gateway) gateway.stop()
    if (router) router.stop()
    stopBackgroundTokenRefresh()
    if (serverClose) serverClose()
    setTimeout(() => process.exit(0), 0)
  }

  process.once("SIGINT", () => shutdown("SIGINT"))
  process.once("SIGTERM", () => shutdown("SIGTERM"))
  
  setInterval(async () => {
    if (isShuttingDown || !client) return
    
    try {
      await client.session.list()
      consecutiveFailures = 0
    } catch (error) {
      console.error("[index] 健康检查失败:", error instanceof Error ? error.message : String(error))
      consecutiveFailures++
      
      if (consecutiveFailures >= 3) {
        console.error("[index] 连续失败次数过多，准备重启...")
        restartServer()
      }
    }
  }, 30000)
}

main().catch((error) => {
  console.error("[index] 启动失败:", error)
  stopBackgroundTokenRefresh()
  process.exit(1)
})