# Changelog

## Unreleased

### Added

- 支持 `/mode plan|build`、`/plan`、`/build`，并按 Bot/QQ 用户持久化模式偏好
- 支持将 OpenCode Question 工具的单选、多选和自定义问题转发到 QQ，含 `/question` 轮询兜底
- 增加单实例 PID 锁、OpenCode 内嵌服务器生命周期管理和固定 5 分钟长任务心跳
- 新增 `ARCHITECTURE_ZH.md`，面向熟悉 Python 但不熟悉 TS/JS 的新人说明项目结构、桥接逻辑和多 Bot 可行性
- README 新增最近修复说明、外部 OpenCode 对接说明、变更记录入口
- README 新增提示：启动外部 OpenCode 时应显式指定 host/port，并与 `openqq` 的 `OPENCODE_BASE_URL` 保持一致

### Changed

- `/sessions` 现在直接读取当前连接的 OpenCode server 的真实 session 列表，而不是只依赖 `openqq` 进程内存历史
- 配置 `OPENCODE_BASE_URL` 时，启动阶段改为严格校验外部 OpenCode；不可达时直接报错，而不是自动切回新的内嵌 server
- QQ Gateway 的 auth failure 判断改为结构化 `QQApiError`，只在明确鉴权失败时清理 token cache
- `/command` 与 `\command` 前缀统一支持，`/sessions` 的数字回复优先级高于权限/确认数字回复

### Fixed

- 修复 QQ Gateway 在长时间断网后反复 Resume 过期会话、进程存活但平台显示未登录的问题
- 修复 `/stop` 与已完成模型结果竞争时丢弃有效回复的问题
- 修复长任务硬超时截断、空 prompt 结果、嵌套 provider 错误和模型默认值覆盖会话选择的问题
- 修复 Windows 控制台 CP936 下中文日志显示乱码的问题
- 修复 `\sessions` 被当作普通聊天转给 OpenCode 的问题
- 修复 `permission.asked` 未被桥接到 QQ 的问题
- 修复 QQ 中数字回复被误判为权限确认，导致会话切换失败的问题
- 修复助手先发普通文本确认时，QQ 侧无法用 `1/3` 继续或取消的问题
- 修复权限提示中 `操作：undefined`、`已允许一次：undefined`、`路径：(未提供路径)` 的问题
- 修复长任务进度文本与最终文本重复发送的问题
- 缓解普通 gateway 重连失败导致的反复 `Token refreshed` / `GET /gateway` 问题

### Notes

- 当前 `openqq` 想共享现有 OpenCode 会话时，应连接一个明确可访问的 OpenCode server，而不是依赖随机端口的默认 TUI 内部 server
