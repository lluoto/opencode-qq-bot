import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import {
  clearTokenCache,
  startBackgroundTokenRefresh,
  stopBackgroundTokenRefresh,
} from "../../src/qq/api.js"

const BOT_A = { appId: "bot-a", clientSecret: "secret-a" } as const
const BOT_B = { appId: "bot-b", clientSecret: "secret-b" } as const

function tokenResponse(token: string, expiresIn: number): Response {
  return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

function requestAppId(init?: RequestInit): string {
  if (typeof init?.body !== "string") {
    throw new TypeError("Expected a JSON request body")
  }

  const body: unknown = JSON.parse(init.body)
  if (typeof body !== "object" || body === null || !("appId" in body) || typeof body.appId !== "string") {
    throw new TypeError("Expected an appId in the request body")
  }
  return body.appId
}

async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  stopBackgroundTokenRefresh()
  clearTokenCache()
})

afterEach(() => {
  stopBackgroundTokenRefresh()
  clearTokenCache()
  mock.restore()
})

describe("abortable refresh sleep", () => {
  test("removes its abort listener when the timer completes", async () => {
    // Given
    const apiModule: unknown = await import("../../src/qq/api.js")
    const abortableSleep = typeof apiModule === "object" && apiModule !== null
      ? Reflect.get(apiModule, "abortableSleep")
      : undefined

    // When
    const exportType = typeof abortableSleep

    // Then
    expect(exportType).toBe("function")
    if (typeof abortableSleep !== "function") {
      return
    }

    const signal = new AbortController().signal
    const removeListener = spyOn(signal, "removeEventListener")
    await abortableSleep(0, signal)
    expect(removeListener).toHaveBeenCalledTimes(1)
  })
})

describe("scoped background refresh lifecycle", () => {
  test("keeps bot B refreshing after bot A is stopped", async () => {
    // Given
    const requestCounts = new Map<string, number>()
    let resolveSecondBotBRequest: (() => void) | undefined
    const secondBotBRequest = new Promise<void>((resolve) => {
      resolveSecondBotBRequest = resolve
    })
    spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      const appId = requestAppId(init)
      const requestCount = (requestCounts.get(appId) ?? 0) + 1
      requestCounts.set(appId, requestCount)
      if (appId === BOT_B.appId && requestCount === 2) {
        resolveSecondBotBRequest?.()
      }
      return Promise.resolve(tokenResponse(`${appId}-token-${requestCount}`, 0))
    })
    const options = { refreshAheadMs: 0, randomOffsetMs: 0, minRefreshIntervalMs: 0 } as const
    startBackgroundTokenRefresh(BOT_A.appId, BOT_A.clientSecret, options)
    startBackgroundTokenRefresh(BOT_B.appId, BOT_B.clientSecret, options)
    await flushMicrotasks()

    // When
    stopBackgroundTokenRefresh(BOT_A.appId)
    await secondBotBRequest
    const observedCounts = {
      botA: requestCounts.get(BOT_A.appId),
      botB: requestCounts.get(BOT_B.appId),
    }

    // Then
    expect(observedCounts).toEqual({ botA: 1, botB: 2 })
  })

  test("includes the App ID in every emitted refresh-loop log", async () => {
    // Given
    const messages: string[] = []
    spyOn(globalThis, "fetch").mockResolvedValue(tokenResponse("token-a", 7200))
    const log = {
      info: (message: string): void => { messages.push(message) },
      error: (message: string): void => { messages.push(message) },
      debug: (message: string): void => { messages.push(message) },
    }
    startBackgroundTokenRefresh(BOT_A.appId, BOT_A.clientSecret, { log, randomOffsetMs: 0 })
    await flushMicrotasks()

    // When
    stopBackgroundTokenRefresh(BOT_A.appId)
    await flushMicrotasks()

    // Then
    expect(messages.length).toBeGreaterThan(0)
    expect(messages.every((message) => message.includes(`appId=${BOT_A.appId}`))).toBe(true)
  })
})
