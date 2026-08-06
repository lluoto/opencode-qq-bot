// @input:  child_process, net
// @output: createOpencodeServer
// @pos:    opencode层 - OpenCode 服务器启动（绕过 bun Windows remapping bug）
// bun Windows 下无法通过 PATH 找到 opencode 命令（全局重映射损坏），
// 所以用完整路径直接启动 opencode server。
import { spawn, execFileSync } from "child_process"
import { createServer } from "net"
import { readFileSync } from "fs"

interface ServerHandle {
  url: string
  close: () => void
}

// Full path to opencode.exe — avoids bun's broken global binary remapping
const OPENCODE_BIN = "C:\\Users\\lluoto\\.bun\\bin\\opencode.exe"

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const sock = createServer()
      sock.once("error", () => resolve(true))
      sock.once("listening", () => {
        sock.close()
        resolve(false)
      })
      sock.listen(port, "127.0.0.1")
    })
    if (open) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

// Windows: 查找占用指定端口的进程 PID
function findPidOnPort(port: number): number | null {
  try {
    const out = execFileSync("netstat", ["-ano", "-p", "tcp"], {
      encoding: "utf-8",
      windowsHide: true,
    })
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/TCP\s+\S*:(\d+)\s+\S+\s+LISTENING\s+(\d+)/)
      if (m && Number(m[1]) === port) {
        return Number(m[2])
      }
    }
  } catch {
    // netstat failed — ignore
  }
  return null
}

// 检查进程是否存活
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// 获取进程的父进程 PID
function getParentPid(pid: number): number | null {
  try {
    const out = execFileSync("wmic", ["process", "where", `ProcessId=${pid}`, "get", "ParentProcessId"], {
      encoding: "utf-8",
      windowsHide: true,
    })
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    // 第一行是表头 "ParentProcessId"
    const val = lines.find((l) => /^\d+$/.test(l))
    return val ? Number(val) : null
  } catch {
    return null
  }
}

// 杀掉指定 PID 的进程树（包含子进程）
function killProcessTree(pid: number): void {
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf-8",
      windowsHide: true,
      stdio: "ignore",
    })
    console.log(`[embedded-server] Killed orphan opencode server (PID ${pid})`)
  } catch (e) {
    console.error(`[embedded-server] Failed to kill PID ${pid}:`, (e as Error).message)
  }
}

export async function createOpencodeServer(options: { port: number }): Promise<ServerHandle> {
  const port = options.port
  const url = `http://127.0.0.1:${port}`

  // Check if server is already running
  const alreadyRunning = await waitForPort(port, 2000)
  if (alreadyRunning) {
    // 区分孤儿 server 与手动启动的 server：
    // 如果占用端口的进程是 opencode server 且其父进程已不存在（孤儿），
    // 说明是之前被强杀的 bot 遗留的泄漏实例，必须杀掉重建。
    const pid = findPidOnPort(port)
    if (pid !== null) {
      const parentPid = getParentPid(pid)
      const isOrphan = parentPid !== null && !isProcessAlive(parentPid)
      if (isOrphan) {
        console.log(`[embedded-server] Port ${port} held by orphan server PID ${pid} (parent ${parentPid} dead), killing it...`)
        killProcessTree(pid)
        // 等待端口释放
        const released = await new Promise<boolean>((resolve) => {
          const deadline = Date.now() + 5000
          const check = () => {
            waitForPort(port, 500).then((open) => {
              if (!open || Date.now() > deadline) {
                resolve(!open)
              } else {
                setTimeout(check, 500)
              }
            })
          }
          check()
        })
        if (!released) {
          console.log("[embedded-server] Port not released after killing orphan — will reuse anyway")
        }
      } else {
        console.log(`[embedded-server] OpenCode server already running on ${url} (PID ${pid})`)
        return {
          url,
          close: () => {
            console.log("[embedded-server] External server — skip shutdown")
          },
        }
      }
    } else {
      console.log(`[embedded-server] OpenCode server already running on ${url}`)
      return {
        url,
        close: () => {
          console.log("[embedded-server] External server — skip shutdown")
        },
      }
    }
  }

  // Start the server process
  console.log(`[embedded-server] Starting opencode server on port ${port}...`)

  // The opencode server needs a writable working directory for its data
  const serverCwd = "C:\\Users\\lluoto\\.local\\share\\opencode"
  if (!require("fs").existsSync(serverCwd)) {
    require("fs").mkdirSync(serverCwd, { recursive: true })
  }
  // The server also needs a `server` subdirectory
  const serverDir = serverCwd + "\\server"
  if (!require("fs").existsSync(serverDir)) {
    require("fs").mkdirSync(serverDir)
    console.log(`[embedded-server] Created server directory: ${serverDir}`)
  }

  const opencodeConfigPath = "C:\\Users\\lluoto\\.config\\opencode\\opencode.json"
  let configContent = ""
  try {
    configContent = readFileSync(opencodeConfigPath, "utf-8")
    // Strip UTF-8 BOM if present (0xEF,0xBB,0xBF → \uFEFF)
    configContent = configContent.replace(/^\uFEFF/, "")
    console.log(`[embedded-server] Loaded config from ${opencodeConfigPath}`)
  } catch (e) {
    console.log(`[embedded-server] No config file found: ${(e as Error).message}`)
  }

  const proc = spawn(OPENCODE_BIN, ["server", "--port", String(port)], {
    cwd: serverCwd,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: "",
      // Don't set OPENCODE_CONFIG_CONTENT — let server auto-load from ~/.config/opencode/opencode.json
      // which avoids conflicts with the provider loading mechanism
      USERPROFILE: process.env.USERPROFILE || "C:\\Users\\lluoto",
    },
  })

  let capturedOutput = ""
  const MAX_CAPTURED_OUTPUT = 64 * 1024  // 只保留最近64KB，防止内存泄漏

  const appendCaptured = (text: string): void => {
    capturedOutput += text
    if (capturedOutput.length > MAX_CAPTURED_OUTPUT) {
      capturedOutput = capturedOutput.slice(-MAX_CAPTURED_OUTPUT)
    }
  }

  proc.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString()
    appendCaptured(text)
    console.log(`[opencode-server] ${text.trim()}`)
  })

  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString()
    appendCaptured(text)
    console.log(`[opencode-server:err] ${text.trim()}`)
  })

  proc.on("error", (err) => {
    console.error(`[embedded-server] Failed to start opencode: ${err.message}`)
  })

  // Wait for server to be ready
  const ready = await waitForPort(port, 30000)

  if (!ready) {
    // Check if process is still alive
    const exited = proc.exitCode !== null
    if (exited) {
      throw new Error(
        `OpenCode server exited with code ${proc.exitCode}. Output:\n${capturedOutput}`,
      )
    }
    throw new Error(
      `OpenCode server did not start on port ${port} within 30s.\nOutput:\n${capturedOutput}`,
    )
  }

  console.log(`[embedded-server] OpenCode server ready: ${url}`)
  return {
    url,
    close: () => {
      console.log("[embedded-server] Shutting down OpenCode server...")
      proc.kill()
    },
  }
}
