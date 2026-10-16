# Saved prompts and draft models for the local engine

## Status

Implemented, 2026-10-16, on the local-only fork. Measured on an M4 Mac with
24 GB and Qwen3.6 35B A3B (UD-IQ3_S), against llama.cpp b10240 (August) and
b11696 (built from source, October 16).

## Problem

Every new engine reads the whole prompt again. A headless session spends
about 30 seconds reading Qwen Code's 8.7K-token prompt before it answers, and
`qwen --continue` reads the whole history again, because the engine that
processed it exited with the previous session. Speculative decoding only had
n-gram drafts; draft models (DFlash, MTP) promise more on new text.

## Goals

- Resuming a session, or starting another one in the same project, does not
  read what the engine already read.
- Draft models can be configured per local model, and fall back to n-gram
  drafting when missing.
- Nothing about this can make a request fail.

## Design

### Saved prompts

- llama-server runs with `--slot-save-path` and two slots that share one
  cache (`--parallel 2 --kv-unified`). Requests with the main-session prompt
  id are pinned to slot 0, and side queries (memory extraction, subagents and
  other background queries) to slot 1, with `id_slot` in the request body, so
  slot 0 always holds the conversation and both can still run at once.
  Compaction uses the main-session prompt id, so it runs in slot 0 and reuses
  the conversation it summarizes.
- A conversation turn ends when a main-session stream (prompt id
  `<session>########<n>`) completes without a tool call. The server then
  saves slot 0 to `<project>-<engine>-<session>.bin` before it grants another
  lease, so no side query has replaced the state. Saving after every tool
  step would add the save time to every step.
- When an engine starts, it restores the session's own file, or else the
  newest file of the same project and engine. llama.cpp checkpoints the
  hybrid model's recurrent state at the start of each user message, so a new
  session reuses the system prompt and tools from another session's file.
- `<engine>` hashes the model file path (which includes the snapshot
  commit), the draft path, the context size and the speculation setting:
  a state is never restored into a different model or setup.
- Files live in the user cache folder (`~/Library/Caches/qwen-code/prompt-cache`
  on macOS), not next to the history in `~/.qwen`: they are large, can always
  be recomputed, are skipped by Time Machine, and the engine sandbox may write
  there. The folder is private to the user; files beyond 4 GB in total are
  deleted, oldest first. `localModelPromptCache: false` turns it off.
- Restoring needs llama.cpp from 2026-10-08 or later (#26004): older builds
  restore the tokens but not the hybrid model's checkpoints, and read the
  prompt again in full.

### Draft models

- A `localModels` entry may name a `draft` GGUF (`repo`, `file`). With
  speculative decoding on and the draft downloaded, the engine runs it
  (`--spec-draft-model`, 6 tokens per step); otherwise it keeps n-gram
  drafting. llama.cpp reads the draft's type (DFlash, DSpark or MTP) from
  its GGUF metadata, so no type is configured; a plain small model would
  load without being used. `/models download` fetches the draft
  too, and the GPU size check at engine start counts it.
- A draft that does not fit the GPU passes startup and then fails every
  request, so an engine with a draft answers one short request before it is
  used, and otherwise stops with an explanation.

## Measurements

Engine benchmark, Qwen Code's real 8.7K-token first request:

|                                     | b10240                         | b11696                                     |
| ----------------------------------- | ------------------------------ | ------------------------------------------ |
| Cold prompt                         | 24–29 s (295–355 tok/s)        | 25–26 s (328–349 tok/s)                    |
| Saving the conversation             | 0.11–0.15 s, 244 MB            | 1.6–1.9 s, 574 MB                          |
| Follow-up after restart and restore | re-reads 8,708 tokens, 27–31 s | 4 tokens, 0.1 s, plus 1.4–1.5 s to restore |

Writing speed at temperature 0 (identical text for every configuration), 32K
context:

|                           | File edit  | Prose      |
| ------------------------- | ---------- | ---------- |
| b10240, n-gram (before)   | 61 tok/s   | 28 tok/s   |
| b11696, no drafting       | 28.6 tok/s | 28.6 tok/s |
| b11696, n-gram            | 61 tok/s   | 28 tok/s   |
| b11696, DFlash (6 tokens) | 63 tok/s   | 22 tok/s   |
| b11696, DFlash (3 tokens) | 51 tok/s   | 28 tok/s   |
| b11696, DFlash + n-gram   | 73 tok/s   | 21 tok/s   |

For this mixture-of-experts model the DFlash draft
(`z-lab/Qwen3.6-35B-A3B-DFlash`, Q8_0) does not pay: only 22–39% of its
drafts are accepted on new text, and each drafted token routes to other
experts, so verifying them costs about as much as generating. It also needs
GPU memory the 64K context uses: at 64K the first request failed with
`kIOGPUCommandBufferCallbackErrorOutOfMemory`. The built-in models therefore
keep n-gram drafting; draft models are opt-in for models where they help,
such as dense ones.

End-to-end, `qwen -p` in a small project: a new session that reads a file
and summarizes it, then `--continue` with a follow-up question, twice. Time
until the answer is written, including engine start, and in brackets until
the process exits:

|                                              | Before (b10240)       | After (b11696, saved prompts) |
| -------------------------------------------- | --------------------- | ----------------------------- |
| New session, first in the project            | 52.0 s (90 s)         | 51.7 s (86 s)                 |
| New session after another one in the project | 40.7 s (76 s)         | 15.9 s (52 s)                 |
| `--continue`                                 | 36.7–37.8 s (70–72 s) | 11.1–13.7 s (50–69 s)         |

Before, every run read the whole prompt again (0 tokens cached). After, the
resumed requests reused 8,153 of about 9,150 tokens, and the second new
session reused 8,153 of 8,669 from the first session's file. A hybrid model
can only go back to a checkpoint, and here the last one that still matched
was at the start of the first user message. The rest of each run is the
memory extraction a headless run waits for: it reads its own 6.7K-token
prompt in slot 1, which is not saved, and takes 34–51 s. In an interactive
session it runs in the background.

## Risks

- A saved state is several hundred MB to a few GB; saving it adds 1–5 seconds
  after each turn, before the next request.
- A side query pinned to slot 1 waits for slot 1; two side queries at once run
  one after another.
- Saved states contain the processed conversation and are as sensitive as the
  history file; the folder is user-only.

## Validation

- Unit tests: state file names and choice, pruning, engine arguments for
  drafts and the prompt cache, slot pinning, saving only at turn ends and
  after in-flight requests, restoring on start, best-effort failures, the
  `draft` setting and `/models` draft download.
- Engine and end-to-end measurements above.
