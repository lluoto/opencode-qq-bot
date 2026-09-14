interface BunRuntime {
  readonly JSONC: { parse(input: string): unknown }
  file(path: string): { text(): Promise<string> }
}

declare const Bun: BunRuntime

export function parseConfiguredModelIds(configText: string): ReadonlySet<string> {
  const parsed = Bun.JSONC.parse(configText)
  if (!isRecord(parsed) || !isRecord(parsed.provider)) {
    return new Set()
  }

  const ids = new Set<string>()
  for (const [providerId, provider] of Object.entries(parsed.provider)) {
    if (!isRecord(provider) || !isRecord(provider.models)) {
      continue
    }
    for (const modelId of Object.keys(provider.models)) {
      ids.add(`${providerId}/${modelId}`)
    }
  }
  return ids
}

export async function loadConfiguredModelIds(): Promise<ReadonlySet<string>> {
  const home = process.env.USERPROFILE ?? process.env.HOME
  if (!home) {
    return new Set()
  }

  try {
    return parseConfiguredModelIds(await Bun.file(`${home}/.config/opencode/opencode.json`).text())
  } catch {
    return new Set()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
