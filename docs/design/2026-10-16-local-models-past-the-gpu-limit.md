# Local models past the GPU limit

## Status

Implemented, 2026-10-16, on the local-only fork. Measured on an M4 Mac with
24 GB, llama.cpp b11696, and Qwen3.6 35B A3B in two quantizations.

## Problem

macOS lets the GPU use about two thirds of memory: 16 GiB on a 24 GB Mac.
Qwen Code refused every model that did not fit in that with 1 GiB to spare,
so a 16.8 GB build of a 35B A3B model could not run although the Mac has
the memory for it.

## Options considered

- **llama.cpp's automatic fit** (`--fit on`, its default). For the 16.8 GB
  file it split five layers between GPU and CPU its own way: reading a
  prompt took 167 s instead of 26 s.
- **Streaming weights from the SSD** (as Hypura does). Built for models
  larger than memory; its own figures are 0.3 to 2.2 tokens per second, and
  it reads the whole prompt again for every request.
- **Experts of the first layers in system memory** (`--n-cpu-moe N`).
  Qwen3.6 35B A3B keeps 85–92% of its weights in experts, depending on the
  quantization; moving a few layers' worth frees enough GPU memory while
  attention and the rest stay on the GPU. Chosen.

## Design

- The model fits when its files (with its draft) plus 1 GiB for the context
  fit the GPU limit; it then runs as before.
- Otherwise, if the files plus 1 GiB plus 4 GiB for macOS and other apps fit
  in RAM, Qwen Code reads the GGUF header (tensor names and offsets, about
  40 ms) and adds up the expert tensors of each layer, matching llama.cpp's
  pattern (`blk.N.ffn_{up,down,gate,gate_up}_{,ch}exps`). It picks the
  smallest N whose first N layers free enough to leave 1.5 GiB of the limit:
  1 GiB for the context and 0.5 GiB of margin. The engine starts with
  `--n-cpu-moe N --load-mode none`.
- A dense model, or one whose experts cannot free enough, is refused as
  before, with the size and the limit. A model too big for RAM is refused
  with the Mac's memory size.
- `/models download` can only check the file size before downloading, so it
  refuses only files too big for RAM; after the download it says how many
  layers will run on the CPU, or why the model cannot run.

## Measurements

Qwen Code's real 8,669-token first request, then a file edit and new text at
temperature 0; 32K context, n-gram speculation on. Q3_K_M is 16.8 GB with
396 MiB of experts in each of its first two layers and 364 MiB in the rest.

| Model and layers on the CPU | Load mode | Prompt      | File edit       | New text        |
| --------------------------- | --------- | ----------- | --------------- | --------------- |
| UD-IQ3_S (13.7 GB), none    | mmap      | 25.9 s      | 58.5 tok/s      | 27.6 tok/s      |
| Q3_K_M, llama.cpp's fit     | mmap      | 166.6 s     | 26.3 tok/s      | 27.1 tok/s      |
| Q3_K_M, 2                   | mmap      | 33.6 s      | 38.8 tok/s      | 16.3 tok/s      |
| Q3_K_M, 3                   | mmap      | 31.6–43.3 s | 44.4–45.9 tok/s | 26.1–28.0 tok/s |
| Q3_K_M, 4                   | mmap      | 49.4–56.2 s | 46.1–49.6 tok/s | 25.6–29.6 tok/s |
| Q3_K_M, 5                   | mmap      | 52.6 s      | 30.8 tok/s      | 26.9 tok/s      |
| Q3_K_M, 8                   | mmap      | 58.5 s      | 21.0 tok/s      | 17.7 tok/s      |
| Q3_K_M, 3                   | none      | 32.6 s      | 51.6 tok/s      | 25.9 tok/s      |
| Q3_K_M, 4                   | none      | 33.2 s      | 49.1 tok/s      | 28.1 tok/s      |
| Q3_K_M, 5                   | none      | 36.8 s      | 35.4 tok/s      | 25.1 tok/s      |

- Two layers leave the GPU about 0.5 GiB free at a 32K context, and new text
  ran at about half speed; three leave about 0.9 GiB. The 0.5 GiB margin
  picks three for this file.
- Each further layer moves work to the CPU, which reads prompts more slowly.
- Reading the CPU layers into memory (`--load-mode none`) instead of mapping
  the file made prompts faster and steadier. It loads in about 9 s instead
  of 3 s.
- macOS barely swapped in any run.

## Risks

- The margin is calibrated on one model at a 32K context. A 64K context
  needs more cache, so it leaves less of the margin free.
- Memory read with `--load-mode none` cannot be dropped and read back from
  the file under memory pressure; it is compressed or swapped instead. The
  4 GiB reserve keeps room for macOS and a few apps.
- An older llama-server without `--n-cpu-moe` or `--load-mode` exits at
  startup with its usage error; build 10240 (August 2026) has both.

## Validation

- Unit tests: GGUF header reading (string and number arrays, alignment,
  split files), expert bytes per layer, the fit (no reading of layers when
  the model fits, fewest layers, dense and too-big models), engine arguments,
  and the download messages.
- The measurements above, and a session in Qwen Code with the Q3_K_M file.
