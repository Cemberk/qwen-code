# Quickstart

> 👏 Welcome to Qwen Code!

This quickstart guide will have you using AI-powered coding assistance in just a few minutes. By the end, you'll understand how to use Qwen Code for common development tasks.

## Before you begin

Make sure you have:

- A **terminal** open
- A computer running **Windows, macOS or Linux**. Qwen Code runs its models
  on this machine: on an NVIDIA GPU (CUDA), an AMD or Intel GPU (Vulkan,
  integrated graphics included), Apple silicon (Metal), or the CPU. The
  default model needs about 16 GB of memory for the GPU (or 24 GB on a Mac);
  smaller machines can use a smaller model (see [Step 2](#step-2-pick-a-model))
- A code project to work with

## Step 1: Install Qwen Code

This fork is built from source, together with its own llama.cpp, which runs
the models. Neither is published to a package registry, and there is no
installer or update channel. The steps below download tools, dependencies
and a model. After that, Qwen Code itself connects only to this machine,
unless you turn on [web access](./features/web-fetch), and its engine is
built without HTTPS, so it cannot download anything.

### Get the two repositories

Clone them side by side, on these branches:

```bash
git clone -b adaptive-local-inference https://github.com/Cemberk/qwen-code
git clone -b adaptive-moe https://github.com/Cemberk/llama.cpp
```

### Install the tools

|                         | Windows                                                                                                                                                  | macOS                    | Linux (Debian, Ubuntu)                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------- |
| Node.js 22 or later     | `winget install OpenJS.NodeJS.LTS`                                                                                                                       | `nvm install 22`         | `nvm install 22` ([nvm](https://github.com/nvm-sh/nvm))  |
| git, CMake              | `winget install Git.Git Kitware.CMake`                                                                                                                   | `brew install cmake git` | `sudo apt-get install git cmake build-essential`         |
| C++ compiler            | `winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"` | `xcode-select --install` | (build-essential, above)                                 |
| NVIDIA GPU              | `winget install Nvidia.CUDA`                                                                                                                             |                          | `sudo apt-get install nvidia-cuda-toolkit`               |
| AMD or Intel GPU        | nothing: the installer gathers the Vulkan tools without administrator rights                                                                             |                          | `sudo apt-get install libvulkan-dev glslc spirv-headers` |
| `hf` (downloads models) | `pip install -U "huggingface_hub[cli]"`                                                                                                                  | `brew install hf`        | `pip install -U "huggingface_hub[cli]"`                  |

Apple silicon needs no GPU toolkit (Metal is part of macOS). On Windows, if
the Vulkan SDK is installed, the installer uses it. Behind a proxy that
inspects TLS, let Node.js use the system's certificates first:
`export NODE_OPTIONS=--use-system-ca` (PowerShell:
`$env:NODE_OPTIONS = '--use-system-ca'`).

### Run the installer

From the `qwen-code` checkout:

```bash
# macOS, Linux
cd qwen-code
sh scripts/install-local.sh

# Windows (PowerShell)
cd qwen-code
powershell -ExecutionPolicy Bypass -File scripts\install-local.ps1
```

It:

1. builds Qwen Code (`corepack pnpm install --frozen-lockfile`,
   `npm run build`, `npm run bundle`);
2. builds the llama.cpp checkout's `llama-server` with the backend this
   machine's GPU needs, the same that `/models setup` recommends (on
   Windows without the Vulkan SDK, after gathering the Vulkan tools with
   `scripts\windows-vulkan-noadmin.ps1` from the llama.cpp checkout);
3. adds a `qwen` command to `~/.local/bin` (Windows: `qwen.cmd` in
   `%USERPROFILE%\.local\bin`, added to your user `PATH`);
4. sets `localModelEngine` in `~/.qwen/settings.json` to the new
   `llama-server` (or prints the line to add, if the file has comments).

Options: `LLAMA_DIR=...`, `JOBS=2` and `DOWNLOAD_MODEL=1` before
`sh scripts/install-local.sh`; `-LlamaDir ...`, `-Jobs 2` and
`-DownloadModel` after `install-local.ps1`. Building llama.cpp's GPU code
takes a lot of memory per compile job: keep the default 4 jobs, or 2 on a
machine with 16 GB.

Check that the command works from another directory (on Windows, in a new
terminal):

```bash
cd ~
qwen --version
```

### The same steps by hand

```bash
# Qwen Code
cd qwen-code
corepack pnpm install --frozen-lockfile
npm run build && npm run bundle

# llama-server: the backend and its options for this machine
node scripts/local-setup.mjs backend
node scripts/local-setup.mjs cmake-args
cd ../llama.cpp
cmake -B build <the options above>
cmake --build build --config Release --target llama-server ggml-rpc-server -j 4

# the engine Qwen Code runs (Windows: build\bin\Release\llama-server.exe)
cd ../qwen-code
node scripts/local-setup.mjs set-engine ../llama.cpp/build/bin/llama-server
```

The `qwen` command is a script that runs `dist/cli.js` with your Node.js:

```bash
# macOS, Linux: ~/.local/bin/qwen (add ~/.local/bin to PATH in ~/.zshrc or ~/.bashrc)
#!/bin/sh
exec "/path/to/node" "/path/to/qwen-code/dist/cli.js" "$@"
```

```bat
:: Windows: %USERPROFILE%\.local\bin\qwen.cmd (and that folder on your PATH)
@"C:\Program Files\nodejs\node.exe" "C:\path\to\qwen-code\dist\cli.js" %*
```

### Download the default model

With nothing configured, Qwen Code runs the first downloaded model in its
list, Qwen3.6 35B A3B (13.7 GB) once you have it. Download it once into the
Hugging Face cache:

```bash
hf download unsloth/Qwen3.6-35B-A3B-GGUF Qwen3.6-35B-A3B-UD-IQ3_S.gguf
```

For a smaller machine, `hf download Qwen/Qwen3-4B-GGUF Qwen3-4B-Q4_K_M.gguf`
(2.5 GB) works anywhere.

### Check the setup

Start `qwen` in a project folder, then:

- `/models setup` shows this machine's GPUs, the engine and its devices,
  and how the engine is kept off the network.
- `/models plan` shows how the model runs here, and `/models bench`
  measures it.

The first reply of a new project takes a while on a small GPU: the engine
reads Qwen Code's instructions and tools first (minutes on integrated
graphics). Later replies, later sessions and new projects reuse what it
read.

### Update Qwen Code

One script brings both checkouts up to date and rebuilds them (llama.cpp
only recompiles what changed). It stops if either checkout has changes of
your own, and stops the local model pool before rebuilding its engine:

```bash
# macOS, Linux
cd qwen-code
sh scripts/update-local.sh

# Windows (PowerShell)
cd qwen-code
powershell -ExecutionPolicy Bypass -File scripts\update-local.ps1
```

It takes the installer's options (`JOBS=2 sh scripts/update-local.sh`,
`-Jobs 2`).

## Step 2: Pick a model

Qwen Code comes with a list of Qwen models that it runs itself with llama.cpp.
It starts the engine on your first prompt and stops it when you exit. With
nothing configured it runs the first one you have downloaded, normally
`qwen3.6-35b-a3b`.

- `/models` lists the models and marks the downloaded ones.
  `/models download <id>` and `/models remove <id>` download and delete a
  model with `hf`.
- `/model` switches to another model in the list and saves the choice.
  `qwen --model qwen3-8b` picks one for a single session.

On a machine with less memory for the GPU (a Mac with less than 24 GB,
integrated graphics, a GPU with less than 16 GB), use `qwen3-8b` or
`qwen3-4b`; `/models` says how each downloaded model runs here. See
[Local Models](./configuration/local-models) for the full list and how to
change it.

Qwen Code connects only to model servers on this machine, unless you turn on
[web access](./features/web-fetch). It downloads a model only when you run
`/models download`.

### Using your own model server

To use a server you run yourself, run `/auth`. The setup wizard asks for:

1. **Base URL** of the server's OpenAI-compatible API. The host must be `127.0.0.1`, `::1` or `localhost`. For example: Ollama `http://127.0.0.1:11434/v1`, LM Studio `http://localhost:1234/v1`, vLLM `http://127.0.0.1:8000/v1`, llama.cpp `http://127.0.0.1:8080/v1`.
2. **API key**: any non-empty value if your server doesn't check keys (for example `ollama`).
3. **Model IDs**: picked from the server's model list when it provides one, or typed in.
4. Optional advanced settings, then a review of the JSON saved to `settings.json`.

Remote and cloud endpoints are rejected.

> [!note]
>
> Qwen Code stores its configuration and customizations in `.qwen` directories: `~/.qwen/` for user-level settings (e.g. `settings.json`) and global custom commands, and `<project>/.qwen/` for project-specific files such as custom commands and summaries.

> [!tip]
>
> Use `/doctor` to check your current configuration at any time. See the [Authentication](./configuration/auth) page for details.

## Step 3: Start your first session

Open your terminal in any project directory and start Qwen Code:

```bash
cd /path/to/your/project
qwen
```

The first time you open a folder, Qwen Code asks whether you trust it. Trust
it only if you trust its code; see [Trusted Folders](./configuration/trusted-folders).

You'll see the Qwen Code welcome screen with your session information and
recent conversations. Type `/help` for available commands.

Qwen models occasionally switch language partway through a reply. To keep
replies in English, run this once, before your first prompt. Qwen Code saves
it for later sessions:

```
/language output English
```

Your first prompt starts the model. With the default model, the first reply
of a session takes about a minute while the model reads Qwen Code's
instructions. Later replies in the same session start within about a second.

## Chat with Qwen Code

### Ask your first question

Qwen Code will analyze your files and provide a summary. You can also ask more specific questions:

```
explain the folder structure
```

You can also ask Qwen Code about its own capabilities:

```
what can Qwen Code do?
```

> [!note]
>
> Qwen Code reads your files as needed - you don't have to manually add context. Qwen Code also has access to its own documentation and can answer questions about its features and capabilities.

### Make your first code change

Now let's make Qwen Code do some actual coding. Try a simple task:

```
add a hello world function to the main file
```

Qwen Code will:

1. Find the appropriate file
2. Show you the proposed changes
3. Ask for your approval
4. Make the edit

> [!note]
>
> Qwen Code always asks for permission before modifying files. You can approve individual changes or enable "Accept all" mode for a session.

### Use Git with Qwen Code

Qwen Code makes Git operations conversational:

```
what files have I changed?
```

```
commit my changes with a descriptive message
```

You can also prompt for more complex Git operations:

```
create a new branch called feature/quickstart
```

```
show me the last 5 commits
```

```
help me resolve merge conflicts
```

### Fix a bug or add a feature

Qwen Code is proficient at debugging and feature implementation.

Describe what you want in natural language:

```
add input validation to the user registration form
```

Or fix existing issues:

```
there's a bug where users can submit empty forms - fix it
```

Qwen Code will:

- Locate the relevant code
- Understand the context
- Implement a solution
- Run tests if available

### Test out other common workflows

There are a number of ways to work with Qwen Code:

**Refactor code**

```
refactor the authentication module to use async/await instead of callbacks
```

**Write tests**

```
write unit tests for the calculator functions
```

**Update documentation**

```
update the README with installation instructions
```

**Code review**

```
review my changes and suggest improvements
```

> [!tip]
>
> **Remember**: Qwen Code is your AI pair programmer. Talk to it like you would a helpful colleague - describe what you want to achieve, and it will help you get there.

## Essential commands

Here are the most important commands for daily use:

| Command               | What it does                                     | Example                            |
| --------------------- | ------------------------------------------------ | ---------------------------------- |
| `qwen`                | start Qwen Code                                  | `qwen`                             |
| `/auth`               | Connect a local model server (in session)        | `/auth`                            |
| `/doctor`             | Check current authentication and environment     | `/doctor`                          |
| `/help`               | Display help information for available commands  | `/help` or `/?`                    |
| `/compress`           | Replace chat history with summary to save Tokens | `/compress`                        |
| `/clear`              | Clear conversation history and free up context   | `/clear` (aliases: `reset`, `new`) |
| `/theme`              | Change Qwen Code visual theme                    | `/theme`                           |
| `/language`           | View or change language settings                 | `/language`                        |
| → `ui [language]`     | Set UI interface language                        | `/language ui ja-JP`               |
| → `output [language]` | Set LLM output language                          | `/language output English`         |
| `/quit`               | Exit Qwen Code immediately                       | `/quit` or `/exit`                 |

See the [CLI reference](./features/commands) for a complete list of commands.

## Pro tips for beginners

**Be specific with your requests**

- Instead of: "fix the bug"
- Try: "fix the login bug where users see a blank screen after entering wrong credentials"

**Use step-by-step instructions**

- Break complex tasks into steps:

```
1. create a new database table for user profiles
2. create an API endpoint to get and update user profiles
3. build a webpage that allows users to see and edit their information
```

**Let Qwen Code explore first**

- Before making changes, let Qwen Code understand your code:

```
analyze the database schema
```

```
build a dashboard showing products that are most frequently returned by our UK customers
```

**Save time with shortcuts**

- Press `?` to see all available keyboard shortcuts
- Use Tab for command completion
- Press ↑ for command history
- Type `/` to see all slash commands

## Getting help

- **In Qwen Code**: Type `/help` or ask "how do I..."
- **Documentation**: You're here! Browse other guides
