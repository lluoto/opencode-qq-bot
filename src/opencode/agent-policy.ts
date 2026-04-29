import { existsSync, readFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"

const OH_MY_OPENAGENT_CONFIG = join(homedir(), ".config", "opencode", "oh-my-openagent.json")

let cachedAgentIds: Set<string> | null = null

function getOhMyOpenAgentIds(): Set<string> {
  if (cachedAgentIds) {
    return cachedAgentIds
  }

  try {
    if (!existsSync(OH_MY_OPENAGENT_CONFIG)) {
      cachedAgentIds = new Set()
      return cachedAgentIds
    }

    const raw = JSON.parse(readFileSync(OH_MY_OPENAGENT_CONFIG, "utf-8")) as {
      agents?: Record<string, unknown>
    }
    cachedAgentIds = new Set(Object.keys(raw.agents ?? {}).map((id) => id.toLowerCase()))
    return cachedAgentIds
  } catch {
    cachedAgentIds = new Set()
    return cachedAgentIds
  }
}

export function isOpenAIGptModel(providerId?: string, modelId?: string): boolean {
  return providerId === "openai" && typeof modelId === "string" && /^gpt([-.]|$)/i.test(modelId)
}

export function isOhMyOpenAgent(agentId?: string): boolean {
  return !!agentId && getOhMyOpenAgentIds().has(agentId.toLowerCase())
}

export function isAgentAllowedForModel(agentId: string | undefined, providerId?: string, modelId?: string): boolean {
  if (!agentId || !isOhMyOpenAgent(agentId)) {
    return true
  }
  return isOpenAIGptModel(providerId, modelId)
}
