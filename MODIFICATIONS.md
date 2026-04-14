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