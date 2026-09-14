import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk"
import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { Config } from "./config.js"
import { EventRouter } from "./opencode/events.js"
import { SessionManager } from "./opencode/sessions.js"
import type { MessageContext } from "./qq/types.js"

interface TokenCall {
  readonly appId: string
  readonly clientSecret: string
}

const tokenCalls: TokenCall[] = []
const replies: string[] = []

mock.module("./qq/api.js", () => ({
  getAccessToken: async (appId: string, clientSecret: string): Promise<string> => {
    tokenCalls.push({ appId, clientSecret })
    return `${appId}:${clientSecret}`
  },
}))

mock.module("./qq/sender.js", () => ({
  replyToQQ: async (_accessToken: string, _ctx: MessageContext, text: string): Promise<void> => {
    replies.push(text)
  },
}))

const { createBridge } = await import("./bridge.js")

const config = {
  qq: { appId: "global-bot", clientSecret: "global-secret", sandbox: true },
  opencode: { baseUrl: "http://127.0.0.1", externalUrl: false },
  allowedUsers: [],
  maxReplyLength: 3000,
} satisfies Config

const bridgeBot = {
  appId: "bridge-bot",
  clientSecret: "bridge-secret",
  sandbox: true,
}

const baseMessage = {
  type: "c2c",
  botId: bridgeBot.appId,
  userId: "user-1",
  msgId: "message-1",
  content: "/help",
} satisfies MessageContext

function createClient(): OpencodeClient {
  const client = createOpencodeClient({ baseUrl: "http://127.0.0.1" })
  Object.defineProperty(client.session, "list", {
    value: async () => ({ data: [] }),
  })
  return client
}

type PromptRejector = (reason?: unknown) => void

function holdSessionPrompts(client: OpencodeClient): PromptRejector[] {
  const promptRejectors: PromptRejector[] = []
  Object.defineProperty(client.session, "prompt", {
    value: () => new Promise<never>((_resolve, reject) => {
      promptRejectors.push(reject)
    }),
  })
  return promptRejectors
}

function capturePromptBodies(client: OpencodeClient): Array<Record<string, unknown>> {
  const promptBodies: Array<Record<string, unknown>> = []
  Object.defineProperty(client.session, "prompt", {
    value: async ({ body }: { body: Record<string, unknown> }) => {
      promptBodies.push(body)
      return { data: { parts: [{ type: "text", text: "ok" }] } }
    },
  })
  return promptBodies
}

async function waitForPromptCount(promptRejectors: readonly PromptRejector[], expectedCount: number): Promise<void> {
  for (let turn = 0; turn < 10 && promptRejectors.length < expectedCount; turn += 1) {
    await Promise.resolve()
  }
}

async function stopPromptRequests(
  requests: readonly Promise<void>[],
  promptRejectors: readonly PromptRejector[],
): Promise<void> {
  for (const reject of promptRejectors) {
    reject(new Error("stop test prompt"))
  }
  await Promise.all(requests)
}

beforeEach(() => {
  tokenCalls.length = 0
  replies.length = 0
})

describe("bridge state isolation", () => {
  test("uses the latest assistant message when the prompt result has no text part", async () => {
    const client = createClient()
    Object.defineProperty(client.session, "prompt", {
      value: async () => ({ data: { parts: [] } }),
    })
    Object.defineProperty(client.session, "messages", {
      value: async () => ({
        data: [{
          info: { role: "assistant" },
          parts: [{ type: "text", text: "recovered assistant text" }],
        }],
      }),
    })
    const sessions = new SessionManager(client)
    sessions.switchSession(baseMessage.userId, "session-1", "Test session")
    const bridge = createBridge(config, client, new EventRouter(client), sessions, bridgeBot)

    await bridge.handleMessage({ ...baseMessage, msgId: "recover-final-text", content: "run" })

    expect(replies).toEqual(["recovered assistant text"])
  })

  test("omits the model override so a selected CLI session keeps its own model", async () => {
    const client = createClient()
    const promptBodies = capturePromptBodies(client)
    const sessions = new SessionManager(client)
    sessions.switchSession(baseMessage.userId, "cli-session", "CLI session")
    const bridge = createBridge(config, client, new EventRouter(client), sessions, bridgeBot)

    await bridge.handleMessage({ ...baseMessage, msgId: "follow-cli-model", content: "follow session model" })

    expect(promptBodies).toEqual([{
      parts: [{ type: "text", text: "follow session model" }],
    }])
  })

  test("sends a model override after an explicit model selection", async () => {
    const client = createClient()
    const promptBodies = capturePromptBodies(client)
    const sessions = new SessionManager(client)
    sessions.switchSession(baseMessage.userId, "cli-session", "CLI session")
    sessions.setModel(baseMessage.userId, "anthropic", "claude-opus-5")
    const bridge = createBridge(config, client, new EventRouter(client), sessions, bridgeBot)

    await bridge.handleMessage({ ...baseMessage, msgId: "explicit-model", content: "use selected model" })

    expect(promptBodies).toEqual([{
      parts: [{ type: "text", text: "use selected model" }],
      model: { providerID: "anthropic", modelID: "claude-opus-5" },
    }])
  })

  test("suppresses a duplicate message ID in the same bot and C2C scope", async () => {
    // Given
    const client = createClient()
    const bridge = createBridge(config, client, new EventRouter(client), new SessionManager(client), bridgeBot)

    // When
    await bridge.handleMessage(baseMessage)
    await bridge.handleMessage(baseMessage)

    // Then
    expect(replies).toHaveLength(1)
  })

  test("deduplicates the same message ID independently for each bot", async () => {
    // Given
    const client = createClient()
    const bridge = createBridge(config, client, new EventRouter(client), new SessionManager(client), bridgeBot)
    const otherBotMessage = {
      ...baseMessage,
      botId: "other-bot",
    } satisfies MessageContext

    // When
    await bridge.handleMessage(baseMessage)
    await bridge.handleMessage(otherBotMessage)

    // Then
    expect(replies).toHaveLength(2)
  })

  test("deduplicates the same message ID independently for C2C and group scopes", async () => {
    // Given
    const client = createClient()
    const bridge = createBridge(config, client, new EventRouter(client), new SessionManager(client), bridgeBot)
    const groupMessage = {
      ...baseMessage,
      type: "group",
      groupId: "group-1",
    } satisfies MessageContext

    // When
    await bridge.handleMessage(baseMessage)
    await bridge.handleMessage(groupMessage)

    // Then
    expect(replies).toHaveLength(2)
  })

  test("tracks concurrent requests independently for each bot", async () => {
    // Given
    const client = createClient()
    const promptRejectors = holdSessionPrompts(client)
    const sessions = new SessionManager(client)
    const firstMessage = { ...baseMessage, msgId: "busy-1", content: "first" } satisfies MessageContext
    const secondMessage = {
      ...baseMessage,
      botId: "other-bot",
      msgId: "busy-2",
      content: "second",
    } satisfies MessageContext
    sessions.switchSession(firstMessage.userId, "session-1", "Test session")
    const bridge = createBridge(config, client, new EventRouter(client), sessions, bridgeBot)

    // When
    const firstRequest = bridge.handleMessage(firstMessage)
    await waitForPromptCount(promptRejectors, 1)
    const secondRequest = bridge.handleMessage(secondMessage)
    await waitForPromptCount(promptRejectors, 2)
    const promptCount = promptRejectors.length
    await stopPromptRequests([firstRequest, secondRequest], promptRejectors)

    // Then
    expect(promptCount).toBe(2)
  })

  test("replies busy to a second concurrent request in the same bot and C2C scope", async () => {
    // Given
    const client = createClient()
    const promptRejectors = holdSessionPrompts(client)
    const sessions = new SessionManager(client)
    sessions.switchSession(baseMessage.userId, "session-1", "Test session")
    const bridge = createBridge(config, client, new EventRouter(client), sessions, bridgeBot)
    const firstMessage = { ...baseMessage, msgId: "same-scope-busy-1", content: "first" } satisfies MessageContext
    const secondMessage = { ...baseMessage, msgId: "same-scope-busy-2", content: "second" } satisfies MessageContext
    const busyReply = "上一条消息还在处理中，请稍候再试"

    // When
    const firstRequest = bridge.handleMessage(firstMessage)
    await waitForPromptCount(promptRejectors, 1)
    const secondRequest = bridge.handleMessage(secondMessage)
    for (let turn = 0; turn < 10 && promptRejectors.length < 2 && !replies.includes(busyReply); turn += 1) {
      await Promise.resolve()
    }
    const observed = {
      promptCount: promptRejectors.length,
      busyReplyCount: replies.filter((reply) => reply === busyReply).length,
    }
    await stopPromptRequests([firstRequest, secondRequest], promptRejectors)

    // Then
    expect(observed).toEqual({ promptCount: 1, busyReplyCount: 1 })
  })

  test("tracks concurrent C2C and group requests independently for one bot", async () => {
    // Given
    const client = createClient()
    const promptRejectors = holdSessionPrompts(client)
    const sessions = new SessionManager(client)
    const c2cMessage = { ...baseMessage, msgId: "scope-busy-1", content: "first" } satisfies MessageContext
    const groupMessage = {
      ...baseMessage,
      type: "group",
      groupId: "group-1",
      msgId: "scope-busy-2",
      content: "second",
    } satisfies MessageContext
    sessions.switchSession(c2cMessage.userId, "session-1", "Test session")
    const bridge = createBridge(config, client, new EventRouter(client), sessions, bridgeBot)

    // When
    const c2cRequest = bridge.handleMessage(c2cMessage)
    await waitForPromptCount(promptRejectors, 1)
    const groupRequest = bridge.handleMessage(groupMessage)
    await waitForPromptCount(promptRejectors, 2)
    const promptCount = promptRejectors.length
    await stopPromptRequests([c2cRequest, groupRequest], promptRejectors)

    // Then
    expect(promptCount).toBe(2)
  })
})

describe("bridge command credentials", () => {
  test("forwards a prompt result that arrives shortly after stop instead of discarding it", async () => {
    // Regression test: /stop and a genuinely-completed startPrompt() result can race and
    // arrive within milliseconds of each other (the server already finished and billed for
    // the call). The bridge must not silently discard that result — it grants a short grace
    // period after abort so a near-simultaneous real result still reaches the user.
    const client = createClient()
    let promptStarted = false
    let resolvePrompt: (value: unknown) => void = () => {}
    Object.defineProperty(client.session, "prompt", {
      value: () => new Promise((resolve) => {
        promptStarted = true
        resolvePrompt = resolve
      }),
    })
    Object.defineProperty(client.session, "abort", { value: async () => ({ data: true }) })
    const sessions = new SessionManager(client)
    sessions.switchSession(baseMessage.userId, "session-1", "Test session")
    const bridge = createBridge(config, client, new EventRouter(client), sessions, bridgeBot)
    const promptMessage = { ...baseMessage, msgId: "late-prompt", content: "run" } satisfies MessageContext
    const stopMessage = { ...baseMessage, msgId: "late-stop", content: "/stop" } satisfies MessageContext

    const promptRequest = bridge.handleMessage(promptMessage)
    for (let turn = 0; turn < 10 && !promptStarted; turn += 1) {
      await Promise.resolve()
    }
    await bridge.handleMessage(stopMessage)
    resolvePrompt({ data: { parts: [{ type: "text", text: "late model result" }] } })
    await promptRequest
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(replies).toEqual(["已停止当前任务：Test session", "late model result"])
  })

  test("resolves with no result once startPrompt() itself rejects after stop", async () => {
    const client = createClient()
    const promptRejectors = holdSessionPrompts(client)
    Object.defineProperty(client.session, "abort", { value: async () => ({ data: true }) })
    const sessions = new SessionManager(client)
    sessions.switchSession(baseMessage.userId, "session-1", "Test session")
    const bridge = createBridge(config, client, new EventRouter(client), sessions, bridgeBot)
    const promptMessage = { ...baseMessage, msgId: "stop-prompt", content: "run" } satisfies MessageContext
    const stopMessage = { ...baseMessage, msgId: "stop-command", content: "/stop" } satisfies MessageContext

    const promptRequest = bridge.handleMessage(promptMessage)
    await waitForPromptCount(promptRejectors, 1)
    await bridge.handleMessage(stopMessage)
    // Grace period is in effect right after stop: the request is still considered active
    // until the in-flight startPrompt() actually settles (or the grace period expires).
    expect(bridge.hasActiveRequests()).toBe(true)

    for (const reject of promptRejectors) {
      reject(new Error("cleanup"))
    }
    await promptRequest

    expect(bridge.hasActiveRequests()).toBe(false)
  })

  test("uses the Bridge bot credentials for command token lookup", async () => {
    // Given
    const client = createClient()
    const bridge = createBridge(config, client, new EventRouter(client), new SessionManager(client), bridgeBot)
    const statusMessage = { ...baseMessage, content: "/status" } satisfies MessageContext

    // When
    await bridge.handleMessage(statusMessage)

    // Then
    expect(tokenCalls).toEqual([
      { appId: bridgeBot.appId, clientSecret: bridgeBot.clientSecret },
      { appId: bridgeBot.appId, clientSecret: bridgeBot.clientSecret },
    ])
  })
})

describe("bridge question forwarding", () => {
  test("forwards a multiple-choice question to QQ and submits the selected labels", async () => {
    const client = createClient()
    let resolvePrompt: (value: unknown) => void = () => {}
    Object.defineProperty(client.session, "prompt", {
      value: () => new Promise((resolve) => { resolvePrompt = resolve }),
    })
    const sessions = new SessionManager(client)
    sessions.switchSession(baseMessage.userId, "session-1", "Test session")
    const router = new EventRouter(client)
    const bridge = createBridge(config, client, router, sessions, bridgeBot)
    const promptRequest = bridge.handleMessage({ ...baseMessage, msgId: "question-prompt", content: "run" })

    for (let turn = 0; turn < 10 && !(router as any).listeners.get("session-1"); turn += 1) {
      await Promise.resolve()
    }
    const eventCallback = (router as any).listeners.get("session-1") as ((event: unknown) => void) | undefined
    if (!eventCallback) throw new Error("Expected question event listener")

    const fetchCalls: Array<{ url: string; init?: RequestInit }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init })
      return new Response("true", { status: 200 })
    }) as typeof fetch
    try {
      eventCallback({
        type: "question.asked",
        properties: {
          id: "question-1",
          sessionID: "session-1",
          questions: [{
            header: "范围",
            question: "选择要处理的模块",
            multiple: true,
            custom: false,
            options: [
              { label: "核心", description: "处理核心模块" },
              { label: "界面", description: "处理界面模块" },
            ],
          }],
        },
      })
      await new Promise((resolve) => setTimeout(resolve, 0))

      await bridge.handleMessage({ ...baseMessage, msgId: "question-answer", content: "1,2" })

      expect(replies[0]).toContain("【范围】 (1/1)")
      expect(replies[0]).toContain("多选用逗号分隔")
      expect(fetchCalls).toHaveLength(1)
      expect(fetchCalls[0]?.url).toBe("http://127.0.0.1/question/question-1/reply")
      expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({ answers: [["核心", "界面"]] })
      expect(replies).toContain("已提交选择，模型继续执行")

      resolvePrompt({ data: { parts: [{ type: "text", text: "continued" }] } })
      await promptRequest
      expect(replies).toContain("continued")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("discovers a pending question by polling when the SSE event is missing", async () => {
    const client = createClient()
    let resolvePrompt: (value: unknown) => void = () => {}
    Object.defineProperty(client.session, "prompt", {
      value: () => new Promise((resolve) => { resolvePrompt = resolve }),
    })
    const sessions = new SessionManager(client)
    sessions.switchSession(baseMessage.userId, "session-1", "Test session")
    const bridge = createBridge(config, client, new EventRouter(client), sessions, bridgeBot)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (!init?.method && String(url).endsWith("/question")) {
        return Response.json([{
          id: "polled-question",
          sessionID: "session-1",
          questions: [{
            question: "继续还是停止？",
            header: "下一步",
            options: [{ label: "继续", description: "继续执行" }],
            multiple: false,
            custom: false,
          }],
        }])
      }
      return new Response("true", { status: 200 })
    }) as typeof fetch
    try {
      const promptRequest = bridge.handleMessage({ ...baseMessage, msgId: "poll-prompt", content: "run" })
      for (let turn = 0; turn < 20 && !replies.some((reply) => reply.includes("继续还是停止")); turn += 1) {
        await Bun.sleep(5)
      }

      expect(replies.some((reply) => reply.includes("继续还是停止"))).toBe(true)
      await bridge.handleMessage({ ...baseMessage, msgId: "poll-answer", content: "1" })
      resolvePrompt({ data: { parts: [{ type: "text", text: "done" }] } })
      await promptRequest
      expect(replies).toContain("done")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
