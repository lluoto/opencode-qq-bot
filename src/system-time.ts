// @input:  fetch (global)
// @output: checkSystemTime, TIME_DRIFT_WARN_SECONDS
// @pos:    根层 - 启动时检测系统时间偏差，防止 SSL 证书 "not yet valid" 错误
//
// 背景：2026-06-01 日志中曾出现
//   ERROR certificate is not yet valid at https://opencode.ai/zen/v1/chat/completions
// 原因是系统时钟偏慢，导致 SSL 证书的 notBefore 晚于本地时间。
// 此模块在 bot 启动时做一次快速时间校验。

const TIME_DRIFT_WARN_SECONDS = 60 // 偏差超过 60 秒就报警
const TIMEOUT_MS = 5_000

export interface TimeCheckResult {
  ok: boolean
  systemTime: string
  serverTime: string | null
  driftSeconds: number
  source: string
}

export async function checkSystemTime(): Promise<TimeCheckResult> {
  const systemTime = Date.now()

  // 依次尝试多个时间源，取第一个成功的
  const sources = [
    { url: "https://opencode.ai/zen/health", label: "opencode.ai" },
    { url: "https://google.com", label: "google.com" },
    { url: "https://www.baidu.com", label: "baidu.com" },
  ]

  for (const { url, label } of sources) {
    try {
      const resp = await fetch(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const dateHeader = resp.headers.get("date")
      if (!dateHeader) continue

      const serverTime = new Date(dateHeader).getTime()
      if (isNaN(serverTime)) continue

      const driftSeconds = Math.round((systemTime - serverTime) / 1000)
      const driftAbs = Math.abs(driftSeconds)
      const ok = driftAbs <= TIME_DRIFT_WARN_SECONDS

      if (!ok) {
        console.error(
          `[timecheck] ⚠ 系统时间偏差过大！\n` +
          `[timecheck]   源: ${label}\n` +
          `[timecheck]   本地: ${new Date(systemTime).toISOString()}\n` +
          `[timecheck]   服务器: ${dateHeader}\n` +
          `[timecheck]   偏差: ${driftSeconds} 秒（超过 ${TIME_DRIFT_WARN_SECONDS} 秒阈值）\n` +
          `[timecheck]   后果: 可能导致 SSL 证书 \"not yet valid\" 错误，AI 请求全部失败`
        )
      } else {
        console.log(`[timecheck] 系统时间正常（偏差 ${driftSeconds} 秒，源: ${label}）`)
      }

      return { ok, systemTime: new Date(systemTime).toISOString(), serverTime: dateHeader, driftSeconds, source: label }
    } catch {
      continue // 换下一个源
    }
  }

  // 所有源都不可达，跳过检查
  console.warn("[timecheck] 无法连接任何时间源，跳过系统时间检查")
  return { ok: true, systemTime: new Date(systemTime).toISOString(), serverTime: null, driftSeconds: 0, source: "none" }
}
