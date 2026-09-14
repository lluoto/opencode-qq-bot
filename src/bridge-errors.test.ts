import { describe, expect, test } from "bun:test"
import { getPromptError, getRetryPartErrorMessage, isQuotaRetryMessage, mergePartText, toUserFacingError } from "./bridge.js"

describe("toUserFacingError", () => {
  test("maps exhausted free-model quota to tomorrow retry guidance", () => {
    const error = { data: { message: "Insufficient Balance", statusCode: 402 } }

    expect(toUserFacingError(error, {
      providerID: "opencode",
      modelID: "deepseek-v4-flash-free",
    })).toBe("免费模型今日额度已用尽，请明天再试")
  })

  test("preserves paid-model balance errors", () => {
    const error = { data: { message: "Insufficient Balance", statusCode: 402 } }

    expect(toUserFacingError(error, {
      providerID: "deepseek",
      modelID: "deepseek-v4-pro",
    })).toBe("Insufficient Balance")
  })

  test("preserves unrelated errors", () => {
    expect(toUserFacingError(new Error("连接失败"))).toBe("连接失败")
  })

  test("maps unavailable upstream endpoints to model-switch guidance", () => {
    expect(toUserFacingError(new Error("Error from provider (Console): Upstream request failed: Endpoint is unavailable.")))
      .toBe("当前模型上游服务不可用，请稍后重试或切换模型")
  })

  test("recognizes the free-model rate-limit retry state", () => {
    expect(isQuotaRetryMessage("Rate limit exceeded. Please try again later.")).toBe(true)
  })
})

describe("getRetryPartErrorMessage", () => {
  test("extracts message from a RetryPart ApiError", () => {
    const retryPart = {
      id: "p1",
      sessionID: "s1",
      messageID: "m1",
      type: "retry",
      attempt: 1,
      error: {
        name: "APIError",
        data: {
          message: "Rate limit exceeded. Please try again later.",
          isRetryable: true,
        },
      },
      time: { created: 0 },
    }

    expect(getRetryPartErrorMessage(retryPart)).toBe("Rate limit exceeded. Please try again later.")
  })

  test("returns undefined for non-retry parts", () => {
    expect(getRetryPartErrorMessage({ id: "p2", type: "text", text: "hi" })).toBeUndefined()
  })

  test("returns undefined when retry error has no message", () => {
    expect(getRetryPartErrorMessage({ id: "p3", type: "retry", attempt: 2, error: {} })).toBeUndefined()
  })
})

describe("getPromptError", () => {
  test("extracts the nested assistant error returned by session.prompt", () => {
    const error = { name: "APIError", data: { message: "Endpoint is unavailable" } }

    expect(getPromptError({ data: { info: { error } } })).toBe(error)
  })
})

describe("mergePartText", () => {
  test("accumulates delta from message.part.updated", () => {
    expect(mergePartText("已有内容", "", "新的内容")).toBe("已有内容新的内容")
  })

  test("prefers complete part text over accumulated delta", () => {
    expect(mergePartText("已有内容", "完整内容", "被覆盖的增量")).toBe("完整内容")
  })
})
