# Adaptive local inference: every machine, every model

Status: proposed. Covers qwen-code (`harden/local-only`) and the llama.cpp fork
(`Cemberk/llama.cpp`, identical to ggml-org `master` at e30ad80 on 2026-11-05).

## Goal

One local engine that picks the best way to run a model on whatever machine it
is on (Windows, macOS, Linux; NVIDIA, AMD, Apple, Intel; discrete or unified
memory), and keeps doing so as models gain new features. Two concrete aims:

1. Make the default model (Qwen3.6 35B A3B) faster on every machine.
2. Run models larger than GPU memory, and larger than RAM, by keeping only the
   experts a session uses close to the compute, and moving them as the
   conversation changes.

We keep llama.cpp as the engine and add the techniques to our fork, rather
than adopting Strata's engine: llama.cpp brings every GPU backend and new
model architectures as they appear, while Strata hand-writes each model.

## Where things stand

### qwen-code

`packages/core/src/local-models/` starts one `llama-server` per session.

|                                                     | macOS              | Windows                                 | Linux            |
| --------------------------------------------------- | ------------------ | --------------------------------------- | ---------------- |
| GPU memory measured, model fitted (`gpu-memory.ts`) | yes                | no                                      | no               |
| `--n-cpu-moe` chosen                                | yes                | no                                      | no               |
| Engine network confinement                          | Seatbelt           | `--offline` only                        | `--offline` only |
| Prompt cache folder (`prompt-cache.ts`)             | `~/Library/Caches` | `~/.cache` (should be `%LOCALAPPDATA%`) | XDG              |
| Install hint when `llama-server` is missing         | brew               | brew (wrong)                            | brew (wrong)     |

The engine's environment keeps only `PATH`, `HOME` and `TMPDIR`
(`engine.ts`, `engineCommand`). On Windows a child usually needs `SystemRoot`
(Winsock, driver DLLs) and `TEMP`/`TMP`; unverified, but the likely cause of
engine start failures there.

### llama.cpp (upstream, so already in the fork)

| Capability                                  | Where                                                                                    | Notes                                 |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------- |
| Static expert placement                     | `--n-cpu-moe`, `-ot` (`common/arg.cpp`)                                                  | per layer or tensor pattern           |
| Auto-fit unset options to device memory     | `--fit`, `--fit-target`, `--fit-ctx`                                                     | we do not use it yet                  |
| Large-batch offload of CPU weights          | `ggml_backend_sched` `op_offload`; CUDA `GGML_OP_OFFLOAD_MIN_BATCH` (32)                 | prefill copies CPU experts to the GPU |
| **GPU cache of CPU-resident experts**       | `--moe-cache-mib`, `src/llama-moe-cache.{h,cpp}`                                         | experimental, see below               |
| Drafting                                    | `--spec-type`: draft, eagle3, mtp, dflash, dspark, five n-gram kinds (`common/common.h`) | no live gating of draft length        |
| Context checkpoints for hybrid / SWA models | `--ctx-checkpoints`, `--checkpoint-min-step`                                             | placement not tied to turn boundaries |
| Host prompt cache                           | `--cache-ram`, `--cache-idle-slots`                                                      |                                       |
| Architectures                               | Qwen3.5/3.6 MoE, Qwen3-Next, DeepSeek-V4, many more (`src/llama-arch.h`)                 |                                       |

The MoE cache today:

- One SLRU per device and layer group; hits are promoted, misses evict from
  the probation half.
- On a miss, the selected expert ids are read back to the host
  (`ggml_backend_synchronize`), then the missing experts are uploaded and the
  GPU computes them. **That is one host round trip per MoE layer per step**,
  which is the main limit on decode speed.
- Off for large batches (prefill), so prefill does not evict generation experts.
- Logs hits, misses and bytes uploaded at exit; nothing exposed at runtime.
- Disables pipeline parallelism across GPUs.

### What we take from elsewhere

| Source                     | Idea                                                                                                                              | Reported gain (their conditions)                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Strata                     | Misses computed on the CPU, in place, while the GPU runs cached experts                                                           | Qwen3.6 Q4_K_XL on RTX 3060: 59.7 vs 48-52 tok/s for `-ncmoe 26`; Flash-Next 3-5x llama.cpp decode on 12-16 GB cards |
| Strata                     | Per-machine planner: memory tiers, unified-memory accounting, threads from P/E cores, optional calibration cached by hardware key | +up to 7.9% from calibration                                                                                         |
| Strata                     | Bigger prefill chunks when the model fits                                                                                         | pp4096 6220 vs 3453 at chunk 512 (R9700)                                                                             |
| Strata                     | Prompt-lookup drafting only when measured acceptance and cost pay                                                                 | +6-11% on code edits                                                                                                 |
| Strata                     | Checkpoint at the last turn boundary                                                                                              | -33% on first edit of last message                                                                                   |
| gr8, DeepInfer             | Draft length chosen per round from confidence, acceptance and step cost                                                           | not isolated                                                                                                         |
| DeepInfer `eplb/policy.py` | Greedy expert placement from historical per-expert token counts                                                                   | datacenter; we reuse the algorithm with memory tiers as ranks                                                        |
| DeepInfer                  | Bounded replay for sliding-window models: re-read only window + margin                                                            |                                                                                                                      |
| LPLB                       | Per-batch LP balancing across 8-16 GPUs                                                                                           | not applicable to one machine; at most 2-GPU desktops                                                                |

Strata's numbers are from its own docs and not reproduced by us.

## Architecture

```
qwen-code (TypeScript)                         llama.cpp fork (C++)
+---------------------+   +------------------+
| 1 Hardware probe    |-->|                  |
+---------------------+   | 3 Planner        |--> EnginePlan --> 4 Engine adapter --> llama-server
| 2 Model inspector   |-->| rules + cached   |                       ^                     |
+---------------------+   | calibration      |                       |                     |
                          +------------------+                       |                     v
                                   ^                                  |          expert stats, draft
                                   +---- 5 Runtime feedback <---------+--------- acceptance, cache hits
                                        (saved per project)
```

1. **Hardware probe** -> `HardwareProfile`: devices with kind (discrete or
   unified), backend (CUDA, HIP, Vulkan, Metal, SYCL), memory, compute
   capability or gfx target, PCIe link; RAM; CPU physical cores with P/E split
   and AVX2/AVX-512; disk class; WSL. Sources: `nvidia-smi`; AMD KFD sysfs on
   Linux and `Win32_VideoController` plus shared-memory size on Windows;
   `sysctl` on macOS. Unified memory is counted once, less an OS reserve.
2. **Model inspector** -> `ModelCapabilities`, from GGUF metadata (we already
   parse headers in `gguf.ts`): architecture, MoE layout and bytes per expert
   per layer, experts used per token, built-in draft heads (MTP, DFlash,
   DSpark), sliding window, recurrent layers, context. A new model feature is
   a new field here and a rule in the planner, not a new engine.
3. **Planner** -> `EnginePlan`: which `llama-server` build, layer and expert
   placement, MoE cache size, KV type, batch sizes, threads, drafting, cache
   and checkpoint policy. Rules give a good default with no measurement;
   optional calibration sweeps keep a setting only if it is >3% faster and
   cache the result under GPU|VRAM|CPU|RAM|model|ctx.
4. **Engine adapter**: today's `engine.ts`, generalised so the command line
   comes from the plan. One adapter (our fork) for now; the interface leaves
   room for another engine later.
5. **Runtime feedback**: the fork exposes expert-usage counts, cache hit rate
   and draft acceptance; qwen-code saves them per project next to the prompt
   cache and feeds them into the next plan and the next warm start.

## Expert tiering (the core)

Routing is chosen per token and per layer, so the experts a step needs are
only known when it runs. Usage within a session is skewed, which is what makes
a cache work; the speed depends on where misses are served from.

Tiers: **VRAM** (hot, computed by the GPU), **RAM** (warm, computed by the CPU
in place or uploaded), **SSD** (cold, mapped, paged in by the OS).

What matters per machine class:

| Machine                                                        | Tiers that matter | Main lever                                                       |
| -------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------- |
| Discrete GPU + RAM (NVIDIA, Radeon, Arc)                       | VRAM <-> RAM      | MoE cache with CPU-side miss compute                             |
| Unified memory (Apple, Strix Halo, 780M-class iGPU, DGX Spark) | RAM <-> SSD       | GPU sees all of RAM; keep hot experts resident, cold ones mapped |
| RAM smaller than the model (any)                               | RAM <-> SSD       | expert-granular residency and prefetch                           |
| Two GPUs                                                       | VRAM0, VRAM1, RAM | disjoint caches (no duplicate experts), split by layer           |

Fork work, in order:

1. **Expose cache statistics at runtime.** Per layer and expert: selections,
   hits, misses, bytes. A server endpoint (e.g. `/moe/stats`) and an option to
   dump routing traces (layer, token, expert ids) to a file.
2. **Offline simulator.** Replays routing traces against placement policies
   and cache sizes, so policies are compared without the hardware. Traces from
   real qwen-code sessions on each test machine are the benchmark corpus.
3. **Warm start from a saved profile.** Seed the cache with the experts a
   project used last time (top-N by count, EPLB-style greedy fill per layer
   within the budget), instead of starting empty. Mark them protected in the
   SLRU.
4. **Frequency-aware policy.** SLRU plus decayed per-expert counts (EPLB
   greedy over a sliding window) to decide promotion and eviction. Validate in
   the simulator first.
5. **Hybrid miss compute.** For a decode step, split each MoE layer: cached
   experts on the GPU, missed experts computed by the CPU from RAM at the same
   time, results added. This removes the per-layer synchronous upload; uploads
   move to a background stream for experts that keep missing. This is the
   largest change and the biggest expected win on discrete GPUs.
6. **SSD tier.** With mmap, the OS already pages experts in. Add per-expert
   `madvise(WILLNEED)` / `PrefetchVirtualMemory` for predicted experts, lock
   the hot set (`mlock` / `VirtualLock`), and size the resident set from the
   RAM budget. Required for models larger than RAM.
7. **Lookahead prefetch (research).** Predict the next layer's experts from
   the current hidden state and start their uploads or page-ins early. Only if
   the simulator shows the miss latency still dominates after 5 and 6.

## Other techniques

| Technique                                | Stock flags                                             | Fork change                                                  | Phase     |
| ---------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------ | --------- |
| Fit model and context per machine        | `--fit`, `--n-cpu-moe` from our planner                 |                                                              | 1         |
| Larger prefill batches when it fits      | `-b`/`-ub` 2048-4096                                    |                                                              | 2         |
| 8-bit KV on tight memory                 | `-ctk q8_0 -ctv q8_0`, flash attention on               |                                                              | 2         |
| Threads from physical / P-cores          | `-t`, `-tb`                                             |                                                              | 2         |
| MoE cache on discrete GPUs               | `--moe-cache-mib`                                       | items 1-6 above                                              | 2, then 3 |
| Built-in draft heads                     | `--spec-type mtp\|dflash\|dspark` when the GGUF has one |                                                              | 2         |
| Gated n-gram drafting                    |                                                         | skip drafting when measured acceptance x length does not pay | 3         |
| Adaptive draft length                    |                                                         | choose N per round from confidence, acceptance and step cost | 3         |
| Turn-boundary checkpoints                | `--ctx-checkpoints`                                     | place one at the last turn boundary                          | 3         |
| Bounded replay for sliding-window models |                                                         | re-read only window + margin after a restore                 | 4         |
| Fewer experts per token ("fast" mode)    | `--override-kv <arch>.expert_used_count=int:N` (verify) |                                                              | 4, opt-in |

## Phases

**Phase 1: correct everywhere (qwen-code only).**

- Hardware probe for all platforms; `fitModel` on all platforms; unified
  memory handled.
- Windows: engine environment (`SystemRoot`, `TEMP`, `TMP`, `USERPROFILE`,
  `LOCALAPPDATA`), cache folder, per-platform install hints.
- `localModelEngine` names the fork's `llama-server`; `/models setup` prints
  the build commands for this machine's backend (Metal, CUDA, Vulkan, HIP),
  always without OpenSSL so the engine cannot reach HTTPS.
- Engine network confinement on Linux: run it in an empty network namespace
  (`bwrap --unshare-net` where available), listening on a Unix socket
  (`--host <path>.sock`, which `llama-server` supports), with qwen's client
  talking over that socket. Windows: loopback and `--offline` only, as no
  confinement works there without admin rights.
- Done when: the default model starts and fits on every test machine.

**Phase 2: planner with stock flags.**

- Model inspector, planner, plan-driven `engineCommand`, calibration cache.
- Done when: per machine, tokens/s for prompt and generation beat today's
  defaults on the benchmark corpus, with no regressions.

**Phase 3: fork, expert tiering 1-5 and drafting.**

- Stats endpoint and traces, simulator, warm start, frequency policy, hybrid
  miss compute; gated and adaptive drafting; turn-boundary checkpoints.
- qwen-code saves expert profiles per project.
- Done when: a model 1.5-2x larger than VRAM generates at a usable speed on a
  12-16 GB discrete GPU, and the default model is faster on discrete GPUs than
  with the best static `--n-cpu-moe`.

**Phase 4: larger than RAM, new model features.**

- SSD tier, lookahead prefetch if justified, bounded replay, model catalog
  mapped to hardware tiers so `/model` only offers what runs well.

## Measuring

- Machines: at least one each of Apple Silicon, NVIDIA discrete, Radeon
  discrete, AMD unified (780M or Strix Halo), and a Linux box; recorded as
  `HardwareProfile` with every result.
- Corpus: recorded qwen-code sessions (prompts, tool outputs, edits) replayed
  against the engine, plus `llama-bench` for raw prefill and decode.
- Metrics: prompt tok/s, generation tok/s, time to first token after resume
  and after compaction, MoE cache hit rate, draft acceptance, peak memory.
- Rule: a change lands only with before/after numbers on at least two machine
  classes, and an output check (same tokens at temperature 0 where the
  technique should not change output).

## Keeping the fork healthy

- Rebase on ggml-org `master` regularly; keep our changes in new files where
  possible (`llama-moe-cache.cpp` already is one).
- The fork is for personal use and is not upstreamed.

## Progress

- Phase 1 (branch `adaptive-local-inference`): hardware probe, fitting on
  every platform, Windows engine environment, `localModelEngine`,
  `/models setup`; Linux engine in an empty network namespace on a Unix
  socket.
- Phase 2, first part: GGUF metadata reader and model inspector
  (`model-inspector.ts`), planner (`planner.ts`) with one rule (2048-token
  prompt batches when the GPU has 2 GiB to spare), `localModelEngineArgs`
  for per-machine experiments, `/models plan`, and `/models bench`, which
  logs prompt and generation speed with the machine and options to
  `~/.qwen/local-model-bench.jsonl`. Further rules wait for bench results
  from each machine class.
- Phase 2, second part: the planner asks the engine build for its devices
  (`--list-devices`), so a CPU-only build is planned for the CPU;
  `/models bench` reads `/metrics` for draft acceptance and the MoE cache
  hit rate; `/models` says how each downloaded model runs here. Verified
  end to end on Windows (780M laptop) with a CPU build of the fork.
- Phase 3 in the fork (branch `adaptive-moe` of `Cemberk/llama.cpp`):
  - Item 1: `llama_moe_cache_get_stats()`, `llamacpp:moe_cache_*` in
    `/metrics`, `--moe-cache-trace FILE`. Compiled (CPU build).
  - Item 2: `tools/moe-sim/moe_cache_sim.py` (slru, lru, lfu, warm,
    belady); its lfu and warm model the engine exactly.
  - Items 3 and 4: `--moe-cache-profile FILE` (decayed usage per expert,
    warm start of up to half the slots, saved at exit) and
    `--moe-cache-policy lfu`. qwen-code passes a profile per project and
    model whenever `localModelEngineArgs` turns the cache on. Not yet
    compiled.
  - Gated n-gram drafting: `ngram-simple` pauses after a run of rejected
    drafts (backoff 8 to 256 steps). Not yet compiled.
  - `scripts/windows-vulkan-noadmin.ps1`: Vulkan build without the SDK
    installer's administrator rights; done by hand on the 780M laptop.
- Already upstream, so no work: checkpoints at user-message boundaries and
  near the prompt end (also written into slot save files), and
  confidence-based early stop of model drafts (`--spec-draft-p-min`).

## Item 5, hybrid miss compute: design, waiting for traces

Today a miss is uploaded to the GPU before the layer runs, one host round
trip per cached layer per step. With about 128 misses per token at a 25%
cache (the synthetic run of the simulator), uploads cannot keep up on
PCIe; the CPU should compute the missed experts from RAM while the GPU
computes the cached ones:

1. Let `mul_mat_id` skip ids of -1, leaving zeros: CPU first, then the
   CUDA, HIP and Vulkan kernels (`ggml/src/ggml-*/`), with tests in
   `tests/test-backend-ops.cpp`.
2. In `build_moe_ffn` with a cache, compute each FFN twice: on the device
   over the banks with the cached slots (misses as -1), and on the CPU
   over the host experts with the missed ids (hits as -1); add the two
   before the weighted sum.
3. The copy callback fills both id lists from the slot map instead of
   uploading; uploads move to a background stream for experts whose score
   says they will keep missing.

It touches kernels on every backend, so it waits until real traces from a
discrete-GPU machine show the miss rate the cache leaves after warm start
and LFU.

## Testing at the end

1. Build the fork (`adaptive-moe`) on each machine with its backend; on
   Windows without admin rights, with `scripts\windows-vulkan-noadmin.ps1`,
   and with `-j 2` to `-j 4`.
2. `/models setup`, `/models plan` and `/models bench` with the default
   model; the engine starts on Windows, Linux (`bwrap`, socket) and macOS.
3. On a discrete GPU with a model that spills: bench without and with
   `--moe-cache-mib`, then with `--moe-cache-policy lfu`; a second session
   in the same project should log "warm start" and a higher hit rate.
4. Record `--moe-cache-trace` and compare policies in the simulator.
5. Speculation on: the bench's draft acceptance on code and on prose.
6. Run the unit tests on Linux or macOS too: the engine-start and `hf`
   tests use shell-script stand-ins that Windows cannot run.

## Decisions (2026-11-05)

1. Not upstreamed; the fork is personal.
2. Keep the engine off the network as far as each OS allows: Seatbelt on
   macOS, a network namespace and Unix socket on Linux, loopback and
   `--offline` on Windows; every build without OpenSSL.
3. No CI for the fork: builds are made and tested on each machine when
   needed.
4. qwen-code prints the setup commands for the machine (`/models setup`)
   rather than downloading an engine. Downloading may come later, for
   llama.cpp only and only when none is installed.
