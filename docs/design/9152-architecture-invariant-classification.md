# Architecture invariant classification

Issue #9152 asks for a policy decision: which architectural invariants in this
repository are enforced mechanically, which are left to review, and which are
not worth enforcing — written down where a new invariant will encounter it.

This document is that record. It is the canonical answer to "should this
invariant have a guard?" for every invariant asserted in AGENTS.md or an open
architecture issue.

## Classification scheme

| Category                  | Meaning                                                                                               | Failure mode if unguarded                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Mechanically enforced** | A guard fails the build, lint, or test suite. No human judgment needed.                               | Drift reintroduced silently by a merged PR.                                |
| **Review-only**           | Requires judgment no lint rule can approximate. Enforced by the two-tier gate and reviewer checklist. | Missed in review; no mechanical backstop.                                  |
| **Not worth enforcing**   | The cost of a guard exceeds the cost of occasional violations.                                        | Acceptable — the invariant is a preference, not a load-bearing constraint. |

A guard is **gap** if the invariant is classified as mechanically enforced but
no guard exists yet, or the existing guard is partial.

---

## AGENTS.md conventions

### 1. ESM throughout (`"type": "module"`)

**Mechanically enforced.** `package.json` declares `"type": "module"` in every
package. Node and the TypeScript compiler reject `require()` at runtime and
`import =` syntax at compile time under ESM mode. No separate guard needed.

### 2. TypeScript strict mode

**Mechanically enforced.** `tsconfig.json` sets `"strict": true`,
`"noImplicitAny": true`, `"strictNullChecks": true`, `"noUnusedLocals": true`,
`"verbatimModuleSyntax": true`. `npm run typecheck` fails on any violation.

### 3. Prettier formatting

**Mechanically enforced.** `lint-staged` runs Prettier via the `pre-commit`
hook (`scripts/pre-commit.js`). CI checks formatting with
`node scripts/lint.js --prettier` (the `Run Prettier` step in
`.github/workflows/ci.yml`); `npm run format` is the local write-mode command,
not the CI check.

### 4. No `any` types

**Mechanically enforced.** `@typescript-eslint/no-explicit-any` is configured
as an error in `eslint.config.js`.

### 5. Consistent type imports

**Mechanically enforced.** `@typescript-eslint/consistent-type-imports` in
`eslint.config.js`.

### 6. No relative imports between packages

**Mechanically enforced.** Two guards:

- `eslint-rules/no-relative-cross-package-imports.js` (custom ESLint rule)
- `import/no-relative-packages` (built-in)

### 7. Tests collocated with source (`file.test.ts` next to `file.ts`)

**Review-only.** The collocation convention cannot be mechanically enforced
without false positives — a test file may legitimately live in a shared
`__tests__/` directory for cross-cutting integration tests, and AGENTS.md
itself allowlists this. A lint rule would either miss violations or flag
legitimate exceptions. The reviewer checklist covers this.

### 8. File naming: `PascalCase.tsx` for React components, `kebab-case.ts` for `.ts` in `packages/core` and `packages/cli`

**Mechanically enforced.** `check-file/filename-naming-convention` in
`eslint.config.js` enforces `KEBAB_CASE` for `*.ts`. Legacy camelCase files
are allowlisted in `eslint.legacy-filenames.mjs`, which `eslint.config.js`
imports. `PascalCase.tsx` is the existing
convention but is not separately enforced — a `.tsx` file in kebab-case would
pass the rule. **Gap:** add `PASCAL_CASE` for `*.tsx` or accept the convention
as socially enforced. Low priority — React tooling and imports naturally
converge on PascalCase for components.

### 9. Comments: default to none

**Review-only.** The absence of comments is a style preference, not a
structural invariant. A lint rule cannot distinguish a necessary "why" comment
from noise. The reviewer checklist in AGENTS.md covers this.

### 10. Conventional Commits

**Not worth enforcing.** There is no `commitlint` config or `commit-msg` hook.
The convention is socially enforced through PR titles and squash-merge. A
commit-msg hook would block worktree commits and CI automation without
meaningfully improving the commit history (squash-merge rewrites messages
anyway). The cost exceeds the benefit.

### 11. Node.js `>=22`

**Mechanically enforced — partial.** `package.json` declares
`"engines": { "node": ">=22.0.0" }`, but without `engine-strict` npm only
_warns_ on a version mismatch — nothing fails. CI selecting Node 22 means
shipped artifacts are built and tested on a supported runtime, but an
unsupported local runtime is not rejected. **Gap:** making this mechanical
requires either `engine-strict=true` in `.npmrc` or a check that actually
fails (e.g. a preinstall runtime assertion).

### 12. Core modules are maintainer-only (two-tier gate)

**Review-only.** The two-tier gate in AGENTS.md is a policy, not a lint rule.
It requires judgment about scope, confidence, and downstream consumers —
exactly the kind of decision that cannot be approximated mechanically. The
gate is enforced through the triage skill and reviewer judgment.

---

## Architecture issues

### #9146: utils/ must be a leaf layer

**Mechanically enforced — partial.** Merged PR #9147 added a
`no-restricted-imports` entry blocking `packages/cli/src/utils/**` from
importing `**/serve/*` and `**/serve/**`. This covers the `serve/` direction
only. The issue identifies 7 upward-importing directories in CLI (`config`,
`ui`, `i18n`, `nonInteractive`, `serve`, `commands`, root) and 10 in core
(`config`, `tools`, `services`, `core`, `agents`, `telemetry`, `memory`,
`hooks`, `models`, root barrel).

**Gap:** the remaining directories are not yet blocked. This is intentional
— the issue's own plan describes steps 5-7 as needing decisions or being
large enough to warrant separate PRs. The guard should be extended directory
by directory as each move lands. **No new guard until the moves are done.**
Prematurely blocking imports into `config/` or `ui/` would break the build
before the code is moved.

---

## #4063 structural problems

The 14 structural problems in #4063 are a problem register, not a set of
invariants. Most describe "this module is too large" or "this type is
over-coupled" — they are refactoring targets, not ongoing constraints to
guard. Two exceptions:

### #4063 item 5: Barrel export self-references (core modules import from `'../index.js'`)

**Mechanically enforced — gap (in open PRs, not on main).** An
`eslint-rules/no-core-root-barrel-import.js` rule exists in two open PRs —
#8139 (branch `lane3-core-root-barrel`) and #9635 (branch
`codex/pr-9152-root-barrel-cleanup`) — but has **not merged to `main`**. The
rule blocks `packages/core/src/**` from importing the root barrel
`../index.js`. **Action: merge one of the PRs carrying the rule, or record
why it was deferred.**

### #4063 item 2: Config god-object

**Review-only.** The two-tier gate in AGENTS.md already covers this — core
infrastructure changes require maintainer awareness. A line-count guard was
considered and rejected (the issue itself argues against it; #4063's
commentary and the Qwen Code review of #9152 both reject line-count lint).
Size is a symptom; the invariant is "don't add new responsibilities to
Config," which is a judgment call.

The remaining #4063 items (AppContainer size, useGeminiStream size, naming
like `core/coreToolScheduler.ts`, non-interactive code scattered across 4
locations) are refactoring targets, not invariants. They are tracked in
#4063 itself.

---

## Summary table

| Invariant                         | Source    | Classification       | Guard                                                                  | Status                                 |
| --------------------------------- | --------- | -------------------- | ---------------------------------------------------------------------- | -------------------------------------- |
| ESM only                          | AGENTS.md | Mechanical           | `package.json` `"type": "module"`                                      | ✅                                     |
| TS strict mode                    | AGENTS.md | Mechanical           | `tsconfig.json`                                                        | ✅                                     |
| Prettier formatting               | AGENTS.md | Mechanical           | `lint-staged` / pre-commit                                             | ✅                                     |
| No `any` types                    | AGENTS.md | Mechanical           | `@typescript-eslint/no-explicit-any`                                   | ✅                                     |
| Consistent type imports           | AGENTS.md | Mechanical           | `@typescript-eslint/consistent-type-imports`                           | ✅                                     |
| No relative cross-package imports | AGENTS.md | Mechanical           | `no-relative-cross-package-imports.js` + `import/no-relative-packages` | ✅                                     |
| Tests collocated                  | AGENTS.md | Review-only          | —                                                                      | ✅ (by design)                         |
| kebab-case `.ts` filenames        | AGENTS.md | Mechanical           | `check-file/filename-naming-convention`                                | ✅                                     |
| PascalCase `.tsx` filenames       | AGENTS.md | Mechanical           | —                                                                      | ⚠️ Gap (low priority)                  |
| No comments by default            | AGENTS.md | Review-only          | —                                                                      | ✅ (by design)                         |
| Conventional Commits              | AGENTS.md | Not worth enforcing  | —                                                                      | ✅ (by design)                         |
| Node ≥22                          | AGENTS.md | Mechanical (partial) | `package.json` `"engines"` (warn-only without `engine-strict`)         | ⚠️ Gap (local runtime not rejected)    |
| Core modules maintainer-only      | AGENTS.md | Review-only          | Two-tier gate                                                          | ✅ (by design)                         |
| utils/ is a leaf layer            | #9146     | Mechanical (partial) | `no-restricted-imports` (serve/ only)                                  | ⚠️ Intentionally incremental           |
| No core root barrel self-import   | #4063     | Mechanical           | `no-core-root-barrel-import.js`                                        | ❌ In open PRs #8139/#9635, not merged |
| Config god-object                 | #4063     | Review-only          | Two-tier gate                                                          | ✅ (by design)                         |

## Open actions

1. **Merge `no-core-root-barrel-import.js`** by landing one of the open PRs
   that carry it (#8139 or #9635), or record why it was deferred — closes the
   #4063 item 5 guard gap.
2. **Extend `utils/` leaf guard** directory by directory as #9146 steps 5-7
   land — no premature blocking.
