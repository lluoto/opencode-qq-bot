// @input:  child_process, net
// @output: createOpencodeServer
// @pos:    opencode层 - OpenCode 服务器启动（绕过 bun Windows remapping bug）
// bun Windows 下无法通过 PATH 找到 opencode 命令（全局重映射损坏），
// 所以用完整路径直接启动 opencode server。
import { spawn } from "child_process"
import { createServer } from "net"

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

export async function createOpencodeServer(options: { port: number }): Promise<ServerHandle> {
  const port = options.port
  const url = `http://127.0.0.1:${port}`

  // Check if server is already running
  const alreadyRunning = await waitForPort(port, 2000)
  if (alreadyRunning) {
    console.log(`[embedded-server] OpenCode server already running on ${url}`)
    return {
      url,
      close: () => {
        console.log("[embedded-server] External server — skip shutdown")
      },
    }
  }

  // Start the server process
  console.log(`[embedded-server] Starting opencode server on port ${port}...`)

  // The opencode server needs a writable working directory for its data
  const serverCwd = "C:\\Users\\lluoto\\.local\\share\\opencode"
  if (!require("fs").existsSync(serverCwd)) {
    require("fs").mkdirSync(serverCwd, { recursive: true })
  }

  const proc = spawn(OPENCODE_BIN, ["server", "--port", String(port)], {
    cwd: serverCwd,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: "" },
  })

  let capturedOutput = ""

  proc.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString()
    capturedOutput += text
    console.log(`[opencode-server] ${text.trim()}`)
  })

  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString()
    capturedOutput += text
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
