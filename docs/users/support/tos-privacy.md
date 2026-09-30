# Qwen Code: Terms of Service and Privacy Notice

Qwen Code is an open-source AI coding assistant tool maintained by the Qwen Code team. This document outlines the terms of service and privacy policies that apply when using Qwen Code's authentication methods and AI model services.

## How to determine your authentication method

Qwen Code supports four authentication methods to access AI models. Your authentication method determines which terms of service and privacy policies apply to your usage:

1. **Qwen OAuth** — Log in with your qwen.ai account (free tier discontinued 2026-04-15)
2. **Alibaba Cloud Coding Plan** — Use an API key from Alibaba Cloud
3. **API Key** — Bring your own API key
4. **Vertex AI** — Use Google Cloud Vertex AI

For each authentication method, different Terms of Service and Privacy Notices may apply depending on the underlying service provider.

| Authentication Method     | Provider          | Terms of Service                                                   | Privacy Notice                                                     |
| :------------------------ | :---------------- | :----------------------------------------------------------------- | :----------------------------------------------------------------- |
| Qwen OAuth                | Qwen AI           | [Qwen Terms of Service](https://qwen.ai/termsservice)              | [Qwen Privacy Policy](https://qwen.ai/privacypolicy)               |
| Alibaba Cloud Coding Plan | Alibaba Cloud     | See [details below](#2-if-you-are-using-alibaba-cloud-coding-plan) | See [details below](#2-if-you-are-using-alibaba-cloud-coding-plan) |
| API Key                   | Various Providers | Depends on your chosen API provider (OpenAI, Anthropic, etc.)      | Depends on your chosen API provider                                |
| Vertex AI                 | Google Cloud      | [Google Cloud Terms](https://cloud.google.com/terms)               | [Google Cloud Privacy](https://cloud.google.com/privacy)           |

## 1. If you are using Qwen OAuth Authentication

When you authenticate using your qwen.ai account, these Terms of Service and Privacy Notice documents apply:

- **Terms of Service:** Your use is governed by the [Qwen Terms of Service](https://qwen.ai/termsservice).
- **Privacy Notice:** The collection and use of your data is described in the [Qwen Privacy Policy](https://qwen.ai/privacypolicy).

For details about authentication setup, quotas, and supported features, see [Authentication Setup](../configuration/settings).

## 2. If you are using Alibaba Cloud Coding Plan

When you authenticate using an API key from Alibaba Cloud, the applicable Terms of Service and Privacy Notice from Alibaba Cloud apply.

Alibaba Cloud Coding Plan is available in two regions:

- **阿里云百炼 (aliyun.com)** — [bailian.console.aliyun.com](https://bailian.console.aliyun.com)
- **Alibaba Cloud (alibabacloud.com)** — [bailian.console.alibabacloud.com](https://bailian.console.alibabacloud.com)

> [!important]
>
> When using Alibaba Cloud Coding Plan, you are subject to Alibaba Cloud's terms and privacy policies. Please review their documentation for specific details about data usage, retention, and privacy practices.

## 3. If you are using your own API Key

When you authenticate using API keys from other providers, the applicable Terms of Service and Privacy Notice depend on your chosen provider.

> [!important]
>
> When using your own API key, you are subject to the terms and privacy policies of your chosen API provider, not Qwen Code's terms. Please review your provider's documentation for specific details about data usage, retention, and privacy practices.

Qwen Code supports various OpenAI-compatible providers. Please refer to your specific provider's terms of service and privacy policy for detailed information.

## 4. If you are using Vertex AI

When you authenticate with Google Cloud Vertex AI, the applicable Terms of Service and Privacy Notice are Google Cloud's.

> [!important]
>
> When using Vertex AI, you are subject to [Google Cloud's Terms of Service](https://cloud.google.com/terms) and [Google Cloud Privacy Notice](https://cloud.google.com/privacy), not Qwen Code's terms. Please review Google Cloud's documentation for specific details about data usage, retention, and privacy practices.

## Usage Statistics and Telemetry

Qwen Code does not collect usage statistics and does not send telemetry anywhere. [Telemetry](../../developers/development/telemetry) is off by default; when you enable it, it is only written to the local file set by `telemetry.outfile`.

This does not affect what data your chosen AI service provider may collect according to its own privacy policy.

## Frequently Asked Questions (FAQ)

### 1. Is my code, including prompts and answers, used to train AI models?

Whether your code, including prompts and answers, is used to train AI models depends on your authentication method and the specific AI service provider you use:

- **Qwen OAuth**: Data usage is governed by [Qwen's Privacy Policy](https://qwen.ai/privacypolicy). Please refer to their policy for specific details about data collection and model training practices.

- **Alibaba Cloud Coding Plan**: Data usage is governed by Alibaba Cloud's privacy policy. Please refer to their policy for specific details about data collection and model training practices.

- **API Key**: Data usage depends entirely on your chosen API provider. Each provider has their own data usage policies. Please review the privacy policy and terms of service of your specific provider.

- **Vertex AI**: Data usage is governed by [Google Cloud's Terms of Service](https://cloud.google.com/terms) and [Privacy Notice](https://cloud.google.com/privacy). Please review Google Cloud's policies for specific details about data collection and model training practices.

**Important**: Qwen Code itself does not use your prompts, code, or responses for model training. Any data usage for training purposes would be governed by the policies of the AI service provider you authenticate with.

### 2. How do I switch between authentication methods?

You can switch between Qwen OAuth, Alibaba Cloud Coding Plan, your own API key, and Vertex AI at any time:

1. **During startup**: Choose your preferred authentication method when prompted
2. **Within the CLI**: Use the `/auth` command to reconfigure your authentication method
3. **Environment variables**: Set up `.env` files for automatic API key authentication

For detailed instructions, see the [Authentication Setup](../configuration/auth.md) documentation.
