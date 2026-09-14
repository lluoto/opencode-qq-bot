// @input:  ./client (OpencodeClient)
// @output: SessionManager, UserSession
// @pos:    opencode层 - QQ用户<->OpenCode Session 映射管理
import type { OpencodeClient } from "./client.js"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const DEFAULT_AGENT_PREFERENCES_PATH = join(homedir(), ".openqq", "agent-preferences.json")

interface UserSession {
  sessionId: string
  title?: string
  // Set only after an explicit /model selection; otherwise OpenCode owns the model.
  modelId?: string
  providerId?: string
  agentId?: string
}

export class SessionManager {
  private sessions = new Map<string, UserSession>()
  private client: OpencodeClient
  private namespace: string
  private preferencesPath: string

  constructor(client: OpencodeClient, namespace = "default", preferencesPath = DEFAULT_AGENT_PREFERENCES_PATH) {
    this.client = client
    this.namespace = namespace
    this.preferencesPath = preferencesPath
  }

  async getOrCreate(stateKey: string): Promise<UserSession> {
    const existing = this.sessions.get(stateKey)
    if (existing) return existing

    const result = await this.client.session.create({})
    const session: UserSession = {
      sessionId: result.data!.id,
      title: result.data!.title,
      agentId: this.readAgentPreference(stateKey),
    }
    this.sessions.set(stateKey, session)
    return session
  }

  async createNew(stateKey: string): Promise<UserSession> {
    const existing = this.sessions.get(stateKey)
    const result = await this.client.session.create({})
    const session: UserSession = {
      sessionId: result.data!.id,
      title: result.data!.title,
      agentId: existing?.agentId ?? this.readAgentPreference(stateKey),
    }
    this.sessions.set(stateKey, session)
    return session
  }

  switchSession(stateKey: string, sessionId: string, title?: string): void {
    const existing = this.sessions.get(stateKey)
    this.sessions.set(stateKey, {
      sessionId,
      title,
      providerId: existing?.providerId,
      modelId: existing?.modelId,
      agentId: existing?.agentId ?? this.readAgentPreference(stateKey),
    })
  }

  getSession(stateKey: string): UserSession | undefined {
    return this.sessions.get(stateKey)
  }

  setModel(stateKey: string, providerId: string, modelId: string): void {
    const s = this.sessions.get(stateKey)
    if (s) {
      s.providerId = providerId
      s.modelId = modelId
    }
  }

  setAgent(stateKey: string, agentId: string): void {
    const s = this.sessions.get(stateKey)
    if (s) {
      s.agentId = agentId
    }
    this.writeAgentPreference(stateKey, agentId)
  }

  getModel(stateKey: string): { providerId?: string; modelId?: string } {
    const s = this.sessions.get(stateKey)
    return { providerId: s?.providerId, modelId: s?.modelId }
  }

  getAgent(stateKey: string): string | undefined {
    return this.sessions.get(stateKey)?.agentId ?? this.readAgentPreference(stateKey)
  }

  private preferenceKey(stateKey: string): string {
    return `${this.namespace}:${stateKey}`
  }

  private readPreferences(): Record<string, string> {
    try {
      if (!existsSync(this.preferencesPath)) return {}
      const parsed = JSON.parse(readFileSync(this.preferencesPath, "utf8"))
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {}
      return Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      )
    } catch (error) {
      console.error("[sessions] Failed to read agent preferences:", error)
      return {}
    }
  }

  private readAgentPreference(stateKey: string): string | undefined {
    return this.readPreferences()[this.preferenceKey(stateKey)]
  }

  private writeAgentPreference(stateKey: string, agentId: string): void {
    try {
      const preferences = this.readPreferences()
      preferences[this.preferenceKey(stateKey)] = agentId
      mkdirSync(dirname(this.preferencesPath), { recursive: true })
      writeFileSync(this.preferencesPath, `${JSON.stringify(preferences, null, 2)}\n`, "utf8")
    } catch (error) {
      console.error("[sessions] Failed to persist agent preference:", error)
    }
  }
}

export type { UserSession }
