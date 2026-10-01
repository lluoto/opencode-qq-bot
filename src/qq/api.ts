// @input:  (none - raw HTTP to QQ Bot REST API)
// @output: getAccessToken, apiRequest, sendC2CMessage, sendGroupMessage, getGatewayUrl, startBackgroundTokenRefresh
// @pos:    qq层 - QQ Bot REST API 鉴权+请求封装 (Token singleflight + 后台刷新)

const API_BASE = process.env.QQ_SANDBOX === "true"
  ? "https://sandbox.api.sgroup.qq.com"
  : "https://api.sgroup.qq.com"

function getApiBase(sandbox?: boolean): string {
  if (sandbox !== undefined) {
    return sandbox ? "https://sandbox.api.sgroup.qq.com" : "https://api.sgroup.qq.com"
  }
  return API_BASE
}
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken"

interface CachedToken {
  token: string
  expiresAt: number
}

const cachedTokens = new Map<string, CachedToken>()
// Singleflight：防止并发获取 Token 时重复请求
const tokenFetchPromises = new Map<string, Promise<string>>()

/**
 * 获取 AccessToken，内置缓存与 singleflight 并发保护。
 * 当多个请求同时发现 Token 过期时，只会发起一次真实刷新请求。
 */
export async function getAccessToken(appId: string, clientSecret: string): Promise<string> {
  const cachedToken = cachedTokens.get(appId)
  if (cachedToken && Date.now() < cachedToken.expiresAt - 5 * 60 * 1000) {
    return cachedToken.token
  }

  const tokenFetchPromise = tokenFetchPromises.get(appId)
  if (tokenFetchPromise) {
    console.log(`[qqbot-api] Token fetch in progress for appId=${appId}, waiting for existing request...`)
    return tokenFetchPromise
  }

  const newTokenFetchPromise = (async () => {
    try {
      return await doFetchToken(appId, clientSecret)
    } finally {
      tokenFetchPromises.delete(appId)
    }
  })()
  tokenFetchPromises.set(appId, newTokenFetchPromise)

  return newTokenFetchPromise
}

/**
 * 真正执行 Token 获取的内部函数。
 */
async function doFetchToken(appId: string, clientSecret: string): Promise<string> {
  const requestBody = { appId, clientSecret }
  const requestHeaders = { "Content-Type": "application/json" }
  const requestId = `token-${Date.now().toString(36)}-${(++nextRequestId).toString(36)}`

  console.log(`[qqbot-api:${requestId}] >>> POST ${TOKEN_URL} (retries=${NETWORK_RETRY_DELAYS_MS.length})`)
  console.log(`[qqbot-api:${requestId}] >>> Headers:`, JSON.stringify(requestHeaders, null, 2))
  console.log(`[qqbot-api:${requestId}] >>> Body:`, JSON.stringify({ appId, clientSecret: "***" }, null, 2))

  for (let attempt = 0; attempt <= NETWORK_RETRY_DELAYS_MS.length; attempt += 1) {
    let response: Response
    try {
      response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: attempt === 0 ? requestHeaders : { ...requestHeaders, Connection: "close" },
        body: JSON.stringify(requestBody),
      })
    } catch (err) {
      const detail = describeNetworkError(err)
      console.error(`[qqbot-api:${requestId}] <<< Network error attempt=${attempt + 1}: ${detail}`)
      if (attempt < NETWORK_RETRY_DELAYS_MS.length && isTransientNetworkError(detail)) {
        await retryDelay(requestId, attempt, detail)
        continue
      }
      throw new Error(`Network error getting access_token request=${requestId}: ${detail}`)
    }

    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value
    })
    console.log(`[qqbot-api:${requestId}] <<< Status attempt=${attempt + 1}: ${response.status} ${response.statusText}`)
    console.log(`[qqbot-api:${requestId}] <<< Headers:`, JSON.stringify(responseHeaders, null, 2))

    let data: { access_token?: string; expires_in?: number }
    try {
      const rawBody = await response.text()
      const logBody = rawBody.replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token": "***"')
      console.log(`[qqbot-api:${requestId}] <<< Body:`, logBody)
      data = JSON.parse(rawBody) as { access_token?: string; expires_in?: number }
    } catch (err) {
      const detail = describeNetworkError(err)
      console.error(`[qqbot-api:${requestId}] <<< Response body error attempt=${attempt + 1}: ${detail}`)
      if (response.ok && attempt < NETWORK_RETRY_DELAYS_MS.length && isTransientNetworkError(detail)) {
        await retryDelay(requestId, attempt, detail)
        continue
      }
      throw new Error(`Failed to parse access_token response request=${requestId}: ${detail}`)
    }

    if (!response.ok || !data.access_token) {
      const detail = JSON.stringify(data)
      if (response.status >= 500 && attempt < NETWORK_RETRY_DELAYS_MS.length) {
        await retryDelay(requestId, attempt, `HTTP ${response.status}: ${detail}`)
        continue
      }
      throw new Error(`Failed to get access_token request=${requestId}: ${detail}`)
    }

    const cachedToken = {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
    }
    cachedTokens.set(appId, cachedToken)

    console.log(`[qqbot-api:${requestId}] Token cached for appId=${appId}, expires at: ${new Date(cachedToken.expiresAt).toISOString()}`)
    return cachedToken.token
  }

  throw new Error(`Token retries exhausted request=${requestId}`)
}

/**
 * 清空当前 Token 缓存。
 * 不会中断已经在进行中的刷新请求。
 */
export function clearTokenCache(appId?: string): void {
  if (appId !== undefined) {
    cachedTokens.delete(appId)
    return
  }
  cachedTokens.clear()
}

/**
 * 获取当前 Token 缓存状态，便于监控或启动阶段打印状态。
 */
export function getTokenStatus(): { status: "valid" | "expired" | "refreshing" | "none"; expiresAt: number | null } {
  const cachedToken = cachedTokens.values().next().value
  if (tokenFetchPromises.size > 0) {
    return { status: "refreshing", expiresAt: cachedToken?.expiresAt ?? null }
  }
  if (!cachedToken) {
    return { status: "none", expiresAt: null }
  }
  const isValid = Date.now() < cachedToken.expiresAt - 5 * 60 * 1000
  return { status: isValid ? "valid" : "expired", expiresAt: cachedToken.expiresAt }
}

/**
 * 生成消息序号，范围固定为 0~65535。
 * 用时间戳低位与随机数混合，避免进程内碰撞。
 */
export function getNextMsgSeq(_msgId: string): number {
  const timePart = Date.now() % 100000000
  const random = Math.floor(Math.random() * 65536)
  return (timePart ^ random) % 65536
}

const DEFAULT_API_TIMEOUT = 30000
const FILE_UPLOAD_TIMEOUT = 120000
const NETWORK_RETRY_DELAYS_MS = [250, 1_000]
let nextRequestId = 0

function redactHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, key.toLowerCase() === "authorization" ? "***" : value]),
  )
}

/**
 * 统一封装 QQ Bot REST 请求。
 * 保留源实现的超时、日志、错误处理和 JSON 解析行为。
 */
export async function apiRequest<T = unknown>(
  accessToken: string,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs?: number,
  sandbox?: boolean,
): Promise<T> {
  const url = `${getApiBase(sandbox)}${path}`
  const headers: Record<string, string> = {
    Authorization: `QQBot ${accessToken}`,
    "Content-Type": "application/json",
  }

  const isFileUpload = path.includes("/files")
  const timeout = timeoutMs ?? (isFileUpload ? FILE_UPLOAD_TIMEOUT : DEFAULT_API_TIMEOUT)

  const requestId = `${Date.now().toString(36)}-${(++nextRequestId).toString(36)}`
  const bodyText = body === undefined ? undefined : JSON.stringify(body)
  const isIdempotentMessage = method === "POST" && path.includes("/messages") && typeof (body as { msg_id?: unknown } | undefined)?.msg_id === "string"
  const mayRetry = method === "GET" || method === "HEAD" || isIdempotentMessage

  console.log(`[qqbot-api:${requestId}] >>> ${method} ${url} (timeout: ${timeout}ms, retries=${mayRetry ? NETWORK_RETRY_DELAYS_MS.length : 0})`)
  console.log(`[qqbot-api:${requestId}] >>> Headers:`, JSON.stringify(redactHeaders(headers), null, 2))
  if (body) {
    const logBody = { ...(body as Record<string, unknown>) }
    if (typeof logBody.file_data === "string") {
      logBody.file_data = `<base64 ${logBody.file_data.length} chars>`
    }
    console.log(`[qqbot-api:${requestId}] >>> Body:`, JSON.stringify(logBody, null, 2))
  }

  for (let attempt = 0; attempt <= NETWORK_RETRY_DELAYS_MS.length; attempt += 1) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)
    const attemptHeaders = attempt === 0 ? headers : { ...headers, Connection: "close" }
    let res: Response
    try {
      res = await fetch(url, { method, headers: attemptHeaders, signal: controller.signal, body: bodyText })
    } catch (err) {
      clearTimeout(timeoutId)
      const detail = describeNetworkError(err)
      const timedOut = err instanceof Error && err.name === "AbortError"
      console.error(`[qqbot-api:${requestId}] <<< ${timedOut ? "Request timeout" : "Network error"} attempt=${attempt + 1}: ${detail}`)
      if (mayRetry && attempt < NETWORK_RETRY_DELAYS_MS.length) {
        await retryDelay(requestId, attempt, detail)
        continue
      }
      throw new Error(timedOut
        ? `Request timeout [${path}] request=${requestId}: exceeded ${timeout}ms`
        : `Network error [${path}] request=${requestId}: ${detail}`)
    } finally {
      clearTimeout(timeoutId)
    }

    const responseHeaders: Record<string, string> = {}
    res.headers.forEach((value, key) => { responseHeaders[key] = value })
    console.log(`[qqbot-api:${requestId}] <<< Status attempt=${attempt + 1}: ${res.status} ${res.statusText}`)
    console.log(`[qqbot-api:${requestId}] <<< Headers:`, JSON.stringify(responseHeaders, null, 2))

    let data: T
    try {
      const rawBody = await res.text()
      console.log(`[qqbot-api:${requestId}] <<< Body:`, rawBody)
      data = JSON.parse(rawBody) as T
    } catch (err) {
      const detail = describeNetworkError(err)
      console.error(`[qqbot-api:${requestId}] <<< Response body error attempt=${attempt + 1}: ${detail}`)
      if (res.ok && mayRetry && attempt < NETWORK_RETRY_DELAYS_MS.length && isTransientNetworkError(detail)) {
        await retryDelay(requestId, attempt, detail)
        continue
      }
      throw new Error(`Failed to parse response [${path}] request=${requestId}: ${detail}`)
    }

    if (!res.ok) {
      const error = data as { message?: string; code?: number }
      const detail = error.message ?? JSON.stringify(data)
      if (mayRetry && res.status >= 500 && attempt < NETWORK_RETRY_DELAYS_MS.length) {
        await retryDelay(requestId, attempt, `HTTP ${res.status}: ${detail}`)
        continue
      }
      throw new Error(`API Error [${path}] request=${requestId}: ${detail}`)
    }

    return data
  }

  throw new Error(`Request retries exhausted [${path}] request=${requestId}`)
}

function describeNetworkError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const detail = error as Error & { code?: unknown; cause?: unknown }
  const code = typeof detail.code === "string" ? ` code=${detail.code}` : ""
  const cause = detail.cause instanceof Error ? ` cause=${detail.cause.message}` : detail.cause ? ` cause=${String(detail.cause)}` : ""
  return `${detail.message}${code}${cause}`
}

function isTransientNetworkError(detail: string): boolean {
  return /certificate|tls|socket|connect|network|reset|closed|econn|etimedout/i.test(detail)
}

async function retryDelay(requestId: string, attempt: number, reason: string): Promise<void> {
  const delay = NETWORK_RETRY_DELAYS_MS[attempt]!
  console.warn(`[qqbot-api:${requestId}] retrying in ${delay}ms after ${reason}`)
  await new Promise((resolve) => setTimeout(resolve, delay))
}

/**
 * 获取 WebSocket Gateway 地址。
 */
export async function getGatewayUrl(accessToken: string, sandbox?: boolean): Promise<string> {
  const data = await apiRequest<{ url: string }>(accessToken, "GET", "/gateway", undefined, undefined, sandbox)
  return data.url
}

/**
 * QQ 发消息成功后的通用响应结构。
 */
export interface MessageResponse {
  id: string
  timestamp: number | string
}

/**
 * 构建普通文本消息体。
 * 这里固定使用纯文本消息，不再保留 markdown 模式切换。
 */
function buildMessageBody(
  content: string,
  msgId: string | undefined,
  msgSeq: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    content,
    msg_type: 0,
    msg_seq: msgSeq,
  }

  if (msgId) {
    body.msg_id = msgId
  }

  return body
}

/**
 * 发送 C2C 单聊文本消息。
 * msgSeq 可选，传入时优先使用，便于上层做分片发送。
 */
export async function sendC2CMessage(
  accessToken: string,
  openid: string,
  content: string,
  msgId?: string,
  msgSeq?: number,
  sandbox?: boolean,
): Promise<MessageResponse> {
  const resolvedMsgSeq = msgSeq ?? (msgId ? getNextMsgSeq(msgId) : 1)
  const body = buildMessageBody(content, msgId, resolvedMsgSeq)
  return apiRequest(accessToken, "POST", `/v2/users/${openid}/messages`, body, undefined, sandbox)
}

/**
 * 发送 C2C 输入状态提示，告诉用户机器人正在输入。
 */
export async function sendC2CInputNotify(
  accessToken: string,
  openid: string,
  msgId?: string,
  inputSecond: number = 60,
  sandbox?: boolean,
): Promise<void> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1
  const body = {
    msg_type: 6,
    input_notify: {
      input_type: 1,
      input_second: inputSecond,
    },
    msg_seq: msgSeq,
    ...(msgId ? { msg_id: msgId } : {}),
  }

  await apiRequest(accessToken, "POST", `/v2/users/${openid}/messages`, body, undefined, sandbox)
}

/**
 * 发送群聊文本消息。
 * msgSeq 可选，传入时优先使用，便于上层做分片发送。
 */
export async function sendGroupMessage(
  accessToken: string,
  groupOpenid: string,
  content: string,
  msgId?: string,
  msgSeq?: number,
  sandbox?: boolean,
): Promise<MessageResponse> {
  const resolvedMsgSeq = msgSeq ?? (msgId ? getNextMsgSeq(msgId) : 1)
  const body = buildMessageBody(content, msgId, resolvedMsgSeq)
  return apiRequest(accessToken, "POST", `/v2/groups/${groupOpenid}/messages`, body, undefined, sandbox)
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

const backgroundRefreshAbortControllers = new Map<string, AbortController>()

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
    console.log(`[qqbot-api] Background token refresh already running for appId=${appId}`)
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
    log?.info?.(`[qqbot-api] Background token refresh started appId=${appId}`)

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

          log?.debug?.(`[qqbot-api] Token valid appId=${appId}, next refresh in ${Math.round(refreshIn / 1000)}s`)
          await abortableSleep(refreshIn, signal)
        } else {
          log?.debug?.(`[qqbot-api] No cached token appId=${appId}, retrying soon`)
          await abortableSleep(minRefreshIntervalMs, signal)
        }
      } catch (err) {
        if (signal.aborted) break

        log?.error?.(`[qqbot-api] Background token refresh failed appId=${appId}: ${err}`)
        await abortableSleep(retryDelayMs, signal)
      }
    }

    if (backgroundRefreshAbortControllers.get(appId) === abortController) {
      backgroundRefreshAbortControllers.delete(appId)
    }
    log?.info?.(`[qqbot-api] Background token refresh stopped appId=${appId}`)
  }

  refreshLoop().catch((err) => {
    if (backgroundRefreshAbortControllers.get(appId) === abortController) {
      backgroundRefreshAbortControllers.delete(appId)
    }
    log?.error?.(`[qqbot-api] Background token refresh crashed appId=${appId}: ${err}`)
  })
}

/**
 * 停止后台 Token 刷新循环。
 */
export function stopBackgroundTokenRefresh(appId?: string): void {
  if (appId !== undefined) {
    backgroundRefreshAbortControllers.get(appId)?.abort()
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
export async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined

    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort)
    }

    const onAbort = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      cleanup()
      reject(new Error("Aborted"))
    }

    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener("abort", onAbort, { once: true })
    }

    timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
  })
}
