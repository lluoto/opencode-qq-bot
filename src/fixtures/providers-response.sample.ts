import type { ConfigProvidersResponse, Model, Provider } from "@opencode-ai/sdk"

type SanitizedModel = Pick<Model, "id" | "providerID" | "name" | "status">

type SanitizedProvider = Pick<Provider, "id" | "name" | "source" | "env" | "key"> & {
  readonly models: Readonly<Record<string, SanitizedModel>>
}

type SanitizedProvidersResponse = {
  readonly data: Pick<ConfigProvidersResponse, "default"> & {
    readonly providers: readonly SanitizedProvider[]
  }
}

export const providersResponseSample = {
  data: {
    providers: [
      {
        id: "api-provider",
        name: "API Provider",
        source: "api",
        env: [],
        models: {
          "api-active": { id: "api-active", providerID: "api-provider", name: "API Active", status: "active" },
          "api-alpha": { id: "api-alpha", providerID: "api-provider", name: "API Alpha", status: "alpha" },
        },
      },
      {
        id: "env-provider",
        name: "Environment Provider",
        source: "env",
        env: ["ENV_PROVIDER_KEY"],
        models: {
          "env-active": { id: "env-active", providerID: "env-provider", name: "Env Active", status: "active" },
          "env-beta": { id: "env-beta", providerID: "env-provider", name: "Env Beta", status: "beta" },
        },
      },
      {
        id: "empty-env-provider",
        name: "Empty Environment Provider",
        source: "env",
        env: [],
        models: {
          "empty-env-active": {
            id: "empty-env-active",
            providerID: "empty-env-provider",
            name: "Empty Env Active",
            status: "active",
          },
        },
      },
      {
        id: "keyed-config-provider",
        name: "Keyed Config Provider",
        source: "config",
        env: [],
        key: "configured-key",
        models: {
          "config-active": {
            id: "config-active",
            providerID: "keyed-config-provider",
            name: "Config Active",
            status: "active",
          },
          "config-deprecated": {
            id: "config-deprecated",
            providerID: "keyed-config-provider",
            name: "Config Deprecated",
            status: "deprecated",
          },
        },
      },
      {
        id: "unkeyed-config-provider",
        name: "Unkeyed Config Provider",
        source: "config",
        env: [],
        key: "",
        models: {
          "unkeyed-config-active": {
            id: "unkeyed-config-active",
            providerID: "unkeyed-config-provider",
            name: "Unkeyed Config Active",
            status: "active",
          },
        },
      },
      {
        id: "custom-provider",
        name: "Custom Provider",
        source: "custom",
        env: [],
        models: {
          "custom-active": {
            id: "custom-active",
            providerID: "custom-provider",
            name: "Custom Active",
            status: "active",
          },
        },
      },
    ],
    default: {},
  },
} satisfies SanitizedProvidersResponse
