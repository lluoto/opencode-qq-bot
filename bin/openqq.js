#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

if (process.platform === "win32") {
  // Bun writes UTF-8, while legacy Windows consoles often still expect CP936.
  // The code page belongs to the shared console, so chcp in an attached child
  // updates it for this process without requiring native FFI.
  spawnSync("chcp.com", ["65001"], { stdio: "ignore", windowsHide: true })
  process.stdout.setDefaultEncoding("utf8")
  process.stderr.setDefaultEncoding("utf8")
  if (!process.stdout.isTTY) {
    process.stdout.write("\uFEFF")
  }
}

const logDirectory = process.env.OPENQQ_LOG_DIR ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".openqq")
const utf8LogFile = join(logDirectory, "openqq-utf8.log")
const instanceLockFile = join(logDirectory, "openqq-instance.lock")
mkdirSync(logDirectory, { recursive: true })
if (!existsSync(utf8LogFile)) {
  writeFileSync(utf8LogFile, "\uFEFF", "utf8")
}

for (const method of ["log", "error", "warn"]) {
  const original = console[method]
  console[method] = (...args) => {
    appendFileSync(utf8LogFile, `${args.map(String).join(" ")}\n`, "utf8")
    original(...args)
  }
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readLockOwner() {
  try {
    return Number.parseInt(readFileSync(instanceLockFile, "utf8").trim(), 10)
  } catch {
    return undefined
  }
}

function acquireInstanceLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(instanceLockFile, `${process.pid}\n`, { encoding: "utf8", flag: "wx" })
      process.once("exit", () => {
        if (readLockOwner() === process.pid) {
          try {
            unlinkSync(instanceLockFile)
          } catch {}
        }
      })
      return
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      const owner = readLockOwner()
      if (isProcessRunning(owner)) {
        console.error(`[openqq] Another OpenQQ instance is already running (PID ${owner}).`)
        process.exit(1)
      }
      try {
        unlinkSync(instanceLockFile)
      } catch {}
    }
  }
  throw new Error("Unable to acquire the OpenQQ instance lock")
}

acquireInstanceLock()

await import("../src/index.ts")
