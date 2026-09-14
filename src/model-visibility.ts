export type VisibleModel = {
  readonly id: string
  readonly label: string
}

export function listVisibleModels(response: unknown, declaredModelIds?: ReadonlySet<string>): VisibleModel[] {
  const responseRecord = toRecord(response)
  const data = responseRecord ? toRecord(responseRecord["data"]) : undefined
  const providers = data ? toRecordArray(data["providers"]) : []
  const visibleModels: VisibleModel[] = []

  for (const provider of providers) {
    if (!isProviderAuthorized(provider, declaredModelIds)) {
      continue
    }

    const providerId = getNonEmptyString(provider["id"])
    if (!providerId) {
      continue
    }

    for (const model of toRecordValues(provider["models"])) {
      if (getNonEmptyString(model["status"]) !== "active") {
        continue
      }

      const modelId = getNonEmptyString(model["id"])
      if (!modelId || (declaredModelIds !== undefined && !declaredModelIds.has(`${providerId}/${modelId}`))) {
        continue
      }

      visibleModels.push({
        id: `${providerId}/${modelId}`,
        label: `${providerId} / ${modelId}`,
      })
    }
  }

  return visibleModels
}

function isProviderAuthorized(
  provider: Readonly<Record<string, unknown>>,
  declaredModelIds: ReadonlySet<string> | undefined,
): boolean {
  return getNonEmptyString(provider["key"]) !== undefined ||
    (getNonEmptyString(provider["source"]) === "config" && declaredModelIds !== undefined)
}

function toRecordArray(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  return Array.isArray(value)
    ? value.map(toRecord).filter((record): record is Readonly<Record<string, unknown>> => record !== undefined)
    : []
}

function toRecordValues(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  const record = toRecord(value)
  return record
    ? Object.values(record)
        .map(toRecord)
        .filter((entry): entry is Readonly<Record<string, unknown>> => entry !== undefined)
    : []
}

function toRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) ? value : undefined
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}
