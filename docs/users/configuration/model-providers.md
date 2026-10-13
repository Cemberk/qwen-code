# Model Providers

Qwen Code connects only to local OpenAI-compatible model servers (Ollama, LM Studio, vLLM, llama.cpp and similar) running on this machine. Use the `modelProviders` setting in `settings.json` to declare the models on those servers. The `/model` command then switches between them.

For first-time setup (the `/auth` wizard, environment variables and CLI flags), see [Authentication](auth.md).

To have Qwen Code run Qwen models itself, without a server of your own, see [Local Models](local-models.md). Those models are listed in `/model` ahead of the `modelProviders` entries.

## Overview

`modelProviders` accepts exactly one key, `openai`. Its value is **an array of model definitions** (`ModelConfig[]`). Any other key, such as `anthropic` or `gemini`, is a configuration error, and so is a model entry without a valid loopback `baseUrl`.

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
  }
}
```

**`ModelConfig` fields:**

| Field              | Required | Description                                                                                                                                                                  |
| ------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | Yes      | Model ID sent to the server (for example `qwen3-coder:30b`).                                                                                                                 |
| `baseUrl`          | Yes      | The server's OpenAI-compatible `/v1` root. The host must be exactly `127.0.0.1`, `::1` (`[::1]`) or `localhost`, over `http` or `https`.                                     |
| `envKey`           | No       | **Name** of the environment variable that holds the API key. When omitted or unset, the key falls back to `--openai-api-key`, `OPENAI_API_KEY`, then `security.auth.apiKey`. |
| `name`             | No       | Display name in the `/model` picker. Defaults to `id`.                                                                                                                       |
| `description`      | No       | Description shown in the `/model` picker.                                                                                                                                    |
| `capabilities`     | No       | Explicit model capabilities: `vision`, `agent` and `reasoning` (see below).                                                                                                  |
| `generationConfig` | No       | Request settings for this model: `timeout`, `maxRetries`, `samplingParams`, `contextWindowSize`, `extra_body` and more.                                                      |
| `fastOnly`         | No       | When `true`, the model is listed only in the fast-model picker (`/model --fast`), not the main list.                                                                         |
| `visionOnly`       | No       | When `true`, the model is listed only in the vision-model picker (`/model --vision`), not the main list.                                                                     |

Credentials are never stored in the model entry itself. The runtime reads them from `process.env[envKey]`.

> [!note]
>
> **Model uniqueness:** A model is identified by its `id` and `baseUrl`, so the same model ID can be listed for two different servers. If two entries share both values, the first one wins and later duplicates are skipped with a warning.

> [!note]
>
> **Hot reload:** A running interactive session picks up `modelProviders` edits in `settings.json` without a restart (the file watcher debounces about 300 ms). Reopen `/model` to see new entries. The current selection is kept. An invalid edit leaves the previous model list in place.

## Local server examples

Most local inference servers expose an OpenAI-compatible API. Configure each model with the server's loopback base URL:

```json
{
  "env": {
    "OLLAMA_API_KEY": "ollama",
    "LMSTUDIO_API_KEY": "lm-studio",
    "VLLM_API_KEY": "not-needed",
    "LLAMACPP_API_KEY": "not-needed"
  },
  "modelProviders": {
    "openai": [
      {
        "id": "qwen3-coder:30b",
        "name": "Qwen3 Coder 30B (Ollama)",
        "envKey": "OLLAMA_API_KEY",
        "baseUrl": "http://127.0.0.1:11434/v1",
        "generationConfig": {
          "timeout": 300000,
          "streamIdleTimeoutMs": 600000,
          "maxRetries": 1,
          "contextWindowSize": 32768,
          "samplingParams": {
            "temperature": 0.7,
            "top_p": 0.9,
            "max_tokens": 4096
          }
        }
      },
      {
        "id": "qwen3-coder-30b-a3b-instruct",
        "name": "Qwen3 Coder 30B (LM Studio)",
        "envKey": "LMSTUDIO_API_KEY",
        "baseUrl": "http://localhost:1234/v1",
        "generationConfig": {
          "timeout": 60000,
          "samplingParams": {
            "temperature": 0.5
          }
        }
      },
      {
        "id": "Qwen/Qwen3-Coder-30B-A3B-Instruct",
        "name": "Qwen3 Coder 30B (vLLM)",
        "envKey": "VLLM_API_KEY",
        "baseUrl": "http://127.0.0.1:8000/v1",
        "generationConfig": {
          "timeout": 120000,
          "maxRetries": 2,
          "contextWindowSize": 131072,
          "customHeaders": {
            "X-Client-Request-ID": "req-123"
          },
          "extra_body": {
            "chat_template_kwargs": { "enable_thinking": true }
          },
          "samplingParams": {
            "temperature": 0.6,
            "max_tokens": 8192
          }
        }
      },
      {
        "id": "local-model",
        "name": "Local model (llama.cpp)",
        "envKey": "LLAMACPP_API_KEY",
        "baseUrl": "http://127.0.0.1:8080/v1",
        "generationConfig": {
          "contextWindowSize": 16384
        }
      }
    ]
  }
}
```

Set `baseUrl` to the API's `/v1` root rather than the full `/v1/chat/completions` path. The client appends the request path itself. Qwen Code never follows HTTP redirects from the model server.

For servers that don't check API keys, any non-empty placeholder works (for example `ollama` or `not-needed`). If you start vLLM or `llama-server` with `--api-key`, put that key in the variable named by `envKey`.

For queued or slow local servers, `streamIdleTimeoutMs` controls how long this model may stay silent between streamed chunks. It overrides the global `QWEN_STREAM_IDLE_TIMEOUT_MS` value for that model entry; set it to `0` to disable the idle guard. The separate 15-minute stream lifetime cap still applies unless `QWEN_STREAM_MAX_LIFETIME_MS` is raised or disabled.

> [!note]
>
> **About `envKey`**: `envKey` is the **name of an environment variable**, not the key itself. Set that variable in one of these ways:
>
> - **A `.env` file** (recommended):
>   ```bash
>   # ~/.qwen/.env (or .qwen/.env in the project)
>   VLLM_API_KEY=your-server-key
>   ```
>   Add `.env` to your `.gitignore` so the key isn't committed.
> - **The `env` field in `settings.json`**, as in the example above.

## Vision models

To send images to a model, set `capabilities.vision` to `true` (or use `generationConfig.modalities`). For a vision model that can also follow the normal agent policy and use tools, opt in to full-turn image routing with both capabilities:

```json
"capabilities": {
  "vision": true,
  "agent": true
}
```

When a text-only primary model uses that model as its configured vision model, the complete image-bearing turn stays on that exact model and base URL across tool calls and retries. The next independent turn returns to the primary model, and each request receives only the media types its target supports. Omit `agent` (or set it to `false`) to keep the safer Vision Bridge transcription flow.

## Side models

`fastModel`, `compactionModel`, `visionModel`, `advisorModel`, a subagent's `model:` field and `modelFallbacks` all name models from your `modelProviders.openai` entries. They use the base URL and API key of that entry, so they always go to a local loopback server; there is no routing to other providers. A side-model ID that isn't configured runs on the main model instead (the vision bridge refuses rather than falling back).

## Override reasoning capabilities

Set `capabilities.reasoning` on a model entry to declare its reasoning request shape, offered effort tiers and default tier. For a model Qwen Code doesn't know, declare all three fields:

```json
{
  "id": "my-reasoning-model",
  "baseUrl": "http://127.0.0.1:8000/v1",
  "envKey": "VLLM_API_KEY",
  "capabilities": {
    "reasoning": {
      "profile": "openai-effort",
      "efforts": ["low", "medium", "high"],
      "defaultEffort": "medium"
    }
  }
}
```

`efforts` is the supported subset of `low/medium/high/xhigh/max`. An explicit `defaultEffort` must belong to that subset. `profile` selects how the reasoning switch is written into the request body:

| Profile              | Request body shape                                                              |
| -------------------- | ------------------------------------------------------------------------------- |
| `openai-effort`      | Top-level `reasoning_effort`                                                    |
| `openai-reasoning`   | A nested `reasoning` object                                                     |
| `deepseek-openai`    | `thinking: { type }` plus `reasoning_effort`                                    |
| `qwen-chat-template` | `chat_template_kwargs.enable_thinking` (vLLM, SGLang, llama.cpp chat templates) |

A toggle-only declaration omits `efforts` and `defaultEffort`.

Reasoning changes apply before the next user prompt. That prompt's requests, retries and child agents share the captured reasoning configuration. An invalid update keeps the previous configuration and logs the model and field error. An invalid declaration in a fresh session falls back to the default behavior. Explicit user choices and raw overrides in `reasoning`, `samplingParams` and `extra_body` keep their precedence; a model default is not saved as a user choice.

## Resolution layers

Each field of the effective model configuration is chosen from the first layer that provides it:

| Layer (highest → lowest)   | authType                     | model                         | apiKey                                | baseUrl                           | apiKeyEnvKey                     |
| -------------------------- | ---------------------------- | ----------------------------- | ------------------------------------- | --------------------------------- | -------------------------------- |
| Programmatic overrides     | `/auth`                      | `/auth` input                 | `/auth` input                         | `/auth` input                     | —                                |
| Model provider selection   | —                            | `modelProviders.openai[].id`  | `env[modelProviders.openai[].envKey]` | `modelProviders.openai[].baseUrl` | `modelProviders.openai[].envKey` |
| CLI arguments              | `--auth-type`                | `--model`                     | `--openai-api-key`                    | `--openai-base-url`               | —                                |
| Environment variables      | —                            | `OPENAI_MODEL` / `QWEN_MODEL` | `OPENAI_API_KEY`                      | `OPENAI_BASE_URL`                 | —                                |
| Settings (`settings.json`) | `security.auth.selectedType` | `model.name`                  | `security.auth.apiKey`                | `security.auth.baseUrl`           | —                                |
| Default                    | none                         | none                          | —                                     | none                              | —                                |

Notes:

- `openai` is the only auth type. `--auth-type` and `security.auth.selectedType` reject any other value. Without either, Qwen Code selects `openai` only when `OPENAI_API_KEY`, `OPENAI_BASE_URL` and `OPENAI_MODEL` (or `QWEN_MODEL`) are all set.
- For the model ID, `--model` wins over `model.name`, and `model.name` wins over `OPENAI_MODEL` / `QWEN_MODEL`.
- There is no default base URL and no default model ID. Whichever layer supplies the base URL, it must be a loopback URL, or startup fails with an error.
- `--openai-api-key` and `--openai-base-url` are the only credential flags.

## Generation config layering: the impermeable provider layer

Model configuration follows one important rule: **the model provider layer is impermeable**.

1. **When a `modelProviders` model is selected** (for example with `/model`):
   - The model entry's `generationConfig` is applied **atomically**.
   - Lower layers (CLI, env, settings) don't take part in `generationConfig` resolution at all.
   - Fields the entry doesn't define are `undefined`; they are not inherited from settings.

   Put every model-specific generation setting in the matching model entry. Top-level `model.generationConfig` values, including `contextWindowSize`, `modalities`, `customHeaders` and `extra_body`, are ignored for provider models.

2. **When no `modelProviders` model is selected** (for example `--model` with an ID that isn't configured, or a setup that uses only CLI flags, environment variables or settings):
   - Each field falls through CLI → env → settings → defaults.
   - The result is a **Runtime Model** (see below).

### Per-field precedence for `generationConfig`

| Priority | Source                                     | Behavior                                                                                      |
| -------- | ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| 1        | Programmatic overrides                     | Runtime `/model` and `/auth` changes                                                          |
| 2        | `modelProviders.openai[].generationConfig` | **Impermeable layer**: replaces all `generationConfig` fields; lower layers don't participate |
| 3        | `settings.model.generationConfig`          | Used only for **Runtime Models**                                                              |
| 4        | Content-generator defaults                 | Used only for **Runtime Models**                                                              |

### Atomic field treatment

These fields are atomic objects. A provider value replaces the whole object; nothing is merged:

- `samplingParams`: temperature, top_p, max_tokens, and so on
- `customHeaders`: custom HTTP headers
- `extra_body`: extra request body parameters

### Example

```jsonc
// User settings (~/.qwen/settings.json)
{
  "model": {
    "generationConfig": {
      "timeout": 30000,
      "samplingParams": { "temperature": 0.5, "max_tokens": 1000 },
    },
  },
  "modelProviders": {
    "openai": [
      {
        "id": "qwen3-coder:30b",
        "baseUrl": "http://127.0.0.1:11434/v1",
        "envKey": "OLLAMA_API_KEY",
        "generationConfig": {
          "timeout": 60000,
          "samplingParams": { "temperature": 0.2 },
        },
      },
    ],
  },
}
```

When `qwen3-coder:30b` is selected from `modelProviders`:

- `timeout` = 60000 (from the model entry)
- `samplingParams.temperature` = 0.2 (the entry's object replaces the settings object)
- `samplingParams.max_tokens` = **undefined** (the entry doesn't define it, and the provider layer doesn't inherit from settings)

When a model that isn't configured is used with `--model other-model` (a Runtime Model):

- `timeout` = 30000 (from settings)
- `samplingParams.temperature` = 0.5 (from settings)
- `samplingParams.max_tokens` = 1000 (from settings)

The merge strategy for `modelProviders` itself is REPLACE: a `modelProviders` object in project settings replaces the one in user settings instead of merging with it.

## Reasoning / thinking configuration

The optional `reasoning` field under `generationConfig` controls how hard a reasoning-capable model thinks. The [`/effort`](../features/commands) command sets the same tier interactively.

```jsonc
{
  "modelProviders": {
    "openai": [
      {
        "id": "my-reasoning-model",
        "baseUrl": "http://127.0.0.1:8000/v1",
        "envKey": "VLLM_API_KEY",
        "generationConfig": {
          // One of 'low' | 'medium' | 'high' | 'xhigh' | 'max',
          // or `false` to disable reasoning.
          "reasoning": { "effort": "high" },
        },
      },
    ],
  },
}
```

How the tier reaches the server:

- **Models with `capabilities.reasoning.profile`**: written in that profile's shape (see [Override reasoning capabilities](#override-reasoning-capabilities)) and limited to the declared `efforts`.
- **Known GPT-5-family model IDs**: sent as a flat `reasoning_effort`, clamped to the tiers that model supports.
- **Other models**: sent as a nested `reasoning: { effort }` object, capped at `xhigh`. Many local servers ignore this field. If yours needs a specific knob, declare a `profile` or set the field yourself in `samplingParams` or `extra_body`.

### `reasoning: false`

Setting `reasoning: false` (the literal boolean) disables thinking on models that allow it, which is useful for cheap side queries. The same opt-out is applied per request for one-off calls such as suggestion generation.

- Models with a `profile` receive that profile's disable shape (for example `thinking: { type: "disabled" }` for `deepseek-openai`).
- Models whose ID starts with `qwen` and that have no profile receive `chat_template_kwargs: { enable_thinking: false }`, which vLLM, SGLang and llama.cpp chat templates read. Servers that don't recognize the field ignore it.
- Known GPT-5-family models that allow disabling receive `reasoning_effort: "none"`.
- Set `generationConfig.thinkingMandatory: true` (or `capabilities.reasoning.canDisable: false`) for a model that rejects a disable request. The disable is then never sent.

For other servers, inject your inference framework's own switch through `samplingParams` or `extra_body`.

### Interaction with `samplingParams`

> [!warning]
>
> When `generationConfig.samplingParams` is set, its keys are sent to the server **verbatim** and the separate `reasoning` injection is skipped, except for models with explicit reasoning capabilities and known GPT-5-family IDs. So `{ samplingParams: { temperature: 0.5 }, reasoning: { effort: "max" } }` drops the reasoning field for other models. Include the server's reasoning knob in `samplingParams` directly in that case (for example `samplingParams.reasoning_effort`). A `reasoning` object you place inside `samplingParams` is your own value and ships unchanged.

## Provider Models vs Runtime Models

Qwen Code distinguishes two kinds of model configuration.

### Provider Model

- Defined in `modelProviders.openai`.
- Has a complete, atomic configuration package that is applied as an impermeable layer.
- Appears in the `/model` list with its name, description and capabilities.
- Recommended for multi-model workflows and team consistency.

### Runtime Model

- Created when you use a model ID that isn't in `modelProviders`, through CLI flags, environment variables or settings.
- Each field is resolved through the layers (CLI → env → settings → defaults).
- Captured automatically as a **RuntimeModelSnapshot** once the configuration is complete, so you can switch back to it without re-entering credentials.

```bash
# Creates a RuntimeModelSnapshot with ID: $runtime|openai|my-local-model
qwen --auth-type openai --model my-local-model \
  --openai-api-key not-needed --openai-base-url http://127.0.0.1:8080/v1
```

The snapshot captures the model ID, API key, base URL and generation config. It is kept in memory for the running session, appears in the `/model` list as a runtime option, and can be selected with `/model $runtime|openai|my-local-model`.

| Aspect                  | Provider Model                    | Runtime Model                              |
| ----------------------- | --------------------------------- | ------------------------------------------ |
| Configuration source    | `modelProviders` in settings      | CLI, env, settings layers                  |
| Configuration atomicity | Complete, impermeable package     | Layered, each field resolved independently |
| Reusability             | Always available in `/model` list | Captured as snapshot, appears if complete  |
| Team sharing            | Yes (via committed settings)      | No (user-local)                            |
| Credential storage      | Reference via `envKey` only       | May capture the actual key in the snapshot |

Use Provider Models for models you use regularly or share with a team. Use Runtime Models for quick tests of a model you haven't added yet.

## Selection persistence and recommendations

> [!important]
>
> Define `modelProviders` in the user-scope `~/.qwen/settings.json` whenever possible, and avoid storing credentials in any committed settings file. Keeping the model catalog in user settings avoids conflicts between project and user scopes and makes `/auth` and `/model` write back to a consistent scope.

- `/model` and `/auth` save `model.name` and `security.auth.selectedType` to the closest writable scope that already defines `modelProviders`; otherwise they use the user scope.
- Without `modelProviders`, every model is a Runtime Model built from CLI, env and settings layers. That's fine for a single model, but a `modelProviders` catalog keeps switches atomic and easier to debug when you use several models.
