# Troubleshooting

This guide provides solutions to common issues and debugging tips, including topics on:

- Model server connection and configuration errors
- Frequently asked questions (FAQs)
- Debugging tips

## Model server connection and configuration errors

- **Error: `No model server base URL is configured`**
  - **Cause:** Qwen Code has no default base URL. None of the selected model entry, `--openai-base-url`, `OPENAI_BASE_URL` or `security.auth.baseUrl` provides one.
  - **Solution:** Run `/auth` and enter your local server's base URL, or set one of those sources. For example: Ollama `http://127.0.0.1:11434/v1`, LM Studio `http://localhost:1234/v1`, vLLM `http://127.0.0.1:8000/v1`, llama.cpp `http://127.0.0.1:8080/v1`. See [Authentication](../configuration/auth).

- **Error: `Model server base URL "..." is not allowed: the host must be 127.0.0.1, ::1 or localhost.`**
  - **Cause:** Qwen Code only talks to model servers on this machine's loopback interface. LAN addresses, `0.0.0.0`, other host names and cloud endpoints are rejected, both in `modelProviders` entries and in flags, environment variables and settings.
  - **Solution:** Run the model server locally and use a loopback base URL. If the server listens on all interfaces, still connect through `127.0.0.1` or `localhost`.

- **Error: `Auth type '...' is not supported`**
  - **Cause:** `security.auth.selectedType` or `--auth-type` is set to something other than `openai`, for example a value left over from an older configuration.
  - **Solution:** Set `security.auth.selectedType` to `"openai"`, or remove it and run `/auth`.

- **Error: a missing API key or model**
  - **Cause:** The API key or model ID could not be resolved from any source.
  - **Solution:** Run `/auth`, or set `OPENAI_API_KEY` (any non-empty value if your server doesn't check keys) and `OPENAI_MODEL`. When a `modelProviders` entry declares an `envKey`, make sure that variable is set.

- **Error: `Connection error` or `ECONNREFUSED` against `127.0.0.1` / `localhost`**
  - **Cause:** The local model server isn't running, or it listens on a different port than the configured base URL.
  - **Solution:** Start the server (for example `ollama serve`, the LM Studio local server, `vllm serve <model>` or `llama-server -m <model.gguf>`) and check that the port and the `/v1` path match your base URL. The server must answer directly: Qwen Code doesn't follow HTTP redirects from the model server.

- **Error: `Connection error. (cause: fetch failed)` against a self-signed endpoint**
  - **Cause:** You are pointing Qwen Code at a self-hosted server (for example a local model behind `https://`) whose TLS certificate is self-signed, so Node.js rejects it.
  - **Solution:** Trust the certificate by setting `NODE_EXTRA_CA_CERTS` to the absolute path of its CA certificate file, or serve the local endpoint over plain `http://` on loopback. Qwen Code has no option to skip certificate verification.

- **Issue: Unable to display UI after authentication failure**
  - **Cause:** If authentication fails after selecting an authentication type, the `security.auth.selectedType` setting may be persisted in `settings.json`. On restart, the CLI may get stuck trying to authenticate with the failed auth type and fail to display the UI.
  - **Solution:** Clear the `security.auth.selectedType` configuration item in your `settings.json` file:
    - Open `~/.qwen/settings.json` (or `./.qwen/settings.json` for project-specific settings)
    - Remove the `security.auth.selectedType` field
    - Restart the CLI to allow it to prompt for authentication again

## Frequently asked questions (FAQs)

- **Q: How do I update Qwen Code to the latest version?**
  - A: Pull the latest changes from the repository, and then rebuild using the commands `npm run build` and `npm run bundle`.

- **Q: Where are the Qwen Code configuration or settings files stored?**
  - A: The Qwen Code configuration is stored in two `settings.json` files:
    1. In your home directory: `~/.qwen/settings.json`.
    2. In your project's root directory: `./.qwen/settings.json`.

    Refer to [Qwen Code Configuration](../configuration/settings) for more details.

- **Q: Why don't I see cached token counts in my stats output?**
  - A: Cached token information is only displayed when cached tokens are being used. It depends on your local server reporting cached prompt tokens in its usage data; many local servers don't. You can still view your total token usage using the `/stats` command.

- **Q: A customization (extension, hook, skill, MCP server, or subagent) seems to be breaking Qwen Code. How do I isolate it?**
  - A: Start Qwen Code with the `--safe-mode` flag to disable all customizations — context files, hooks, extensions, skills, MCP servers, custom subagents (only built-in subagents load), permission rules, settings-sourced approval mode overrides, memory features, and sandbox settings — for the session. Note: the CLI flags `--yolo` and `--approval-mode` still take effect in safe mode. If the problem disappears in safe mode, re-enable your customizations one at a time to find the culprit.
    - Example: `qwen --safe-mode`
    - Alternative: set the environment variable `QWEN_CODE_SAFE_MODE=true` if the CLI cannot accept flags.
    - Note: unlike the flag, an exported `QWEN_CODE_SAFE_MODE` is inherited by child processes, so every `qwen` started from that shell runs in safe mode too: it writes no session record, and other sessions cannot list it. Unset the variable rather than leaving it exported in your shell.
    - Note: "MCP servers" here means servers configured in `settings.json` / project `.mcp.json` — local, ambient state that safe mode is meant to isolate against. MCP servers you explicitly supply for the current invocation (`--mcp-config`) are not local/ambient state and are still honored under safe mode.

## Common error messages and solutions

- **Error: `EADDRINUSE` (Address already in use) when starting an MCP server.**
  - **Cause:** Another process is already using the port that the MCP server is trying to bind to.
  - **Solution:**
    Either stop the other process that is using the port or configure the MCP server to use a different port.

- **Error: Command not found (when attempting to run Qwen Code with `qwen`).**
  - **Cause:** The CLI is not correctly installed or it is not in your system's `PATH`.
  - **Solution:**
    - Check that `~/.local/bin/qwen` exists and that `~/.local/bin` is on your `PATH`; see [Add the `qwen` command](../quickstart#add-the-qwen-command).
    - Otherwise, run the bundle directly with Node.js 22 (e.g. `node dist/cli.js ...`). To update, pull the latest changes from the repository, and then rebuild using the commands `npm run build` and `npm run bundle`.

- **Error: `MODULE_NOT_FOUND` or import errors.**
  - **Cause:** Dependencies are not installed correctly, or the project hasn't been built.
  - **Solution:**
    1.  Run `corepack pnpm install --frozen-lockfile` to ensure all dependencies are present.
    2.  Run `npm run build` to compile the project.
    3.  Verify that the build completed successfully with `npm run start`.

- **Error: "Operation not permitted", "Permission denied", or similar.**
  - **Cause:** When sandboxing is enabled, Qwen Code may attempt operations that are restricted by your sandbox configuration, such as writing outside the project directory or system temp directory.
  - **Solution:** Refer to the [Configuration: Sandboxing](../features/sandbox) documentation for more information, including how to customize your sandbox configuration.

- **Qwen Code is not running in interactive mode in "CI" environments**
  - **Issue:** Qwen Code does not enter interactive mode (no prompt appears) if an environment variable starting with `CI_` (e.g. `CI_TOKEN`) is set. This is because the `is-in-ci` package, used by the underlying UI framework, detects these variables and assumes a non-interactive CI environment.
  - **Cause:** The `is-in-ci` package checks for the presence of `CI`, `CONTINUOUS_INTEGRATION`, or any environment variable with a `CI_` prefix. When any of these are found, it signals that the environment is non-interactive, which prevents the CLI from starting in its interactive mode.
  - **Solution:** If the `CI_` prefixed variable is not needed for the CLI to function, you can temporarily unset it for the command. e.g. `env -u CI_TOKEN qwen`

- **DEBUG mode not working from project .env file**
  - **Issue:** Setting `DEBUG=true` in a project's `.env` file doesn't enable debug mode for the CLI.
  - **Cause:** The `DEBUG` and `DEBUG_MODE` variables are automatically excluded from project `.env` files to prevent interference with the CLI behavior.
  - **Solution:** Use a `.qwen/.env` file instead, or configure the `advanced.excludedEnvVars` setting in your `settings.json` to exclude fewer variables.

- **Trackpad scrolling in tmux changes prompt history instead of scrolling the conversation**
  - **Issue:** In a tmux session, trackpad or wheel scrolling may cycle through previous prompts, similar to pressing `Up Arrow` or `Down Arrow`.
  - **Cause:** tmux can translate wheel gestures into plain arrow-key sequences. Those sequences are indistinguishable from real arrow-key presses by the time qwen-code receives them.
  - **Solution:** If screen reader mode is disabled, make sure `ui.useTerminalBuffer` is enabled; then use `Shift+Up` / `Shift+Down`, or the mouse wheel when tmux forwards wheel events to the app (requires `ui.mouseTracking`). If you prefer host scrollback, adjust your tmux mouse bindings for wheel events.

- **Right-click does nothing, links do not open, or text cannot be selected in the terminal**
  - **Issue:** Native right-click context menus, OSC 8 hyperlink clicks, and terminal-native text selection stop working while Qwen Code is running.
  - **Cause:** When `ui.mouseTracking` is enabled (the default), Qwen Code captures all mouse events via SGR mouse tracking to power in-app text selection, click-to-position, row hover, history-item toggling, and viewport scrolling. The terminal forwards every mouse event to the app instead of handling it natively. Qwen Code supplies its own replacements while tracking is on: a single click copies an OSC 8 hyperlink to the clipboard, and right-click on a link or text selection opens an in-app context menu.
  - **Solution:** If you prefer the terminal's native handling, set `"ui.mouseTracking": false` in your `settings.json`. This turns off all in-app mouse interaction, including the in-app link open and context menu. In Virtualized History (`ui.useTerminalBuffer: true`, the default), the wheel will no longer scroll the transcript — use `Shift+↑/↓`, `PgUp/PgDn`, or `Ctrl+Home/End` instead. To also restore native terminal scrollback, set `"ui.useTerminalBuffer": false`. Requires restart.

## Exit Codes

The Qwen Code uses specific exit codes to indicate the reason for termination. This is especially useful for scripting and automation.

| Exit Code | Error Type                 | Description                                                                                         |
| --------- | -------------------------- | --------------------------------------------------------------------------------------------------- |
| 41        | `FatalAuthenticationError` | An error occurred during the authentication process.                                                |
| 42        | `FatalInputError`          | Invalid or missing input was provided to the CLI. (non-interactive mode only)                       |
| 44        | `FatalSandboxError`        | An error occurred with the sandboxing environment (e.g. Docker, Podman, or Seatbelt).               |
| 52        | `FatalConfigError`         | A configuration file (`settings.json`) is invalid or contains errors.                               |
| 53        | `FatalTurnLimitedError`    | The maximum number of conversational turns for the session was reached. (non-interactive mode only) |

## Debugging Tips

- **CLI debugging:**
  - Use the `--verbose` flag (if available) with CLI commands for more detailed output.
  - Check the CLI logs, often found in a user-specific configuration or cache directory.

- **Core debugging:**
  - Check the server console output for error messages or stack traces.
  - Increase log verbosity if configurable.
  - Use Node.js debugging tools (e.g. `node --inspect`) if you need to step through server-side code.

- **Tool issues:**
  - If a specific tool is failing, try to isolate the issue by running the simplest possible version of the command or operation the tool performs.
  - For `run_shell_command`, check that the command works directly in your shell first.
  - For _file system tools_, verify that paths are correct and check the permissions.

- **Pre-flight checks:**
  - Always run `npm run preflight` before committing code. This can catch many common issues related to formatting, linting, and type errors.
