# Qwen Code (local-only fork)

**An open-source AI coding agent for your terminal that talks only to a model
server on your own machine.**

This fork of Qwen Code runs the interactive terminal CLI (`qwen`) and headless
mode (`qwen -p`) against a local OpenAI-compatible model server such as
Ollama, LM Studio, vLLM or llama.cpp. It makes no other network connections:

- The model base URL is required and its host must be `127.0.0.1`, `::1` or
  `localhost`; anything else is rejected at startup. Model requests never
  follow HTTP redirects.
- No cloud providers, no sign-in, no telemetry uploads, no usage statistics,
  no update checks, no web tools and no remote MCP servers or extension
  installs.
- It is built from source. There is no installer, package-registry release or
  update channel.

## Build from source

Requires Node.js 22 or later.

```bash
git clone <your fork of this repository> qwen-code
cd qwen-code
corepack pnpm install --frozen-lockfile
npm run build
npm run bundle

# Run the bundle directly...
node dist/cli.js --help
# ...or define a `qwen` command, e.g. in ~/.zshrc or ~/.bashrc
alias qwen="node $PWD/dist/cli.js"
```

## Run a local model server

Start any OpenAI-compatible server on the loopback interface and make sure it
serves at least one model. Common base URLs:

| Server                     | Base URL                    |
| -------------------------- | --------------------------- |
| Ollama                     | `http://127.0.0.1:11434/v1` |
| LM Studio                  | `http://localhost:1234/v1`  |
| vLLM                       | `http://127.0.0.1:8000/v1`  |
| llama.cpp (`llama-server`) | `http://127.0.0.1:8080/v1`  |

## Connect Qwen Code to the server

Open a terminal in your project and start Qwen Code:

```bash
cd /path/to/your-project
qwen
```

On first launch (or any time with `/auth`) the setup wizard asks for the
server's base URL, an API key value (any non-empty value if the server doesn't
check keys) and the model IDs to use, and saves them to
`~/.qwen/settings.json`.

For scripts, configure the server with environment variables or flags instead:

```bash
export OPENAI_BASE_URL="http://127.0.0.1:11434/v1"
export OPENAI_API_KEY="ollama"
export OPENAI_MODEL="qwen3-coder:30b"

qwen -p "Explain this repository and show me where to start."
```

See [Authentication](./docs/users/configuration/auth.md) for the
`settings.json` format and [Settings](./docs/users/configuration/settings.md)
for everything else.

## Privacy

See the [Privacy Notice](./docs/users/support/tos-privacy.md).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for build, test and code-style
guidelines.

## Acknowledgments

Qwen Code was originally based on
[Google Gemini CLI](https://github.com/google-gemini/gemini-cli) v0.8.2. This
fork removes every network path except the local model server.
