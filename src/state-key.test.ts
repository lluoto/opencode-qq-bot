import { describe, expect, test } from "bun:test"
import { deriveStateKey } from "./state-key.js"

describe("deriveStateKey", () => {
  test("derives a C2C key from bot and user IDs", () => {
    expect(deriveStateKey("bot-a", "user-1")).toBe("bot-a:user-1")
  })

  test("derives a group key from bot, group, and user IDs", () => {
    expect(deriveStateKey("bot-a", "user-1", "group-9")).toBe("bot-a:group-9:user-1")
  })

  test("separates the same user across bots", () => {
    expect(deriveStateKey("bot-a", "user-1")).not.toBe(deriveStateKey("bot-b", "user-1"))
  })

  test("separates C2C and group scopes", () => {
    expect(deriveStateKey("bot-a", "user-1")).not.toBe(deriveStateKey("bot-a", "user-1", "group-9"))
  })

  test("rejects an empty bot ID", () => {
    expect(() => deriveStateKey("", "user-1")).toThrow()
  })

  test("rejects an empty user ID", () => {
    expect(() => deriveStateKey("bot-a", "")).toThrow()
  })

  test("rejects an empty group ID when provided", () => {
    expect(() => deriveStateKey("bot-a", "user-1", "")).toThrow()
  })
})
