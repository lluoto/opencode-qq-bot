import type { OpencodeClient } from "./client.js"
import type { Event } from "@opencode-ai/sdk"

export interface AdapterSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface AdapterModel {
  id: string
  providerId: string
  modelId: string
  label: string
}

export interface AdapterAgent {
  id: string
  label: string
}

export interface PromptParams {
  sessionId: string
  text: string
  model?: { providerID: string; modelID: string }
  agent?: string
}

export interface SSEStream {
  stream: AsyncIterable<Event>
}

function toAdapterSession(raw: Record<string, unknown>): AdapterSession | null {
  const id = typeof raw.id === "string" ? raw.id : undefined
  if (!id) return null
  return {
    id,
    title: typeof raw.title === "string" ? raw.title : id,
    createdAt: typeof raw.time === "object" && raw.time !== null
      ? Number((raw.time as Record<string, unknown>).created ?? 0)
      : 0,
    updatedAt: typeof raw.time === "object" && raw.time !== null
      ? Number((raw.time as Record<string, unknown>).updated ?? 0)
      : 0,
  }
}

export async function createSession(client: OpencodeClient): Promise<AdapterSession> {
  const result = await client.session.create({})
  const raw = (result.data ?? result) as unknown as Record<string, unknown>
  const session = toAdapterSession(raw)
  if (!session) throw new Error("session.create returned invalid data")
  return session
}

export async function listSessions(client: OpencodeClient): Promise<AdapterSession[]> {
  const result = await client.session.list()
  const arr = Array.isArray(result.data) ? result.data : Array.isArray(result) ? result : []
  return (arr as Record<string, unknown>[])
    .map(toAdapterSession)
    .filter((s): s is AdapterSession => s !== null)
}

export async function abortSession(client: OpencodeClient, sessionId: string): Promise<void> {
  await client.session.abort({ path: { id: sessionId } })
}

export async function updateSessionTitle(client: OpencodeClient, sessionId: string, title: string): Promise<AdapterSession> {
  const result = await client.session.update({ path: { id: sessionId }, body: { title } })
  const raw = (result.data ?? result) as unknown as Record<string, unknown>
  const session = toAdapterSession(raw)
  if (!session) throw new Error("session.update returned invalid data")
  return session
}

export async function promptAsync(client: OpencodeClient, params: PromptParams): Promise<void> {
  await client.session.promptAsync({
    path: { id: params.sessionId },
    body: {
      parts: [{ type: "text", text: params.text }],
      ...(params.model ? { model: params.model } : {}),
      ...(params.agent ? { agent: params.agent } : {}),
    },
  })
}

export async function listProviderModels(client: OpencodeClient): Promise<AdapterModel[]> {
  const result = await client.provider.list()
  const data = (result.data ?? result) as unknown as Record<string, unknown>
  const allProviders = Array.isArray(data.all) ? data.all as Record<string, unknown>[] : []
  const models: AdapterModel[] = []

  for (const provider of allProviders) {
    const providerId = typeof provider.id === "string" ? provider.id : undefined
    if (!providerId) continue

    const rawModels = provider.models
    if (!rawModels || typeof rawModels !== "object") continue

    const entries = Array.isArray(rawModels) ? rawModels : Object.values(rawModels)
    for (const m of entries) {
      if (!m || typeof m !== "object") continue
      const rec = m as Record<string, unknown>
      const modelId = typeof rec.id === "string" ? rec.id : undefined
      if (!modelId) continue
      const modelName = typeof rec.name === "string" ? rec.name : modelId
      models.push({ id: `${providerId}/${modelId}`, providerId, modelId, label: `${providerId} / ${modelName}` })
    }
  }

  return models
}

export async function listAgents(client: OpencodeClient): Promise<AdapterAgent[]> {
  const result = await client.app.agents()
  const arr = Array.isArray(result.data) ? result.data : Array.isArray(result) ? result : []
  return (arr as Record<string, unknown>[])
    .map((a) => {
      const id = typeof a.id === "string" ? a.id : typeof a.name === "string" ? a.name : undefined
      if (!id) return null
      const desc = typeof a.description === "string" ? a.description : undefined
      return { id, label: desc ? `${id} - ${desc}` : id }
    })
    .filter((a): a is AdapterAgent => a !== null)
}

export async function subscribeEvents(client: OpencodeClient): Promise<SSEStream> {
  const result = await client.event.subscribe()
  return { stream: result.stream as AsyncIterable<Event> }
}

export async function healthCheck(client: OpencodeClient): Promise<void> {
  try {
    await client.session.list()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`OpenCode server unreachable: ${msg}`)
  }
}
