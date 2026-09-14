import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import {
  clearTokenCache,
  getAccessToken,
  startBackgroundTokenRefresh,
  stopBackgroundTokenRefresh,
} from "../../src/qq/api.js"

const BOT_A = { appId: "bot-a", clientSecret: "secret-a" } as const
const BOT_B = { appId: "bot-b", clientSecret: "secret-b" } as const

function tokenResponse(token: string, expiresIn = 7200): Response {
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

function recordTokenRequests(expiresIn = 7200): string[] {
  const requestedAppIds: string[] = []
  const requestCounts = new Map<string, number>()
  spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
    const appId = requestAppId(init)
    requestedAppIds.push(appId)
    const requestCount = (requestCounts.get(appId) ?? 0) + 1
    requestCounts.set(appId, requestCount)
    return Promise.resolve(tokenResponse(`${appId}-token-${requestCount}`, expiresIn))
  })
  return requestedAppIds
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

describe("getAccessToken per App ID", () => {
  test("keeps each App ID token cached when another bot fetches", async () => {
    // Given
    const requestedAppIds = recordTokenRequests()

    // When
    const firstA = await getAccessToken(BOT_A.appId, BOT_A.clientSecret)
    const firstB = await getAccessToken(BOT_B.appId, BOT_B.clientSecret)
    const secondA = await getAccessToken(BOT_A.appId, BOT_A.clientSecret)

    // Then
    expect({ firstA, firstB, secondA, requestedAppIds }).toEqual({
      firstA: "bot-a-token-1",
      firstB: "bot-b-token-1",
      secondA: "bot-a-token-1",
      requestedAppIds: [BOT_A.appId, BOT_B.appId],
    })
  })

  test("singleflights concurrent requests for the same App ID", async () => {
    // Given
    const requestedAppIds = recordTokenRequests()

    // When
    const tokens = await Promise.all([
      getAccessToken(BOT_A.appId, BOT_A.clientSecret),
      getAccessToken(BOT_A.appId, BOT_A.clientSecret),
    ])

    // Then
    expect({ tokens, requestedAppIds }).toEqual({
      tokens: ["bot-a-token-1", "bot-a-token-1"],
      requestedAppIds: [BOT_A.appId],
    })
  })

  test("uses independent in-flight requests for different App IDs", async () => {
    // Given
    const pendingResponses: Array<(response: Response) => void> = []
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise<Response>((resolve) => pendingResponses.push(resolve)),
    )

    // When
    const tokenAPromise = getAccessToken(BOT_A.appId, BOT_A.clientSecret)
    const tokenBPromise = getAccessToken(BOT_B.appId, BOT_B.clientSecret)
    const requestsBeforeResolution = pendingResponses.length
    for (const [index, resolve] of pendingResponses.entries()) {
      resolve(tokenResponse(index === 0 ? "token-a" : "token-b"))
    }
    const tokens = await Promise.all([tokenAPromise, tokenBPromise])

    // Then
    expect({ requestsBeforeResolution, tokens }).toEqual({
      requestsBeforeResolution: 2,
      tokens: ["token-a", "token-b"],
    })
  })

  test("clears only the requested App ID cache", async () => {
    // Given
    const requestedAppIds = recordTokenRequests()
    await getAccessToken(BOT_A.appId, BOT_A.clientSecret)
    await getAccessToken(BOT_B.appId, BOT_B.clientSecret)

    // When
    clearTokenCache(BOT_A.appId)
    const secondA = await getAccessToken(BOT_A.appId, BOT_A.clientSecret)
    const secondB = await getAccessToken(BOT_B.appId, BOT_B.clientSecret)

    // Then
    expect({ secondA, secondB, requestedAppIds }).toEqual({
      secondA: "bot-a-token-2",
      secondB: "bot-b-token-1",
      requestedAppIds: [BOT_A.appId, BOT_B.appId, BOT_A.appId],
    })
  })

  test("clears every App ID cache when no App ID is provided", async () => {
    // Given
    const requestedAppIds = recordTokenRequests()
    await getAccessToken(BOT_A.appId, BOT_A.clientSecret)
    await getAccessToken(BOT_B.appId, BOT_B.clientSecret)

    // When
    clearTokenCache()
    const secondA = await getAccessToken(BOT_A.appId, BOT_A.clientSecret)
    const secondB = await getAccessToken(BOT_B.appId, BOT_B.clientSecret)

    // Then
    expect({ secondA, secondB, requestedAppIds }).toEqual({
      secondA: "bot-a-token-2",
      secondB: "bot-b-token-2",
      requestedAppIds: [BOT_A.appId, BOT_B.appId, BOT_A.appId, BOT_B.appId],
    })
  })
})

describe("background token refresh", () => {
  test("starts an independent refresh loop for each App ID", async () => {
    // Given
    const requestedAppIds = recordTokenRequests()

    // When
    startBackgroundTokenRefresh(BOT_A.appId, BOT_A.clientSecret)
    startBackgroundTokenRefresh(BOT_B.appId, BOT_B.clientSecret)
    await flushMicrotasks()

    // Then
    expect(requestedAppIds).toEqual([BOT_A.appId, BOT_B.appId])
  })

  test("stops only the requested App ID refresh loop", async () => {
    // Given
    const requestedAppIds = recordTokenRequests(0)
    const options = { minRefreshIntervalMs: 1_000_000, randomOffsetMs: 0 } as const
    startBackgroundTokenRefresh(BOT_A.appId, BOT_A.clientSecret, options)
    startBackgroundTokenRefresh(BOT_B.appId, BOT_B.clientSecret, options)
    await flushMicrotasks()

    // When
    stopBackgroundTokenRefresh(BOT_A.appId)
    startBackgroundTokenRefresh(BOT_A.appId, BOT_A.clientSecret, options)
    await flushMicrotasks()

    // Then
    expect(requestedAppIds).toEqual([BOT_A.appId, BOT_B.appId, BOT_A.appId])
  })

  test("stops every refresh loop when no App ID is provided", async () => {
    // Given
    const requestedAppIds = recordTokenRequests(0)
    const options = { minRefreshIntervalMs: 1_000_000, randomOffsetMs: 0 } as const
    startBackgroundTokenRefresh(BOT_A.appId, BOT_A.clientSecret, options)
    startBackgroundTokenRefresh(BOT_B.appId, BOT_B.clientSecret, options)
    await flushMicrotasks()

    // When
    stopBackgroundTokenRefresh()
    startBackgroundTokenRefresh(BOT_A.appId, BOT_A.clientSecret, options)
    startBackgroundTokenRefresh(BOT_B.appId, BOT_B.clientSecret, options)
    await flushMicrotasks()

    // Then
    expect(requestedAppIds).toEqual([BOT_A.appId, BOT_B.appId, BOT_A.appId, BOT_B.appId])
  })
})
