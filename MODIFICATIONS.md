# OpenCode QQ Bot 修改日志

## 修改时间: 2026-04-11

## 1. 核心问题诊断

### 问题1: 连接现有服务器失败
- **现象**: 启动时尝试连接 localhost:4096 但连接被拒绝
- **原因**: SDK 的 createOpencodeServer 使用 `spawn("opencode", ...)` 但 opencode 不在 PATH
- **修复**: 创建 embedded-server.ts 直接调用 opencode-cli.exe 完整路径

### 问题2: 无法启动独立服务器
- **现象**: createOpencodeServer 抛出 "Server exited with code 0"
- **原因**: SDK 找不到 opencode CLI，需要使用完整路径 `C:\Users\lluoto\AppData\Local\OpenCode\opencode-cli.exe`
- **修复**: 修改 embedded-server.ts 使用绝对路径

### 问题3: 错误消息显示 [object Object]
- **现象**: session.error 时显示 "[object Object]" 而非实际错误
- **原因**: toErrorMessage 函数只处理顶层 error.message
- **修复**: 更新 bridge.ts:toErrorMessage 提取嵌套的 error.data.message

### 问题4: API 认证失败 (401) - 仍存在
- **现象**: "Header中未收到Authorization参数，无法进行身份验证"
- **原因**: OpenCode 没有从环境变量读取 API key，需要通过 `opencode auth login` 设置或使用正确格式
- **状态**: 未解决

## 2. 修改的文件

### src/index.ts (已修改)
- 移除对 @opencode-ai/sdk 的 createOpencodeServer 依赖
- 改用本地 embedded-server.ts

### src/opencode/embedded-server.ts (新建)
- 使用绝对路径调用 opencode-cli.exe
- 添加现有服务器检测逻辑
- 从 .env 文件加载 API keys

### src/opencode/events.ts (已修改)
- 简化日志输出
- 修复 session ID 提取

### src/opencode/client.ts (已修改)
- 添加超时参数和调试日志

### src/bridge.ts (已修改)
- 修复错误消息提取

---

## 终端日志 (2026-04-11 12:29-12:49)

```
PS C:\Users\lluoto> openqq
[index] 启动 OpenCode 服务器...
[embedded] 检查现有服务器...
[embedded] 无现有服务器，尝试启动新的...
[embedded] 启动 OpenCode 服务器 on port 4096
[embedded] Loaded API keys: [ "ZHIPU_API_KEY", "DEEPSEEK_API_KEY" ]
[embedded] Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.
[embedded] opencode server listening on http://127.0.0.1:4096
[embedded] 服务器已就绪 at http://127.0.0.1:4096
[index] OpenCode 服务器已启动: http://127.0.0.1:4096
[client] Creating client for: http://127.0.0.1:4096
[client] Running health check...
[client] Health check passed, sessions: 17
[index] OpenCode 连接成功
[events] 连接事件流...
[events] 已连接事件流
[events] 事件: server.connected sessionID: undefined
[index] OpenCode QQ Bot 已启动
[index] QQ Gateway 已就绪

[qqbot-api] >>> POST .../messages
[qqbot-api] <<< Body: {"content": "可用命令：\n/new - 创建新会话..."

[events] 事件: session.created sessionID: ses_2837ada6dffefbB062bs7W8CZZ
[bridge] Sending prompt to session: ses_2837ada6dffefbB062bs7W8CZZ
[bridge] Body: {"parts": [{"type": "text", "text": "verify connect to em server lluoto dir by vscode"}]}
[bridge] Prompt started for session: ses_2837ada6dffefbB062bs7W8CZZ
[events] 事件: message.updated sessionID: ses_2837ada6dffefbB062bs7W8CZZ
[bridge] Event received: message.updated
[events] 事件: message.part.updated sessionID: ses_2837ada6dffefbB062bs7W8CZZ
[bridge] Event received: message.part.updated
[bridge] Text updated: verify connect to em server lluoto dir by vscode
[events] 事件: session.status sessionID: ses_2837ada6dffefbB062bs7W8CZZ
[bridge] Session status: { type: "busy" }

[bridge] Prompt result: {
  "data": {
    "info": {
      "modelID": "glm-5",
      "providerID": "z-ai",
      "error": {
        "name": "APIError",
        "data": {
          "message": "Header中未收到Authorization参数，无法进行身份验证。",
          "statusCode": 401,
          "metadata": { "url": "https://open.bigmodel.cn/api/paas/v4/chat/completions" }
        }
      }
    }
  }
}

[events] 事件: session.error sessionID: ses_2837ada6dffefbB062bs7W8CZZ
[bridge] Session error: { name: "APIError", data: { message: "Header中未收到Authorization参数..." }}
[bridge] Session finished with text: verify connect to em server lluoto dir by vscode

[qqbot-api] >>> POST .../messages
[qqbot-api] <<< Body: {"content": "处理失败：Header中未收到Authorization参数，无法进行身份验证。"}
```

## 3. API 认证问题分析

### 当前配置
- opencode.json 配置了 z-ai provider，baseURL: https://open.bigmodel.cn/api/paas/v4
- 模型: glm-5

### 问题根因
即使加载了 ZHIPU_API_KEY 环境变量，OpenCode server 也没有读取它。OpenCode 需要：
1. 使用 `opencode auth login` 交互式配置，或
2. 在 opencode.json 中配置 apiKey (不安全)

### 可能的解决方案
1. 运行 `opencode auth login` 配置 Z.AI/智谱 API key
2. 修改 opencode.json 添加 apiKey (需要重新启动 server)

## 4. 配置

### Bot 目录
```
C:\Users\lluoto\.bun\install\global\node_modules\opencode-qq-bot
```

### .env 文件
```
C:\Users\lluoto\.openqq\.env
```

### OpenCode 配置
```
C:\Users\lluoto\.config\opencode\opencode.json
```

## 5. 使用说明

```powershell
# 启动
openqq

# 创建新会话
/new
```

## 6. 待解决问题

- [ ] API key 认证 - 需要通过 `opencode auth login` 配置

---

## 8. 终端日志复查结论 (2026-04-17)

### 本次结论
- 当前贴出的终端日志里，`127.0.0.1:4096` **没有在请求处理中途 shutdown**。
- 当前失败链路是：`QQ 消息 -> OpenCode session.prompt -> z-ai/glm-5 返回 401 -> bot 回复失败信息`。
- 所以本次“回复超时/超过 QQ 命令响应时间”的直接原因，不是本次日志里的 4096 进程立刻退出，而是 bot 对普通消息会一直等模型完成后再回复，慢请求或失败请求时容易让 QQ 侧看起来像“超时”或触发重复投递。

### 当前日志中的阻塞点
- `providerID: "z-ai"`
- `modelID: "glm-5"`
- `error.data.message: "Header中未收到Authorization参数，无法进行身份验证。"`

### 本次修复
1. **增加 QQ 重复消息去重**
   - 根据 `msgId` 记录最近 10 分钟内已处理的消息。
   - 如果 QQ 因为等待过久而重投同一条消息，bot 不会重复执行同一个请求。

2. **增加长请求的即时回执**
   - 普通消息处理超过 2 秒时，先回复：`正在处理中，完成后继续回复，请稍候。`
   - 这样即使模型很慢，QQ 端也能先收到一个及时响应。

3. **避免活跃请求期间触发 4096 健康检查重启**
   - 当 `busyUsers.size > 0` 时，跳过 `client.session.list()` 健康检查。
   - 这样可以避免长任务处理中，watchdog 误判服务异常并重启本地 4096 server。

### 涉及文件
- `src/bridge.ts`
  - 增加 `hasActiveRequests()`
  - 增加重复消息去重
  - 增加 2 秒后发送“处理中”提示
- `src/index.ts`
  - 健康检查前先判断是否有活跃请求

### 仍未解决的问题
- `z-ai / glm-5` 的 API key 仍未被 OpenCode provider 正确使用。
- 即使 bot 已把 `.env` 传给嵌入式 server，当前 provider 仍返回 401。
- 这个问题需要继续在 OpenCode provider 配置或 `opencode auth login` 路径上处理。

---

## 9. 工作流复盘结论 (QQ -> Gateway -> Bridge -> OpenCode -> SSE -> QQ)

### 现象
- QQ Gateway 正常
- `127.0.0.1:4096` 正常
- `session.prompt()` 成功发起
- OpenCode 创建了 assistant message
- 之后持续收到 `session.status = retry`
- 重试信息为：`Cannot connect to API: Unable to connect. Is the computer able to access the url?`
- 最终 Bridge 5 分钟超时，回复 QQ：`处理失败：AI 响应超时（5 分钟）`

### 根因
根因不在 QQ，也不在本地 OpenCode server 启动，而在 **OpenCode sidecar 无法访问上游模型 API**。

从工作流上看，真正卡住的位置是：

`session.prompt() -> 上游模型请求(OpenAI-compatible endpoint) -> 持续 retry -> 无 session.idle / 无 session.error -> Bridge 超时`

### 暴露出的 Bridge 逻辑问题
旧逻辑还有两个误导性问题：

1. **把用户输入当成 AI 输出**
   - `message.part.updated` 里最先收到的是 user message 的 `hello`
   - 旧代码直接把这段文本写进 `latestText`
   - 所以日志里会看到：`latestText so far: hello`
   - 这不是真正的 AI 回复

2. **网络不可达时等待过久**
   - OpenCode 一直发 `session.status.retry`
   - 旧 Bridge 没有把这种重复 retry 当成失败条件
   - 结果一直等到 5 分钟超时，才告诉 QQ 用户失败

### 本次补丁
1. **只接受 assistant message 的文本片段**
   - 在 `message.updated` 中记录 assistant message id
   - 只有 `message.part.updated.part.messageID === assistantMessageId` 时，才更新 `latestText`

2. **连接类 retry 提前失败**
   - 如果 `session.status.type === retry`
   - 且 message 包含 `Cannot connect to API`
   - 连续出现 2 次后，立即失败并返回：
   - `AI 服务连接失败，请检查 OPENAI_BASE_URL / 代理配置`

### 涉及文件
- `src/bridge.ts`

### 结果
- 不会再把用户的 `hello` 误判为 AI 返回内容
- 不会再因为上游 API 无法连接而白等 5 分钟
- QQ 用户能更快收到明确的网络/代理错误提示

---

## 10. Headless Server / TUI 会话分离结论

### 现象
- QQ 指令已经真实进入 OpenCode，并执行了工具调用
- 但桌面 TUI 里看不到同一条任务

### 原因
- `openqq` 当前使用的是 embedded headless server：`http://127.0.0.1:4096`
- 这是一个独立后端
- 桌面 OpenCode / 普通 TUI 没有自动 attach 到这个后端
- 所以看起来像“QQ 指令没传进去”，其实是“传进了另一个 server”

### 日志证据
- 已创建独立 session，例如：`ses_2ad2969a4ffePeIFu2Opr1pp4X`
- 已真实执行 tool calls：
  - `ssh cuixi@10.19.25.48 ...`
  - 读取远程 `cg_trajectory_analysis.py`
  - 检查输出目录
  - 尝试修改远程脚本

### 暴露出的 Bridge 问题
- 长任务过程中，assistant 已经输出了 commentary 文本
- 但因为没有及时等到 `session.idle`，旧逻辑仍然在 5 分钟后返回：`AI 响应超时（5 分钟）`

### 本次修复
- 当 5 分钟超时发生时：
  - 如果已经有有效 assistant 文本 `latestText`
  - 不再报失败
  - 改为把当前进度返回给 QQ，并附加提示：
  - `任务仍在继续，QQ 等待窗口已到上限...`

### 效果
- 长任务不再被一律误判成失败
- QQ 用户至少能收到当前进度摘要
- 真正需要继续观察详细过程时，可通过：
  - `opencode attach http://127.0.0.1:4096`
  - 连接到与 `openqq` 相同的 headless backend

---

## 11. 长任务分段回传

### 问题
- 即使修复了“超时不再直接报失败”，QQ 用户仍然可能在长任务期间长时间看不到新进度。

### 本次修复
- 在 `src/bridge.ts` 中增加 `onProgress` 回调
- 当 assistant message 的 `text` part 持续增长时：
  - 文本长度达到可读阈值
  - 且距离上次进度回传超过 15 秒
  - 就主动向 QQ 发送一条中途进度

### 回传格式
- 中途进度：
  - `<assistant 当前文本>`
  - `[处理中，任务仍在继续...]`

### 结果
- 长任务不必等到 5 分钟才看到内容
- 有 commentary / 分析文本时会提前回传到 QQ
- 最终若仍未 `session.idle`，超时也会返回最后一段有效文本，而不是直接报失败

---

## 12. QQ 权限确认与后台终止

### 问题
- headless backend 中如果遇到 `permission.asked`，原先只能在 attach/TUI 里处理
- 在纯 QQ 流程里会卡住，看起来像任务“还在后台但不可视”

### 本次修复
1. `permission.updated` 事件进入桥接层
2. bot 将权限请求转发到 QQ
3. 用户可直接在 QQ 回复：
   - `1` 允许一次
   - `2` 总是允许
   - `3` 拒绝
4. 当 5 分钟超时发生时：
   - 先写日志
   - 再调用 `client.session.abort()` 主动终止后端 session

### 同步的可视化配置
- `.env` 增加：
  - `OPENCODE_TUI_ATTACH_URL=http://127.0.0.1:4096`
  - `OPENCODE_LOCAL_TOOL_DIR=C:\Users\lluoto\.local\share\opencode\tool-output`

### 结果
- 权限请求不再只能在另一个 server/TUI 里手工点选
- QQ 可直接处理授权
- 超时的后台任务不会无限挂住
