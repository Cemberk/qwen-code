# Observability with OpenTelemetry

Learn how to enable and setup OpenTelemetry for Qwen Code. Telemetry is only
ever written to a local file (`telemetry.outfile`); Qwen Code has no network
telemetry exporter.

- [Observability with OpenTelemetry](#observability-with-opentelemetry)
  - [Key Benefits](#key-benefits)
  - [OpenTelemetry Integration](#opentelemetry-integration)
  - [Configuration](#configuration)
  - [Local Telemetry](#local-telemetry)
  - [Logs and Metrics](#logs-and-metrics)
    - [Logs](#logs)
    - [Metrics](#metrics)
    - [Spans](#spans)
    - [Resource Metrics](#resource-metrics)
    - [Performance Monitoring (Reserved)](#performance-monitoring-reserved)

## Migration Notes

- `tool_output_truncated` was renamed to `qwen-code.tool_output_truncated` for namespace consistency — downstream consumers filtering on the old name should update their queries.

- The `tool.call.latency` histogram documentation previously listed a `decision` attribute — this was never set on the histogram (only `function_name` is recorded). The `tool.call.count` counter continues to include `decision`.

- The `qwen-code.file_operation` log event and `file.operation.count` metric documentation previously listed diff-stat attributes (`model_added_lines`, `model_removed_lines`, `user_added_lines`, `user_removed_lines`) — these were never set on either. Diff-stat data is available via the `tool_call` log event's `metadata` attribute.

## Key Benefits

- **🔍 Usage Analytics**: Understand interaction patterns and feature adoption
  across your team
- **⚡ Performance Monitoring**: Track response times, token consumption, and
  resource utilization
- **🐛 Real-time Debugging**: Identify bottlenecks, failures, and error patterns
  as they occur
- **📊 Workflow Optimization**: Make informed decisions to improve
  configurations and processes
- **🔒 Local Only**: Telemetry is written to a local file and never leaves
  your machine

## OpenTelemetry Integration

Built on **[OpenTelemetry]** — the vendor-neutral, industry-standard
observability framework — Qwen Code's observability system provides:

- **Standardized Data**: Records use the OpenTelemetry data model, written as
  JSON to the local `telemetry.outfile`

[OpenTelemetry]: https://opentelemetry.io/

## Configuration

All telemetry behavior is controlled through your `.qwen/settings.json` file.
These settings can be overridden by environment variables or CLI flags.

| Setting                           | Environment Variable                                 | CLI Flag                                                 | Description                                                                                                                            | Values         | Default   |
| --------------------------------- | ---------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------- | --------- |
| `enabled`                         | `QWEN_TELEMETRY_ENABLED`                             | `--telemetry` / `--no-telemetry`                         | Enable or disable telemetry                                                                                                            | `true`/`false` | `false`   |
| `outfile`                         | `QWEN_TELEMETRY_OUTFILE`                             | `--telemetry-outfile <path>`                             | Local file telemetry is written to; nothing is recorded without it                                                                     | file path      | -         |
| `logPrompts`                      | `QWEN_TELEMETRY_LOG_PROMPTS`                         | `--telemetry-log-prompts` / `--no-telemetry-log-prompts` | Include user prompt content and API request/response text in telemetry logs                                                            | `true`/`false` | `true`    |
| `userId`                          | `QWEN_TELEMETRY_USER_ID`                             | -                                                        | Stable end-user identifier written to GenAI spans as `gen_ai.user.id`; prefer a pseudonymous value                                     | string         | -         |
| `includeSensitiveSpanAttributes`  | `QWEN_TELEMETRY_INCLUDE_SENSITIVE_SPAN_ATTRIBUTES`   | -                                                        | Include standard GenAI messages, instructions, tool definitions, tool arguments, and successful tool results as native span attributes | `true`/`false` | `false`   |
| `sensitiveSpanAttributeMaxLength` | `QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH` | -                                                        | Maximum compact JSON string length for each sensitive native span attribute.                                                           | `1..104857600` | `1048576` |
| `resourceAttributes`              | `OTEL_RESOURCE_ATTRIBUTES` (+ `OTEL_SERVICE_NAME`)   | -                                                        | Static resource attributes attached to every recorded span / log / metric. See [Resource attributes](#resource-attributes) below.      | `key=value,…`  | `{}`      |
| `metrics.includeSessionId`        | `QWEN_TELEMETRY_METRICS_INCLUDE_SESSION_ID`          | -                                                        | Include `session.id` on metric data points.                                                                                            | `true`/`false` | `false`   |

**Note on boolean environment variables:** For the boolean settings (`enabled`,
`logPrompts`, `includeSensitiveSpanAttributes`), setting the
corresponding environment variable to `true` or `1` will enable the feature. Any
other value will disable it.

**Note on integer environment variables:** `QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH`
must be a positive integer when set. Invalid values fail telemetry configuration
resolution instead of silently falling back.

`gen_ai.tool.description` is non-sensitive static registry metadata and is
emitted independently of `includeSensitiveSpanAttributes`. This includes
descriptions supplied by MCP servers and other workspace tool providers. The
value is limited to 4096 UTF-16 code units and never includes dynamic invocation
details.

**Sensitive span attributes:** When `includeSensitiveSpanAttributes` is enabled,
native span attributes carry standard OpenTelemetry GenAI JSON:

- Main-agent and LLM input messages (`gen_ai.input.messages`)
- Tool definitions (`gen_ai.tool.definitions`)
- Main-agent and LLM output messages (`gen_ai.output.messages`)
- Final executed tool arguments (`gen_ai.tool.call.arguments`)
- Successful tool results (`gen_ai.tool.call.result`)
- Interaction spans retain the compatibility `new_context` attribute.

Main-agent input is one original user-text projection before context
expansion, and main-agent output is one final user-visible answer after all
tool and continuation work settles. LLM values still come from provider-final
SDK request objects and raw provider responses, so their input can include
history, expanded files, system instructions, and tool results, and their
output can include every provider candidate. Tool values come from the final
invocation parameters and successful model-facing result. Each
standard GenAI value is compact JSON and must be complete and schema-valid.
A value that is invalid, cyclic, or longer than
`sensitiveSpanAttributeMaxLength` is omitted as a whole; JSON is never
truncated and no preview, hash, or truncation metadata is emitted. The
interaction-specific `new_context` attribute retains its existing
truncation behavior. The default maximum is 1 MiB (`1048576`) per attribute
and the accepted range is `1..104857600` (100 MiB). The limit is measured as
JavaScript string length rather than UTF-8 bytes. Non-ASCII content can
therefore occupy more bytes in the outfile.

⚠️ **Security warning:** enabling this flag writes full conversation history,
file contents read by `read_file`, shell commands and their output (including
secrets in env vars or arguments), and model responses to the telemetry
outfile. Treat the file as sensitive. The flag defaults to `false`.

This setting does not disable sensitive data in OTel logs or other telemetry
sinks; non-internal API response telemetry can populate `response_text`, so
OTel logs, UI telemetry, and chat recording may receive response text
independently of this setting.

**End-user identity:** `telemetry.userId` and
`QWEN_TELEMETRY_USER_ID` are explicit opt-ins for the span attribute
`gen_ai.user.id`. The environment variable takes precedence after both values
are trimmed; a blank environment value falls back to settings. The identifier
is written only to interaction, LLM, Tool, and Agent spans. It is not a Resource
attribute, log or metric attribute, outbound Baggage value, or current
OpenTelemetry GenAI standard field. Prefer a stable pseudonymous identifier.
The value is resolved at startup, so configuration changes require a restart.

For detailed information about all configuration options, see the
[Configuration Guide](../../users/configuration/settings.md).

### Resource attributes

Resource attributes are static key-value pairs attached to every span, log,
and metric written to the telemetry outfile. Use them to slice telemetry by
team, environment, or any other dimension you care about.

Two sources, merged in priority order (lowest → highest):

1. The standard `OTEL_RESOURCE_ATTRIBUTES` env var
2. `telemetry.resourceAttributes` in `.qwen/settings.json` (overrides env on
   key conflict)

`OTEL_SERVICE_NAME` is a separate escape hatch — when set, it overrides
`service.name` from any other source (per the OpenTelemetry spec).

#### Examples

**Slice all telemetry by team / environment:**

```bash
export OTEL_RESOURCE_ATTRIBUTES="team=platform,env=prod,cost_center=eng-123"
```

**Set a custom `service.name`:**

```bash
export OTEL_SERVICE_NAME=qwen-code-ci
```

**Fleet baseline (`~/.qwen/settings.json`) + per-host override:**

```json
{
  "telemetry": {
    "resourceAttributes": {
      "deployment.environment": "production",
      "service.namespace": "engineering-tooling"
    }
  }
}
```

```bash
# Add a one-off tag without touching settings:
export OTEL_RESOURCE_ATTRIBUTES="debug_run=true"
```

#### Reserved keys

Some keys are runtime-controlled and cannot be overridden:

- `service.version` — always set to the running CLI version. Setting it from
  any source is silently dropped with a warning.
- `session.id` — runtime-injected per session. User-provided values from
  either env or settings are dropped with a warning. The reason is that
  Resource attributes auto-attach to every metric data point; allowing user
  override would bypass [Cardinality controls](#cardinality-controls) below.
  Spans and logs always carry `session.id`.

`service.name` is **not** reserved; it follows the precedence chain above.

#### Format

`OTEL_RESOURCE_ATTRIBUTES` follows the OpenTelemetry spec:
`key1=value1,key2=value2` with values percent-encoded. Spaces in values must
be encoded as `%20`, **commas as `%2C`** (unencoded commas split the value at
the wrong boundary and the second half is dropped as malformed). Malformed
pairs are skipped with a warning rather than failing telemetry startup.

#### Troubleshooting: when a user-provided attribute appears not to take effect

Reserved keys (`service.version`, `session.id`), malformed pairs, non-string
settings values, and invalid percent-encoding are all silently dropped with a
warning logged via the OpenTelemetry diagnostics channel. That channel routes
to the debug log file (`~/.qwen/log/otel-*.log`), **not** the console, so the
behavior can look like silent failure.

If a custom resource attribute isn't appearing on exported telemetry:

1. Check `~/.qwen/log/otel-*.log` for lines matching `cannot override` (reserved
   key dropped), `Skipping malformed` (bad env var pair), or `must be a string`
   (non-string settings value).
2. Verify the env var is set in the qwen-code process's environment (not just
   your shell) and that values are percent-encoded.
3. Confirm `telemetry.enabled` is `true` — telemetry init only runs if enabled.

### Cardinality controls

Metrics are aggregated by attribute set at the backend — every distinct
combination of attribute values produces a new time series. Attaching a
high-cardinality field like `session.id` to a metric causes time-series fan-out
proportional to the number of sessions, which quickly exhausts metric backend
storage.

To prevent this, Qwen Code keeps high-cardinality attributes off metric data
points by default. Spans and logs are per-event and unaffected, so they
continue to carry `session.id` for trace and log correlation.

#### `telemetry.metrics.includeSessionId` (default: `false`)

Setting this to `true` (via settings or
`QWEN_TELEMETRY_METRICS_INCLUDE_SESSION_ID=true`) re-attaches `session.id` to
every metric data point.

⚠️ **Warning:** each CLI session creates a new value. Leaving this on for a
fleet will blow up metric storage. Recommended only for short-term debugging.
For long-term session correlation, query trace or log backends instead.

#### Migration from earlier versions

Prior to this release, `session.id` was attached to metrics by default. If
your Prometheus queries / Grafana dashboards / alert rules reference
`session_id` on a metric, you have two options:

**Option A** — restore the previous behavior for short-term debugging:

```bash
export QWEN_TELEMETRY_METRICS_INCLUDE_SESSION_ID=true
```

or:

```json
{
  "telemetry": {
    "metrics": { "includeSessionId": true }
  }
}
```

**Option B (recommended)** — move session-level analysis off metrics. Spans
and logs still carry `session.id`.

### Client-side HTTP span on outbound fetch

When telemetry is enabled, Qwen Code registers `UndiciInstrumentation`
which creates a client-side HTTP span for every outbound `fetch()`
request originated by the process — including the `openai` SDK used for
model requests. The span
lets you see network latency (TTFB / response body transfer) separately
from upstream model processing time, which the existing
`api.generateContent` span alone can't distinguish.

These spans go to the telemetry outfile just like the rest of the
telemetry — they do not affect what is written onto the outbound HTTP
request itself. Qwen Code installs a no-op `TextMapPropagator`, so no
`traceparent` header is ever written onto outbound requests.

## Local Telemetry

To capture telemetry data locally:

1. Enable telemetry in your `.qwen/settings.json`:

   ```json
   {
     "telemetry": {
       "enabled": true,
       "outfile": ".qwen/telemetry.log"
     }
   }
   ```

2. Run Qwen Code and send prompts.
3. View logs and metrics in the specified file (e.g., `.qwen/telemetry.log`).

## Logs and Metrics

The following section describes the structure of logs, metrics, and spans
generated for Qwen Code.

- A `sessionId` is included as a common attribute on all logs and metrics.

### Logs

Logs are timestamped records of specific events. All log records automatically include `event.name` and `event.timestamp` attributes.

The following events are logged:

#### Core Session Events

- `qwen-code.config`: Emitted once at startup with CLI configuration.
  - **Attributes**: `model`, `sandbox_enabled`, `core_tools_enabled`, `approval_mode`, `file_filtering_respect_git_ignore`, `debug_mode`, `truncate_tool_output_threshold`, `truncate_tool_output_lines`, `hooks` (comma-separated, omitted if disabled), `ide_enabled`, `interactive_shell_enabled`, `mcp_servers`, `mcp_servers_count`, `mcp_tools`, `mcp_tools_count`, `output_format`, `skills`, `subagents`

- `session.start`: A session begins. Emitted after telemetry initialization at startup and again on every session switch; lifecycle semantics are described in the Spans section.
  - **Attributes**: `session.id` (string), `session.previous_id` (string, present only when this start continues a persisted conversation under a new session id)

- `session.end`: A session ends. Emitted before a session switch replaces the current session, and at telemetry shutdown.
  - **Attributes**: `session.id` (string)

- `qwen-code.user_prompt`: User submits a prompt.
  - **Attributes**: `prompt_length` (int), `prompt_id` (string), `prompt` (string, excluded if `log_prompts_enabled` is false), `auth_type` (string)

- `qwen-code.user_retry`: User retries the last prompt.
  - **Attributes**: `prompt_id` (string)

- `qwen-code.conversation_finished`: A conversation turn sequence completes.
  - **Attributes**: `approvalMode` (string), `turnCount` (int)

#### Tool Events

- `qwen-code.tool_call`: Each function/tool call. Terminal events are normalized so `status` is authoritative: success and cancelled events omit error fields, while error events always have a non-empty `error_type` (`unknown` when the producer did not classify the error). Blank tool names are emitted as `unknown_tool`. A missing `execution_status` is normalized to `unknown` and is never inferred from the terminal `status`.
  - **Attributes**: `function_name` (string), `function_args` (object), `call_id` (string, optional), `duration_ms` (int), `started_at_ms` (int, optional — epoch ms at which `duration_ms` started counting, including any approval wait; absent when the call never ran), `status` (string: "success", "error", or "cancelled"), `execution_status` (string: "not_started", "success", "error", "cancelled", or "unknown"), `success` (boolean), `decision` (string: "accept", "reject", "auto_accept", or "modify", optional), `error` (string, optional), `error_type` (string, present for error events), `prompt_id` (string), `response_id` (string, optional), `content_length` (int, optional), `tool_type` (string: "native" or "mcp"), `mcp_server_name` (string, optional), `metadata` (object, optional — for file-writing tools contains `model_added_lines`, `model_removed_lines`, `user_added_lines`, `user_removed_lines`, `model_added_chars`, `model_removed_chars`, `user_added_chars`, `user_removed_chars`)

- `qwen-code.file_operation`: Each file operation.
  - **Attributes**: `tool_name` (string), `operation` (string: "create", "read", "update"), `lines` (int, optional), `mimetype` (string, optional), `extension` (string, optional), `programming_language` (string, optional)

- `qwen-code.tool_output_truncated`: Tool output exceeded size threshold.
  - **Attributes**: `tool_name` (string), `original_content_length` (int), `truncated_content_length` (int), `threshold` (int), `lines` (int), `prompt_id` (string)

#### API Events

- `qwen-code.api_request`: Outgoing request to the LLM API.
  - **Attributes**: `model` (string), `prompt_id` (string), `request_text` (string, optional — contains request content only when `log_prompts_enabled` is true; log-to-span bridge spans additionally require `includeSensitiveSpanAttributes`; opaque `thoughtSignature` provider payload is included, with its policy decision tracked in #11682), `subagent_name` (string, optional)

- `qwen-code.api_response`: Response received from LLM API.
  - **Attributes**: `response_id` (string), `model` (string), `status_code` (int/string, optional), `duration_ms` (int), `input_token_count` (int), `output_token_count` (int), `cached_content_token_count` (int), `thoughts_token_count` (int), `total_token_count` (int), `prompt_id` (string), `auth_type` (string, optional), `response_text` (string, optional — contains visible response content only when `log_prompts_enabled` is true; log-to-span bridge spans additionally require `includeSensitiveSpanAttributes`; it carries no content for internal prompt ids or responses with no visible text), `subagent_name` (string, optional)

- `qwen-code.api_error`: API request failed.
  - **Attributes**: `model` (string), `prompt_id` (string), `duration_ms` (int), `error_message` (string), `response_id` (string, optional), `auth_type` (string, optional), `error_type` (string, optional), `status_code` (int/string, optional), `subagent_name` (string, optional)

  Additionally, OTel-standard aliases (`http.status_code`, `error.message`, `model_name`, `duration`) are emitted for compatibility.

- `qwen-code.api_cancel`: API request cancelled by user.
  - **Attributes**: `model` (string), `prompt_id` (string), `auth_type` (string, optional), `loop_wakeups_cancelled` (int, optional)

- `qwen-code.api_retry`: HTTP-status retry (429/5xx) at an LLM call site. Distinct from `chat.content_retry` which handles `InvalidStreamError` retries on a separate budget.
  - **Attributes**: `model` (string), `prompt_id` (string, optional), `attempt_number` (int), `error_type` (string, optional), `error_message` (string), `status_code` (int/string, optional), `retry_delay_ms` (int), `duration_ms` (int, equals retry_delay_ms — backoff sleep, not HTTP round-trip; for attempt duration see the qwen-code.llm_request span), `subagent_name` (string, optional)

- `qwen-code.malformed_json_response`: `generateJson` response couldn't be parsed.
  - **Attributes**: `model` (string)

- `qwen-code.flash_fallback`: Switched to flash model as fallback.
  - **Attributes**: `auth_type` (string)

- `qwen-code.ripgrep_fallback`: Switched to grep as fallback.
  - **Attributes**: `use_ripgrep` (boolean), `use_builtin_ripgrep` (boolean), `error` (string, optional)

#### Resilience Events

- `qwen-code.chat.content_retry`: Content-error retry (e.g. empty stream).
  - **Attributes**: `attempt_number` (int), `error_type` (string), `retry_delay_ms` (int), `model` (string)

- `qwen-code.chat.content_retry_failure`: All content retries exhausted.
  - **Attributes**: `total_attempts` (int), `final_error_type` (string), `total_duration_ms` (int, optional), `model` (string)

- `qwen-code.chat.invalid_chunk`: Invalid chunk received from stream.
  - **Attributes**: `error.message` (string, optional)

#### Command Events

- `qwen-code.slash_command`: User executes a slash command.
  - **Attributes**: `command` (string), `subcommand` (string, optional), `status` (string: "success" or "error", optional)

- `qwen-code.slash_command.model`: User switches model via `/model` command.
  - **Attributes**: `model_name` (string)

- `qwen-code.skill_launch`: A skill is launched.
  - **Attributes**: `skill_name` (string), `success` (boolean), `prompt_id` (string)

- `qwen-code.auth`: Authentication event.
  - **Attributes**: `auth_type` (string), `action_type` ("auto", "manual"), `status` ("success", "error", "cancelled"), `error_message` (optional)

#### Subagent Events

- `qwen-code.subagent_execution`: Subagent lifecycle event.
  - **Attributes**: `subagent_name` (string), `status` ("started", "completed", "failed", "cancelled"), `terminate_reason` (optional), `result` (optional), `execution_summary` (optional)

#### Goal Events

- `qwen-code.goal_state`: A reported Goal runtime transition, not one event per transcript record. Emitted for `create`, `replace`, `edit`, `pause`, `resume`, `clear`, `complete`, `blocked`, `usage_limited`, and `verifier_reject`. Per-turn `turn_finished` and `checkpoint` are not reported, and neither is the state a resumed session recovers from its transcript. A checkpoint check following a verifier rejection may be journaled as `verifier_reject` while broadcasting the excluded `checkpoint` cause; only the rejection transition is reported. The objective, the stop reason, and checkpoint failure text are never included in this event, whatever `telemetry.logPrompts` is set to. Tool-call events can still carry objectives and model-authored reasons in `function_args`.
  - **Scope**: `replace` describes the successor Goal and does not settle the outgoing Goal. `pause` includes both user and automatic no-progress pauses. `no_progress_turns` carries the raw consecutive no-progress count when available; it does not classify the stop or add a metric dimension. Outcome histograms include only `complete`, `blocked`, and `usage_limited`; they do not measure the final spend of every removed or paused Goal.
  - **Attributes**: `cause` (string), `goal_id` (string), `revision` (int), `status` ("active", "paused", "blocked", "usage_limited", "complete"; absent on `clear`), `limit_kind` ("evidence_catalog", "checkpoint_request", "token_budget", "turn_budget", "time_budget"; optional; the first two are no longer produced and can appear only on a Goal an earlier build stopped, since the verifier reads the transcript tail and no evidence checkpoint runs), `turn_count` (int, optional), `tokens_used` (int, optional; legacy transcripts without spend tracking restore this as 0, not as an absent value), `no_progress_turns` (int, optional), `token_budget` (int, optional), `turn_budget` (int, optional), `active_time_ms` (int, optional), `active_time_budget_ms` (int, optional), `objective_length` (int, optional; code points)

#### Arena Events

- `qwen-code.arena_session_started`: Arena session begins.
  - **Attributes**: `arena_session_id` (string), `model_ids` (JSON string array), `task_length` (int)

- `qwen-code.arena_agent_completed`: An arena agent finishes.
  - **Attributes**: `arena_session_id` (string), `agent_session_id` (string), `agent_model_id` (string), `status` (string: "completed"/"failed"/"cancelled"), `duration_ms` (int), `rounds` (int), `total_tokens` (int), `input_tokens` (int), `output_tokens` (int), `tool_calls` (int), `successful_tool_calls` (int), `failed_tool_calls` (int)

- `qwen-code.arena_session_ended`: Arena session completes.
  - **Attributes**: `arena_session_id` (string), `status` (string: "selected"/"discarded"/"failed"/"cancelled"), `duration_ms` (int), `display_backend` (string, optional), `agent_count` (int), `completed_agents` (int), `failed_agents` (int), `cancelled_agents` (int), `winner_model_id` (string, optional)

#### Workflow Events

- `qwen-code.workflow_keyword`: Workflow keyword trigger fired.

- `qwen-code.workflow_run`: Workflow run reached terminal state.
  - **Attributes**: `status` (string), `agents_dispatched` (int), `agents_completed` (int, all settled dispatches), `agents_failed` (int, settled dispatches with failed status), `agents_cached` (int, settled dispatches served from a prior run), `agents_respawned` (int, dispatched calls re-run after a prior failed or interrupted attempt), `phase_count` (int), `tokens_spent` (int), `duration_ms` (int). `agents_failed` and `agents_cached` are subsets of `agents_completed`, while `agents_respawned` describes provenance and is not an additional outcome count.

- `qwen-code.workflow_size_warning`: A running workflow crossed its large-run threshold; emitted at most once per run.
  - **Attributes**: `axis` (string: "agents"/"tokens", the threshold crossed first), `scheduled_agents` (int, dispatches excluding journal replays), `total_tokens` (int), `projected_tokens` (int), `agent_cap` (int), `token_cap` (int), `cap_from_guideline` (boolean, whether the agent threshold came from `tools.workflowSizeGuideline`)

#### Auto-Memory Events

- `qwen-code.memory.extract`: Memory extraction run completed.
  - **Attributes**: `trigger` ("auto"/"manual"), `status` ("completed"/"skipped"/"failed"), `skipped_reason` (optional), `patches_count` (int), `touched_topics` (string), `duration_ms` (int)

- `qwen-code.memory.dream`: Memory consolidation (dream) run completed.
  - **Attributes**: `trigger` ("auto"/"manual"), `status` ("updated"/"noop"/"failed"/"cancelled"), `deduped_entries` (int), `touched_topics_count` (int), `touched_topics` (string), `duration_ms` (int)

- `qwen-code.memory.recall`: Memory recall operation completed.
  - **Attributes**: `query_length` (int), `docs_scanned` (int), `docs_selected` (int), `strategy` ("none"/"heuristic"/"model"), `duration_ms` (int)

#### Prompt Suggestion & Speculation Events

- `qwen-code.prompt_suggestion`: Prompt suggestion outcome.
  - **Attributes**: `outcome` ("accepted"/"ignored"/"suppressed"), `prompt_id` (optional), `accept_method` ("tab"/"enter"/"right", optional), `accept_source` ("live"/"fallback", optional), `time_to_accept_ms` (optional), `time_to_ignore_ms` (optional), `time_to_first_keystroke_ms` (optional), `suggestion_length` (optional), `similarity` (optional), `was_focused_when_shown` (optional), `reason` (optional)

- `qwen-code.speculation`: Speculative execution outcome.
  - **Attributes**: `outcome` ("accepted"/"aborted"/"failed"), `turns_used` (int), `files_written` (int), `tool_use_count` (int), `duration_ms` (int), `boundary_type` (optional), `had_pipelined_suggestion` (boolean)

#### Other Events

- `qwen-code.chat_compression`: Chat context compressed.
  - **Attributes**: `tokens_before` (int), `tokens_after` (int), `compression_input_token_count` (int, optional), `compression_output_token_count` (int, optional)

- `qwen-code.next_speaker_check`: Next speaker determination.
  - **Attributes**: `prompt_id` (string), `finish_reason` (string), `result` (string)

- `loop_detected`: Loop detected during agent execution. _(Note: emitted without `qwen-code.` prefix — pre-existing inconsistency.)_
  - **Attributes**: `loop_type` (string), `prompt_id` (string)

- `kitty_sequence_overflow`: Kitty graphics protocol sequence exceeded buffer size. _(Note: emitted without `qwen-code.` prefix — pre-existing inconsistency.)_
  - **Attributes**: `sequence_length` (int), `truncated_sequence` (string, first 20 chars)

### Metrics

Metrics are numerical measurements of behavior over time. Metric names use the `qwen-code.*` prefix.

#### Core Metrics

- `qwen-code.session.count` (Counter, Int): Incremented once per CLI startup.

- `qwen-code.tool.call.count` (Counter, Int): Counts tool calls.
  - **Attributes**: `function_name`, `status` ("success"/"error"/"cancelled"), `success` (boolean, retained for compatibility), `decision` ("accept"/"reject"/"auto_accept"/"modify", optional), `tool_type` ("mcp"/"native", optional)

- `qwen-code.tool.execution.count` (Counter, Int): Counts tool execution outcomes. Deliberately carries no `function_name` dimension to stay low-cardinality, so an execution-failure rate cannot be attributed to a specific tool without dropping to the `qwen-code.tool_call` logs; exclude `unknown`, `not_started`, and `cancelled` when computing execution-failure ratios (denominator is `success` + `error`).
  - **Attributes**: `execution_status` ("not_started"/"success"/"error"/"cancelled"/"unknown"), `tool_type` ("mcp"/"native"), plus globally configured common metric attributes such as the opt-in `session.id`

- `qwen-code.tool.call.latency` (Histogram, ms): Measures tool call latency.
  - **Attributes**: `function_name` (string)

- `qwen-code.api.request.count` (Counter, Int): Counts all API requests.
  - **Attributes**: `model`, `status_code`, `error_type` (optional)

- `qwen-code.api.request.latency` (Histogram, ms): Measures API request latency.
  - **Attributes**: `model` (string)

- `qwen-code.token.usage` (Counter, Int): Counts tokens used.
  - **Attributes**: `model`, `type` ("input"/"output"/"thought"/"cache")

- `qwen-code.file.operation.count` (Counter, Int): Counts file operations.
  - **Attributes**: `operation` ("create"/"read"/"update"), `lines` (optional), `mimetype` (optional), `extension` (optional), `programming_language` (optional)

- `qwen-code.chat_compression` (Counter, Int): Counts chat compression operations.
  - **Attributes**: `tokens_before` (int), `tokens_after` (int)

- `qwen-code.slash_command.model.call_count` (Counter, Int): Counts model slash command calls.
  - **Attributes**: `slash_command.model.model_name` (string)

- `qwen-code.subagent.execution.count` (Counter, Int): Counts subagent execution events.
  - **Attributes**: `subagent_name`, `status` ("started"/"completed"/"failed"/"cancelled"), `terminate_reason` (optional)

#### Resilience Metrics

- `qwen-code.api.retry.count` (Counter, Int): HTTP-status retries (429/5xx) at LLM call sites.
  - **Attributes**: `model` (string)

- `qwen-code.chat.content_retry.count` (Counter, Int): Retries due to content errors.

- `qwen-code.chat.content_retry_failure.count` (Counter, Int): All content retries exhausted.

- `qwen-code.chat.invalid_chunk.count` (Counter, Int): Invalid chunks from stream.

#### Goal Metrics

- `qwen-code.goal.transition.count` (Counter, Int): Goal state transitions, one per `qwen-code.goal_state` event.
  - **Attributes**: `cause`, `status` (optional), `limit_kind` (optional)

- `qwen-code.goal.tokens_used` (Histogram, `{token}`): Cumulative tokens spent at each completion, blocking, or usage-limit stop. Legacy transcripts without spend tracking restore an initial spend of 0; unknown prior spend is not distinguishable from measured zero.
  - **Attributes**: `cause` ("complete", "blocked", "usage_limited"), `limit_kind` (optional)

- `qwen-code.goal.turn_count` (Histogram, `{turn}`): Cumulative turns finished at each of the same three stops.
  - **Attributes**: `cause` ("complete", "blocked", "usage_limited"), `limit_kind` (optional)

A resumed Goal can contribute multiple stop observations, each containing its lifetime cumulative meters. Histogram `_count` counts stops, not distinct Goals, and `_sum` is not total Goal spend. Token buckets extend through 600 million and turn buckets through 50,000 to distinguish larger resumed runs. Values above those finite boundaries share the `+Inf` bucket; observation count and sum still retain those values.

#### Arena Metrics

- `qwen-code.arena.session.count` (Counter, Int): Arena sessions by status.
  - **Attributes**: `status`, `display_backend` (optional)

- `qwen-code.arena.session.duration` (Histogram, ms): Arena session duration.
  - **Attributes**: `status`

- `qwen-code.arena.agent.count` (Counter, Int): Arena agent completions.
  - **Attributes**: `status`, `model_id`

- `qwen-code.arena.agent.duration` (Histogram, ms): Arena agent execution duration.
  - **Attributes**: `model_id`

- `qwen-code.arena.agent.tokens` (Counter, Int): Token usage by arena agents.
  - **Attributes**: `model_id`, `type` ("input"/"output")

- `qwen-code.arena.result.selected` (Counter, Int): Arena result selections.
  - **Attributes**: `model_id`

#### Auto-Memory Metrics

- `qwen-code.memory.extract.count` (Counter, Int): Auto-memory extraction runs.
  - **Attributes**: `trigger` ("auto"/"manual"), `status`

- `qwen-code.memory.extract.duration` (Histogram, ms): Extraction duration.
  - **Attributes**: `trigger`, `status`

- `qwen-code.memory.dream.count` (Counter, Int): Auto-memory dream runs.
  - **Attributes**: `trigger` ("auto"/"manual"), `status`

- `qwen-code.memory.dream.duration` (Histogram, ms): Dream run duration.
  - **Attributes**: `trigger`, `status`

- `qwen-code.memory.recall.count` (Counter, Int): Auto-memory recall operations.
  - **Attributes**: `strategy` ("none"/"heuristic"/"model")

- `qwen-code.memory.recall.duration` (Histogram, ms): Recall duration.
  - **Attributes**: `strategy`

#### API Request Breakdown

- `qwen-code.api.request.breakdown` (Histogram, ms): API request time breakdown by phase.
  - **Attributes**: `model`, `phase` ("request_preparation"/"network_latency"/"response_processing"/"token_processing")

### Spans

Distributed tracing spans form a tree rooted at `qwen-code.interaction`. In the CLI, each interaction is a trace root with its own `traceId`. Cross-prompt correlation uses the `session.id` attribute.

Session lifecycle is also exported through the OpenTelemetry General Session
semantic conventions. When the OTel logs pipeline is enabled, Qwen Code emits
`session.start` and `session.end` log events with the required `session.id`
attribute (cataloged under Core Session Events above). A resumed persisted
conversation includes `session.previous_id` on its `session.start` event only
when the resumed session id differs from the current one; cold-start
resumptions (`--resume`, `--continue`, `--fork-session`) do not carry it.
`/clear` and other replacement flows intentionally do not claim continuation
because they discard the previous conversation.

The existing Qwen-specific `qwen-code.config`/`cli_config` record remains
available for compatibility. GenAI request
spans continue to use `gen_ai.conversation.id` for the same owning session ID.

- `qwen-code.interaction`: Main-agent invocation span. It covers all LLM requests, tool approval/execution, and continuations for one logical prompt. User queries, retries, cron prompts, notifications, teammate messages, and Goal turns create invocations; tool results, hooks, and steering reuse the exact active prompt ID.
  - **GenAI attributes**: `gen_ai.operation.name` (`invoke_agent`), `gen_ai.agent.name` (`qwen-code`), `gen_ai.conversation.id`, optional `gen_ai.output.type` (`json` only with a configured JSON Schema), sensitive `gen_ai.input.messages`, sensitive `gen_ai.output.messages`, and optional ARMS extension `gen_ai.user.id`
  - **Compatibility attributes**: `session.id`, `qwen-code.prompt_id`, `qwen-code.message_type`, `qwen-code.model`, `qwen-code.approval_mode`, `interaction.sequence`, `interaction.duration_ms`, `qwen-code.turn_status` ("ok"/"error"/"cancelled")
  - `gen_ai.request.model` is intentionally omitted because the agent supports overrides, fallback, and dynamic model selection. `gen_ai.provider.name` and agent ID/version/description are also omitted.
  - Agent input is one original user prompt, not the expanded model request. Agent output is one final user-visible text projection; structured JSON uses compact JSON text with `finish_reason=tool_call`. Both are omitted unless sensitive span attributes are enabled and the complete JSON fits the per-attribute limit.

- `qwen-code.llm_request`: Wraps a single LLM API call.
  - **GenAI attributes**: `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.conversation.id`, optional ARMS extension `gen_ai.user.id`, `gen_ai.request.model`, `gen_ai.request.stream`, `gen_ai.request.choice.count`, `gen_ai.request.max_tokens`, `gen_ai.request.temperature`, `gen_ai.request.top_p`, `gen_ai.request.frequency_penalty`, `gen_ai.request.presence_penalty`, `gen_ai.request.stop_sequences`, optional `gen_ai.output.type`, `gen_ai.response.id`, `gen_ai.response.model`, `gen_ai.response.finish_reasons`, `gen_ai.response.time_to_first_chunk`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens`
  - **Compatibility attributes**: `session.id`, `qwen-code.prompt_id`, `llm_request.context` ("subagent"/"interaction"/"standalone"), `duration_ms`, `ttft_ms`, `request_setup_ms`, `attempt`, `retry_total_delay_ms`, `sampling_ms`, `output_tokens_per_second`, `success`, `error`, `finish_reason`, `thoughts_token_count`, `subagent_name`, `error_type`, `error_status_code`
  - Standard response fields come from the provider response. Standard token fields are emitted only for provider-reported non-negative safe integers. If the provider reports only a total token count, input/output usage is omitted rather than estimated.
  - Standard request-parameter fields come from the first provider-final SDK request object after adapter defaults, overrides, unsupported-field removal, and output-window clamps. Qwen Code does not infer SDK or server defaults.
  - Streaming requests emit `gen_ai.request.stream=true`. `gen_ai.response.time_to_first_chunk` measures seconds from the provider call to the first normalized response yielded by the provider adapter, which may differ from the first raw network frame. Non-streaming requests omit both standard streaming attributes because an absent `gen_ai.request.stream` means non-streaming in the semantic convention.

- `qwen-code.tool`: Wraps the full tool lifecycle (approval wait + execution).
  - **Attributes**: `session.id`, optional ARMS extension `gen_ai.user.id`, `gen_ai.operation.name` (`execute_tool`), optional inherited `gen_ai.agent.name`, `gen_ai.tool.name`, `gen_ai.tool.type` (`function`), `gen_ai.tool.call.id`, `tool.call_id`, `duration_ms`, `success`, `error`, `error.type` on failure, `tool.failure_kind` (string, optional — the specific failure reason, e.g. "cancelled", "tool_error", "tool_exception", "timeout", "permission_denied", "pre_hook_blocked")

- `qwen-code.tool.execution`: Wraps the tool execution phase (after approval). Emitted only for attempted executions.
  - **Attributes**: `session.id`, `gen_ai.tool.name` (optional), `tool.call_id` (optional), `duration_ms`, `success`, `error`, `execution_status` ("success"/"error"/"cancelled"), `error_type`, `error.type`

- `qwen-code.tool.blocked_on_user`: Time a tool spends waiting on user approval.
  - **Attributes**: `session.id`, `tool.name`, `tool.call_id`, `duration_ms`, `decision` ("proceed_once"/"proceed_always"/"cancel"/"aborted"/"auto_approved"/"error"), `source` ("cli"/"hook"/"auto"/"system")

- `qwen-code.hook`: Wraps each pre/post-tool-use hook fire site.
  - **Attributes**: `session.id`, `hook_event` ("PreToolUse"/"PostToolUse"/"PostToolUseFailure"/"PostToolBatch"), `tool.name`, `tool.use_id` (optional), `is_interrupt` (boolean, optional), `duration_ms`, `success`, `should_proceed` (optional), `should_stop` (optional), `block_type` (optional), `error` (optional)

- `qwen-code.subagent`: Wraps a single subagent invocation.
  - **Attributes**: `gen_ai.operation.name` (`invoke_agent`), `gen_ai.agent.name`, `gen_ai.agent.description`, `gen_ai.conversation.id`, optional ARMS extension `gen_ai.user.id`, optional `gen_ai.request.model`, `qwen-code.subagent.id`, `qwen-code.subagent.name`, `qwen-code.subagent.invocation_kind` ("foreground"/"fork"/"background"), `qwen-code.subagent.is_built_in`, `qwen-code.subagent.depth`, `qwen-code.subagent.status`, `qwen-code.subagent.terminate_reason`, `qwen-code.subagent.duration_ms`

Successful and cancelled GenAI spans leave `SpanStatus` as `UNSET`. Failures set `ERROR`, a bounded status description, and low-cardinality `error.type`.

#### GenAI field migration

LLM spans now use standard `gen_ai.request.*`, `gen_ai.response.*`, and `gen_ai.usage.*` fields without exact-equivalent private aliases. Request sampling attributes are written only under their standard names; no bare `temperature`, `top_p`, `max_tokens`, penalty, choice-count, or stop-sequence aliases are emitted. Tool spans similarly use `gen_ai.tool.name` without `tool.name`; blocked-on-user and hook spans keep `tool.name` because they are not GenAI Tool spans. The invalid aliases `gen_ai.usage.cached_tokens`, `gen_ai.server.time_to_first_token`, and `gen_ai.usage.reasoning_tokens` are no longer emitted. Use `gen_ai.usage.cache_read.input_tokens` for provider-reported cache reads and `gen_ai.response.time_to_first_chunk` for standard streaming latency. The private `ttft_ms` Span attribute remains available for first-user-visible-output latency and continues driving `/stats`, `sampling_ms`, and output-token throughput; `gen_ai.response.time_to_first_chunk` is an independent standard attribute measuring first normalized chunk latency. The full version-pinned contract and deferred fields are documented in [GenAI and ARMS field alignment](../../design/gen-ai-arms-field-alignment.md).

#### Resource Metrics

- `qwen-code.memory.usage` (Histogram, bytes): Memory usage. Recorded by the memory-pressure monitor when telemetry is enabled.
  - **Attributes**: `memory_type` (string: "heap_used"/"rss")

- `qwen-code.cpu.usage` (Histogram, percent): CPU usage percentage. Recorded by the memory-pressure monitor when telemetry is enabled.
  - **Attributes**: (none)

### Performance Monitoring (Reserved)

The following metrics are defined but **not yet enabled in production**. They will be activated behind a dedicated performance monitoring config flag.

- `qwen-code.startup.duration` (Histogram, ms): CLI startup time by phase.
  - **Attributes**: `phase` (string)

- `qwen-code.tool.queue.depth` (Histogram, count): Tools in execution queue.

- `qwen-code.tool.execution.breakdown` (Histogram, ms): Tool execution time by phase.
  - **Attributes**: `function_name`, `phase` ("validation"/"preparation"/"execution"/"result_processing")

- `qwen-code.token.efficiency` (Histogram, ratio): Token efficiency metrics.
  - **Attributes**: `model`, `metric`, `context` (optional)

- `qwen-code.performance.score` (Histogram, score): Composite performance score (0-100).
  - **Attributes**: `category`, `baseline` (optional)

- `qwen-code.performance.regression` (Counter, Int): Regression detection events.
  - **Attributes**: `metric`, `severity` ("low"/"medium"/"high"), `current_value`, `baseline_value`

- `qwen-code.performance.regression.percentage_change` (Histogram, percent): Percentage change vs baseline.
  - **Attributes**: `metric`, `severity`, `current_value`, `baseline_value`

- `qwen-code.performance.baseline.comparison` (Histogram, percent): Performance vs baseline.
  - **Attributes**: `metric`, `category`, `current_value`, `baseline_value`
