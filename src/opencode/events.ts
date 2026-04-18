// @input:  @opencode-ai/sdk (Event, SSE stream), ./client (OpencodeClient)
// @output: EventRouter, EventCallback
// @pos:    opencode层 - 全局 SSE 事件订阅 + 按 sessionId 分发
import type { OpencodeClient } from "./client.js"
import type { Event } from "@opencode-ai/sdk"

export type EventCallback = (event: Event) => void

export class EventRouter {
  private listeners = new Map<string, EventCallback>()
  private running = false
  private abortController: AbortController | null = null
  private client: OpencodeClient
  
  private consecutiveErrors = 0
  private lastSuccessfulConnection = 0
  private isReconnecting = false
  private onReconnect: (() => void) | null = null

  constructor(client: OpencodeClient) {
    this.client = client
  }

  setReconnectCallback(cb: () => void): void {
    this.onReconnect = cb
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.consume()
  }

  stop(): void {
    this.running = false
    this.abortController?.abort()
    this.abortController = null
    this.isReconnecting = false
    this.consecutiveErrors = 0
  }

  register(sessionId: string, callback: EventCallback): void {
    this.listeners.set(sessionId, callback)
  }

  unregister(sessionId: string): void {
    this.listeners.delete(sessionId)
  }

  isHealthy(): boolean {
    return !this.isReconnecting && this.consecutiveErrors < 3
  }

  private async consume(): Promise<void> {
    while (this.running) {
      try {
        this.abortController = new AbortController()
        
        console.log("[events] 连接事件流...")
        const result = await this.client.event.subscribe()
        
        this.consecutiveErrors = 0
        this.isReconnecting = false
        this.lastSuccessfulConnection = Date.now()
        console.log("[events] 已连接事件流")
        
        for await (const event of result.stream) {
          if (!this.running) break

          // Only log important events, not heartbeat
          if (event.type !== "server.heartbeat") {
            console.log("[events] 事件:", event.type, "sessionID:", (event.properties as any).sessionID)
          }

          const sessionId = this.extractSessionId(event)

          if (sessionId) {
            const cb = this.listeners.get(sessionId)
            if (cb) cb(event)
          }
        }
      } catch (err) {
        if (!this.running) break
        
        this.consecutiveErrors++
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[events] 连接错误 (${this.consecutiveErrors}x): ${msg.substring(0, 100)}`)
        
        if (this.consecutiveErrors >= 3 && this.onReconnect) {
          console.log("[events] 触发重连回调")
          this.onReconnect()
        }
        
        await this.backoff()
      }
    }
  }

  private extractSessionId(event: Event): string | undefined {
    const props = event.properties as any
    
    switch (event.type) {
      case "message.part.updated":
        return props.sessionID
      case "message.updated":
        return props.info?.sessionID
      case "session.idle":
      case "session.compacted":
      case "session.status":
      case "session.error":
      case "permission.updated":
      case "permission.replied":
      case "message.removed":
        return props.sessionID
      default:
        return undefined
    }
  }

  private reconnectDelay = 1000
  private async backoff(): Promise<void> {
    this.isReconnecting = true
    
    const timeSinceSuccess = Date.now() - this.lastSuccessfulConnection
    if (timeSinceSuccess < 5 * 60 * 1000 && this.reconnectDelay > 1000) {
      this.reconnectDelay = 1000
    }
    
    const delay = this.reconnectDelay
    console.log(`[events] ${delay}ms 后重连...`)
    await new Promise((r) => setTimeout(r, delay))
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000)
  }

  resetBackoff(): void {
    this.reconnectDelay = 1000
    this.consecutiveErrors = 0
    this.isReconnecting = false
  }
}
