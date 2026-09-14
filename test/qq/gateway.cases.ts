import { EventEmitter } from "node:events"
import { expect, mock, test } from "bun:test"

const clearedAppIds: Array<string | undefined> = []

class FakeWebSocket extends EventEmitter {
  static readonly CONNECTING = 0
  static readonly OPEN = 1

  readonly readyState = FakeWebSocket.OPEN
  readonly sent: string[] = []

  close(): void {}
  send(data: string): void { this.sent.push(data) }
  terminate(): void {}
}

const sockets: FakeWebSocket[] = []

mock.module("ws", () => ({
  default: class extends FakeWebSocket {
    constructor(_url: string) {
      super()
      sockets.push(this)
    }
  },
}))

mock.module("../../src/qq/api.js", () => ({
  clearTokenCache: (appId?: string): void => { clearedAppIds.push(appId) },
  getAccessToken: async (): Promise<string> => "access-token",
  getGatewayUrl: async (): Promise<string> => "ws://gateway.test",
}))

const { startGateway } = await import("../../src/qq/gateway.js")

test("clears only the gateway App ID token when QQ closes with 4004", async () => {
  // Given
  const appId = "bot-a"
  const gateway = await startGateway({
    appId,
    clientSecret: "secret-a",
    sandbox: true,
    onMessage: async (): Promise<void> => {},
  })
  const socket = sockets[0]
  if (!socket) {
    throw new Error("Expected the gateway to create a WebSocket")
  }

  // When
  socket.emit("close", 4004)
  gateway.stop()

  // Then
  expect(clearedAppIds).toEqual([appId])
})

test("identifies instead of resuming a stale session after abnormal close 1006", async () => {
  const startIndex = sockets.length
  const gateway = await startGateway({
    appId: "bot-b",
    clientSecret: "secret-b",
    sandbox: true,
    onMessage: async (): Promise<void> => {},
  })
  const first = sockets[startIndex]
  if (!first) throw new Error("Expected the first WebSocket")

  first.emit("open")
  first.emit("message", JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }))
  first.emit("message", JSON.stringify({
    op: 0,
    t: "READY",
    s: 42,
    d: { session_id: "stale-session" },
  }))
  await Promise.resolve()
  first.emit("close", 1006)

  await Bun.sleep(1_100)
  const second = sockets[startIndex + 1]
  if (!second) throw new Error("Expected a reconnect WebSocket")
  second.emit("open")
  second.emit("message", JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }))
  await Promise.resolve()

  const authPayload = second.sent.map((item) => JSON.parse(item)).find((item) => item.op === 2 || item.op === 6)
  gateway.stop()

  expect(authPayload?.op).toBe(2)
})
