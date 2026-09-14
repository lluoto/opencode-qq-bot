import { expect, test } from "bun:test"

test("passes the isolated per-App-ID token lifecycle suite", () => {
  // Given
  const command = [
    process.execPath,
    "test",
    "./test/qq/api.cases.ts",
    "./test/qq/refresh-lifecycle.cases.ts",
  ] as const

  // When
  const result = Bun.spawnSync({
    cmd: command,
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  })

  // Then
  if (result.exitCode !== 0) {
    console.error(new TextDecoder().decode(result.stdout))
    console.error(new TextDecoder().decode(result.stderr))
  }
  expect(result.exitCode).toBe(0)
})
