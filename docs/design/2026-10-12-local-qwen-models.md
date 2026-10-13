# Built-in local Qwen models

[English](2026-10-12-local-qwen-models.md) | [简体中文](2026-10-12-local-qwen-models.zh-CN.md)

## Status

Implemented, 2026-10-12, on the local-only fork. Verified on an Apple M4 with
24 GB, `mlx-lm` 0.32.0 and llama.cpp build 10240.

## Problem

The fork talks only to an OpenAI-compatible model server on loopback, but the
user has to start that server, pick its model files and describe it in
`modelProviders`. The fork is meant to be a local Qwen agent: it should come
with a list of Qwen models, let the user switch between them, and run them
itself.

## Goals

- A built-in, user-editable list of Qwen models, each named by its Hugging
  Face repository (and file, for GGUF).
- qwen runs the selected model itself: MLX models through `mlx_lm.server`,
  GGUF models through `llama-server`. MLX comes first in the list, since the
  fork mainly runs on Apple Silicon.
- `/model`, `model.name` and `--model` select local models like any other.
- qwen never connects out. Model files come from the Hugging Face cache on
  disk; a missing model gets the exact `hf download` command for the user to
  run.

## Non-goals

- Downloading models, checking for new ones or reading Hugging Face metadata.
- Installing engines. The user installs `mlx-lm` and `llama.cpp`.
- Serving more than one model at a time, or sharing an engine between qwen
  sessions.
- Running engines inside a Docker sandbox, whose network is off.

## Design

### Configuration

`localModels` is a top-level setting: an array of entries.

```json
{
  "localModels": [
    {
      "id": "qwen3-8b-mlx",
      "name": "Qwen3 8B (MLX 4-bit)",
      "format": "mlx",
      "repo": "mlx-community/Qwen3-8B-4bit",
      "contextSize": 32768
    },
    {
      "id": "qwen3-8b-gguf",
      "name": "Qwen3 8B (GGUF Q4_K_M)",
      "format": "gguf",
      "repo": "Qwen/Qwen3-8B-GGUF",
      "file": "Qwen3-8B-Q4_K_M.gguf",
      "contextSize": 32768
    }
  ]
}
```

| Field         | Required  | Meaning                                                                   |
| ------------- | --------- | ------------------------------------------------------------------------- |
| `id`          | Yes       | The name `/model`, `model.name` and `--model` use. Unique.                |
| `name`        | No        | Display name. Defaults to `id`.                                           |
| `format`      | Yes       | `mlx` (run by `mlx_lm.server`) or `gguf` (run by `llama-server`).         |
| `repo`        | Yes       | Hugging Face repository, `owner/name`.                                    |
| `file`        | GGUF only | The `.gguf` file in the repository. For split files, the first part.      |
| `contextSize` | No        | Context window in tokens, default 32768. Sizes the engine and compaction. |

- The default value is a built-in list of Qwen models. Setting `localModels`
  in `~/.qwen/settings.json` replaces it.
- `localModels` is read from user and system settings only. A workspace's
  settings cannot add a model, because an entry decides which files an engine
  loads.
- Entries are validated at startup. A bad entry is a configuration error, like
  a bad `modelProviders` entry.

### Model selection

- Each entry becomes an `openai` model provider entry ahead of the user's own
  `modelProviders` entries, so `/model` lists it and the existing selection,
  persistence and hot-reload paths handle it.
- These entries carry a fixed placeholder base URL, `http://127.0.0.1:0/v1`,
  so a persisted `model.baseUrl` stays valid across sessions. Port 0 accepts
  no connections. The content generator replaces it with the running engine's
  address.
- With no auth type and no model configured, qwen selects the `openai` auth
  type and the first local model, so a fresh install starts without the auth
  dialog.

### Model files

- Files are read from the Hugging Face cache: `HF_HUB_CACHE`, else
  `HUGGINGFACE_HUB_CACHE`, else `$HF_HOME/hub`, else
  `$XDG_CACHE_HOME/huggingface/hub`, else `~/.cache/huggingface/hub`, the same
  order `huggingface_hub` uses.
- The repository's `refs/main` names the snapshot. A GGUF entry needs its file
  in the snapshot. An MLX entry needs `config.json` and every weight file the
  safetensors index lists (or `model.safetensors`).
- A missing model fails the request with the command to fetch it, for example
  `hf download mlx-community/Qwen3-8B-4bit`, and a note that the command
  contacts huggingface.co while qwen itself does not.
- A project `.env` cannot set `HF_HUB_CACHE`, `HUGGINGFACE_HUB_CACHE`,
  `HF_HOME` or `XDG_CACHE_HOME`, so a repository cannot point qwen at model
  files it supplies.

### Engine lifecycle

- One engine per qwen process, serving one model. Nothing starts until the
  first request for a local model.
- Every request for a local model takes a lease on that model. A lease for the
  model already loaded proceeds at once. A lease for another model waits until
  the requests on the loaded model finish, then the engine restarts with the
  new model. Leases are granted in order, so a stream of requests for the
  loaded model cannot starve a switch.
- This covers the main model, `/model` switches, side models, subagents and
  workflows. They all build their content generator through
  `createContentGenerator`.
- An engine that exits is restarted on the next request.
- Readiness: qwen polls `/health` on loopback until it answers 200, and fails
  the request with the end of the engine's output if the engine exits first or
  does not answer within 5 minutes. `llama-server` answers once the model is
  loaded; `mlx_lm.server` answers once its worker starts and loads the model
  while the first request waits.
- Shutdown: `SIGTERM`, then `SIGKILL` after 1.5 seconds, from the exit
  cleanup; `SIGKILL` from a process `exit` listener, which also covers the
  crash handler. A qwen process killed with `SIGKILL` leaves its engine
  running.
- Engine binaries are found on `PATH` (absolute entries only). A missing
  engine fails the request with how to install it.

### Engine isolation

- Engines bind `127.0.0.1` only. qwen picks the port by binding
  `127.0.0.1:0` and closing it at once; it never accepts a connection.
- Engines start with a minimal environment: `PATH`, `HOME`, `TMPDIR` and the
  engine's own settings. Variables that make engines download or enable tools
  (`LLAMA_ARG_*`, `HF_TOKEN` and others) are not passed.
- `llama-server` runs with `--offline`, `--no-webui` and `--no-slots`, and a
  per-session random API key passed in its environment (`LLAMA_API_KEY`), not
  on its command line.
- `mlx_lm.server` runs with `HF_HUB_OFFLINE=1` and `--allowed-origins none`,
  so browsers get no CORS grant to read its responses. It loads whatever model
  a request's `model` field names (downloading it when online), so requests
  carry `default_model`, the name of the model it was started with. qwen sets
  that through `extra_body`, which is applied last: qwen's own handling,
  including Qwen's `enable_thinking` switch, still sees the entry's id.
- Both engines get Qwen3's recommended sampling (`--temp 0.6 --top-p 0.95
--top-k 20 --min-p 0`) for requests that set none. `mlx_lm.server` would
  otherwise decode greedily, which Qwen3 advises against.
- On macOS each engine runs under `sandbox-exec` with a profile that allows
  network traffic only to this machine's own addresses (loopback and its
  interface addresses) and file writes only in temporary directories and
  `~/Library/Caches`, so a model file that exploits an engine cannot plant
  anything that runs later. When qwen itself runs inside its Seatbelt sandbox, the
  engine inherits that sandbox instead, because sandboxes cannot nest.
- `QWEN_LOCAL_MODEL_KEY` holds only the placeholder `local`, which satisfies
  qwen's "API key configured" checks. The content generator sends the real
  key, which exists only in qwen's memory and the engine's environment, so
  commands qwen runs never see it.

## Decisions and alternatives

- **Both engines, MLX first**, as the user chose. On the M4 with Qwen3 4B the
  two generated at the same speed, and MLX read long prompts about 10% faster
  (see Validation). llama.cpp reads GGUF, which covers models with no MLX conversion
  and machines without Apple Silicon.
- **No downloads in qwen.** Every earlier phase removed network code. The user
  runs `hf download` knowingly.
- **Placeholder base URL** instead of a port reserved at startup: a persisted
  selection stays valid, and a restart may use a new port.
- **Lease per request** instead of restarting only on `/model`: side models,
  subagents and workflows can name any local model and still reach it.
- **No listening socket in qwen.** A proxy would have hidden the engine's port,
  but the fork has no listening sockets.

## Risks and limits

- `mlx_lm.server` has no authentication. Any process on the machine can use
  the loaded model or make it load another model from disk. A web page that
  finds the port can still send simple requests, though it cannot read the
  responses. Neither can read qwen's conversation.
- A model that `mlx_lm.server` fails to load fails each request with its error
  until the engine restarts (a `/model` switch).
- The first request of a session is slow. qwen's system prompt and tool
  definitions come to about 12,000 tokens in `qwen -p` and 17,500 in the
  interactive UI; Qwen3 4B on the M4 takes about 80 seconds to read the
  latter. Later requests reuse the engine's prompt cache. qwen's auto-memory
  extractor and prompt suggestions add requests after each turn.
- Switching between local models reloads the engine, which takes seconds for
  small models and longer for large ones. Fast, vision and subagent models
  that differ from the main model cause such switches.
- Each qwen session runs its own engine and its own copy of the model.
- Preset repository and file names come from the author's knowledge; qwen
  cannot check them. A wrong name shows up when `hf download` fails.
- On Linux, engines run without the loopback-only profile.

## Validation

- Unit tests (`packages/core/src/local-models/*.test.ts`): configuration
  validation, cache lookup (split GGUF, partial MLX downloads, a ref that is
  not a commit), the engine command and environment, engine start, failure and
  stop with a stand-in engine, lease ordering, switching, abort and restart,
  and the content generator's address, key and `model` handling.
- CLI tests: the default model with nothing configured, `localModels: []`,
  invalid entries at startup and on hot reload, the provider fallback, and the
  `.env` exclusions.
- Seatbelt profile, probed with UDP `connect()`, which sends no packets: a
  public address, the router and another LAN address are refused with
  `EPERM`; loopback and this machine's own LAN address are allowed. Both engines
  served requests under the profile, and a write to the home directory from
  inside it failed with `Operation not permitted`.
- `llama-server` under qwen: bound to `127.0.0.1` only; `401` without the key,
  `200` with it; stopped within 70 ms.
- `mlx_lm.server` under qwen: bound to `127.0.0.1` only; no CORS grant for a
  foreign origin; a request naming another model fails with "outgoing traffic
  has been disabled", and the server keeps serving.
- End to end, `qwen -p` against Qwen3 4B in both formats: the model called
  `read_file` and answered from the file, and in a second test wrote a Python
  file, ran it with the shell tool and reported its output. No engine was left
  running. With nothing configured but `localModels`, both `qwen -p` and the
  interactive UI ran the first local model without the auth dialog. A model
  that is not downloaded failed within a second with the `hf download`
  command.
- Interactive `/model` switch: Qwen3 4B MLX answered the first prompt (its
  requests carried `default_model`); after `/model qwen3-4b-gguf`, the next
  prompt, the prompt suggestion and the memory extractor went to the GGUF
  engine. No engine was left running after `/quit`.
- Speed, Qwen3 4B, cold engine, one run each:
  - A 4,580-token prompt: MLX 4-bit read it at about 335 tokens/s (including
    the model load) and generated 26.2 tokens/s; llama.cpp Q4_K_M read it at
    332 tokens/s and generated 27.5 tokens/s.
  - The 17,500-token interactive request, tools included: first token after
    78 seconds on MLX and 87 seconds on llama.cpp.

## Acceptance criteria

- With no configuration, `qwen` selects the first built-in local model and
  starts its engine on the first prompt.
- A model that is not downloaded fails with the `hf download` command.
- `/model` switches between local models in both formats, and requests reach
  the newly loaded model.
- Engines bind loopback only, and stop when qwen exits.
- No code path in qwen connects to a host other than loopback.

## Open questions

- Share one engine between qwen sessions, so two sessions do not load two
  copies of a model.
