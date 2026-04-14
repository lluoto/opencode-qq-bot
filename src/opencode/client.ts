// @input:  @opencode-ai/sdk
// @output: createClient, getClient, healthCheck, OpencodeClient
// @pos:    opencode层 - OpenCode SDK 客户端封装 + 健康检查
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk"

let client: OpencodeClient | null = null

export function createClient(baseUrl: string): OpencodeClient {
  console.log("[client] Creating client for:", baseUrl)
  client = createOpencodeClient({ baseUrl })
  return client
}

export function getClient(): OpencodeClient {
  if (!client) throw new Error("OpenCode client not initialized")
  return client
}

export async function healthCheck(oc: OpencodeClient, timeoutMs = 5000): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  
  try {
    console.log("[client] Running health check...")
    const result = await oc.session.list()
    console.log("[client] Health check passed, sessions:", result.data?.length)
    clearTimeout(timeout)
  } catch (err) {
    clearTimeout(timeout)
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`OpenCode server unreachable: ${msg}`)
  }
}

export type { OpencodeClient }
