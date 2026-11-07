# Compute pool: any model, any size, every device

Status: design, 2026-11-07. Builds on
[adaptive local inference](./2026-11-05-adaptive-local-inference-design.md)
(branch `adaptive-local-inference` here, `adaptive-moe` in the
[llama.cpp fork](https://github.com/Cemberk/llama.cpp)). All work stays in
the two forks.

## Goal

1. **Many agents on one machine, efficiently.** Every `qwen` process and
   every subagent shares one engine per model, batched together, instead of
   loading the model once per process.
2. **Different models on different machines.** A request for a model goes
   to whichever of the user's devices runs it, or can run it best.
3. **Any model size on any machine, trading speed for size.** A model that
   does not fit in RAM streams its experts from the SSD; the planner says in
   advance how fast it will be.
4. **All devices in one pool.** The user's computers on the local network
   pool memory and compute; one model can be split across them.

Network use changes from the earlier decision ("keep the engine off
network"): pool traffic may use the **local network**. Engines themselves
still listen only on loopback or a Unix socket; only the pool daemon talks
to other machines, authenticated and encrypted (see Security).

## What we learned from others (read 2026-11-07)

Source read in full by research passes; details in the notes below each.

| Project                                                 | License    | What it does                                                                                                              | Take                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Avoid                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [BigMoeOnEdge](https://github.com/Helldez/BigMoeOnEdge) | Apache-2.0 | llama.cpp v0.9.0 + one 34-line patch; experts streamed from flash into a RAM cache, computed on the CPU; `--auto` planner | Storage probe (lanes 1/2/4, slice sizes, median of 3); seconds-per-byte cost model across flash/RAM/VRAM; hit curve from replaying recorded routing; "an unmeasured option never justifies a move"; print predicted vs measured with a reproducing command; direct-I/O correctness check at open; **a live mmap serialises unbuffered reads on Windows** (0.9 vs 2.5 GiB/s); per-expert ready hook in `mul_mat_id` to overlap reads with compute; speculative reads enter the LRU at the cold end                                                                                           | Global LRU over a cyclic layer sweep (0% hits below one token cycle: the "cache cliff"); page commit/decommit per expert (2370 faults/token, Windows syscall per miss); bounce + memcpy on every direct read; read and compute costs added, overlap ignored; one request at a time |
| [Pooled](https://github.com/Nehanth/pooled)             | MIT        | One model split by layers across browser tabs over WebRTC; SSD expert tier; speculation on the host                       | Control (rollback, checkpoint, reset) carried in the hidden-state frame header so it cannot be reordered; 16-token prefill frames, up to 6 in flight; lap timeout from measured laps; on a dropped device, re-prefill prompt + emitted tokens (greedy output identical); host drafts, one verify frame of K+1 tokens per lap; leave phones and slow devices out of the chain; host chosen by memory bandwidth; cache inventory exchange and credit-windowed peer weight fetch; parallel reads instead of mmap (mmap stalled at ~1 GB/s); RAM tier = segmented LRU with admit-on-second-miss | Placement ignores links; full re-deal on every change; one conversation per room keyed by position; speculation turned off with offload; no prefetch; weights from peers checked for length only                                                                                   |
| [exo](https://github.com/exo-explore/exo)               | Apache-2.0 | MLX cluster: discovery, placement, multi-model instances, routing                                                         | Membership state machine (Alive / Suspect / Wedged / Gone, probe answered off the app thread, own-stall detection); hard version gate at discovery (wire version + build hash) with incompatible peers listed, not joined; `memory_once_loaded` + re-check at launch against double booking; placement previews with per-node memory deltas; least-in-flight routing; heartbeat lines in long streams; reconciled desired state with crash-loop pause                                                                                                                                       | No authentication at all; random node id per restart; placement ignores link and compute speed; cycle enumeration explodes with nodes; every node downloads the whole model; never unloads                                                                                         |
| [ExecuTorch](https://github.com/pytorch/executorch)     | BSD        | PyTorch export to per-backend `.pte`                                                                                      | Nothing now                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | One artifact per backend, desktop GPU paths experimental; only phone NPUs would be a reason                                                                                                                                                                                        |

### What the fork already has (verified in source)

- **Router mode** (`llama-server` with no model, `--models-max`,
  `--models-memory-margin`): one child process per model, LRU unload. We do
  not need it: the pool daemon owns engines directly (it already plans,
  confines and caches prompts per model), but its unload rule is the model
  for ours.
- **Slots**: `-np N`, `--kv-unified` (one KV pool shared by all slots),
  continuous batching, `--slot-prompt-similarity`, host prompt cache
  `--cache-ram` (8 GiB default), `--cache-idle-slots`, slot save/restore.
  KV memory is set by `n_ctx`, not by the slot count.
- **ggml-rpc** (protocol 8.0.1): remote devices appear as GPUs and take
  layer ranges like local ones (split by free memory, RPC devices first).
  Graph is sent once and replayed by id (`GRAPH_RECOMPUTE`); inputs and
  compute are one-way; **one blocking round trip per remote stage per
  ubatch** (the `GET_TENSOR` that brings the hidden state back), plus
  `n_embd` floats per token each way. Weight cache on the server (`-c`,
  64-bit FNV of tensors over 10 MiB). **No authentication; one client at a
  time** (serial accept loop). Tensor-parallel over RPC (`-sm tensor`,
  allreduce mesh) exists but is experimental.
- **Pipeline overlap** (`n_copies = 4`) happens only across ubatches of one
  decode, and is turned off by any tensor override, `--n-cpu-moe` and the
  MoE cache.
- **Our MoE cache** is sequence-agnostic (plans the union of a ubatch's
  experts), limited to 32 tokens per ubatch (hybrid: 16), and uploads misses
  from the host pointer of the mmapped weights, which is where a RAM/SSD
  tier plugs in. RPC devices would qualify as cache devices but the upload
  would cross the network; remote layers must not use it.

## The key numbers that shape the design

- **On our hardware, a LAN hop is cheap per token.** The 780M decodes the
  default model at 5-10 tok/s: 100-200 ms per token. A wired hop costs
  0.3-1 ms round trip plus 2 x `n_embd` x 4 bytes (16 KiB at n_embd 2048);
  Pooled measured 3.5-4 ms per extra device in total overheads and 8.6 ms
  of wire for two Wi-Fi hops. So splitting a model across machines costs a
  few percent per token on Ethernet and 5-15% on Wi-Fi, **if** it moves
  layers from SSD or CPU onto a GPU. It never makes a model that already
  fits on one GPU faster; it makes models that do not fit much faster than
  streaming them.
- **Batching is where several agents win.** Decode is limited by reading
  weights. Four sequences decoded together read each dense weight once; for
  MoE the union of experts grows less than linearly. Four agents sharing an
  engine cost far less than 4x one agent; four engines cost 4x memory and
  contend for the same bandwidth.
- **Streaming from SSD is bounded by the drive**: seconds per token =
  (1 - hit rate) x expert bytes per token / read rate. BigMoeOnEdge: 5
  tok/s for Qwen3.6-35B-A3B on a 16 GB Windows laptop; 1 tok/s for 284B on a
  12 GB phone. Our `next` policy avoids the cache cliff that capped theirs.

## Architecture

```
 machine A                                          machine B
+--------------------------------------------+     +------------------------+
| qwen  qwen  qwen (subagents)               |     | qwen                   |
|   \     |    /    named pipe / Unix socket |     |  |                     |
|  +------------------------------------+    |     | +--------------------+ |
|  | qwen pool daemon                   |<=========>| qwen pool daemon   | |
|  |  sessions -> slots, model ledger,  | mTLS LAN | |                    | |
|  |  planner, placement, prompt cache  |    |     | +--------------------+ |
|  +------------------------------------+    |     |   |            |       |
|     | loopback/socket     | loopback       |     |   | loopback   |       |
|  llama-server (model X)  RPC tunnel <------------->  rpc-server   llama-server
|   -np N --kv-unified      (stage 2 of Y)   |     |   (layers of Y) (model Z)
+--------------------------------------------+     +------------------------+
```

Three layers, each useful alone:

1. **Machine daemon** (`qwen pool`): one per user per machine. Owns every
   engine on the machine; every `qwen` process is its client.
2. **SSD tier and multi-tier planner** (fork + planner): any size on one
   machine.
3. **Pool**: daemons on the LAN pair, share state, route requests to each
   other, and split models across machines.

### 1. Machine daemon

Moves `LocalModelServer`, `engine.ts`, the planner and prompt cache out of
each `qwen` process into one long-lived process. TypeScript, in
`packages/core/src/local-models/pool/` with a `qwen pool` command; no new
language or dependency.

- **Lifetime.** The first `qwen` that needs a local model connects to
  `\\.\pipe\qwen-pool-<user>` (Windows) or `$XDG_RUNTIME_DIR/qwen-pool.sock`
  / `~/Library/Caches/qwen/pool.sock`; if nothing answers it starts
  `qwen pool serve` detached and retries. A lock file prevents two daemons.
  The daemon lives exactly as long as some `qwen` process on the machine
  needs it (see Teardown); keeping a machine in the pool with no `qwen`
  open is an explicit opt-in (`qwen pool share --always`). The client keeps
  today's in-process path as a fallback when the daemon cannot start, so
  nothing regresses.
- **Protocol to clients.** The same OpenAI-compatible HTTP the content
  generator speaks today, over the pipe/socket, plus a small control API:
  `acquire(model, session)`, `release(session, saveState)`, `status`,
  `plan`, `bench`. A lease now names a **session** (`qwen` process +
  conversation, or subagent id), and the daemon pins it to a slot.
- **One engine per model, N slots.** `-np` from the plan (default 4, more on
  big machines), `--kv-unified`, `n_ctx` sized from memory left after
  weights. Slot affinity per session (`id_slot`), so a session's KV stays
  put between turns. When sessions outnumber slots, or KV runs out, the
  least recently used idle session is saved (`/slots/:id?action=save`,
  today's prompt-state files) and its slot reused; it is restored when it
  comes back. Side queries and subagents get their own sessions instead of
  sharing one side slot.
- **Several models on one machine.** A memory ledger per device:
  `committed = sum(weights + KV + compute buffers of running engines) +
pending loads x fraction not yet loaded` (exo's `memory_once_loaded`).
  A new model loads if the plan fits in what is free; otherwise the least
  recently used engine with no active lease is stopped (router mode's rule);
  otherwise the request waits or is placed on another machine.
- **Scheduling.** The daemon queues leases per engine; the engine batches
  whatever is active. Interactive conversation turns go before background
  work (memory extraction, side queries) when the engine is saturated.

#### Teardown: nothing left behind when the last `qwen` closes

Requirement: when every `qwen` process on the machine has exited, by any
means (normal exit, Ctrl+C, closed terminal, killed from the task manager,
crash), no daemon, engine, `rpc-server` or tunnel is left running, no port
or pipe stays open, and the next start finds a clean state. Today's
in-process engine only meets this on a normal exit (`process.once('exit')`
kills it); a hard kill of `qwen` on Windows or macOS orphans
`llama-server`. The daemon must fix that, not add a second way to leak.

- **Clients are connections.** Every `qwen` process holds one open
  connection to the daemon for its lifetime; leases belong to that
  connection. The OS closes it when the process dies however it dies, so
  the daemon learns at once and releases that process's leases (saving
  their prompt state first, as a normal release does). No heartbeats or
  pid polling needed for local clients.
- **Last client gone -> clean exit.** When the client count reaches zero
  (and `share --always` is off), a short grace period (30 s, so a restart
  of `qwen` reuses the warm engine) then: refuse new connections, save
  session states, stop every engine (SIGTERM / graceful stop, then kill
  after the existing grace), stop remote assignments it hosts and tell
  peers it is leaving, close the pool port, remove the socket and lock
  file, exit 0. A new `qwen` during the grace cancels it.
- **Engines die with the daemon, however it dies.** Child processes are
  tied to the daemon at the OS level, not by an exit handler:
  - Windows: every child is assigned to a Job Object created with
    `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; the job handle closes when the
    daemon dies, and Windows kills the whole job. (Node has no API for
    this: a tiny launcher, or a fork flag below.)
  - Linux: `bwrap --die-with-parent` where confined (already used), else
    `PR_SET_PDEATHSIG` via the fork flag.
  - macOS (and as the portable fallback everywhere): fork flag
    `--exit-with-parent` for `llama-server` and `rpc-server`: the child
    reads its stdin, a pipe from the daemon, and exits when it reaches end
    of file, which happens when the daemon dies. Cheap, no polling, works
    under Seatbelt.
- **Remote work dies with its requester.** An `rpc-server` or engine a
  daemon hosts for a peer belongs to that peer's TLS connection; when the
  link drops (or health marks the peer gone), the assignment is stopped
  after a short grace for reconnects. A tunnel closes with either end.
- **Stale state on start.** The lock file records the daemon's pid and start
  time; a new daemon that finds a lock whose process is gone (or reused by
  another program) removes it and the stale socket. On start it also kills
  engines a dead daemon left behind, identified by a pid file per engine
  (pid + start time + binary path, so it never touches an unrelated
  process).
- **Tests.** End-to-end on all three OSes: start two `qwen` clients, kill
  them with SIGKILL / `taskkill /F`, assert within the grace + 10 s that no
  `llama-server`, `rpc-server` or daemon process remains and the pipe/socket
  and lock are gone; kill the daemon itself with SIGKILL and assert its
  engines exit; restart after a crash and assert a clean start.

Fork work for this layer (multiple sequences through the MoE cache):

- Raise the cache's 32-token / hybrid 16-token ubatch limits, or split a
  larger ubatch into cache-sized groups, so 4-8 agents with drafts
  (8 x 7 tokens) still use the cache.
- Admission when the union of a ubatch's experts exceeds the slots: keep
  the highest-scored, compute the rest on the CPU (hybrid) instead of
  skipping the cache.
- Per-slot draft gating already exists (ngram-simple gate); verify it
  keys on the slot, not the engine.

### 2. SSD tier and multi-tier planner (one machine, any size)

Tiers: **device cache** (today's slot banks) <- **RAM cache** (new) <-
**SSD** (the GGUF file). Exact output: the same experts are computed, only
where and when they are read changes.

- **RAM tier** in `src/llama-moe-cache.cpp`: a fixed pool of expert slots
  in one pinned host buffer (`ggml_backend_dev_host_buffer_type` of the
  cache device, so device uploads are fast), not page commit/decommit per
  expert (BigMoeOnEdge's Windows and Android cost). Policy: our `next`
  policy across all layers (it avoids the cyclic-sweep cliff), with
  admit-on-second-miss for prompt processing so a long prompt does not
  flush the decode set (Pooled's T1 rule).
- **SSD reads**: expert tensors are not loaded or mapped when the tier is on
  (`--moe-ssd`); the cache keeps `{file, offset, bytes per expert}` per
  expert tensor from `gguf_get_data_offset + gguf_get_tensor_offset`. Reads
  are direct (`O_DIRECT`, `FILE_FLAG_NO_BUFFERING`, `F_NOCACHE`) into an
  aligned staging window, then copied into the RAM slot; 4-8 reader threads
  (count from the storage probe). Checked at open: one block read direct and
  buffered must match, else buffered. The model file must not stay mapped on
  Windows while reading unbuffered.
- **Where misses are computed**: a RAM-tier hit not in the device cache is
  computed on the CPU (hybrid mode, today) or uploaded (non-hybrid, today);
  an SSD miss is read into the RAM tier first. To overlap reads with
  compute, port BigMoeOnEdge's idea: a per-expert ready flag checked in
  the CPU `mul_mat_id` (`ggml-cpu`), exposed through
  `ggml_backend_reg_get_proc_address`, so the CPU computes the experts
  already present while the rest are being read.
- **Prefetch**: next-layer router on the current hidden state (they
  measured 81-89% accuracy) fills the RAM tier at the cold end, cancelled by
  real reads. Off by default; the planner turns it on only where the A/B on
  the first answer shows a gain (it lost on phones from extra reads, should
  win on NVMe with spare bandwidth).
- **Simulator**: `tools/moe-sim` gains a RAM tier, an SSD bandwidth model and
  prefetch, so a recorded trace predicts hit rates per tier for any budget.
- **Planner** (`planner.ts`, `gpu-memory.ts`): today it refuses models
  larger than RAM. New cost model in seconds per token:
  - `dense_bytes / device_bandwidth` (or CPU if not on a device)
  - `+ hit_dev x expert_bytes / device_bandwidth`
  - `+ (1 - hit_dev) x expert_bytes / cpu_bandwidth` (hybrid)
  - `+ (1 - hit_ram) x expert_bytes / ssd_rate`, less overlap.
    Hit rates from the simulator over the model's saved trace (we already save
    profiles per model and project), or a conservative curve when there is
    none. Inputs from a storage probe (cached per drive: rate at 1/2/4/8 lanes
    for the model's slice size, median of 3, ~2 GiB read) and a bandwidth
    probe per device (bench we already run). The plan states predicted tok/s;
    `/models bench` prints predicted vs measured, and the error feeds the next
    plan. A model runs if predicted decode >= a floor the user sets (default
    1 tok/s); `/models` shows each model's predicted speed on this machine and
    across the pool.

### 3. Pool (the user's devices on the LAN)

**Membership and security**

- Each daemon has a persistent Ed25519 identity (node id = key fingerprint),
  generated once in the user's config dir.
- **Pairing**: `qwen pool create` on the first machine makes a pool (a
  random pool key); `qwen pool join` on another shows a 6-digit code; the
  user enters it on a machine already in the pool (SPAKE2-style, or simpler:
  the code authenticates a one-time key exchange). After pairing every
  member knows every other member's public key. Nothing joins without the
  user at a member machine.
- **Transport**: mutual TLS between daemons (Node's `tls`, self-signed
  certificates pinned to the paired keys), one port (default 52450),
  listening only on the interfaces the user allows (default: private
  addresses; none on public networks). No traffic leaves the LAN; no relay.
- **Discovery**: UDP multicast hello on the LAN carrying only node id and
  wire version, plus a remembered address list; the TLS handshake is what
  admits a peer.
- **Version gate**: hello and handshake carry the wire version and a build
  id (qwen-code commit + fork commit + backend set). Mismatched members are
  shown by `qwen pool status` ("update this machine") but not used for
  splits; whole-model routing works across versions as long as the HTTP API
  matches.
- **Health**: exo's states: alive, suspect (missed probes), wedged
  (transport up, daemon not answering), gone. Probes every 2 s while in use,
  10 s otherwise; a machine that slept is not blamed for its own stall.
- **Contribution**: per machine, `pool.share` (off by default) and a cap on
  the memory it offers; a machine in use by its owner (interactive engine
  busy) is deprioritised for others' work.

**State**: no leader. Each daemon publishes its own facts: devices and
measured speeds, free memory (from its ledger), models on disk (with
hashes), engines running and their free slots, link measurements to each
peer. Peers keep the latest copy; nothing needs global ordering because
placement is confirmed by the machine that would host it (it re-checks its
ledger and accepts or refuses, exo's launch re-check). Fewer moving parts
than exo's elected master, which suits 2-6 personal machines.

**Routing (different models on different machines)**

- A session asks its local daemon for model M. Order:
  1. an engine already serving M with a free slot (local first, then the
     peer with the lowest predicted latency);
  2. place M: every option the planner can price (local, each peer, local
     streaming, a split), predicted tok/s, files already present, and the
     owner's load; take the best;
  3. if only a slow option exists, say so in `/models plan` before using it.
- Requests to a peer are proxied by the daemons over the TLS link (HTTP/2
  streams). Session affinity keeps a conversation on the same engine (its KV
  and prompt state are there).
- **Model files**: a peer that lacks a GGUF fetches it from a member that has
  it (ranges, credit window, resumable), verified by SHA-256 against the
  hash the source published (computed once per file, cached by size and
  mtime), else from Hugging Face as today. Downloads still only happen on a
  user command (`/models download`) or confirmed placement.

**Splitting one model across machines**

Step A, on ggml-rpc as it is (works today, least code):

- The head machine runs `llama-server` with `--rpc 127.0.0.1:<port>` per
  remote stage. Each port is a **tunnel** in the local daemon to the remote
  daemon, which forwards to an `rpc-server` it started on loopback for this
  assignment (one per client, since rpc-server serves one at a time). The
  engines stay on loopback; the network hop is authenticated and encrypted.
  Cost of the tunnel: two local copies per message, well under the LAN round
  trip; measured before anything else.
- Placement: contiguous layer ranges by the planner, not by free memory:
  minimise predicted time per token = sum of stage compute (measured
  ms/layer per device) + one round trip per remote stage, subject to each
  stage fitting in that device's memory. Pooled-style speed mode: fewest,
  fastest devices; slow devices (phones, busy machines) left out when the
  rest hold the model. Remote stages hold whole layers including experts in
  their own GPU or CPU memory (`rpc-server -d Vulkan0,CPU` with expert
  tensors of remote layers overridden to the remote CPU device); the MoE
  cache stays off for remote layers.
- Weights: fork change to `rpc-server` to answer `SET_TENSOR_HASH` from the
  member's local copy of the same GGUF (index of tensor hashes built once
  per file and cached), so a stage loads from its own disk instead of
  receiving gigabytes over the LAN. Without a local copy, the first load
  goes over the LAN and lands in rpc-server's cache.
- Speculation: drafting runs on the head; a draft batch of K+1 tokens goes
  through every stage in one pass, and rejection is just KV metadata on the
  head (`seq_rm`), so it is exact for free. This is what pays for the hops.
- Fork changes: authenticate the RPC hello with a per-assignment key the
  daemon passes to both ends (defence in depth behind the tunnel); keep
  pipeline overlap on for ubatches when stages are remote.

Step B, a native stage server (only if Step A's measured cost per token or
its missing MoE cache on remote stages justifies it):

- `llama-stage` in the fork: loads only layers [a, b) of the GGUF (loader
  skips other tensors), runs them with its own device placement, MoE cache
  and SSD tier, and keeps the KV for its layers per sequence.
- Frames: `seq id | pos | n tokens | control (rollback to k, checkpoint
save/load, reset) | f16 or f32 hidden states`, control in the header so it
  cannot be reordered (Pooled); prompt frames of 16-64 tokens with several
  in flight; timeouts from measured laps.
- Several sequences per frame (Pooled serves one), and micro-batches of
  different agents interleaved so stages work in parallel instead of
  waiting on each other.
- On a lost stage: re-place, re-prefill prompt + emitted tokens (greedy
  output identical).
- Later, expert parallelism: a member holds a subset of a layer's experts
  and computes only tokens routed to them (DeepInfer EPLB placement from
  our usage profiles), for MoE models whose experts dwarf everything else.

Within one machine (all its devices): the planner may add the integrated
GPU next to a discrete one (llama.cpp drops it by default) with `-ts` from
measured speed, only where the bench shows a gain. NPUs: not now.

## Phases

Each phase lands with before/after numbers on at least two machine classes
(rule from the main design), and output checks at temperature 0.

**P0, close the open measurements** (before building on them): rebuild the
fork at `4a478859c` and run `tools/moe-cache-check`; benchmark Qwen3.6-35B-A3B
on the 780M; the two-project prefix reuse run.

P0 results (2026-11-07, Radeon 780M, Windows, Vulkan):

- Fork `4a478859c`, OLMoE: every cache policy gives the same text as all
  experts on the GPU, and `--probs` the same log-probabilities; hybrid
  within CPU/GPU rounding. Hit rates: SLRU 0.1%, LFU 28.7%, next 29.1%,
  hybrid 32.7% (31.7% -> 33.9% with the saved profile); the simulator on
  the same trace: hybrid 33.4%, optimum 43.7%. The admission rule changed
  hybrid little (32.3% before).
- Qwen3.6-35B-A3B (UD-IQ3_S, 13.7 GB) **did not start**: Vulkan told the
  engine 15.6 GB of the 16.5 GB shared budget was free, but Windows shares
  that budget between all programs and the desktop (`dwm.exe`) held 5.6 GB
  of it; allocation failed past about 13 GB, wherever the layers went,
  because experts moved to the CPU were read into pinned, GPU-visible
  memory that counts against the same budget. Fixed in `db801a2353`: the
  plan takes other programs' shared GPU memory off the budget (Windows
  counters; amdgpu GTT in use on Linux), places the experts itself, and
  keeps CPU experts mapped from the file. The counter sum errs high (it
  left 9.3 GB where about 11 GB worked), so the planner is cautious; it
  should learn the real limit from starts that succeed and fail.
- Qwen3.6-35B-A3B with that plan (21 layers of experts on the CPU): prose
  prompt 42.1 tok/s, generation 3.9 tok/s; code edit prompt 54.5 tok/s,
  generation 7.3 tok/s, 84% of drafts accepted. By hand with 12 layers on
  the CPU: 54.6 / 3.7 and 58.5 / 6.9.
- Two-project prefix reuse: not measured; stopped twice by low memory on
  this machine. When the run was stopped, the `qwen` process died and its
  engine stayed alive holding 7.7 GB: the teardown gap of the daemon
  design, seen in practice.

**P1, machine daemon (goal 1).** qwen-code: daemon process and client,
session leases, slot affinity, save/restore of idle sessions, per-session
subagent slots, memory ledger and LRU unload, multiple models at once,
priority of interactive turns, clean teardown (job objects / end-of-stdin exit, stale lock and engine cleanup, kill tests on all three OSes). Fork: `--exit-with-parent` for `llama-server` and `rpc-server`. Fork: MoE cache with more tokens per ubatch
and admission under unions. Done when: 4 `qwen` processes on one model use
one engine, and aggregate tok/s with 4 agents beats 4 separate engines (and
one agent loses < 10%).

**P2, SSD tier (goal 3).** Fork: RAM tier, direct reads, ready hook,
prefetch behind an A/B; simulator tiers. qwen-code: storage probe, cost
model, predicted speed in `/models` and `/models plan`, predicted vs measured
in `/models bench`, speed floor. Done when: a model 2x larger than RAM runs
exactly (same tokens as fully loaded) at the predicted speed +-20% on the
780M laptop and one NVMe desktop.

**P3, pool membership and routing (goal 2).** Identity, pairing, mTLS,
discovery, health, published state, version gate, request proxying, session
affinity across machines, peer model transfer, `qwen pool
create|join|status|leave|share`. Done when: a session on machine A uses a
model running on machine B with < 5 ms added per request on Ethernet, and
nothing connects without pairing.

**P4, split over ggml-rpc (goal 4, step A).** Tunnel, per-assignment
rpc-server, link probe (RTT, throughput), measured ms/layer per device,
pipeline placement, local-GGUF hash index in rpc-server, RPC hello key,
speculation through the pipeline. Done when: a model larger than any one
member runs faster split across two machines than streamed from SSD on the
faster of them, and the per-token overhead matches the model (round trips x
RTT + transfer).

**P5, native stages (step B)**, decided from P4's numbers: `llama-stage`,
frame protocol, multi-sequence frames, micro-batch interleaving, loss
recovery; then expert parallelism.

**P6, every device in a machine**: integrated + discrete GPU by measured
speed.

## Security summary

- Nothing joins without pairing at an existing member; every link is mutual
  TLS pinned to paired keys; only private interfaces; no relay.
- Engines (`llama-server`, `rpc-server`) only ever listen on loopback or a
  Unix socket, with the existing confinement; the daemon is the only process
  on the network.
- A member can read everything it computes (hidden states reveal prompts;
  Pooled says so too). The pool is for one user's own devices, not for
  sharing with others.
- Model files from peers are verified by SHA-256; results from peers are
  not verified (same trust as the machine itself).

## Open questions

- Pairing UX on a machine without a terminal open (a login item that shows
  the code?). For now: `qwen pool join` in a terminal.
- Whether the daemon should also accept other OpenAI-compatible clients on
  this machine (an editor, scripts): easy once it exists, needs an API key
  per client.
- Wi-Fi only machines: allowed, but the planner prices the link from
  measurements and will usually prefer whole-model routing to splits.
- macOS sandboxing of the daemon itself (it needs the network now; the
  engines keep their Seatbelt profile).
