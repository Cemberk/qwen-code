# Quickstart

> 👏 Welcome to Qwen Code!

This quickstart guide will have you using AI-powered coding assistance in just a few minutes. By the end, you'll understand how to use Qwen Code for common development tasks.

## Before you begin

Make sure you have:

- A **terminal** or command prompt open
- A code project to work with
- A model engine: `mlx-lm` (`uv tool install mlx-lm`) on Apple Silicon or llama.cpp (`brew install llama.cpp`), and a Qwen model downloaded with `hf download` (see [Local Models](./configuration/local-models)). Alternatively, any OpenAI-compatible model server running on this machine, such as [Ollama](https://ollama.com), [LM Studio](https://lmstudio.ai) or [vLLM](https://docs.vllm.ai)

## Step 1: Build Qwen Code

This fork is built from source. It is not published to a package registry, and
there is no installer or update channel.

### Build from source

**Prerequisites**

Make sure you have Node.js 22 or later installed.

```bash
git clone <your fork of this repository> qwen-code
cd qwen-code
corepack pnpm install --frozen-lockfile
npm run build && npm run bundle

# Define a `qwen` command, e.g. in ~/.zshrc or ~/.bashrc
alias qwen="node $PWD/dist/cli.js"
```

You can also run the bundle directly with `node dist/cli.js`.

## Step 2: Pick a model

Qwen Code comes with a list of Qwen models that it runs itself. With nothing
configured it runs the first one, `qwen3-8b-mlx`. Download it once:

```bash
hf download mlx-community/Qwen3-8B-4bit
```

Then start Qwen Code and send a prompt; the engine starts on the first
request and stops when you exit. Use `/model` to switch to another model from
the list. See [Local Models](./configuration/local-models) for the full list,
the GGUF models for llama.cpp, and how to change the list.

Qwen Code only connects to model servers on this machine, and never
downloads anything itself.

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
# optional
cd /path/to/your/project
# start qwen
qwen
```

You'll see the Qwen Code welcome screen with your session information, recent conversations, and latest updates. Type `/help` for available commands.

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
| → `ui [language]`     | Set UI interface language                        | `/language ui zh-CN`               |
| → `output [language]` | Set LLM output language                          | `/language output Chinese`         |
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
