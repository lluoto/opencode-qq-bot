// @input:  @opencode-ai/sdk (Event, SSE stream), ./client (OpencodeClient)
// @output: EventRouter, EventCallback
// @pos:    opencode层 - 全局 SSE 事件订阅 + 按 sessionId 分发
import type { OpencodeClient } from "./client.js"
import type { Event } from "@opencode-ai/sdk"

export type EventCallback = (event: Event) => void

const LOGGED_EVENT_TYPES = new Set([
  "session.idle", "session.error", "session.status", "session.compacted",
  "question.asked", "question.replied", "question.rejected",
  "permission.asked", "permission.replied",
])

export class EventRouter {
  private listeners = new Map<string, EventCallback>()
  private globalListeners = new Set<EventCallback>()
  private running = false
  private abortController: AbortController | null = null
  private client: OpencodeClient

  private consecutiveErrors = 0
  private lastSuccessfulConnection = 0
  private lastEventAt = 0
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

  onEvent(callback: EventCallback): () => void {
    this.globalListeners.add(callback)
    return () => this.globalListeners.delete(callback)
  }

  isHealthy(): boolean {
    return !this.isReconnecting && this.consecutiveErrors < 3
  }

  isStale(maxIdleMs: number): boolean {
    return this.running && this.lastEventAt > 0 && Date.now() - this.lastEventAt > maxIdleMs
  }

  forceReconnect(reason: string): void {
    if (!this.running || this.isReconnecting) return
    console.warn(`[events] Forcing SSE reconnect: ${reason}`)
    this.isReconnecting = true
    this.abortController?.abort()
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
        this.lastEventAt = Date.now()
        console.log("[events] 已连接事件流")

        for await (const event of result.stream) {
          if (!this.running) break

          this.lastEventAt = Date.now()
          // Plugin/catalog churn is noisy; preserve only events relevant to a user request.
          const eventType = String(event.type)
          if (LOGGED_EVENT_TYPES.has(eventType)) {
            console.log("[events] 事件:", eventType, "sessionID:", (event.properties as any).sessionID)
          }

          for (const callback of this.globalListeners) callback(event)

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
    const directSessionId = typeof props.sessionID === "string" ? props.sessionID : undefined

    switch (String(event.type)) {
      case "session.created":
      case "session.updated":
      case "session.diff":
      case "message.part.updated":
      case "message.part.delta":
      case "message.part.removed":
        return directSessionId
      case "message.updated":
        return directSessionId ?? props.info?.sessionID
      case "session.idle":
      case "session.compacted":
      case "session.status":
      case "session.error":
      case "permission.asked":
      case "permission.updated":
      case "permission.replied":
      case "question.asked":
      case "question.replied":
      case "question.rejected":
      case "message.removed":
        return directSessionId
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
