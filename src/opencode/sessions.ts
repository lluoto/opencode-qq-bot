import type { OpencodeClient } from "./client.js"
import { createSession } from "./adapter.js"
import type { ModelConfig } from "../config.js"
import { isAgentAllowedForModel } from "./agent-policy.js"

interface UserSession {
  sessionId: string
  title?: string
  modelId?: string
  providerId?: string
  agentId?: string
}

export class SessionManager {
  private sessions = new Map<string, UserSession>()
  private userSessionHistory = new Map<string, Array<{ id: string; title: string }>>()
  private client: OpencodeClient
  private defaultModel?: ModelConfig

  constructor(client: OpencodeClient, defaultModel?: ModelConfig) {
    this.client = client
    this.defaultModel = defaultModel
  }

  async getOrCreate(userId: string): Promise<UserSession> {
    const existing = this.sessions.get(userId)
    if (existing) return existing

    const created = await createSession(this.client)
    const session: UserSession = { sessionId: created.id, title: created.title }
    this.sessions.set(userId, session)
    this.trackSession(userId, created.id, created.title)
    return session
  }

  async createNew(userId: string): Promise<UserSession> {
    const created = await createSession(this.client)
    const session: UserSession = { sessionId: created.id, title: created.title }
    this.sessions.set(userId, session)
    this.trackSession(userId, created.id, created.title)
    return session
  }

  getUserSessions(userId: string): Array<{ id: string; title: string }> {
    return this.userSessionHistory.get(userId) ?? []
  }

  switchSession(userId: string, sessionId: string, title?: string): void {
    const current = this.sessions.get(userId)
    this.sessions.set(userId, {
      providerId: current?.providerId,
      modelId: current?.modelId,
      sessionId,
      title,
    })
  }

  getSession(userId: string): UserSession | undefined {
    return this.sessions.get(userId)
  }

  setModel(userId: string, providerId: string, modelId: string): void {
    const s = this.sessions.get(userId)
    if (s) {
      s.providerId = providerId
      s.modelId = modelId
      if (!isAgentAllowedForModel(s.agentId, providerId, modelId)) {
        s.agentId = undefined
      }
    }
  }

  setAgent(userId: string, agentId: string): void {
    const s = this.sessions.get(userId)
    if (s) {
      s.agentId = agentId
    }
  }

  getModel(userId: string): { providerId?: string; modelId?: string } {
    const s = this.sessions.get(userId)
    return {
      providerId: s?.providerId ?? this.defaultModel?.providerId,
      modelId: s?.modelId ?? this.defaultModel?.modelId,
    }
  }

  getAgent(userId: string): string | undefined {
    return this.sessions.get(userId)?.agentId
  }

  updateSessionTitle(userId: string, sessionId: string, title: string): void {
    const history = this.userSessionHistory.get(userId)
    if (history) {
      const entry = history.find((h) => h.id === sessionId)
      if (entry) entry.title = title
    }
    const current = this.sessions.get(userId)
    if (current && current.sessionId === sessionId) {
      current.title = title
    }
  }

  private trackSession(userId: string, sessionId: string, title: string): void {
    const history = this.userSessionHistory.get(userId) ?? []
    if (!history.some((h) => h.id === sessionId)) {
      history.push({ id: sessionId, title })
      this.userSessionHistory.set(userId, history)
    }
  }
}

export type { UserSession }
