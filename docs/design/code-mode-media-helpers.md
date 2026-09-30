# Code Mode media helpers

## Goal

Let Code Mode consume the media shapes that Qwen Code already returns from
nested MCP tool calls:

- `image(result.content[0])` accepts a Qwen MCP image content block.

## Data contract

Nested tool responses expose image media through `content` as Qwen's existing
MCP image shape:

```ts
type ImageContent = {
  type: 'image';
  data: string;
  mimeType: string;
};
```

The Core scheduler and the CLI ACP session derive these blocks through one
shared normalizer over their existing GenAI response parts. Text remains
available through `CodeModeToolResult.output`. This keeps the guest API
independent of the scheduler's internal `functionResponse` wrapper.

## Limits and validation

The helper uses the existing Code Mode media item and decoded-byte budgets.
MCP image blocks must contain base64 data and an `image/*` MIME type.

Media-bearing nested tool results use the existing 16 MiB media frame limit so
images larger than the 1 MiB control limit are preserved. Tool calls and tool
results without image content retain the 1 MiB control frame limit.

## Non-goals

- Image detail hints.
- Remote image URLs.
- `yield_control`, persistent storage, or timers.
