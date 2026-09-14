export function deriveStateKey(botId: string, userId: string, groupId?: string): string {
  if (botId.length === 0 || userId.length === 0 || groupId === "") {
    throw new RangeError("State key identifiers must be non-empty")
  }

  return groupId ? `${botId}:${groupId}:${userId}` : `${botId}:${userId}`
}
