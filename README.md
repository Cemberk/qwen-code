# Qwen Code (local-only fork)

**An open-source AI coding agent for your terminal that runs Qwen models on
your own machine.**

This fork of Qwen Code runs the interactive terminal CLI (`qwen`) and headless
mode (`qwen -p`) against Qwen models it runs itself with llama.cpp, or against
your own OpenAI-compatible model server on this machine, such as Ollama,
LM Studio, vLLM or llama.cpp. Unless you turn on web access, it makes no other
network connections:

- Model servers must be on `127.0.0.1`, `::1` or `localhost`; anything else is
  rejected at startup. Model requests never follow HTTP redirects.
- The built-in models run offline from the Hugging Face cache. Qwen Code
  downloads a model only when you run `/models download`.
- No cloud providers, no sign-in, no telemetry uploads, no usage statistics,
  no update checks and no remote MCP servers or extension installs.
- Web access is off by default. `/web on` gives the model a `web_fetch` tool
  that reads web pages, and every fetch asks for your approval; see
  [Web Access](./docs/users/features/web-fetch.md).
- It is built from source. There is no installer, package-registry release or
  update channel.

## Install

On a Mac with Apple silicon, [Homebrew](https://brew.sh) and
[nvm](https://github.com/nvm-sh/nvm):

```bash
# Node.js 22 builds and runs Qwen Code, llama.cpp runs the models, hf downloads them
nvm install 22
brew install llama.cpp hf

# Build
git clone <your fork of this repository> qwen-code
cd qwen-code
nvm use 22
corepack pnpm install --frozen-lockfile
npm run build && npm run bundle

# Add a `qwen` command that runs this build with Node.js 22 from any directory
mkdir -p ~/.local/bin
cat > ~/.local/bin/qwen <<EOF
#!/bin/sh
exec "$(command -v node)" "$PWD/dist/cli.js" "\$@"
EOF
chmod +x ~/.local/bin/qwen

# Download the default model, Qwen3.6 35B A3B (13.7 GB, for Macs with 24 GB)
hf download unsloth/Qwen3.6-35B-A3B-GGUF Qwen3.6-35B-A3B-UD-IQ3_S.gguf
```

`~/.local/bin` must be on your `PATH`. Node.js 22 does not have to be your
default Node.js version. See the [Quickstart](./docs/users/quickstart.md) for
each step, smaller models and updating.

## Start Qwen Code

Open a terminal in your project and start Qwen Code:

```bash
cd /path/to/your-project
qwen
```

Run `/language output English` once to keep replies in English. The first
reply of a session takes about 70 seconds while the model loads. `/model`
switches models, and `/models` downloads and removes them; see
[Local Models](./docs/users/configuration/local-models.md).

## Use your own model server

Start any OpenAI-compatible server on the loopback interface and make sure it
serves at least one model. Common base URLs:

| Server                     | Base URL                    |
| -------------------------- | --------------------------- |
| Ollama                     | `http://127.0.0.1:11434/v1` |
| LM Studio                  | `http://localhost:1234/v1`  |
| vLLM                       | `http://127.0.0.1:8000/v1`  |
| llama.cpp (`llama-server`) | `http://127.0.0.1:8080/v1`  |

Then run `/auth` in Qwen Code. The setup wizard asks for the server's base
URL, an API key value (any non-empty value if the server doesn't check keys)
and the model IDs to use, and saves them to `~/.qwen/settings.json`.

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
fork removes every network path except local model servers.
