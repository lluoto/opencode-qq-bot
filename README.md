# OpenCode QQ Bot

Chat with OpenCode AI assistant via QQ bot.

## Features

- Connect QQ to OpenCode server
- Send messages and get AI responses
- Support commands: /new, /status, /sessions, /model, /agent
- Auto-start embedded OpenCode server
- Load API keys from .env file

## Installation

```bash
bun install -g opencode-qq-bot
```

## Configuration

Create `~/.openqq/.env` file:

```env
QQ_APP_ID=your_app_id
QQ_APP_SECRET=your_app_secret
QQ_SANDBOX=false
ALLOWED_USERS=
MAX_REPLY_LENGTH=3000

# API Keys (optional - for embedded server)
ZHIPU_API_KEY=your_zhipu_key
DEEPSEEK_API_KEY=your_deepseek_key
```

## Usage

```bash
# Start bot (auto-starts OpenCode server)
openqq

# Or run from source
cd opencode-qq-bot
bun run src/index.ts
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

## API Keys

### Option 1: Environment Variables

Add to `~/.openqq/.env`:
```
ZHIPU_API_KEY=your_key
DEEPSEEK_API_KEY=your_key
```

### Option 2: OpenCode Auth

```bash
opencode auth login
```

Then select your provider and enter API key.

## Development

```bash
# Clone
git clone https://github.com/gbwssve/opencode-qq-bot.git
cd opencode-qq-bot

# Install dependencies
bun install

# Run in development
bun run dev
```

## License

MIT
