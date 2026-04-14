# OpenCode QQ Bot

Chat with OpenCode AI assistant via QQ bot.

## Features

- Connect QQ to OpenCode server
- Send messages and get AI responses
- Support commands: /new, /status, /sessions, /model, /agent
- Auto-start embedded OpenCode server (standalone mode)
- Or connect to existing OpenCode server (via AstrBot)
- Load API keys from .env file

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
