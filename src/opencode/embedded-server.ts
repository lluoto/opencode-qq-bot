import { spawn } from "node:child_process"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { readFileSync, existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"

const OPENCODE_CLI = "C:\\Users\\lluoto\\AppData\\Local\\OpenCode\\opencode-cli.exe"
const DEFAULT_PORT = 4096

function loadEnvVars(): Record<string, string> {
  const envFile = join(homedir(), ".openqq", ".env")
  const vars: Record<string, string> = { ...process.env }
  
  if (existsSync(envFile)) {
    const content = readFileSync(envFile, "utf-8")
    for (const line of content.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eqIdx = trimmed.indexOf("=")
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim()
        const val = trimmed.slice(eqIdx + 1).trim()
        vars[key] = val;
      }
    }
  }
  if (vars["ZHIPU_API_KEY"]) {
      vars["Z_AI_API_KEY"] = vars["ZHIPU_API_KEY"];
      vars["DEEPSEEK_API_KEY"] = vars["DEEPSEEK_API_KEY"];
    }
  console.log("[embedded] Loaded API keys:", Object.keys(vars).filter(k => k.includes("KEY") || k.includes("Z_AI")))
  return vars
}

export class EmbeddedServer {
  private proc: any = null
  private url: string = ""
  private started = false
  private isOwner = false

  async start(port = DEFAULT_PORT): Promise<{ url: string; close: () => void }> {
    const testUrl = `http://127.0.0.1:${port}`
    
    // Try to connect to existing server first
    console.log("[embedded] 尝试链接...")
    try {
      const testClient = createOpencodeClient({ baseUrl: testUrl })
      await testClient.session.list()
      console.log("[embedded] 连接现有服务器")
      this.url = testUrl
      this.started = true
      this.isOwner = false
      return { url: this.url, close: () => {} }
    } catch {
      console.log("[embedded] 无法连接到现有服务器，正在启动新的服务器...")
    }

    if (this.started) {
      return { url: this.url, close: () => this.close() }
    }

    return new Promise((resolve, reject) => {
      console.log("[embedded] connecting to OpenCode on port", port)
      const serverEnv = loadEnvVars()
      
      this.proc = spawn(OPENCODE_CLI, ["serve", `--port=${port}`, "--hostname=127.0.0.1"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...serverEnv },
      })

      let output = ""
      let resolved = false

      this.proc.stdout?.on("data", (chunk: Buffer) => {
        if (resolved) return
        output += chunk.toString()
        console.log("[embedded]", chunk.toString().trim())
        
        const line = chunk.toString().trim()
        if (line.startsWith("opencode server listening")) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/)
          if (match) {
            this.url = match[1]
            this.started = true
            this.isOwner = true
            resolved = true
            console.log("[embedded] 服务器已启动 at", this.url)
            resolve({ url: this.url, close: () => this.close() })
          }
        }
      })

      this.proc.stderr?.on("data", (chunk: Buffer) => {
        console.log("[embedded stderr]", chunk.toString().trim())
      })

      this.proc.on("error", (err: Error) => {
        console.error("[embedded] Error:", err)
        reject(err)
      })

      this.proc.on("exit", (code: number) => {
        if (!resolved) {
          console.error("[embedded] 服务器退出，代码", code)
          reject(new Error(`Server exited with code ${code}`))
        }
      })

      setTimeout(() => {
        if (!resolved) {
          this.proc?.kill()
          reject(new Error("Timeout waiting for server to start"))
        }
      }, 30000)
    })
  }

  close(): void {
    if (this.proc && this.isOwner) {
      console.log("[embedded] 关闭服务器")
      this.proc.kill()
      this.proc = null
      this.started = false
    }
  }
}

export async function createOpencodeServer(options?: { port?: number }): Promise<{ url: string; close: () => void }> {
  const server = new EmbeddedServer()
  return server.start(options?.port ?? DEFAULT_PORT)
}
