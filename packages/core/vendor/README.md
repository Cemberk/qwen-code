# Vendored binaries

`SHA256SUMS` records every file in this directory.
`scripts/tests/vendored-binaries.test.js` fails if a recorded file changes or
an unrecorded file appears. After replacing a binary on purpose, regenerate the
record from this directory:

```sh
find . -type f ! -name SHA256SUMS ! -name README.md ! -name .DS_Store \
  | sed 's|^\./||' | sort | xargs shasum -a 256 > SHA256SUMS
```

## ripgrep (`ripgrep/<platform>/rg`)

ripgrep 15.0.0 (rev `3a612f88b8`), all five built with the same Rust
compiler (`rustc` commit `6b00bc38`). Checked offline on 2026-10-12:

- `arm64-darwin` and `x64-darwin` are byte-identical to the ripgrep that
  Visual Studio Code ships (`@vscode/ripgrep-universal`), whose signature
  "Developer ID Application: Microsoft Corporation (UBF8T346G9)" verifies.
  The only differing bytes are the code-signature fields (`__LINKEDIT` sizes
  and the signature itself: ad-hoc here for arm64, none for x64).
- `x64-linux` and `arm64-linux` are static musl builds. Their only socket
  calls come from musl's nscd client, which uses a local Unix socket; another
  independently distributed musl build of ripgrep has the same system-call
  profile.
- `x64-win32/rg.exe` imports only `kernel32`, `ntdll`, `bcryptprimitives`,
  `USERENV` and `api-ms-win-core-synch`, and names no networking library.

The Linux and Windows builds were not compared with a released copy, which
needs network access.

## Landlock helper (`landlock-run/<arch>-linux/qwen-landlock-run`)

Built from `landlock-run/src/qwen-landlock-run.c` by
`scripts/build_landlock_run.mjs` with Zig 0.16.0 (clang and LLD 21.1.0). A
rebuild with Zig 0.15.2 has the same program text apart from the compiler
version, and neither build makes a socket call. A byte-identical rebuild needs
Zig 0.16.0.
