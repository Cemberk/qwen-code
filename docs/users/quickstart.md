# Quickstart

> 👏 Welcome to Qwen Code!

This quickstart guide will have you using AI-powered coding assistance in just a few minutes. By the end, you'll understand how to use Qwen Code for common development tasks.

## Before you begin

Make sure you have:

- A **terminal** open
- A Mac with Apple silicon and [Homebrew](https://brew.sh). The default model
  needs 24 GB of memory; smaller Macs can use a smaller model (see
  [Step 2](#step-2-pick-a-model))
- A code project to work with

## Step 1: Install Qwen Code

This fork is built from source. It is not published to a package registry, and
there is no installer or update channel. The steps below download tools,
dependencies and a model. After that, Qwen Code itself connects only to this
machine, unless you turn on [web access](./features/web-fetch).

### Install the tools

| Tool       | What it is for                     | Install                                                    |
| ---------- | ---------------------------------- | ---------------------------------------------------------- |
| Node.js 22 | Builds and runs Qwen Code          | `nvm install 22` with [nvm](https://github.com/nvm-sh/nvm) |
| llama.cpp  | Runs the models (`llama-server`)   | `brew install llama.cpp`                                   |
| `hf`       | Downloads models from Hugging Face | `brew install hf`                                          |

Node.js 22 does not have to be your default Node.js version. The `qwen`
command you create below always runs Node.js 22, so tools that need another
default version keep working.

### Build Qwen Code

```bash
git clone <your fork of this repository> qwen-code
cd qwen-code
nvm use 22
corepack pnpm install --frozen-lockfile
npm run build && npm run bundle
```

The build produces a single file, `dist/cli.js`.

### Add the `qwen` command

In the same terminal, still in the checkout with Node.js 22 active, create a
script named `qwen` in `~/.local/bin`:

```bash
mkdir -p ~/.local/bin
cat > ~/.local/bin/qwen <<EOF
#!/bin/sh
exec "$(command -v node)" "$PWD/dist/cli.js" "\$@"
EOF
chmod +x ~/.local/bin/qwen
```

This writes the full paths of Node.js 22 and of your checkout into the
script, for example:

```sh
#!/bin/sh
exec "/Users/you/.nvm/versions/node/v22.22.0/bin/node" "/Users/you/qwen-code/dist/cli.js" "$@"
```

Unlike a shell alias, the script works in every shell and from other scripts,
whatever your default Node.js version is. If `~/.local/bin` is not on your
`PATH` yet, add this line to `~/.zshrc` (or `~/.bashrc`) and open a new
terminal:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Check that the command works from another directory:

```bash
cd ~
qwen --version
```

### Download the default model

With nothing configured, Qwen Code runs Qwen3.6 35B A3B (13.7 GB). Download it
once into the Hugging Face cache:

```bash
hf download unsloth/Qwen3.6-35B-A3B-GGUF Qwen3.6-35B-A3B-UD-IQ3_S.gguf
```

### Update Qwen Code

After pulling new changes into your checkout, rebuild it with Node.js 22:

```bash
cd qwen-code
nvm use 22
corepack pnpm install --frozen-lockfile   # only when pnpm-lock.yaml changed
npm run build && npm run bundle
```

The `qwen` command runs the new build. Create it again only if you move the
checkout, or remove the Node.js version it names (for example with
`nvm uninstall`).

## Step 2: Pick a model

Qwen Code comes with a list of Qwen models that it runs itself with llama.cpp.
It starts the engine on your first prompt and stops it when you exit. With
nothing configured it runs the first one, `qwen3.6-35b-a3b`.

- `/models` lists the models and marks the downloaded ones.
  `/models download <id>` and `/models remove <id>` download and delete a
  model with `hf`.
- `/model` switches to another model in the list and saves the choice.
  `qwen --model qwen3-8b` picks one for a single session.

On a Mac with less than 24 GB of memory, use `qwen3-8b` or `qwen3-4b`. See
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
of a session takes about 70 seconds while the model reads Qwen Code's
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
