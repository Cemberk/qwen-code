# Local Models

Qwen Code comes with a list of Qwen models that it runs itself with llama.cpp.
Download a model once, pick it with `/model`, and Qwen Code starts
`llama-server` when you send your first prompt and stops it when you exit.
Qwen Code never connects to the internet: you download the model files
yourself.

## Setup

Install llama.cpp; Qwen Code finds `llama-server` on your `PATH`:

```bash
brew install llama.cpp
```

Model files come from the Hugging Face cache (`~/.cache/huggingface/hub`, or
`HF_HUB_CACHE` / `HF_HOME` when set). Install the `hf` command
(`brew install hf`) and download a model, naming the repository
and the GGUF file:

```bash
hf download unsloth/Qwen3.6-35B-A3B-GGUF Qwen3.6-35B-A3B-UD-IQ3_S.gguf
```

This command contacts huggingface.co; Qwen Code itself does not. If you pick
a model that is not downloaded, the request fails with the exact command to
run.

## The built-in list

| `id`                        | Repository and file                                             | Size    | Context |
| --------------------------- | --------------------------------------------------------------- | ------- | ------- |
| `qwen3.6-35b-a3b` (default) | `unsloth/Qwen3.6-35B-A3B-GGUF`, `Qwen3.6-35B-A3B-UD-IQ3_S.gguf` | 13.7 GB | 64K     |
| `qwen3-14b`                 | `Qwen/Qwen3-14B-GGUF`, `Qwen3-14B-Q4_K_M.gguf`                  | ~9.0 GB | 32K     |
| `qwen3-8b`                  | `Qwen/Qwen3-8B-GGUF`, `Qwen3-8B-Q4_K_M.gguf`                    | ~5.0 GB | 32K     |
| `qwen3-4b`                  | `Qwen/Qwen3-4B-GGUF`, `Qwen3-4B-Q4_K_M.gguf`                    | 2.5 GB  | 32K     |

The default, Qwen3.6 35B A3B, is a mixture-of-experts model: 35B parameters,
of which 3B are used per token, so it generates about as fast as a 4B model.
At this quantization it is the largest Qwen that fits the GPU memory of a
24 GB Mac (16 GB by default) together with a 64K context. Close memory-heavy
apps while it runs; otherwise macOS moves their memory to swap.

A model needs roughly its size in memory, plus room for the context. On a Mac
with 24 GB, models up to about 14B fit comfortably.

With nothing else configured, Qwen Code runs the first model in the list.

## Choosing a model

- `/model` lists the local models first, then any servers from
  `modelProviders`. Picking one saves it as `model.name`.
- `qwen --model qwen3-14b` picks a model for one session.
- Setting `model.name` in `~/.qwen/settings.json` picks it for every session.

Switching models restarts the engine, which takes a few seconds for small
models and longer for large ones. If a fast, vision or subagent model is a
different local model from the main one, each switch between them reloads the
engine, so leave those unset or set them to the main model.

## Downloading and removing models from Qwen Code

These commands run the `hf` tool for you, only when you type them. The model
cannot run them.

| Command                           | What it does                                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `/models`                         | Lists the local models and marks the downloaded ones.                                                      |
| `/models download <id>`           | Runs `hf download <repo> <file>` for a model in the list.                                                  |
| `/models download <repo> <file>`  | Adds that file to `localModels` (its id is the file name in lower case, without `.gguf`) and downloads it. |
| `/models remove <id>` or `<repo>` | Runs `hf cache rm model/<repo> -y`, deleting every downloaded file of that repository.                     |

`hf` runs without your Hugging Face token and with telemetry off. Downloading
contacts huggingface.co; the `hf` tool also checks PyPI for a newer version of
itself once a day.

## Changing the list

Set `localModels` in `~/.qwen/settings.json`. It replaces the built-in list, so
copy the entries you want to keep. Edits apply without a restart.

```json
{
  "localModels": [
    {
      "id": "qwen3-14b",
      "name": "Qwen3 14B (Q4_K_M)",
      "repo": "Qwen/Qwen3-14B-GGUF",
      "file": "Qwen3-14B-Q4_K_M.gguf"
    },
    {
      "id": "qwen3-8b-q8",
      "name": "Qwen3 8B (Q8_0)",
      "repo": "Qwen/Qwen3-8B-GGUF",
      "file": "Qwen3-8B-Q8_0.gguf",
      "contextSize": 40960
    }
  ]
}
```

| Field         | Required | Description                                                                                     |
| ------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `id`          | Yes      | The name `/model`, `model.name` and `--model` use. Must be unique.                              |
| `name`        | No       | Display name in `/model`. Defaults to `id`.                                                     |
| `repo`        | Yes      | Hugging Face repository, `owner/name`.                                                          |
| `file`        | Yes      | The `.gguf` file in the repository. For a split file, the first part (`…-00001-of-0000N.gguf`). |
| `contextSize` | No       | Context window in tokens. Default `32768`.                                                      |

Set `"localModels": []` to turn local models off and use only
`modelProviders`.

`localModels` is read from your user settings only. A project's
`.qwen/settings.json` cannot change it, and a project `.env` cannot move the
Hugging Face cache, so a repository cannot make Qwen Code load model files it
supplies.

## How the engine runs

- One engine per Qwen Code session, listening on `127.0.0.1` on a free port.
  In an interactive session it stays loaded, with its prompt cache, until you
  quit.
- The engine gets a minimal environment: no credentials, and none of the
  variables that make llama.cpp download models or enable its built-in tools.
- `llama-server` runs with `--offline`, without its web UI, and with a random
  key per session that only Qwen Code knows.
- It uses Qwen3's recommended sampling (temperature 0.6, top-p 0.95, top-k 20)
  unless a request sets its own, and n-gram speculative decoding, which
  speeds up replies that repeat text from the conversation, such as file
  edits, without changing what the model writes.
- On macOS the engine runs in a sandbox that blocks network traffic to
  anything except this machine, and lets it write files only in temporary
  and cache folders.
- The engine stops when Qwen Code exits. If Qwen Code is killed with
  `kill -9`, the engine keeps running until you stop it.

## Limits

- The first reply of a session takes longest: Qwen Code's instructions and tool
  definitions come to about 17,500 tokens, which Qwen3.6 35B A3B on an M4
  takes about 70 seconds to read. Later replies reuse
  the engine's cache and start within a second. `qwen -p` starts a new engine
  each time, so every run pays this cost.
- Each Qwen Code session runs its own engine and loads its own copy of the
  model.
- Local models do not run inside the Docker sandbox, which has no network.
- On Linux the engine runs without the network sandbox.
