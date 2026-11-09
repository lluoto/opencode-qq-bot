import { existsSync } from "node:fs"
import { spawn } from "node:child_process"
import { join } from "node:path"

const DEFAULT_SHORTCUT = join(process.env.PUBLIC || "C:\\Users\\Public", "Desktop", "向日葵远程控制.lnk")

export async function launchSunlogin(): Promise<void> {
  if (process.platform !== "win32") throw new Error("向日葵启动仅支持 Windows")
  const shortcut = process.env.SUNLOGIN_SHORTCUT?.trim() || DEFAULT_SHORTCUT
  if (!existsSync(shortcut)) throw new Error(`未找到向日葵桌面快捷方式：${shortcut}`)

  await new Promise<void>((resolve, reject) => {
    const child = spawn("cmd.exe", ["/d", "/s", "/c", `start \"\" \"${shortcut}\"`], {
      windowsHide: true,
      stdio: "ignore",
    })
    child.once("error", reject)
    child.once("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`启动向日葵快捷方式失败（退出码 ${code ?? "未知"}）`))
    })
  })
}
