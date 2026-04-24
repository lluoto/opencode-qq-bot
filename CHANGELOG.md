# Changelog

## Unreleased

### Added

- 新增 `ARCHITECTURE_ZH.md`，面向熟悉 Python 但不熟悉 TS/JS 的新人说明项目结构、桥接逻辑和多 Bot 可行性
- README 新增最近修复说明、外部 OpenCode 对接说明、变更记录入口

### Changed

- `/sessions` 现在直接读取当前连接的 OpenCode server 的真实 session 列表，而不是只依赖 `openqq` 进程内存历史
- 配置 `OPENCODE_BASE_URL` 时，启动阶段改为严格校验外部 OpenCode；不可达时直接报错，而不是自动切回新的内嵌 server
- QQ Gateway 的 auth failure 判断改为结构化 `QQApiError`，只在明确鉴权失败时清理 token cache
- `/command` 与 `\command` 前缀统一支持，`/sessions` 的数字回复优先级高于权限/确认数字回复

### Fixed

- 修复 `\sessions` 被当作普通聊天转给 OpenCode 的问题
- 修复 `permission.asked` 未被桥接到 QQ 的问题
- 修复 QQ 中数字回复被误判为权限确认，导致会话切换失败的问题
- 修复助手先发普通文本确认时，QQ 侧无法用 `1/3` 继续或取消的问题
- 修复权限提示中 `操作：undefined`、`已允许一次：undefined`、`路径：(未提供路径)` 的问题
- 修复长任务进度文本与最终文本重复发送的问题
- 缓解普通 gateway 重连失败导致的反复 `Token refreshed` / `GET /gateway` 问题

### Notes

- 当前 `openqq` 想共享现有 OpenCode 会话时，应连接一个明确可访问的 OpenCode server，而不是依赖随机端口的默认 TUI 内部 server
