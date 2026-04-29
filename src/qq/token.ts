// @input:  (none - QQ Bot Token endpoints)
// @output: getAccessToken, clearTokenCache, getTokenStatus, startBackgroundTokenRefresh, stopBackgroundTokenRefresh
// @pos:    qq层 - QQ Bot Token 鉴权 (缓存 + singleflight + 后台刷新)

import { QQApiError } from "./http.js"

const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken"
const DEBUG = process.env.DEBUG_QQ_API === "true"

interface CachedToken {
  token: string
  expiresAt: number
}

interface BackgroundTokenRefreshOptions {
  refreshAheadMs?: number
  randomOffsetMs?: number
  minRefreshIntervalMs?: number
  retryDelayMs?: number
  log?: {
    info: (msg: string) => void
    error: (msg: string) => void
    debug?: (msg: string) => void
  }
}

const cachedTokens = new Map<string, CachedToken>()
const tokenFetchPromises = new Map<string, Promise<string>>()
const backgroundRefreshAbortControllers = new Map<string, AbortController>()

/**
 * 获取 AccessToken，内置缓存与 singleflight 并发保护。
 * 当多个请求同时发现 Token 过期时，只会发起一次真实刷新请求。
 */
export async function getAccessToken(appId: string, clientSecret: string): Promise<string> {
  const cachedToken = cachedTokens.get(appId)
  if (cachedToken && Date.now() < cachedToken.expiresAt - 5 * 60 * 1000) {
    return cachedToken.token
  }

  const existingFetch = tokenFetchPromises.get(appId)
  if (existingFetch) {
    return existingFetch
  }

  const fetchPromise = (async () => {
    try {
      return await doFetchToken(appId, clientSecret)
    } finally {
      tokenFetchPromises.delete(appId)
    }
  })()

  tokenFetchPromises.set(appId, fetchPromise)
  return fetchPromise
}

/**
 * 真正执行 Token 获取的内部函数。
 */
async function doFetchToken(appId: string, clientSecret: string): Promise<string> {
  const requestBody = { appId, clientSecret }
  const requestHeaders = { "Content-Type": "application/json" }

  if (DEBUG) {
    console.log(`[qqbot-api] >>> POST ${TOKEN_URL}`)
    console.log("[qqbot-api] >>> Headers:", JSON.stringify(requestHeaders, null, 2))
    console.log("[qqbot-api] >>> Body:", JSON.stringify({ appId, clientSecret: "***" }, null, 2))
  }

  let response: Response
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(requestBody),
    })
  } catch (err) {
    console.error("[qqbot-api] Token refresh failed (network error):", err instanceof Error ? err.message : String(err))
    throw new Error(`Network error getting access_token: ${err instanceof Error ? err.message : String(err)}`)
  }

  let data: { access_token?: string; expires_in?: number }
  let rawBody: string
  try {
    rawBody = await response.text()
    data = JSON.parse(rawBody) as { access_token?: string; expires_in?: number }
  } catch (err) {
    console.error("[qqbot-api] Token refresh failed (parse error):", err instanceof Error ? err.message : String(err))
    throw new Error(`Failed to parse access_token response: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (DEBUG) {
    const logBody = rawBody.replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token": "***"')
    console.log(`[qqbot-api] <<< Status: ${response.status} ${response.statusText}`)
    console.log("[qqbot-api] <<< Body:", logBody)
  }

  if (!data.access_token) {
    throw new QQApiError({
      message: `Failed to get access_token: ${JSON.stringify(data)}`,
      path: "/app/getAppAccessToken",
      status: response.status,
      code: (data as { code?: number }).code,
      authFailure: response.status === 401 || response.status === 403,
      source: "token",
    })
  }

  const cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
  }
  cachedTokens.set(appId, cachedToken)

  console.log(`[qqbot-api] Token refreshed (${appId}), expires at: ${new Date(cachedToken.expiresAt).toISOString()}`)
  return cachedToken.token
}

/**
 * 清空当前 Token 缓存。
 * 不会中断已经在进行中的刷新请求。
 */
export function clearTokenCache(appId?: string): void {
  if (appId) {
    cachedTokens.delete(appId)
    return
  }
  cachedTokens.clear()
}

/**
 * 获取当前 Token 缓存状态，便于监控或启动阶段打印状态。
 */
export function getTokenStatus(appId: string): { status: "valid" | "expired" | "refreshing" | "none"; expiresAt: number | null } {
  const cachedToken = cachedTokens.get(appId)
  if (tokenFetchPromises.has(appId)) {
    return { status: "refreshing", expiresAt: cachedToken?.expiresAt ?? null }
  }
  if (!cachedToken) {
    return { status: "none", expiresAt: null }
  }
  const isValid = Date.now() < cachedToken.expiresAt - 5 * 60 * 1000
  return { status: isValid ? "valid" : "expired", expiresAt: cachedToken.expiresAt }
}

/**
 * 启动后台 Token 刷新循环。
 * 它会在 Token 过期前提前刷新，避免真正发消息时才发现 Token 已失效。
 */
export function startBackgroundTokenRefresh(
  appId: string,
  clientSecret: string,
  options?: BackgroundTokenRefreshOptions,
): void {
  if (backgroundRefreshAbortControllers.has(appId)) {
    console.log(`[qqbot-api] Background token refresh already running (${appId})`)
    return
  }

  const {
    refreshAheadMs = 5 * 60 * 1000,
    randomOffsetMs = 30 * 1000,
    minRefreshIntervalMs = 60 * 1000,
    retryDelayMs = 5 * 1000,
    log,
  } = options ?? {}

  const abortController = new AbortController()
  backgroundRefreshAbortControllers.set(appId, abortController)
  const signal = abortController.signal

  const refreshLoop = async () => {
    log?.info?.(`[qqbot-api] Background token refresh started (${appId})`)

    while (!signal.aborted) {
      try {
        await getAccessToken(appId, clientSecret)

        const cachedToken = cachedTokens.get(appId)
        if (cachedToken) {
          const expiresIn = cachedToken.expiresAt - Date.now()
          const randomOffset = Math.random() * randomOffsetMs
          const refreshIn = Math.max(
            expiresIn - refreshAheadMs - randomOffset,
            minRefreshIntervalMs,
          )

          log?.debug?.(`[qqbot-api] Token valid (${appId}), next refresh in ${Math.round(refreshIn / 1000)}s`)
          await sleep(refreshIn, signal)
        } else {
          log?.debug?.(`[qqbot-api] No cached token (${appId}), retrying soon`)
          await sleep(minRefreshIntervalMs, signal)
        }
      } catch (err) {
        if (signal.aborted) break

        log?.error?.(`[qqbot-api] Background token refresh failed (${appId}): ${err}`)
        await sleep(retryDelayMs, signal)
      }
    }

    backgroundRefreshAbortControllers.delete(appId)
    log?.info?.(`[qqbot-api] Background token refresh stopped (${appId})`)
  }

  refreshLoop().catch((err) => {
    backgroundRefreshAbortControllers.delete(appId)
    log?.error?.(`[qqbot-api] Background token refresh crashed (${appId}): ${err}`)
  })
}

/**
 * 停止后台 Token 刷新循环。
 */
export function stopBackgroundTokenRefresh(appId?: string): void {
  if (appId) {
    const abortController = backgroundRefreshAbortControllers.get(appId)
    abortController?.abort()
    backgroundRefreshAbortControllers.delete(appId)
    return
  }

  for (const abortController of backgroundRefreshAbortControllers.values()) {
    abortController.abort()
  }
  backgroundRefreshAbortControllers.clear()
}

/**
 * 可被 AbortSignal 中断的 sleep，供后台刷新循环复用。
 */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve()
    }, ms)

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer)
        reject(new Error("Aborted"))
        return
      }

      const onAbort = () => {
        clearTimeout(timer)
        reject(new Error("Aborted"))
      }

      signal.addEventListener("abort", onAbort, { once: true })
    }
  })
}
