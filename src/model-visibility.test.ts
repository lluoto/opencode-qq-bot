import { describe, expect, test } from "bun:test"
import { parseConfiguredModelIds } from "./configured-models.js"
import { providersResponseSample } from "./fixtures/providers-response.sample.js"
import { listVisibleModels } from "./model-visibility.js"

describe("listVisibleModels", () => {
  test("keeps only active models explicitly declared in the OpenCode JSONC config", () => {
    const declaredModels = parseConfiguredModelIds(`{
      // These are the only models the user configured.
      "provider": {
        "openai": { "models": { "gpt-5.6": {}, "gpt-5.6-terra": {} } },
        "anthropic": { "options": { "apiKey": "configured-but-unrestricted" } }
      },
    }`)
    const response: unknown = {
      data: {
        providers: [
          {
            id: "openai",
            key: "configured",
            models: {
              "gpt-5.6": { id: "gpt-5.6", status: "active" },
              "gpt-5.6-terra": { id: "gpt-5.6-terra", status: "active" },
              "gpt-5.6-pro": { id: "gpt-5.6-pro", status: "active" },
            },
          },
          {
            id: "anthropic",
            key: "configured",
            models: { "claude-opus": { id: "claude-opus", status: "active" } },
          },
        ],
      },
    }

    expect(listVisibleModels(response, declaredModels)).toEqual([
      { id: "openai/gpt-5.6", label: "openai / gpt-5.6" },
      { id: "openai/gpt-5.6-terra", label: "openai / gpt-5.6-terra" },
    ])
  })

  test("keeps declared models from a configured provider without an SDK key", () => {
    const response: unknown = {
      data: {
        providers: [
          {
            id: "anthropic",
            source: "config",
            models: {
              "claude-sonnet-4-6": { id: "claude-sonnet-4-6", status: "active" },
            },
          },
        ],
      },
    }

    expect(listVisibleModels(response, new Set(["anthropic/claude-sonnet-4-6"]))).toEqual([
      { id: "anthropic/claude-sonnet-4-6", label: "anthropic / claude-sonnet-4-6" },
    ])
  })

  test("returns active models only when their provider has a configured key", () => {
    // Given
    const response: unknown = providersResponseSample

    // When
    const models = listVisibleModels(response)

    // Then
    expect(models).toEqual([
      { id: "keyed-config-provider/config-active", label: "keyed-config-provider / config-active" },
    ])
  })

  test("returns no models when the SDK response is malformed", () => {
    // Given
    const response: unknown = { data: { providers: "not-an-array" } }

    // When
    const models = listVisibleModels(response)

    // Then
    expect(models).toEqual([])
  })

  test("returns no models when providers is a record", () => {
    // Given
    const response: unknown = {
      data: {
        providers: {
          "api-provider": {
            id: "api-provider",
            source: "api",
            env: [],
            models: {
              "api-active": { id: "api-active", providerID: "api-provider", status: "active" },
            },
          },
        },
      },
    }

    // When
    const models = listVisibleModels(response)

    // Then
    expect(models).toEqual([])
  })

  test("returns no models when provider models is an array", () => {
    // Given
    const response: unknown = {
      data: {
        providers: [
          {
            id: "api-provider",
            source: "api",
            env: [],
            models: [
              { id: "api-active", providerID: "api-provider", status: "active" },
            ],
          },
        ],
      },
    }

    // When
    const models = listVisibleModels(response)

    // Then
    expect(models).toEqual([])
  })
})
