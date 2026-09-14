import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk"
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handleCommand, handleModel, handlePendingSelection, listModels } from "./commands.js"
import type { CommandContext, PendingSelection } from "./commands.js"
import type { Config } from "./config.js"
import { providersResponseSample } from "./fixtures/providers-response.sample.js"
import { SessionManager } from "./opencode/sessions.js"
import type { MessageContext } from "./qq/types.js"
import { deriveStateKey } from "./state-key.js"

type ProvidersLoader = () => Promise<unknown>

const testConfig = {
  qq: { appId: "bot", clientSecret: "secret", sandbox: true },
  opencode: { baseUrl: "http://127.0.0.1", externalUrl: false },
  allowedUsers: [],
  maxReplyLength: 3000,
} satisfies Config

const modelContext = {
  type: "c2c",
  botId: "bot",
  userId: "user-1",
  msgId: "message-1",
  content: "/m",
} satisfies MessageContext

const configuredModelIds = new Set(["keyed-config-provider/config-active"])

const otherBotModelContext = {
  ...modelContext,
  botId: "other-bot",
  msgId: "message-2",
} satisfies MessageContext

const groupModelContext = {
  ...modelContext,
  type: "group",
  groupId: "group-1",
  msgId: "message-3",
} satisfies MessageContext

function createClient(providers: ProvidersLoader = async () => ({ data: { providers: [], default: {} } })): OpencodeClient {
  const client = createOpencodeClient({ baseUrl: "http://127.0.0.1" })
  Object.defineProperty(client.config, "providers", { value: providers })
  return client
}

function createModelCommandContext(client: OpencodeClient = createClient()): CommandContext {
  const sessions = new SessionManager(client)
  sessions.switchSession(modelContext.userId, "session-1", "Test session")
  return {
    config: testConfig,
    client,
    sessions,
    getAccessToken: async () => "token",
    pendingSelections: new Map<string, PendingSelection>(),
    configuredModelIds,
  }
}

describe("listModels", () => {
  test("calls config.providers directly and preserves visible model IDs and labels", async () => {
    // Given
    let providersCalls = 0
    const client = {
      config: {
        providers: async () => {
          providersCalls += 1
          return providersResponseSample
        },
      },
    } satisfies Parameters<typeof listModels>[0]

    // When
    const models = await listModels(client, configuredModelIds)

    // Then
    expect(providersCalls).toBe(1)
    expect(models).toEqual([
      { id: "keyed-config-provider/config-active", label: "keyed-config-provider / config-active" },
    ])
  })
})

describe("model switching", () => {
  test("switches explicitly to an authorized model and fetches the visible list for authorization check", async () => {
    // Given
    let providersCalls = 0
    const context = createModelCommandContext(createClient(async () => {
      providersCalls += 1
      return providersResponseSample
    }))

    // When
    const result = await handleModel(modelContext, "keyed-config-provider/config-active", context)

    // Then
    expect(result).toBe("已切换模型：keyed-config-provider / config-active")
    expect(context.sessions.getModel(modelContext.userId)).toEqual({ providerId: "keyed-config-provider", modelId: "config-active" })
    expect(providersCalls).toBe(1)
  })

  test("switches to the selected model from a pending list", async () => {
    // Given
    const context = createModelCommandContext()
    context.pendingSelections.set(deriveStateKey(modelContext.botId, modelContext.userId, modelContext.groupId), {
      type: "model",
      items: [{ id: "opencode/deepseek-v4-flash-free", label: "opencode / deepseek-v4-flash-free" }],
      expiresAt: Date.now() + 60_000,
    })

    // When
    const result = await handleModel(modelContext, "1", context)

    // Then
    expect(result).toBe("已切换模型：opencode / deepseek-v4-flash-free")
    expect(context.sessions.getModel(modelContext.userId)).toEqual({
      providerId: "opencode",
      modelId: "deepseek-v4-flash-free",
    })
  })

  test("numeric selection after list population switches to the selected visible model", async () => {
    // Given
    const context = createModelCommandContext(createClient(async () => providersResponseSample))
    await handleModel(modelContext, "", context)

    // When
    const selectionResult = await handlePendingSelection(modelContext, 1, context)

    // Then
    expect(selectionResult).toBe("已切换模型：keyed-config-provider / config-active")
    expect(context.sessions.getModel(modelContext.userId)).toEqual({
      providerId: "keyed-config-provider",
      modelId: "config-active",
    })
    expect(context.pendingSelections.has(deriveStateKey(modelContext.botId, modelContext.userId, modelContext.groupId))).toBe(false)
  })

  test("does not consume another bot's pending model selection", async () => {
    // Given
    const context = createModelCommandContext(createClient(async () => providersResponseSample))
    await handleModel(modelContext, "", context)

    // When
    const result = await handleModel(otherBotModelContext, "1", context)

    // Then
    expect(result).toBe("没有待选择的模型列表，请先发送 /model")
    expect(context.pendingSelections.has(deriveStateKey(modelContext.botId, modelContext.userId, modelContext.groupId))).toBe(true)
  })

  test("does not consume a C2C pending model selection from a group", async () => {
    // Given
    const context = createModelCommandContext(createClient(async () => providersResponseSample))
    await handleModel(modelContext, "", context)

    // When
    const result = await handleModel(groupModelContext, "1", context)

    // Then
    expect(result).toBe("没有待选择的模型列表，请先发送 /model")
    expect(context.pendingSelections.has(deriveStateKey(modelContext.botId, modelContext.userId, modelContext.groupId))).toBe(true)
  })

  test("uses the scoped pending selection while keeping SessionManager keyed by raw user ID", async () => {
    // Given
    const context = createModelCommandContext()
    const stateKey = deriveStateKey(modelContext.botId, modelContext.userId, modelContext.groupId)
    context.sessions.switchSession(modelContext.userId, "raw-session", "Raw user session")
    context.pendingSelections.set(stateKey, {
      type: "session",
      items: [{ id: "selected-session", label: "Selected session" }],
      expiresAt: Date.now() + 60_000,
    })

    // When
    const result = await handlePendingSelection(modelContext, 1, context)

    // Then
    expect(result).toBe("已切换到会话：Selected session")
    expect(context.sessions.getSession(modelContext.userId)?.sessionId).toBe("selected-session")
    expect(context.pendingSelections.has(stateKey)).toBe(false)
  })

  test("rejects explicit switch to a hidden model with authorization error", async () => {
    // Given: a model that exists but is not in the visible list (e.g., inactive or unauthorized provider)
    const context = createModelCommandContext(createClient(async () => providersResponseSample))
    const modelBefore = context.sessions.getModel(modelContext.userId)

    // When: attempt to switch to a hidden model explicitly
    const result = await handleModel(modelContext, "hidden-provider/hidden-model", context)

    // Then: reject with the exact error message and do not call setModel
    expect(result).toBe("模型 hidden-provider/hidden-model 当前账号不可用")
    expect(context.sessions.getModel(modelContext.userId)).toEqual(modelBefore)
  })

  test("allows explicit switch to a visible model from the authorized list", async () => {
    // Given: a model that is in the visible list
    const context = createModelCommandContext(createClient(async () => providersResponseSample))

    // When: switch to a visible model explicitly
    const result = await handleModel(modelContext, "keyed-config-provider/config-active", context)

    // Then: succeed and call setModel
    expect(result).toBe("已切换模型：keyed-config-provider / config-active")
    expect(context.sessions.getModel(modelContext.userId)).toEqual({
      providerId: "keyed-config-provider",
      modelId: "config-active",
    })
  })
})

describe("mode switching", () => {
  test("supports /mode and preserves the selection across SessionManager restarts", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openqq-mode-"))
    const preferencesPath = join(tempDir, "agent-preferences.json")
    try {
      const client = createClient()
      const sessions = new SessionManager(client, modelContext.botId, preferencesPath)
      sessions.switchSession(modelContext.userId, "session-1", "Test session")
      const context: CommandContext = {
        config: testConfig,
        client,
        sessions,
        getAccessToken: async () => "token",
        pendingSelections: new Map(),
      }

      const result = await handleCommand({ ...modelContext, content: "/mode plan" }, context)
      const restartedSessions = new SessionManager(client, modelContext.botId, preferencesPath)
      restartedSessions.switchSession(modelContext.userId, "session-1", "Test session")

      expect(result).toBe("已切换模式：plan（重启后保留）")
      expect(restartedSessions.getAgent(modelContext.userId)).toBe("plan")
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test("supports direct /build shortcut", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openqq-mode-"))
    try {
      const client = createClient()
      const sessions = new SessionManager(client, modelContext.botId, join(tempDir, "preferences.json"))
      sessions.switchSession(modelContext.userId, "session-1", "Test session")
      const context: CommandContext = {
        config: testConfig,
        client,
        sessions,
        getAccessToken: async () => "token",
        pendingSelections: new Map(),
      }

      const result = await handleCommand({ ...modelContext, content: "/build" }, context)

      expect(result).toBe("已切换模式：build（重启后保留）")
      expect(sessions.getAgent(modelContext.userId)).toBe("build")
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
