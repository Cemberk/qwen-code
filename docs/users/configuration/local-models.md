# Local Models

Qwen Code comes with a list of Qwen models that it runs itself. Download a
model once, pick it with `/model`, and Qwen Code starts the model server when
you send your first prompt and stops it when you exit. Qwen Code never
connects to the internet: you download the model files yourself.

## Engines

Each model is in one of two formats, and each format has its own engine.
Install the ones you need; Qwen Code finds them on your `PATH`.

| Format | Engine          | Install                  | Notes                                                        |
| ------ | --------------- | ------------------------ | ------------------------------------------------------------ |
| `mlx`  | `mlx_lm.server` | `uv tool install mlx-lm` | Apple's MLX framework. Usually the fastest on Apple Silicon. |
| `gguf` | `llama-server`  | `brew install llama.cpp` | llama.cpp. Runs on any machine; Metal on Apple Silicon.      |

## Downloading a model

Model files come from the Hugging Face cache (`~/.cache/huggingface/hub`, or
`HF_HUB_CACHE` / `HF_HOME` when set). Download a model with the `hf` command
from the `huggingface_hub` package:

```bash
# An MLX model is the whole repository
hf download mlx-community/Qwen3-8B-4bit

# A GGUF model is one file in the repository
hf download Qwen/Qwen3-8B-GGUF Qwen3-8B-Q4_K_M.gguf
```

These commands contact huggingface.co; Qwen Code itself does not. If you pick
a model that is not downloaded, the request fails with the exact command to
run.

## The built-in list

| `id`                      | Repository                                        | Size    |
| ------------------------- | ------------------------------------------------- | ------- |
| `qwen3-8b-mlx` (default)  | `mlx-community/Qwen3-8B-4bit`                     | ~4.6 GB |
| `qwen3-4b-mlx`            | `mlx-community/Qwen3-4B-4bit`                     | ~2.3 GB |
| `qwen3-14b-mlx`           | `mlx-community/Qwen3-14B-4bit`                    | ~8.3 GB |
| `qwen3-coder-30b-a3b-mlx` | `mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit` | ~17 GB  |
| `qwen3-8b-gguf`           | `Qwen/Qwen3-8B-GGUF`, `Qwen3-8B-Q4_K_M.gguf`      | ~5.0 GB |
| `qwen3-4b-gguf`           | `Qwen/Qwen3-4B-GGUF`, `Qwen3-4B-Q4_K_M.gguf`      | ~2.5 GB |
| `qwen3-14b-gguf`          | `Qwen/Qwen3-14B-GGUF`, `Qwen3-14B-Q4_K_M.gguf`    | ~9.0 GB |

A model needs roughly its size in memory, plus room for the context. On a Mac
with 24 GB, models up to about 14B fit comfortably.

With nothing else configured, Qwen Code runs the first model in the list.

## Choosing a model

- `/model` lists the local models first, then any servers from
  `modelProviders`. Picking one saves it as `model.name`.
- `qwen --model qwen3-14b-mlx` picks a model for one session.
- Setting `model.name` in `~/.qwen/settings.json` picks it for every session.

Switching models restarts the engine, which takes a few seconds for small
models and longer for large ones. If a fast, vision or subagent model is a
different local model from the main one, each switch between them reloads the
engine, so leave those unset or set them to the main model.

## Changing the list

Set `localModels` in `~/.qwen/settings.json`. It replaces the built-in list, so
copy the entries you want to keep. Edits apply without a restart.

```json
{
  "localModels": [
    {
      "id": "qwen3-14b-mlx",
      "name": "Qwen3 14B (MLX 4-bit)",
      "format": "mlx",
      "repo": "mlx-community/Qwen3-14B-4bit"
    },
    {
      "id": "qwen3-8b-q8",
      "name": "Qwen3 8B (GGUF Q8_0)",
      "format": "gguf",
      "repo": "Qwen/Qwen3-8B-GGUF",
      "file": "Qwen3-8B-Q8_0.gguf",
      "contextSize": 40960
    }
  ]
}
```

| Field         | Required  | Description                                                                                     |
| ------------- | --------- | ----------------------------------------------------------------------------------------------- |
| `id`          | Yes       | The name `/model`, `model.name` and `--model` use. Must be unique.                              |
| `name`        | No        | Display name in `/model`. Defaults to `id`.                                                     |
| `format`      | Yes       | `mlx` or `gguf`.                                                                                |
| `repo`        | Yes       | Hugging Face repository, `owner/name`.                                                          |
| `file`        | GGUF only | The `.gguf` file in the repository. For a split file, the first part (`…-00001-of-0000N.gguf`). |
| `contextSize` | No        | Context window in tokens. Default `32768`.                                                      |

Set `"localModels": []` to turn local models off and use only
`modelProviders`.

`localModels` is read from your user settings only. A project's
`.qwen/settings.json` cannot change it, and a project `.env` cannot move the
Hugging Face cache, so a repository cannot make Qwen Code load model files it
supplies.

## How the engine runs

- One engine per Qwen Code session, listening on `127.0.0.1` on a free port.
  Nothing else is started.
- The engine gets a minimal environment: no credentials, and none of the
  variables that make engines download models or enable their built-in tools.
- `llama-server` runs with `--offline`, without its web UI, and with a random
  key per session that only Qwen Code knows. `mlx_lm.server` runs with the
  Hugging Face hub set to offline and gives web pages no access to its
  responses.
- Both engines use Qwen3's recommended sampling (temperature 0.6, top-p 0.95,
  top-k 20) unless a request sets its own.
- On macOS the engine runs in a sandbox that blocks network traffic to
  anything except this machine, and lets it write files only in temporary
  and cache folders.
- The engine stops when Qwen Code exits. If Qwen Code is killed with
  `kill -9`, the engine keeps running until you stop it.

## Limits

- `mlx_lm.server` does not check API keys. While it runs, other programs on
  this machine can use the loaded model.
- The first reply of a session takes longest: Qwen Code's instructions and tool
  definitions come to about 17,500 tokens, which a 4B model on an M4 takes
  about 80 seconds to read (a larger model takes longer). Later replies reuse
  the engine's cache and start much sooner.
- Each Qwen Code session runs its own engine and loads its own copy of the
  model.
- Local models do not run inside the Docker sandbox, which has no network.
- On Linux the engine runs without the network sandbox.
