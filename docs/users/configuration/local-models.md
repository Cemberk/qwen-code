# Local Models

Qwen Code comes with a list of Qwen models that it runs itself with llama.cpp.
Download a model once, pick it with `/model`, and Qwen Code starts
`llama-server` when you send your first prompt and stops it when you exit.
Qwen Code does not download models by itself: you download the model files
yourself.

## Setup

Install llama.cpp; Qwen Code finds `llama-server` on your `PATH`:

```bash
brew install llama.cpp
```

[Saved prompts](#saved-prompts) need llama.cpp from 2026-10-08 or later, and
Homebrew's 0.6.0 is older. To build the current version instead (static, with
Metal, without its download support) and put it ahead of Homebrew's on your
`PATH`:

```bash
git clone --depth 1 https://github.com/ggml-org/llama.cpp ~/.local/src/llama.cpp
cd ~/.local/src/llama.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DLLAMA_OPENSSL=OFF -DGGML_METAL=ON
cmake --build build --target llama-server -j
cp build/bin/llama-server ~/.local/bin/
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
| `/models speculation`             | Shows whether speculative decoding is on.                                                                  |
| `/models speculation on` or `off` | Turns speculative decoding on or off (see [How the engine runs](#how-the-engine-runs)).                    |

`hf` runs without your Hugging Face token and with telemetry off. Downloading
contacts huggingface.co; the `hf` tool also checks PyPI for a newer version of
itself once a day.

On a Mac with Apple silicon, `/models download` first asks `hf` for the file's
size (`hf download --dry-run`) and refuses a file too big for the Mac's memory;
see [Model size](#model-size).

`/models remove` deletes the whole repository from the cache, including a file
of it that is still downloading. Wait for downloads from that repository to
finish first.

## Model size

On Apple silicon the GPU can use about two thirds of the Mac's memory (three
quarters above 36 GB), or the limit you set with `sudo sysctl
iogpu.wired_limit_mb=<MB>`. A model whose file fits in that with about 1 GB to
spare for its context runs entirely on the GPU.

A mixture-of-experts model that does not fit, such as Qwen3.6 35B A3B in a
larger quantization, keeps the experts of its first few layers in ordinary
memory, where the CPU runs them (llama.cpp's `--n-cpu-moe`). Qwen Code moves
as few layers as leave the GPU about 1.5 GB to spare, and reads them into
memory rather than mapping the file (`--load-mode none`). After
`/models download`, it says how many layers will run on the CPU. On an M4
with 24 GB, at a 32K context with speculative decoding on:

| Model                                 | Reading an 8.7K-token prompt | File edit | New text |
| ------------------------------------- | ---------------------------- | --------- | -------- |
| UD-IQ3_S (13.7 GB), all on the GPU    | 26 s                         | 58 tok/s  | 28 tok/s |
| Q3_K_M (16.8 GB), 3 layers on the CPU | 33 s                         | 52 tok/s  | 26 tok/s |

A dense model that does not fit cannot run, nor can a model that would leave
macOS and other apps less than 4 GB of memory. Qwen Code checks this before it
downloads a model and before it starts one, and says why instead.

On a 24 GB Mac the GPU limit is about 17 GB: 3-bit builds of a 35B A3B model
(about 14 GB) fit, builds up to about 20 GB run partly on the CPU, and larger
ones cannot run.

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

| Field         | Required | Description                                                                                                         |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `id`          | Yes      | The name `/model`, `model.name` and `--model` use. Must be unique.                                                  |
| `name`        | No       | Display name in `/model`. Defaults to `id`.                                                                         |
| `repo`        | Yes      | Hugging Face repository, `owner/name`.                                                                              |
| `file`        | Yes      | The `.gguf` file in the repository. For a split file, the first part (`…-00001-of-0000N.gguf`).                     |
| `contextSize` | No       | Context window in tokens. Default `32768`.                                                                          |
| `draft`       | No       | A draft model for speculative decoding: `{ "repo": "...", "file": "....gguf" }`. See [Draft models](#draft-models). |

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
  edits, without changing what the model writes. It costs about 5% on new
  text. It is on by default; turn it off with `/models speculation off`
  (saved as `speculativeDecoding` in your user settings). If the engine is
  running, it restarts with the change at your next prompt, so that reply
  takes as long as the first one of a session.
- On macOS the engine runs in a sandbox that blocks network traffic to
  anything except this machine, and lets it write files only in temporary
  and cache folders.
- The engine stops when Qwen Code exits. If Qwen Code is killed with
  `kill -9`, the engine keeps running until you stop it.

## Saved prompts

At the end of each turn, Qwen Code saves the engine's processed prompt for
the session, much like it saves the session's history. When an engine
starts, it restores the session's saved prompt, or else the latest one from
the same project:

- `qwen --continue` and `/resume` continue without reading the conversation
  again.
- A new session in the same project skips reading the system prompt and
  tool definitions, which another session already read.

The files are in `~/Library/Caches/qwen-code/prompt-cache` on macOS
(`~/.cache/qwen-code/prompt-cache` on Linux), readable only by you. A state is
several hundred MB and grows with the conversation; beyond 4 GB in total the
oldest are deleted. A state is only restored into the same model file,
context size and speculative decoding setup. Saving takes one to a few
seconds after a turn. Set `"localModelPromptCache": false` to turn it off.

With llama.cpp older than 2026-10-08 the state is restored but the prompt is
still read again in full, because those versions do not save the
checkpoints the Qwen3.6 models need.

## Draft models

Speculative decoding can use a small draft model that guesses several tokens
for the main model to check at once. Name it in the model's entry:

```json
{
  "id": "qwen3.8-27b",
  "repo": "unsloth/Qwen3.8-27B-GGUF",
  "file": "Qwen3.8-27B-UD-IQ3_XXS.gguf",
  "draft": {
    "repo": "z-lab/Qwen3.8-27B-DFlash2-GGUF",
    "file": "Qwen3.8-27B-DFlash2-Q4_K_M.gguf"
  }
}
```

The draft must be a DFlash, DSpark or MTP GGUF made for the model; llama.cpp
reads which kind it is from the file. A plain small model of the same family
loads but is not used.

`/models download` fetches the draft with the model. Until the draft is
downloaded, or with speculative decoding off, the engine drafts from the
conversation instead (n-gram). The draft needs GPU memory beside the model and
counts toward its [size](#model-size); if the engine still cannot answer with
it, the engine stops at once and says so.

Draft models help dense models most. For Qwen3.6 35B A3B on an M4 they did
not pay: with z-lab's DFlash draft, file edits ran at 63 tokens per second
against 61 with n-gram drafting, and new text at 22 against 28, and the draft
only fit with a 32K context. The built-in models use n-gram drafting.

## Fitting in the context window

The built-in models have a 32K or 64K context window, far less than cloud
models. Qwen Code adapts to it:

- Only the core coding tools go to the model up front: shell, read, edit,
  write, grep, glob, asking you a question, and `web_fetch` when web access is
  on. The others (subagents, memory, goals, artifacts and more) load through
  `tool_search` when the model needs them. Set `tools.eager` to change the
  list.
- Auto-compaction starts at about 75% of the window: at 48.6K tokens of a
  64K window.
- One tool result is cut at about 12,800 characters on a 64K window (shell
  output at 15,360), unless you set `tools.truncateToolOutputThreshold`.
- Loop detection is on, so a model that keeps repeating itself is stopped and
  you are asked whether to keep detecting.

About 14,000 tokens stay fixed in a folder without context files: the system
prompt (3.8K), tool definitions (5.5K), memory (1.9K), the list of skills
(1.8K) and startup context (1.2K). Context files such as `QWEN.md` or
`AGENTS.md` add to that. `/context` shows the breakdown. To save the 1.8K of
the skill list, hide the bundled skills:

```json
{ "skills": { "disabledLevels": ["bundled"] } }
```

## Limits

- The first reply of a session takes longest: the fixed prompt above, about
  14,000 tokens or more, has to be read first, and Qwen3.6 35B A3B on an M4
  reads about 250 tokens a second. Later replies reuse the engine's cache and
  start within a second. `qwen -p` starts a new engine each time, so every run
  pays this cost.
- Each Qwen Code session runs its own engine and loads its own copy of the
  model.
- Local models do not run inside the Docker sandbox, which has no network.
- On Linux the engine runs without the network sandbox.
