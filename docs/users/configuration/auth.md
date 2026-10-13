# Authentication

Qwen Code talks only to a **local OpenAI-compatible model server** running on your own machine, such as Ollama, LM Studio, vLLM or llama.cpp (`llama-server`). There is no cloud sign-in and no hosted provider. "Authentication" means pointing Qwen Code at your local server with three values:

- a **base URL** for the server's OpenAI-compatible API,
- an **API key** value, and
- one or more **model IDs** that the server serves.

The only supported auth type is `openai` (OpenAI Chat Completions).

None of this is needed for the built-in [Local Models](local-models.md): Qwen Code runs those itself and selects the first one when nothing else is configured. The rest of this page is about servers you run yourself.

> [!important]
>
> **The base URL is required and must be loopback.** It must use `http` or `https` and its host must be exactly `127.0.0.1`, `::1` (written `[::1]` in a URL), or `localhost`. Qwen Code rejects any other host (LAN addresses, `0.0.0.0`, other host names) at startup or when you save the configuration. There is no default base URL for a server you run yourself. Requests to the model server never follow HTTP redirects.

Common base URLs:

| Server                     | Base URL                    |
| -------------------------- | --------------------------- |
| Ollama                     | `http://127.0.0.1:11434/v1` |
| LM Studio                  | `http://localhost:1234/v1`  |
| vLLM                       | `http://127.0.0.1:8000/v1`  |
| llama.cpp (`llama-server`) | `http://127.0.0.1:8080/v1`  |

Set the base URL to the API's `/v1` root, not the full `/v1/chat/completions` path. The client adds the request path itself.

## Option 1: Interactive setup with `/auth`

Start `qwen`. If no model server is configured and `localModels` is empty, Qwen Code opens the setup wizard. You can reopen it at any time with the `/auth` command. The wizard ("Local OpenAI-compatible server") has these steps:

1. **Base URL**: the loopback URL of your server, for example `http://127.0.0.1:11434/v1`.
2. **API Key**: any non-empty value if your server doesn't check keys (for example `ollama` or `lm-studio`). If you started the server with a key (for example vLLM's or `llama-server`'s `--api-key`), enter that key.
3. **Model IDs**: if the server lists its models at `GET {baseUrl}/models`, the wizard shows them and you check the ones you want. Otherwise, type the model IDs as a comma-separated list.
4. **Advanced Config** (optional): enable thinking, enable multimodal input, and set the context window size.
5. **Review**: shows the JSON that will be written to `settings.json`. Press Enter to save.

When you save, the wizard writes the following to your settings:

- a `modelProviders.openai` entry for each model ID,
- the API key in the `env` field, stored under a generated variable name (`QWEN_CUSTOM_API_KEY_...`) that the model entries reference through `envKey`,
- `security.auth.selectedType: "openai"` and `model.name`.

Use `/model` afterwards to switch between the configured models.

## Option 2: Configure `settings.json`

To skip the wizard, put everything in `~/.qwen/settings.json`. This example uses Ollama:

```json
{
  "modelProviders": {
    "openai": [
      {
        "id": "qwen3-coder:30b",
        "name": "Qwen3 Coder 30B (Ollama)",
        "baseUrl": "http://127.0.0.1:11434/v1",
        "envKey": "OLLAMA_API_KEY"
      }
    ]
  },
  "env": {
    "OLLAMA_API_KEY": "ollama"
  },
  "security": {
    "auth": {
      "selectedType": "openai"
    }
  },
  "model": {
    "name": "qwen3-coder:30b"
  }
}
```

What each field does:

| Field                        | Description                                                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modelProviders.openai`      | The models `/model` can switch between. `openai` is the only accepted key. Each entry needs an `id` and a loopback `baseUrl`.                        |
| `env`                        | Fallback values for environment variables, such as the variable named by `envKey`. Lowest priority: shell `export` and `.env` files take precedence. |
| `security.auth.selectedType` | Must be `"openai"`. Any other value is rejected with an error.                                                                                       |
| `model.name`                 | The model to use on startup. It should match an `id` in `modelProviders.openai`.                                                                     |

After saving the file, run `qwen`. No interactive setup is needed.

You can list models from several local servers in the same `modelProviders.openai` array, for example an Ollama model and an LM Studio model, each with its own `baseUrl`. For all `modelProviders` fields, including `generationConfig`, `capabilities` and reasoning settings, see [Model Providers](model-providers.md).

> [!important]
>
> Define `modelProviders` in the user-scope `~/.qwen/settings.json`. Project settings replace the whole `modelProviders` object instead of merging with it.

## Option 3: Environment variables and CLI flags

For scripts, CI jobs and one-off runs, you can configure the server without `modelProviders`:

| Environment variable | CLI flag            | Meaning                                               |
| -------------------- | ------------------- | ----------------------------------------------------- |
| `OPENAI_BASE_URL`    | `--openai-base-url` | Loopback base URL of the server.                      |
| `OPENAI_API_KEY`     | `--openai-api-key`  | API key value (any non-empty value for most servers). |
| `OPENAI_MODEL`       | `--model`           | Model ID. `QWEN_MODEL` is an alias of `OPENAI_MODEL`. |
| —                    | `--auth-type`       | Auth type. Only `openai` is accepted.                 |

```bash
export OPENAI_BASE_URL="http://127.0.0.1:8000/v1"
export OPENAI_API_KEY="not-needed"
export OPENAI_MODEL="Qwen/Qwen3-Coder-30B-A3B-Instruct"

qwen -p "Summarize the TODOs in this repository"
```

Setting all three of `OPENAI_BASE_URL`, `OPENAI_API_KEY` and `OPENAI_MODEL` (or `QWEN_MODEL`) is enough to select the `openai` auth type without `settings.json`. Otherwise, set `security.auth.selectedType` or pass `--auth-type openai`:

```bash
qwen --auth-type openai \
  --openai-base-url http://localhost:1234/v1 \
  --openai-api-key lm-studio \
  --model qwen3-coder-30b-a3b-instruct
```

`settings.security.auth.baseUrl` and `settings.security.auth.apiKey` are also read as the lowest-priority sources for the base URL and API key. The same loopback rule applies to every source. For the full precedence order, see [Resolution layers](model-providers.md#resolution-layers).

## Where API keys are read from

When the selected model comes from `modelProviders`, Qwen Code reads the key from the environment variable named by that model's `envKey`. If the model has no `envKey`, or that variable isn't set, it falls back to `--openai-api-key`, then `OPENAI_API_KEY`, then `settings.security.auth.apiKey`.

Environment variables can come from these sources, from **highest to lowest priority**:

1. **Shell environment**: `export` in your shell profile, or inline before `qwen`.
2. **`.env` files**: variables already present in the process environment aren't overwritten. In a trusted folder Qwen Code reads the first project `.env` it finds walking upward from the current directory (`.qwen/.env` then `.env`); `~/.qwen/.env` and then `~/.env` are always read after it. Model server variables (`OPENAI_*`, `QWEN_CUSTOM_API_KEY_*`, `QWEN_MODEL`) are only taken from `~/.qwen/.env`, `~/.env` or your user settings — a project `.env` can never set them. Some variables (like `DEBUG` and `DEBUG_MODE`) are also ignored in project-level `.env` files.
3. **`settings.json` → `env`** (lowest priority): applied only when a variable isn't already set by the environment or a `.env` file.

`--openai-api-key` takes precedence over an `OPENAI_API_KEY` value from any of these sources.

## Security notes

- Keep the model server bound to loopback as well (for example `127.0.0.1`), so other machines on your network can't reach it.
- If your server requires a real API key, don't commit it to version control. Keep it in `~/.qwen/.env` or your user `settings.json`.
- Treat terminal output as sensitive if it prints credentials.
