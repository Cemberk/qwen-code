# Web Access

Qwen Code is fully local by default: the model has no way to read the web.
Turn on web access when you want it to look something up. The model then gets
one tool, `web_fetch`, which reads one web page at a time, and every fetch
asks you first.

## Turning it on and off

| Command    | What it does                                         |
| ---------- | ---------------------------------------------------- |
| `/web`     | Shows whether web access is on.                      |
| `/web on`  | Gives the model the `web_fetch` tool.                |
| `/web off` | Removes the tool, so Qwen Code is fully local again. |

The choice is saved as `tools.webFetch` in `~/.qwen/settings.json` and applies
at once, to this session and later ones. While web access is on, the footer
shows **web on**.

The model cannot run slash commands, and a project's `.qwen/settings.json`
cannot set `tools.webFetch`. If web access is turned on some other way, for
example by an approved edit of `~/.qwen/settings.json`, every fetch still asks
you.

## What happens on each fetch

When the model wants a page, Qwen Code shows you the full URL and asks. Choose
**Yes, allow once** or **No**. There is no "always allow": every fetch asks,
in every approval mode including YOLO and auto mode, and hooks and permission
rules cannot approve it. `qwen -p` cannot ask, so it never fetches.

After you approve:

- Qwen Code sends one GET request for that URL, with no cookies, logins or API
  keys, and the user agent `Mozilla/5.0 (compatible; QwenCode)`.
- It follows redirects within the same site. A redirect to another site is not
  followed: the model is told the new address and has to ask again.
- It downloads at most 2 MB, waits at most 30 seconds, and gives the model at
  most 40,000 characters.
- HTML pages become plain text, with links written as `text (url)`. Plain text,
  JSON and XML come back as they are. Other files, such as images and PDFs,
  are not returned.
- The page is passed to the model as untrusted data, with an instruction not
  to follow instructions in it. A page can still try to mislead the model, so
  check what it does with what it reads.

## Limits

- There is no web search. The model reads pages whose address it knows, or
  that a page it read links to.
- Pages that need JavaScript to show their content come back mostly empty.
- Under the Seatbelt sandbox (`--sandbox` on macOS), traffic outside this
  machine is blocked, so fetches fail.
- Web access only controls `web_fetch`. The model can also reach the internet
  through shell commands such as `curl`, if you approve them.
