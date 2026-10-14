# Built-in local Qwen models

## Status

Implemented, 2026-10-12, on the local-only fork. Verified on an Apple M4 with
24 GB and llama.cpp build 10240. An MLX engine (`mlx_lm.server`) was built,
measured and removed; see Decisions.

## Problem

The fork talks only to an OpenAI-compatible model server on loopback, but the
user has to start that server, pick its model files and describe it in
`modelProviders`. The fork is meant to be a local Qwen agent: it should come
with a list of Qwen models, let the user switch between them, and run them
itself.

## Goals

- A built-in, user-editable list of Qwen models, each named by its Hugging
  Face repository and GGUF file.
- qwen runs the selected model itself with `llama-server`.
- `/model`, `model.name` and `--model` select local models like any other.
- qwen never connects out. Model files come from the Hugging Face cache on
  disk; a missing model gets the exact `hf download` command for the user to
  run.

## Non-goals

- Downloading in qwen's own code, checking for new models or reading Hugging
  Face metadata. Downloads go through the user's `hf` tool.
- Installing llama.cpp.
- Serving more than one model at a time, or sharing an engine between qwen
  sessions.
- Running the engine inside a Docker sandbox, whose network is off.

## Design

### Configuration

`localModels` is a top-level setting: an array of entries.

```json
{
  "localModels": [
    {
      "id": "qwen3-8b",
      "name": "Qwen3 8B (Q4_K_M)",
      "repo": "Qwen/Qwen3-8B-GGUF",
      "file": "Qwen3-8B-Q4_K_M.gguf",
      "contextSize": 32768
    }
  ]
}
```

| Field         | Required | Meaning                                                                   |
| ------------- | -------- | ------------------------------------------------------------------------- |
| `id`          | Yes      | The name `/model`, `model.name` and `--model` use. Unique.                |
| `name`        | No       | Display name. Defaults to `id`.                                           |
| `repo`        | Yes      | Hugging Face repository, `owner/name`.                                    |
| `file`        | Yes      | The `.gguf` file in the repository. For split files, the first part.      |
| `contextSize` | No       | Context window in tokens, default 32768. Sizes the engine and compaction. |

- The default value is a built-in list: Qwen3.6 35B A3B at UD-IQ3_S with a
  64K context (the default), then Qwen3 14B, 8B and 4B at Q4_K_M. Setting
  `localModels` in `~/.qwen/settings.json` replaces it; `[]` turns local
  models off.
- `localModels` is read from user and system settings only. A workspace's
  settings cannot add a model, because an entry decides which file the engine
  loads.
- Entries are validated at startup. A bad entry is a configuration error, like
  a bad `modelProviders` entry; a bad edit during a session is reported once
  and not applied.

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
  dialog. `resolveCliGenerationConfig` falls back to the first provider entry,
  as the model registry does, so `qwen -p` resolves the same model.

### Model files

- Files are read from the Hugging Face cache: `HF_HUB_CACHE`, else
  `HUGGINGFACE_HUB_CACHE`, else `$HF_HOME/hub`, else
  `$XDG_CACHE_HOME/huggingface/hub`, else `~/.cache/huggingface/hub`, the same
  order `huggingface_hub` uses.
- The repository's `refs/main` (a 40-character commit) names the snapshot,
  which must hold the file, or every part of a split file.
- A missing model fails the request with the command to fetch it, for example
  `hf download Qwen/Qwen3-8B-GGUF Qwen3-8B-Q4_K_M.gguf`, and a note that the
  command contacts huggingface.co while qwen itself does not.
- A project `.env` cannot set `HF_HUB_CACHE`, `HUGGINGFACE_HUB_CACHE`,
  `HF_HOME` or `XDG_CACHE_HOME`, so a repository cannot point qwen at model
  files it supplies.

### Downloading and removing

- `/models`, `/models download` and `/models remove` are built-in slash
  commands, so only the user can run them; built-in commands are never
  model-invocable.
- `download` runs `hf download <repo> <file>` for a listed id, or adds a new
  repository and file to the user's `localModels` first. `remove` runs
  `hf cache rm model/<repo> -y`.
- `hf` is found on `PATH` (absolute entries only) and runs with
  `HF_HUB_DISABLE_IMPLICIT_TOKEN=1`, `HF_HUB_DISABLE_TELEMETRY=1` and no
  `HF_TOKEN`. Arguments are validated first: a repository must be
  `owner/name`, and no part of a file path may start with `-`, so neither can
  pass an option to `hf`.
- qwen itself still makes no network connection: `hf` does, and only on the
  user's command.

### Engine lifecycle

- One engine per qwen process, serving one model. Nothing starts until the
  first request for a local model. In an interactive session the engine and
  its prompt cache stay loaded until exit; each `qwen -p` run starts a new one.
- Every request for a local model takes a lease on that model. A lease for the
  model already loaded proceeds at once. A lease for another model waits until
  the requests on the loaded model finish, then the engine restarts with the
  new model. Leases are granted in order, so a stream of requests for the
  loaded model cannot starve a switch.
- This covers the main model, `/model` switches, side models, subagents and
  workflows. They all build their content generator through
  `createContentGenerator`.
- An engine that exits is restarted on the next request.
- Readiness: qwen polls `/health` on loopback until it answers 200 (once the
  model is loaded), and fails the request with the end of the engine's output
  if the engine exits first or does not answer within 5 minutes.
- Shutdown: `SIGTERM`, then `SIGKILL` after 1.5 seconds, from the exit
  cleanup; `SIGKILL` from a process `exit` listener, which also covers the
  crash handler. A qwen process killed with `SIGKILL` leaves its engine
  running.
- `llama-server` is found on `PATH` (absolute entries only). If it is missing,
  the request fails with `brew install llama.cpp`.

### Engine settings and isolation

- The engine binds `127.0.0.1` only. qwen picks the port by binding
  `127.0.0.1:0` and closing it at once; it never accepts a connection.
- The engine starts with a minimal environment: `PATH`, `HOME`, `TMPDIR` and
  `LLAMA_API_KEY`. Variables that make llama.cpp download or enable tools
  (`LLAMA_ARG_*`, `HF_TOKEN` and others) are not passed.
- `llama-server` runs with `--offline`, `--no-webui`, `--no-slots` and
  `--jinja`, and a per-session random API key passed in its environment, not
  on its command line.
- Sampling defaults to Qwen3's recommendation (`--temp 0.6 --top-p 0.95
--top-k 20 --min-p 0`) for requests that set none.
- `--spec-type ngram-simple` turns on n-gram speculative decoding: tokens are
  drafted from text already in the context and checked by the model, so
  output is unchanged. Agents echo context when they edit files.
- On macOS the engine runs under `sandbox-exec` with a profile that allows
  network traffic only to this machine's own addresses (loopback and its
  interface addresses) and file writes only in temporary directories and
  `~/Library/Caches`, so a model file that exploits the engine cannot plant
  anything that runs later. When qwen itself runs inside its Seatbelt
  sandbox, the engine inherits that sandbox instead, because sandboxes cannot
  nest.
- `QWEN_LOCAL_MODEL_KEY` holds only the placeholder `local`, which satisfies
  qwen's "API key configured" checks. The content generator sends the real
  key, which exists only in qwen's memory and the engine's environment, so
  commands qwen runs never see it.

## Decisions and alternatives

- **llama.cpp only.** An MLX engine (`mlx_lm.server`) was implemented first,
  as the default. Measured on the M4 with Qwen3 4B in qwen's real 17,500-token
  context (warm cache, a coding turn): llama.cpp with n-gram speculation
  generated 17.6 tokens/s, llama.cpp 16.5, MLX with a Qwen3 0.6B draft model
  15.4 and MLX 13.1. MLX read a cold prompt about 10% faster (80 s against
  88 s to the first token). MLX also lacks authentication and loads whatever
  model a request names, so it was removed.
- **N-gram speculation, no draft model.** On short prompts a 0.6B draft
  doubled MLX's generation but slowed llama.cpp (32 → 27 tokens/s); at agent
  context it added 18% to MLX and made each cold start 17% slower, because
  the draft reads the prompt too. N-gram speculation needs no extra model,
  costs about 5% on new text and made an edit-style reply 6× faster
  (30 → 185 tokens/s). It is on by default and can be switched off
  (`/models speculation on|off`, `speculativeDecoding`, since 2026-10-13). A
  change restarts the engine at the next request, after the requests in
  flight finish, like a model switch.
- **Qwen3.6 35B A3B as the default.** It is a mixture-of-experts model with
  3B of 35B parameters active per token and hybrid attention (three Gated
  DeltaNet layers per attention layer), so its context cache is small. On the
  M4 the UD-IQ3_S file needs 12.7 GiB for weights, 0.6 GiB of cache per 32K
  tokens and 0.4 GiB of fixed state and buffers: 14.8 GiB at 64K, inside the
  16 GiB GPU limit; at 128K llama.cpp moves layers to the CPU. Against Qwen3
  4B in the same 17,500-token context it reached the first token in 70 s
  instead of 88 s and generated 21.3 tokens/s instead of 17.6. Larger
  quantizations (17–22 GB) exceed the GPU limit, and larger models do not fit
  the disk or would stream from the SSD.
- **No MTP, no 8-bit cache.** The model's multi-token-prediction head (a
  separate 1.2 GB GGUF, `--spec-type draft-mtp`) ran out of GPU memory next
  to the weights. An 8-bit context cache made generation slower (16.9 tokens/s)
  for a cache that is already small.
- **No downloads in qwen's code.** Every earlier phase removed network code.
  The `/models` commands run the user's `hf` tool, deterministically and only
  when the user types them.
- **Placeholder base URL** instead of a port reserved at startup: a persisted
  selection stays valid, and a restart may use a new port.
- **Lease per request** instead of restarting only on `/model`: side models,
  subagents and workflows can name any local model and still reach it.
- **No listening socket in qwen.** A proxy would have hidden the engine's port,
  but the fork has no listening sockets.

## Risks and limits

- The first request of a session is slow. qwen's system prompt and tool
  definitions come to about 12,000 tokens in `qwen -p` and 17,500 in the
  interactive UI; Qwen3 4B on the M4 takes about 90 seconds to read the
  latter. Later requests in an interactive session reuse the prompt cache.
  qwen's auto-memory extractor and prompt suggestions add requests after each
  turn.
- Switching between local models reloads the engine, which takes seconds for
  small models and longer for large ones. Fast, vision and subagent models
  that differ from the main model cause such switches.
- Each qwen session runs its own engine and its own copy of the model.
- Preset repository and file names for the Qwen3 8B and 14B entries come from
  the author's knowledge; qwen cannot check them. A wrong name shows up when
  `hf download` fails. The Qwen3.6 and Qwen3 4B presets were downloaded and
  run.
- Running Qwen3.6 35B A3B next to memory-heavy apps on a 24 GB Mac pushes
  their memory to swap (swap use rose from 5 GB to 9 GB in testing).
- In one of three runs Qwen3.6 35B A3B answered in Chinese after an English
  prompt, although its reasoning was in English; `general.outputLanguage`
  pins the reply language.
- On Linux the engine runs without the Seatbelt profile.

## Validation

- Unit tests (`packages/core/src/local-models/*.test.ts`): configuration
  validation, cache lookup (split GGUF, a ref that is not a commit), the
  engine command and environment, engine start, failure and stop with a
  stand-in engine, lease ordering, switching, abort and restart, and the
  content generator's address and key handling.
- CLI tests: the default model with nothing configured, `localModels: []`,
  invalid entries at startup and on hot reload, the provider fallback, and the
  `.env` exclusions.
- Seatbelt profile, probed with UDP `connect()`, which sends no packets: a
  public address, the router and another LAN address are refused with
  `EPERM`; loopback and this machine's own LAN address are allowed. The
  engine served requests under the profile, and a write to the home directory
  from inside it failed with `Operation not permitted`.
- `llama-server` under qwen: bound to `127.0.0.1` only; `401` without the key,
  `200` with it; stopped within 70 ms.
- End to end, `qwen -p` against Qwen3 4B: the model called `read_file` and
  answered from the file, and in a second test wrote a Python file, ran it
  with the shell tool and reported its output (`42`), with n-gram speculation
  on. No engine was left running. With nothing configured but `localModels`,
  both `qwen -p` and the interactive UI ran the first local model without the
  auth dialog. An interactive `/model` switch between two local models sent
  the next prompt to the newly loaded engine. A model that is not downloaded
  failed within a second with the `hf download` command.
- Qwen3.6 35B A3B through `qwen -p`: wrote and ran the Python file and
  reported `42` in three runs (111–116 s each, including the cold prompt).
- Speed and memory: the measurements under Decisions, from cold engines, one
  or two runs each.

## Acceptance criteria

- With no configuration, `qwen` selects the first built-in local model and
  starts its engine on the first prompt.
- A model that is not downloaded fails with the `hf download` command.
- `/model` switches between local models, and requests reach the newly loaded
  model.
- The engine binds loopback only, and stops when qwen exits.
- No code path in qwen connects to a host other than loopback.

## Open questions

- Share one engine between qwen sessions, so two sessions do not load two
  copies of a model and `qwen -p` keeps a warm prompt cache.
- Use the multi-token-prediction head once there is GPU memory for it (a
  raised `iogpu.wired_limit_mb`, or a smaller quantization).
