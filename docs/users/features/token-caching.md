# Token Caching and Cost Optimization

Caching lowers the price of the prefix every request carries. To make that prefix smaller in the first place — fewer resident tool schemas, smaller context files — see [Resident Context Cost](context-cost.md); the two compose.

Qwen Code keeps the request prefix (system instructions, tool declarations and conversation history) stable between requests, so a local model server with prefix (prompt) caching can reuse it instead of reprocessing it.

## How It Benefits You

- **Less recomputation**: Fewer prompt tokens have to be processed again
- **Faster responses**: Cached content is retrieved more quickly
- **Automatic optimization**: No configuration needed - it works behind the scenes

## Token caching is available for

- Local OpenAI-compatible servers that support prefix caching and report cached prompt tokens in their usage data

## Monitoring Your Savings

Use the `/stats` command to see your cached token savings:

- When active, the stats display shows how many tokens were served from cache
- You'll see both the absolute number and percentage of cached tokens
- Example: "10,500 (90.4%) of input tokens were served from the cache, reducing costs."

This information is only displayed when the server reports cached tokens.

## Example Stats Display

![Qwen Code Stats Display](https://img.alicdn.com/imgextra/i3/O1CN01F1yzRs1juyZu63jdS_!!6000000004609-2-tps-1038-738.png)

The above image shows an example of the `/stats` command output, highlighting the cached token savings information.
