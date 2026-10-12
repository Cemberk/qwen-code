# Markdown Rendering

Qwen Code renders common Markdown structures directly in the TUI so model
answers are easier to scan without leaving the terminal. The renderer is
designed to keep the original source reachable, especially for visual blocks
such as Mermaid diagrams and LaTeX math.

## Render and Raw Modes

By default, Markdown is shown in `render` mode. Supported blocks render as
visual previews where possible:

- Mermaid fenced code blocks
- Markdown tables
- task lists
- blockquotes
- inline and block LaTeX math
- fenced code blocks with syntax highlighting

Press `Alt/Option+M` to toggle the current session between modes. On macOS,
the terminal must send Option as Meta for this shortcut; otherwise Option+M is
treated as normal text input.

- `render`: show rich terminal previews for supported Markdown.
- `raw`: show source-oriented Markdown for visual blocks such as Mermaid,
  tables, and LaTeX.

To start Qwen Code in raw mode by default, set `ui.renderMode`:

```json
{
  "ui": {
    "renderMode": "raw"
  }
}
```

Accepted values are `"render"` and `"raw"`. The shortcut only changes the
current session view; it does not rewrite your settings file.

## Assistant and Tool Images

Image parts use a separate TUI display path and behave the same in Markdown
`render` and `raw` modes. See [Terminal Images](./terminal-images.md) for terminal
support, fallbacks, limits, and session-history behavior.

## Mermaid

Fenced `mermaid` code blocks render visually in `render` mode. Qwen Code draws
the diagram in-process as a terminal wireframe or compact text preview; it does
not run an external renderer. If a Mermaid diagram type cannot be previewed,
Qwen Code shows the original fenced source instead of hiding it behind a
placeholder. During streaming, Qwen Code shows a bounded text preview until the
model response is complete.

### Mermaid Source Copy

Every rendered Mermaid block includes a source hint such as:

```text
Mermaid flowchart (TD) · source: /copy mermaid 1
```

Use these commands to copy Mermaid source from the last AI response:

| Command                | Behavior                                      |
| ---------------------- | --------------------------------------------- |
| `/copy mermaid`        | Copies the last Mermaid block.                |
| `/copy mermaid 1`      | Copies the first Mermaid block.               |
| `/copy code mermaid`   | Copies the last fenced `mermaid` code block.  |
| `/copy code mermaid 1` | Copies the first fenced `mermaid` code block. |

`/copy code 1` counts all fenced code blocks, not only Mermaid blocks. Use
`/copy mermaid N` when you want the Mermaid-specific sequence shown in the
rendered title.

## LaTeX Math

Qwen Code supports basic inline and block LaTeX rendering in the terminal:

```markdown
Inline math: $x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$

$$
\sum_{n=1}^{\infty} 1/n^2 = \pi^2/6
$$
```

The renderer focuses on common symbols and readable terminal output. It is not
a full TeX engine; complex layouts such as matrices, aligned equations, and
large nested expressions may be simplified.

Inline `$...$` expressions are intentionally bounded to 1024 characters per
line so malformed or very large generated Markdown cannot stall terminal
rendering. Longer formulas remain visible as source text and can still be
copied from raw mode or the original response.

### LaTeX Source Copy

Use these commands to copy LaTeX source from the last AI response:

| Command                | Behavior                                |
| ---------------------- | --------------------------------------- |
| `/copy latex`          | Copies the last block LaTeX expression. |
| `/copy latex 2`        | Copies the second block expression.     |
| `/copy latex inline`   | Copies the last inline expression.      |
| `/copy latex inline 2` | Copies the second inline expression.    |
| `/copy inline-latex 2` | Alias for `/copy latex inline 2`.       |

Inline LaTeX does not show a per-expression copy hint in rendered text to avoid
making prose noisy. Switch to raw mode with `Alt/Option+M` when you want to
inspect inline source in place; on macOS this requires Option-as-Meta terminal
input.

## General Code Copy

The `/copy code` command reads fenced code blocks from the last AI Markdown
response:

| Command                 | Behavior                                 |
| ----------------------- | ---------------------------------------- |
| `/copy code`            | Copies the last fenced code block.       |
| `/copy code 2`          | Copies the second fenced code block.     |
| `/copy code typescript` | Copies the last `typescript` code block. |
| `/copy code mermaid 1`  | Copies the first `mermaid` code block.   |

## Selecting an Earlier AI Message

By default `/copy` targets the most recent AI message. Prefix the command with
a positive integer to copy from the Nth-last AI message instead — handy when
the latest reply is something low-signal (e.g., a TODO update) and the
substantive output is one or two turns back.

| Command               | Behavior                                               |
| --------------------- | ------------------------------------------------------ |
| `/copy 2`             | Copies the second-to-last AI message in full.          |
| `/copy 3`             | Copies the third-to-last AI message in full.           |
| `/copy 2 code python` | Copies the last `python` code block from the 2nd-last. |
| `/copy 3 latex`       | Copies the last LaTeX block from the 3rd-last message. |

`/copy 1` is equivalent to `/copy`. If `N` exceeds the number of AI messages
in the session, `/copy` reports the actual count instead of copying anything.
Without a leading integer, sub-selectors such as `/copy code python 2` keep
their existing meaning (the 2nd `python` block in the last message).

## Current Limits

- Wireframe Mermaid rendering is a readable terminal preview, not a full
  Mermaid layout engine.
- Raw mode is global for rendered Markdown blocks; it is not a per-block toggle.
- LaTeX rendering covers common symbols and expressions, not full TeX layout.
- Source copy commands target the last AI response by default, or the Nth-last
  when invoked as `/copy N ...`.
