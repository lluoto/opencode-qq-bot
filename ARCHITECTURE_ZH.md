# OpenCode QQ Bot 架构导读

这份文档写给这样的新人：

- 会 Python
- 对 JavaScript / TypeScript 不熟
- 想快速理解这个项目从原始版本到当前改造版到底做了什么

## 一句话理解

这是一个把 `QQ 机器人` 和 `OpenCode AI` 接起来的桥接器。

你在 QQ 里发消息，机器人把消息转给 OpenCode；OpenCode 的回复、进度、确认请求、权限请求，再转回 QQ。

如果你更熟悉 Python，可以把它理解成：

- `src/qq/*` = QQ 平台适配层
- `src/opencode/*` = OpenCode 平台适配层
- `src/bridge.ts` = 主控制器 / 路由器
- `src/commands/*` = 命令系统
- `src/opencode/sessions.ts` = 用户会话状态管理

## 原始项目做什么

原始 openqq bot 的目标比较直接：

1. 接收 QQ 消息
2. 识别命令或普通聊天
3. 把普通聊天发给 OpenCode
4. 等 OpenCode 返回结果
5. 再把结果回复到 QQ

当时已经支持：

- `/new`
- `/stop`
- `/status`
- `/sessions`
- `/model`
- `/agent`
- `/rename`

所以它从一开始就不是“单纯聊天回显”，而是一个带命令系统和会话系统的 AI 机器人。

## 当前改造版增强了什么

当前版本主要把“真实 QQ 使用中的交互问题”补齐了。

已经增强的点：

1. 同时支持 `/command` 和 `\\command`
2. `/sessions` 列出会话后，数字回复会优先用于切换会话
3. 支持 OpenCode 的 `permission.asked` / `permission.updated`
4. 支持“助手先文本确认，再继续执行”的流程
5. 权限提示能更稳地提取真实路径，减少 `undefined`
6. 长任务可以先提示“正在处理中”，并在处理中回推进度

## 代码分层

### 1. `src/index.ts`

程序入口。

相当于 Python 里的 `main.py`。

负责：

- 加载配置
- 初始化 QQ 连接
- 初始化 OpenCode client
- 初始化 Bridge
- 启动整个程序

### 2. `src/qq/*`

QQ 接入层。

你可以把它理解成：

- `gateway.ts` 负责收消息
- `api.ts` / `sender.ts` 负责发消息
- `token.ts` 负责鉴权 token
- `types.ts` 定义 QQ 消息结构

### 3. `src/opencode/*`

OpenCode 接入层。

主要负责：

- 调 OpenCode SDK
- 创建/切换 session
- 订阅 SSE 事件
- 把事件按 `sessionId` 分发回 bridge

### 4. `src/commands/*`

命令系统。

负责：

- 识别 `/new`、`/sessions` 等命令
- 命令参数解析
- 列表型命令后的数字选择

### 5. `src/bridge.ts`

这是整个项目最关键的文件。

它像一个“异步状态机路由器”。

每条 QQ 消息进来，不是直接都发给 AI，而是要先判断它属于哪一种：

1. 命令
2. 待切换会话的数字回复
3. 待权限确认的数字回复
4. 待操作确认的数字回复
5. 普通聊天消息

如果你熟悉 Python，可以把它粗略理解成：

```python
if is_command(msg):
    handle_command()
elif has_pending_session_selection(user):
    handle_session_selection()
elif has_pending_permission(user):
    handle_permission_reply()
elif has_pending_confirmation(user):
    handle_confirmation_reply()
else:
    send_to_opencode()
```

## 当前真实工作流

### 普通聊天

1. QQ 收到消息
2. 进入 `bridge.ts`
3. 如果不是命令，也不是待处理数字回复
4. 调 `promptAsync()` 发给 OpenCode
5. Bridge 持续监听 SSE 事件
6. 如果任务很久，先回“正在处理中”或中间进度
7. 如果 OpenCode 结束，等到 `session.idle`
8. 发最终回复回 QQ

### 会话切换

1. 用户发送 `/sessions` 或 `\\sessions`
2. 机器人列出历史会话
3. 用户回复数字
4. Bridge 优先把这个数字当成“会话切换”，而不是权限回复

### 权限确认

1. OpenCode 在执行工具时触发权限事件
2. EventRouter 把 `permission.asked` 分发到对应 session
3. Bridge 记录 pending permission
4. QQ 显示：允许一次 / 总是允许 / 拒绝
5. 用户回复 `1/2/3`
6. Bridge 调权限 API 回写给 OpenCode

### 操作确认

有些情况 OpenCode 不直接发权限事件，而是先输出普通文本，例如：

```text
Confirm you want me to write only to ...
```

这个不是专门的事件类型，而是助手普通文本。

当前 Bridge 会：

1. 识别这段文本像“确认问题”
2. 记录 pending confirmation
3. 在 QQ 显示“回复 1 确认继续 / 3 取消”
4. 用户回复 `1`
5. Bridge 再向同一个 session 发送 follow-up prompt 继续执行

## 为什么这个项目不只是“调 API”

它真正难的地方不在 SDK 调用，而在“状态和路由”。

因为 QQ 里的一个简单数字：

- 可能是切换会话
- 可能是权限确认
- 可能是操作确认
- 也可能只是普通聊天内容

这个项目现在最核心的价值，就是把这些冲突顺序理清了。

## 现在的限制：单 Bot 模式

当前代码仍然是“单 QQ Bot 配置”的。

证据很直接：

### 配置层只有一套 QQ 凭证

`src/config.ts` 里只有：

- `QQ_APP_ID`
- `QQ_APP_SECRET`

这意味着当前进程默认只服务一个 QQ Bot。

### 会话映射只按 `userId`

`src/opencode/sessions.ts` 里关键数据结构是：

```ts
private sessions = new Map<string, UserSession>()
```

这里的 key 是 `userId`，不是 `(botId, userId)`。

所以如果你把两个 QQ Bot 的消息都喂进同一个 SessionManager：

- 同一个用户在 Bot A 的会话
- 和同一个用户在 Bot B 的会话

会冲突，映射会覆盖。

## 如果要支持两个 Bot，能不能做

能做，而且不算离谱，但要改成“复合键映射”。

### 推荐思路

把当前所有按 `userId` 存储状态的地方，改成按“作用域键”存储：

```ts
scopeKey = `${botId}:${userId}`
```

或者更明确一些：

```ts
scopeKey = `${appId}:${chatType}:${userId}:${groupId ?? "dm"}`
```

### 需要改的地方

1. `MessageContext`

现在只有：

- `userId`
- `groupId`

最好增加：

- `botId` 或 `appId`

### 2. `SessionManager`

把：

```ts
Map<userId, UserSession>
```

改成：

```ts
Map<scopeKey, UserSession>
```

### 3. Bridge 里的 pending 状态

这些也都不能只按 `userId`：

- pending session selection
- pending permission
- pending confirmation
- busyUsers
- greeted

都应该改成按 `scopeKey`。

### 4. 配置层

有两种实现方式：

#### 方式 A：一个进程支持多个 Bot

新增类似：

- `BOTS_JSON=...`

或多个 appId/appSecret 条目，启动多个 gateway/client。

#### 方式 B：每个 Bot 启一个进程

这是更简单、风险更低的方式。

每个进程各自：

- 一套 QQ 凭证
- 一套 Bridge
- 一套 SessionManager

这时就不需要大量改多租户逻辑。

### 工程建议

如果你只是“有两个 QQ Bot 想同时跑”，我更推荐：

1. 先用两个独立进程
2. 每个进程单独配置 `.env`
3. 必要时再考虑做成多 Bot 单进程

因为当前项目结构本质上还是“单 Bot 单上下文”更自然。

## 给新人的阅读顺序

推荐顺序：

1. `README.md`
2. `ARCHITECTURE_ZH.md`（本文件）
3. `src/index.ts`
4. `src/bridge.ts`
5. `src/commands/router.ts`
6. `src/opencode/events.ts`
7. `src/opencode/sessions.ts`
8. `src/opencode/adapter.ts`

## 最后一句话总结

这个项目现在已经不是“QQ 调一下 AI 接口”这么简单。

它是一个：

- 带命令系统
- 带会话系统
- 带权限系统
- 带确认系统
- 带流式事件回推
- 带状态路由优先级

的异步桥接器。

如果你会 Python，可以把它当成一个“面向聊天平台的 asyncio 状态机网关”来看，理解会非常快。
