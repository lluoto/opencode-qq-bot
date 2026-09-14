import { expect, mock, spyOn, test } from "bun:test"

interface BotCall {
  readonly appId: string
  readonly clientSecret: string
}

const refreshCalls: BotCall[] = []
const client = {
  session: {
    list: async () => ({ data: [] }),
  },
}

mock.module("../src/config.js", () => ({
  ensureConfig: async (): Promise<void> => {},
  loadConfig: () => ({
    qq: { appId: "primary", clientSecret: "primary-secret", sandbox: true },
    opencode: { baseUrl: "http://127.0.0.1", externalUrl: false },
    allowedUsers: [],
    maxReplyLength: 3000,
  }),
}))

mock.module("../src/system-time.js", () => ({
  checkSystemTime: async () => ({ ok: true }),
}))

mock.module("../src/opencode/embedded-server.js", () => ({
  createOpencodeServer: async () => ({
    url: "http://127.0.0.1:4096",
    close: (): void => {},
    forceClose: (): void => {},
    owned: true,
  }),
}))

mock.module("../src/opencode/client.js", () => ({
  createClient: () => client,
  healthCheck: async (): Promise<void> => {},
}))

mock.module("../src/opencode/events.js", () => ({
  EventRouter: class {
    async start(): Promise<void> {}
    stop(): void {}
  },
}))

mock.module("../src/opencode/sessions.js", () => ({
  SessionManager: class {},
}))

mock.module("../src/bridge.js", () => ({
  createBridge: () => ({
    handleMessage: async (): Promise<void> => {},
    hasActiveRequests: (): boolean => false,
  }),
}))

mock.module("../src/qq/gateway.js", () => ({
  startGateway: async () => ({ stop: (): void => {} }),
}))

mock.module("../src/qq/api.js", () => ({
  startBackgroundTokenRefresh: (appId: string, clientSecret: string): void => {
    refreshCalls.push({ appId, clientSecret })
  },
  stopBackgroundTokenRefresh: (): void => {},
}))

test("starts background token refresh once for every QQ_BOTS_JSON bot", async () => {
  // Given
  const previousBotsJson = process.env.QQ_BOTS_JSON
  process.env.QQ_BOTS_JSON = JSON.stringify([
    { appId: "bot-a", clientSecret: "secret-a" },
    { appId: "bot-b", clientSecret: "secret-b" },
  ])
  spyOn(globalThis, "setInterval").mockImplementation((callback, _delay) => {
    const timer = setTimeout(callback, 0)
    clearTimeout(timer)
    return timer
  })

  // When
  await import("../src/index.js")
  for (let turn = 0; turn < 50 && refreshCalls.length < 2; turn += 1) {
    await Promise.resolve()
  }

  // Then
  expect(refreshCalls).toEqual([
    { appId: "bot-a", clientSecret: "secret-a" },
    { appId: "bot-b", clientSecret: "secret-b" },
  ])

  if (previousBotsJson === undefined) {
    delete process.env.QQ_BOTS_JSON
  } else {
    process.env.QQ_BOTS_JSON = previousBotsJson
  }
})
