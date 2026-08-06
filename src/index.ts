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
let bridge: ReturnType<typeof createBridge> | null = null
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

    // 清理子 agent session（parentID 不为空的），保留用户会话
    try {
      const sessions = await client.session.list()
      const items = sessions.data ?? []
      const subSessions = (items as any[]).filter((s: any) => s.parentID || s.parentId)
      if (subSessions.length > 0) {
        console.log(`[index] 清理 ${subSessions.length} 个子 agent 会话 (共 ${items.length} 个)`)
        for (const s of subSessions) {
          try { await client.session.abort({ path: { id: s.id } }) } catch {}
        }
        console.log("[index] 子 agent 会话已清理")
      }
    } catch (e: any) {
      console.log("[index] 跳过会话清理:", e?.message ?? e)
    }

    router = new EventRouter(client)
    await router.start()

    // 解析 QQ_BOTS_JSON 获取多 bot 配置
    let bots = [{ appId: config.qq.appId, clientSecret: config.qq.clientSecret, defaultModel:"" }]
    try {
      if (process.env.QQ_BOTS_JSON) {
        const parsed = JSON.parse(process.env.QQ_BOTS_JSON)
        if (Array.isArray(parsed) && parsed.length > 0) {
          bots = parsed.map((b: any) => ({
            appId: b.appId || b.id,
            clientSecret: b.clientSecret,
            defaultModel: b.defaultModel || "",
            sandbox: b.sandbox || false,
          }))
          console.log(`[index] 从 QQ_BOTS_JSON 加载 ${bots.length} 个 bot`)
        }
      }
    } catch {
      console.log("[index] QQ_BOTS_JSON 解析失败，使用默认单 bot")
    }

    // 为每个 bot 启动 gateway
    const gateways: any[] = []
    for (const bot of bots) {
      const botConfig = { appId: bot.appId, clientSecret: bot.clientSecret, sandbox: bot.sandbox || false }
      const botSessions = new SessionManager(client, bot.defaultModel || undefined)
      const botBridge = createBridge(config, client, router, botSessions, botConfig)

      const botGateway = await startGateway({
        appId: bot.appId,
        clientSecret: bot.clientSecret,
        sandbox: botConfig.sandbox,
        onMessage: botBridge.handleMessage,
        onReady: () => {
          console.log(`[index] QQ Gateway 已就绪 (${bot.appId})`)
        },
      })
      gateways.push(botGateway)
      console.log(`[index] Bot ${bot.appId} 已启动${bot.defaultModel ? ` (默认: ${bot.defaultModel})` : ""}`)
    }

    // 保存引用用于关闭和健康检查
    gateway = { stop: () => gateways.forEach(g => g.stop()) }
    sessions = new SessionManager(client, bots[0]?.defaultModel || undefined)
    bridge = createBridge(config, client, router, sessions)

    consecutiveFailures = 0
    console.log("[index] OpenCode QQ Bot 已启动")
    console.log(`[index] TUI attach 地址: ${process.env.OPENCODE_TUI_ATTACH_URL || config.opencode.baseUrl}`)
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
    bridge = null
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

  // 崩溃防护：bun 默认遇到 unhandledRejection 直接退出进程。
  // 任何一次遗漏的 Promise catch 都会让整个 bot 消失——这里兜底记录日志。
  process.on("unhandledRejection", (reason) => {
    console.error("[index] unhandledRejection:", reason instanceof Error ? reason.stack ?? reason.message : String(reason))
  })
  process.on("uncaughtException", (error) => {
    console.error("[index] uncaughtException:", error.stack ?? error.message)
  })

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
    if (bridge?.hasActiveRequests()) {
      console.log("[index] 跳过健康检查：当前有请求处理中")
      return
    }
    
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

  // 内存看门狗：Windows 检测到虚拟内存耗尽会强杀进程（历史根因）。
  // bot 自身堆超过 6GB 时主动重启，避免被系统 OOM-kill 导致孤儿进程。
  const MEMORY_WATCH_INTERVAL_MS = 60_000
  const MEMORY_LIMIT_BYTES = 6 * 1024 * 1024 * 1024
  setInterval(() => {
    if (isShuttingDown) return
    const mem = process.memoryUsage().rss
    if (mem > MEMORY_LIMIT_BYTES) {
      console.error(`[index] 内存超过 ${MEMORY_LIMIT_BYTES / 1e9}GB (${(mem / 1e9).toFixed(2)}GB)，主动重启避免被系统强杀`)
      restartServer()
    }
  }, MEMORY_WATCH_INTERVAL_MS)
}

main().catch((error) => {
  console.error("[index] 启动失败:", error)
  stopBackgroundTokenRefresh()
  process.exit(1)
})
