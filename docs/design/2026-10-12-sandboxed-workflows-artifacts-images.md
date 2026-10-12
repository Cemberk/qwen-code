# Sandboxed workflows, HTML artifacts and image decoding

[English](2026-10-12-sandboxed-workflows-artifacts-images.md) | [简体中文](2026-10-12-sandboxed-workflows-artifacts-images.zh-CN.md)

## Status

Implemented, 2026-10-12, on the local-only fork. The workflow host, the
artifact viewer and the image checks shipped with the cross-file hardening
change. The Node permission model for both QuickJS hosts and the code-mode
stack limit shipped in the follow-up change.

## Problem

A review of this fork found three features that the project keeps but that
handled untrusted input with more reach than they need:

- Workflow scripts, which the model writes, ran in `node:vm` inside the CLI
  process. `node:vm` is not a security boundary. Two reproductions reached the
  host `process`, and from it `child_process`: one through a caught bridge
  error, one through prototype overrides during `parallel()` and `pipeline()`.
- HTML artifacts ran model-written scripts in the browser. Even under a CSP, a
  script could reach the network through WebRTC ICE (a STUN request) or by
  navigating its own frame.
- Image previews handed file bytes to sharp. libvips picks a decoder from the
  bytes, so its SVG, PDF, TIFF and HEIF loaders were reachable, a far larger
  surface than the three formats the preview renders.

Deleting the features was rejected. They stay, sandboxed.

## Goals

- A workflow script reaches only what the workflow API gives it: `agent()`,
  nested `workflow()`, `log`, `phase`, `args` and `budget`.
- An artifact page cannot make a network request or navigate.
- Only PNG, JPEG and WebP bytes (previews) and GIF bytes (attachment check)
  reach libvips.
- Workflow, artifact and image behaviour is otherwise unchanged.

## Non-goals

- Network isolation of the host process. The permission model of Node 22 and
  24 has no network control (see Risks and limits).
- Scripted artifacts. A later change that re-enables scripts must close
  WebRTC and self-navigation first.
- Browsers other than Chrome; the artifact battery ran in Chrome only.

## Design

### Workflow scripts in an out-of-process QuickJS host

- Each run spawns `node <host>` (`agents/runtime/workflow-host-client.ts`):
  `dist/workflowHost.js` from the bundle, `workflow-host.js` beside core's
  compiled sources, or `workflow-host.ts` through tsx in tests.
- The host runs the script in QuickJS compiled to WebAssembly
  (`@jitl/quickjs-singlefile-mjs-release-sync`) with a 512 MiB memory limit
  and a 256 KiB stack. QuickJS's interrupt handler enforces the 30 s limit on
  every synchronous stretch, not just the first.
- The only host function is `__wfPost(string)`. The prelude
  (`workflow-guest.ts`) captures it, then deletes it along with `process`,
  `require`, `fetch`, the timers, `WebAssembly`, `SharedArrayBuffer` and
  similar globals before the script runs. The runtime captures the builtins it
  needs first, so a script that overrides prototypes changes only its own
  code.
- Parent and host exchange length-prefixed JSON frames (4-byte big-endian
  length, 64 MiB cap; `workflow-protocol.ts`). The parent validates the type
  and shape of every message (`workflow-sandbox.ts`, `handle()`). Anything
  malformed fails the run and kills the host. Results come back as tagged JSON
  that the parent rebuilds (Error, Map, Set, BigInt, shared and circular
  references), so the parent never holds a guest object.
- The host's environment holds only `PATH`, `TMPDIR`, `TEMP`, `TMP`,
  `SystemRoot` and `WINDIR`.
- `parallel()` and `pipeline()` run inside the guest. Dependency
  attribution, which used `AsyncLocalStorage`, now travels as an explicit
  `{group, branch}` on each request, plus `fork` and `join` messages.
- Syntax checks run QuickJS's parser in compile-only mode in the parent, so no
  script code runs. `node:vm` is no longer used on the workflow path.
- Abort or timeout settles the run and sends `abort`. A settled run's host may
  drain in-flight requests for up to 10 s and is then killed with SIGKILL. A
  host that crashes fails its run.

### Node permission model for the QuickJS hosts

Both QuickJS hosts, for workflows and for code mode
(`code-mode/host-client.ts`), start under Node's permission model
(`utils/quickjs-host-permissions.ts`):

- Bundled host: `node --permission <real path of the host>`, with no grants.
  It gets no file reads or writes, child processes, worker threads, native
  addons or WASI. Node still reads the entry script, and the bundle embeds the
  WebAssembly.
- Host beside core's compiled sources: the same plus
  `--allow-fs-read=<install root>`, the parent of the outermost `node_modules`
  that provides QuickJS. Module resolution reads `package.json` files on its
  way up to that directory, so a narrower grant fails.
- Node before 22.13 only accepts `--experimental-permission`; the helper uses
  the spelling the running Node accepts.
- The entry goes in as a real path. Node resolves symlinks in the entry before
  loading it, and that read is not granted.
- Source runs through tsx (tests and development) start without the
  permission model, because tsx needs worker threads and cache writes.

### Code-mode stack limit

The code-mode host's QuickJS stack drops from 1 MiB to 256 KiB, as for
workflows. At 1 MiB, runaway recursion exhausted Node's own stack first. The
script could not catch the error, and the host then aborted inside QuickJS (a
`JS_FreeRuntime` assertion). At 256 KiB QuickJS raises an error the script
can catch.

### HTML artifacts as static pages in an empty sandbox

- The published page is a fixed viewer with no scripts. The model's fragment
  appears only attribute-escaped, inside `<iframe sandbox="" srcdoc="…">`
  (`tools/artifact/html.ts`), so it cannot add markup to the viewer.
- The viewer's CSP, which the srcdoc frame inherits:
  `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'`.
  The empty `sandbox` gives an opaque origin with no scripts, forms, popups,
  top-level navigation, downloads or modals. DNS prefetch is off, and the
  viewer sends no referrer.
- Scripts are off because no CSP or sandbox setting closes WebRTC ICE or a
  script navigating its own frame. Artifacts are static HTML, CSS and SVG.
- Before anything is written, the validator rejects external URLs, location
  assignments, `<meta http-equiv=refresh>`, `<base>`, any `<link>`,
  speculation rules, `serviceWorker.register` and `RTCPeerConnection`. Chrome
  starts prerendering regardless of the CSP, so for prerender the validator is
  the only control.

### Image decoding

- Previews (`utils/image-view.ts`): sharp receives a Buffer, and only bytes
  with a PNG, JPEG or WebP signature. Other bytes are reported as unsupported
  without being decoded.
- Attachments (`utils/fileUtils.ts`): sharp checks a `.gif` only if it starts
  with `GIF8`. Otherwise its data is left out of the request, with a notice.

## Decisions and alternatives

- **QuickJS in a child process**, not `node:vm`, a worker thread or
  `isolated-vm`. `node:vm` and workers share the CLI process, and
  `isolated-vm` is a native addon. Code mode already used QuickJS, so no
  dependency was added.
- **JSON-only bridge.** Nothing the parent receives is a live object, so
  prototype tricks have nothing to grab.
- **One process per run.** A crash or hang affects only that run, and the
  parent kills it.
- **Static artifacts.** No browser setting closes the two script vectors, so
  scripts are off.
- **No permission grants for bundled hosts.** The host does nothing that needs
  one. Unbundled runs get the smallest grant that works: reads below the
  install root.

## Risks and limits

- The permission model of Node 22 and 24 does not control the network. An
  escape from QuickJS combined with a host bug could still open sockets. The
  loopback-only Seatbelt profiles cover that when they are in use.
- After `await null`, or a promise the script built itself, dependency
  attribution goes to whichever settlement resumed the script.
- A forgotten `await` inside an async wrapper is no longer mirrored to the log,
  because QuickJS has no promise-rejection tracker.
- The artifact validator scans bytes. A `rel` value spelled with character
  references is not decoded, which is why any `<link>` is rejected.
- Test runs through tsx do not exercise the permission flags.
  `scripts/tests/quickjs-host-permissions.test.js` does, on bundled hosts.

## Validation

- Workflow escapes: before the change, a caught bridge error reached
  `child_process` (`id -u` ran) and prototype overrides leaked host callbacks.
  After it, both stay inside the guest (`workflow-sandbox.test.ts`, "workflow
  guest isolation"; `workflow-orchestrator.test.ts`).
- `utils/quickjs-host-permissions.test.ts`: Node reports no read, write,
  child-process or worker access under the bundled flags, and reads only below
  the install root under the unbundled flags.
- `scripts/tests/quickjs-host-permissions.test.js`: both hosts, bundled with
  the release build options, run a script under the flags.
- End to end, against a mock model on 127.0.0.1:
  - Through `dist/cli.js`, a workflow run started
    `node --permission …/dist/workflowHost.js` and completed.
  - Through `packages/cli/dist/index.js`, it started
    `node --permission --allow-fs-read=<repo> …/workflow-host.js` and
    completed.
- `code-mode.test.ts`, "turns runaway recursion into an error the script can
  catch" (fails at 1 MiB).
- Artifact battery (headless Chrome, with loopback listeners for TCP, HTTP,
  WebSocket and UDP STUN):
  - Without the viewer, 30 of 36 vectors made real egress.
  - With the shipped viewer, three made any connection: prerender, plus a
    preconnect socket carrying no data from `<iframe src>` and from
    `<link rel=preconnect>`. The validator rejects all three before anything
    is written.
  - `html.test.ts` covers the CSP, the sandbox, escaping and the validator.
- `image-view.sniff.test.ts` and `fileUtils.test.ts`: SVG, PDF, TIFF and text
  bytes never reach sharp.

## Acceptance criteria

- The workflow execution path uses no `node:vm`, and the escape reproductions
  fail.
- Outside tsx runs, both QuickJS hosts start with `--permission` (or
  `--experimental-permission`).
- Artifact pages carry the CSP above and `sandbox=""`, and the viewer
  contains no script.
- Only the listed image signatures reach sharp.

## Open questions

- Deny the hosts network access once the permission model of a supported Node
  version can.
