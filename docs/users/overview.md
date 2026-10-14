# Qwen Code overview

> Learn about Qwen Code, Qwen's agentic coding tool that lives in your terminal and helps you turn ideas into code faster than ever before.

## Get started in 30 seconds

### Install Qwen Code:

This fork is built from source. Follow
[Step 1 of the Quickstart](./quickstart#step-1-install-qwen-code): install
Node.js 22, llama.cpp and `hf`, build Qwen Code, add the `qwen` command and
download a model.

### Start using Qwen Code:

```bash
cd your-project
qwen
```

Qwen Code runs a Qwen model on this machine with llama.cpp. The first reply of a session takes about a minute while the model loads. To use your own model server on this machine instead, such as Ollama, LM Studio or vLLM, run `/auth`; see [Authentication](./configuration/auth). Then let's start with understanding your codebase. Try one of these commands:

```
what does this project do?
```

That's it! [Continue with Quickstart (5 mins) →](./quickstart)

> [!tip]
>
> See [troubleshooting](./support/troubleshooting) if you hit issues.

## What Qwen Code does for you

- **Build features from descriptions**: Tell Qwen Code what you want to build in plain language. It will make a plan, write the code, and ensure it works.
- **Debug and fix issues**: Describe a bug or paste an error message. Qwen Code will analyze your codebase, identify the problem, and implement a fix.
- **Navigate any codebase**: Ask anything about your team's codebase, and get a thoughtful answer back. Qwen Code maintains awareness of your entire project structure, and with [MCP](./features/mcp) can use local tools you run as stdio servers.
- **Automate tedious tasks**: Fix fiddly lint issues, resolve merge conflicts, and write release notes. Do all this in a single command from your developer machine.
- **[Followup suggestions](./features/followup-suggestions)**: Qwen Code predicts what you want to type next and shows it as ghost text. Press Tab to accept, or just keep typing to dismiss.

## Why developers love Qwen Code

- **Works in your terminal**: Not another chat window. Not another IDE. Qwen Code meets you where you already work, with the tools you already love.
- **Takes action**: Qwen Code can directly edit files, run commands, and create commits. Need more? [MCP](./features/mcp) lets Qwen Code use _your_ custom developer tooling through local stdio servers.
- **Unix philosophy**: Qwen Code is composable and scriptable. `tail -f app.log | qwen -p "Tell me if you see any anomalies appear in this log stream"` _works_, and so does `qwen -p "If there are new text strings, translate them into French"` in a script.
