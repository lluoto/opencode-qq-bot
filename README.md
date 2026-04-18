# OpenCode QQ Bot

Chat with OpenCode AI assistant via QQ bot.

## Features

- Connect QQ to OpenCode server
- Send messages and get AI responses
- Support commands: /new, /status, /sessions, /model, /agent
- Accept both `/command` and `\command` prefixes in QQ chat
- Auto-start embedded OpenCode server (standalone mode)
- Or connect to existing OpenCode server (via AstrBot)
- Load API keys from .env file
- Forward long-task progress back to QQ
- Forward OpenCode permission requests to QQ for approval
- Support QQ confirmation replies before continuing sensitive actions

## Installation

### Option 1: From GitHub
```bash
# Clone and install
git clone https://github.com/lluoto/opencode-qq-bot.git
cd opencode-qq-bot
bun install

# Link globally
bun link
```

### Option 2: From npm (if published)
```bash
bun install -g opencode-qq-bot
```

## Two Modes

### Mode 1: Standalone (Embedded Server)
Bot starts its own OpenCode server. Requires API keys.

### Mode 2: External Server (via AstrBot)
Connect to OpenCode server started by AstrBot. No API key needed in bot config.

## Configuration

Create `~/.openqq/.env` file:

```env
QQ_APP_ID=your_app_id
QQ_APP_SECRET=your_app_secret
QQ_SANDBOX=false
OPENCODE_TUI_ATTACH_URL=http://127.0.0.1:4096
OPENCODE_LOCAL_TOOL_DIR=C:\Users\your_user\.local\share\opencode\tool-output
ALLOWED_USERS=
MAX_REPLY_LENGTH=3000

# API Keys (only for standalone/embedded mode)
ZHIPU_API_KEY=your_zhipu_key
DEEPSEEK_API_KEY=your_deepseek_key
```

## Usage

```bash
# Start bot (auto-starts embedded OpenCode server)
openqq

# Or run from source
cd opencode-qq-bot
bun run src/index.ts

# For external server (AstrBot), ensure AstrBot is running first
# Then bot will connect to localhost:4096

# To watch the same headless backend in TUI
opencode attach http://127.0.0.1:4096
```

## Commands

- `/new` - Create new session
- `/stop` - Stop current AI
- `/status` - View server status
- `/sessions` - List history sessions
- `/model` - List available models
- `/model <provider/model>` - Switch model
- `/agent` - List available agents
- `/agent <name>` - Switch agent

QQ also accepts the same commands with a backslash prefix, for example `\sessions`.

When `/sessions` lists historical sessions, reply with the number directly and the bot will prioritize session switching before any permission or confirmation flow.

## Recent Refinements

- `\sessions` now works the same as `/sessions`
- Numeric replies after `/sessions` are routed to session switching first, instead of being mistaken for permission replies
- Repeated progress/final replies are deduplicated to reduce QQ spam on long-running tasks
- If an assistant asks for confirmation first, QQ now shows an explicit confirmation prompt and supports `1` to continue or `3` to cancel
- Permission prompts now use more resilient field extraction so QQ can show the real operation/path and the exact next step

## Permission Approval From QQ

When OpenCode needs a permission decision during a tool call, the bot will send a QQ prompt like:

```text
OpenCode 需要权限确认
操作：...
路径：...
下一步：回复 1 允许一次 / 2 总是允许 / 3 拒绝
```

Reply in QQ with:

- `1` = allow once
- `2` = always allow
- `3` = reject

This avoids headless tasks hanging invisibly on permission prompts.

If OpenCode asks for an explicit confirmation before the permission step, QQ will show:

```text
OpenCode 需要操作确认
Confirm you want me to ...
回复 1 确认继续 / 3 取消
```

## Long Tasks

- The bot sends `正在处理中...` after 2s
- For long tasks, it can send intermediate progress text back to QQ
- If the QQ waiting window is exceeded, the bot returns the latest available progress text instead of a blind timeout failure
- Timed-out backend sessions are aborted so they do not keep running forever in the background

## API Keys Setup

### For Standalone Mode

**Option A: Environment Variables**
Add to `~/.openqq/.env`:
```
ZHIPU_API_KEY=your_key
DEEPSEEK_API_KEY=your_key
```

**Option B: OpenCode Auth (Recommended)**
```bash
# First start OpenCode UI to configure
opencode

# Or use CLI
opencode auth login
```
Then select your provider (Z.AI, OpenAI, etc.) and enter API key.

### For External Server (AstrBot)
API keys are configured in AstrBot settings, not needed in bot config.

## Development

```bash
# Clone
git clone https://github.com/lluoto/opencode-qq-bot.git
cd opencode-qq-bot

# Install dependencies
bun install

# Run in development
bun run dev
```

## License

MIT
