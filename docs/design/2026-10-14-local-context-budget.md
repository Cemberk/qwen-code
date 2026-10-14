# Fitting the agent into a local model's context window

## Status

Implemented, 2026-10-14, on the local-only fork, in five changes: compaction
thresholds, loop detection, tool-output caps, model size checks and the
default eager tool list. Verified with unit tests, `/context` measurements and
the bundle on an M4 Mac with 24 GB.

## Problem

A session with the default model, Qwen3.6 35B A3B with a 64K context,
compacted five times in about 40 minutes, each compaction taking 1.5 to 3.5
minutes. Its log showed:

- The first request was 24,247 tokens before any tool call: system prompt
  4.5K, tool definitions 10.6K, memory and context files 5.4K, the skill list
  1.8K and startup context 0.9K.
- Auto-compaction fired at 32,536 tokens. The ladder subtracts a 20,000-token
  summary reserve and a 13,000-token buffer from every window, which suits
  128K+ cloud models but takes half of a 64K window. About 8K tokens were left
  for work, and compaction cannot shrink the fixed part, so the session
  compacted again every few tool calls.
- One grep result was 20,822 characters, about 5,500 tokens, under the
  25,000-character cap.
- The model read the same 50 lines four times in a row; the always-on guard
  stops five identical calls, and the other loop heuristics were off.

A second problem surfaced in the same sessions: a 4-bit build of the model
(21.2 GB) loaded for five minutes on a Mac whose GPU may use 16 GiB and then
failed with `Compute error.`.

## Goals

- Leave a 64K model most of its window for work.
- Keep behaviour for windows of 128K and more as it was.
- Fail at once, with the reason, when a model cannot fit the GPU.
- Keep the system prompt text: shortening it risks the model's behaviour
  in ways the fork cannot measure.

## Design

- **Compaction thresholds** (`computeThresholds`). Below
  `FULL_RESERVE_WINDOW` (128K) the summary reserve and the auto, warn and hard
  buffers scale with the window. Every smaller window compacts at about 75%
  of it (64K: 48.6K; 32K: 23.75K); larger windows are unchanged. This also
  removes the case where a 32K window fell back to 85% because its ceiling
  went negative.
- **Loop detection.** `model.skipLoopDetection` defaults to false, so the
  streaming heuristics run (repeated text or reasoning, re-reading files,
  repeated call patterns). A detected loop stops the turn and asks whether to
  keep detecting.
- **Tool-output caps.** When unset, the per-result cap (25,000 characters,
  Shell 30,000) and the per-batch budget (200,000) scale with the current
  model's window below 128K, with a 2,000-character floor: 12,800, 15,360 and
  102,400 on a 64K window. Explicit settings are never scaled.
- **Eager tools.** When `tools.eager` is unset, only the core coding tools go
  up front: `run_shell_command`, `read_file`, `edit`, `write_file`,
  `grep_search`, `glob`, `ask_user_question` and `web_fetch`. The rest stay
  registered and load through `tool_search`; plan-mode tools, `tool_search`
  and `tool_call` are exempt. When either half of that bridge is turned off,
  denied or disabled, no default applies, since nothing could load the
  deferred tools back. Tool definitions went from 10.6K to 5.5K tokens.
- **Model size.** On Apple silicon the GPU limit is `iogpu.wired_limit_mb`
  when set, otherwise macOS's default of 2/3 of RAM (3/4 above 36 GiB). A
  model whose files exceed it minus 1 GiB for the context does not start;
  `/models download` checks the size with `hf download --dry-run` before
  downloading and checks the file again after. Other platforms are
  unchanged.

## Results

With the default model, measured with `/context`:

|                                | Before      | After     |
| ------------------------------ | ----------- | --------- |
| Fixed prompt, empty folder     | about 19.0K | 14.2K     |
| Fixed prompt, this repository  | 23.2K       | 18.3K     |
| Auto-compaction                | 32.5K       | 48.6K     |
| Room for work, this repository | about 9K    | about 30K |

## Risks

- A deferred tool costs the model a `tool_search` call before first use, and
  a weaker model may not think to search. `/context` and `tools.eager` make
  the list visible and changeable.
- Loop heuristics can stop a legitimate turn; the dialog lets the user keep
  going and turn detection off for the session.
- The GPU limit is a model of macOS's default, not a query of Metal. A Mac
  with a different default would be judged wrongly; setting
  `iogpu.wired_limit_mb` makes the check use that value.
- A model that passes the size check can still fail with a large context
  cache, for example a dense model at 32K; the check only stops models whose
  weights alone cannot fit.

## Validation

- Unit tests for the threshold ladder (including 64K), the loop-detection
  default, the scaled caps, the default eager list and its bridge exceptions,
  the GPU limit and size messages, the engine refusing a large model, and
  `/models download` refusing one before downloading.
- `/context` in this repository and in an empty folder with the rebuilt
  bundle, for the numbers above.
- The GPU limit computed on the M4 (16.00 GiB), the default model passing
  (13.7 GB) and the 21.2 GB build refused with its size and the limit.

## Open questions

- Shortening the system prompt for small models would need a way to measure
  the effect on the model's work first.
