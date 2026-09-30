# Qwen Code: Privacy Notice

This build of Qwen Code is a local-only fork of the open-source AI coding
assistant. It talks to exactly one service: the OpenAI-compatible model server
that you run and configure yourself on the loopback interface (`127.0.0.1`,
`::1` or `localhost`), for example Ollama, LM Studio, vLLM or llama.cpp.

## What leaves your machine

Nothing. Qwen Code has no telemetry upload, no usage statistics, no crash or
feedback reporting, no update checks and no cloud providers. A model base URL
whose host is not a loopback address is rejected at startup.

The terms and data practices of the model server you run are your own; no
third party is involved.

## What is sent to your local model server

Each model request contains what the assistant needs to answer:

- your prompts and the conversation so far;
- workspace content that tools read or produce during the session, such as
  file contents, directory listings and shell command output;
- project context files (for example `QWEN.md`) and memory entries.

Tools such as file reads, edits and shell commands run locally on your machine,
subject to the approval mode and permission rules you configure.

## What is stored on disk

Qwen Code keeps its state under `~/.qwen`, including your settings, session
transcripts (so you can resume a conversation), shell history and debug logs.
[Telemetry](../../developers/development/telemetry) is off by default; when you
enable it, it is only written to the local file set by `telemetry.outfile`.

## Frequently Asked Questions (FAQ)

### Is my code, including prompts and answers, used to train AI models?

Not by Qwen Code. Your prompts, code and responses go only to the local model
server you configured, and whatever that server does with them is under your
control.

### How do I change the model server?

Use the `/auth` command, or edit the model settings described in
[Authentication Setup](../configuration/auth.md). The base URL must point at a
server on the loopback interface.
