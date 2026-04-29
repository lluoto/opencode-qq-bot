// @input:  @opencode-ai/sdk
// @output: createClient, healthCheck, OpencodeClient
// @pos:    opencode层 - OpenCode SDK 客户端封装 + 健康检查
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk"

export function createClient(baseUrl: string): OpencodeClient {
  return createOpencodeClient({ baseUrl })
}

export async function healthCheck(oc: OpencodeClient): Promise<void> {
  try {
    await oc.session.list()
    console.log("[opencode] health check passed")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`OpenCode server unreachable: ${msg}`)
  }
}

export type { OpencodeClient }
