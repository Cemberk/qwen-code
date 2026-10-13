# 内置本地 Qwen 模型

[English](2026-10-12-local-qwen-models.md) | [简体中文](2026-10-12-local-qwen-models.zh-CN.md)

## 状态

已实现，2026-10-12，用于仅本地运行的分支。已在 24 GB 内存的 Apple M4、
`mlx-lm` 0.32.0 和 llama.cpp build 10240 上验证。

## 问题

该分支只与回环地址上的 OpenAI 兼容模型服务器通信，但用户必须自己启动该服务器、
挑选模型文件，并在 `modelProviders` 中描述它。该分支的定位是本地 Qwen 智能体：
它应自带一份 Qwen 模型列表，允许用户在其中切换，并由自己运行这些模型。

## 目标

- 一份内置、可由用户编辑的 Qwen 模型列表，每个模型以其 Hugging Face 仓库命名
  （GGUF 模型还需指定文件）。
- qwen 自己运行所选模型：MLX 模型通过 `mlx_lm.server`，GGUF 模型通过
  `llama-server`。由于该分支主要运行在 Apple Silicon 上，MLX 排在列表前面。
- `/model`、`model.name` 和 `--model` 选择本地模型的方式与其他模型相同。
- qwen 从不向外连接。模型文件来自磁盘上的 Hugging Face 缓存；缺失的模型会给出
  确切的 `hf download` 命令，由用户自行运行。

## 非目标

- 下载模型、检查新模型或读取 Hugging Face 元数据。
- 安装推理引擎。由用户安装 `mlx-lm` 和 `llama.cpp`。
- 同时提供多个模型，或在多个 qwen 会话之间共享一个引擎。
- 在网络关闭的 Docker 沙箱内运行引擎。

## 设计

### 配置

`localModels` 是一个顶层设置：由条目组成的数组。

```json
{
  "localModels": [
    {
      "id": "qwen3-8b-mlx",
      "name": "Qwen3 8B (MLX 4-bit)",
      "format": "mlx",
      "repo": "mlx-community/Qwen3-8B-4bit",
      "contextSize": 32768
    },
    {
      "id": "qwen3-8b-gguf",
      "name": "Qwen3 8B (GGUF Q4_K_M)",
      "format": "gguf",
      "repo": "Qwen/Qwen3-8B-GGUF",
      "file": "Qwen3-8B-Q4_K_M.gguf",
      "contextSize": 32768
    }
  ]
}
```

| 字段          | 是否必填 | 含义                                                                  |
| ------------- | -------- | --------------------------------------------------------------------- |
| `id`          | 是       | `/model`、`model.name` 和 `--model` 使用的名称。必须唯一。            |
| `name`        | 否       | 显示名称。默认为 `id`。                                               |
| `format`      | 是       | `mlx`（由 `mlx_lm.server` 运行）或 `gguf`（由 `llama-server` 运行）。 |
| `repo`        | 是       | Hugging Face 仓库，`owner/name`。                                     |
| `file`        | 仅 GGUF  | 仓库中的 `.gguf` 文件。对于分片文件，填写第一个分片。                 |
| `contextSize` | 否       | 以 token 计的上下文窗口，默认 32768。决定引擎的上下文大小和压缩阈值。 |

- 默认值是一份内置的 Qwen 模型列表。在 `~/.qwen/settings.json` 中设置
  `localModels` 会替换它。
- `localModels` 只从用户和系统设置中读取。工作区设置无法添加模型，因为条目决定了
  引擎加载哪些文件。
- 条目在启动时校验。错误的条目与错误的 `modelProviders` 条目一样，属于配置错误。

### 模型选择

- 每个条目都会成为一个 `openai` 模型提供方条目，排在用户自己的
  `modelProviders` 条目之前，因此 `/model` 会列出它，现有的选择、持久化和热重载
  路径都能处理它。
- 这些条目带有固定的占位基础 URL `http://127.0.0.1:0/v1`，因此持久化的
  `model.baseUrl` 在不同会话之间保持有效。端口 0 不接受任何连接。内容生成器会把它
  替换为正在运行的引擎地址。
- 当未配置认证类型和模型时，qwen 选择 `openai` 认证类型和第一个本地模型，因此
  全新安装启动时不会弹出认证对话框。

### 模型文件

- 文件从 Hugging Face 缓存读取：依次为 `HF_HUB_CACHE`、
  `HUGGINGFACE_HUB_CACHE`、`$HF_HOME/hub`、`$XDG_CACHE_HOME/huggingface/hub`、
  `~/.cache/huggingface/hub`，与 `huggingface_hub` 的顺序相同。
- 仓库的 `refs/main` 指定快照。GGUF 条目要求其文件位于快照中。MLX 条目要求
  `config.json` 以及 safetensors 索引列出的所有权重文件（或 `model.safetensors`）。
- 缺失的模型会使请求失败，并给出获取它的命令，例如
  `hf download mlx-community/Qwen3-8B-4bit`，同时说明该命令会连接 huggingface.co，
  而 qwen 本身不会。
- 项目的 `.env` 不能设置 `HF_HUB_CACHE`、`HUGGINGFACE_HUB_CACHE`、`HF_HOME`
  或 `XDG_CACHE_HOME`，因此仓库无法让 qwen 加载仓库自带的模型文件。

### 引擎生命周期

- 每个 qwen 进程一个引擎，同一时间只提供一个模型。在第一个针对本地模型的请求之前，
  不会启动任何东西。
- 每个针对本地模型的请求都会获取该模型的租约。已加载模型的租约立即授予。其他模型的
  租约会等待已加载模型上的请求完成，然后引擎以新模型重启。租约按顺序授予，因此针对
  已加载模型的连续请求不会让切换一直等待。
- 这覆盖了主模型、`/model` 切换、辅助模型、子智能体和 Workflow。它们都通过
  `createContentGenerator` 构建内容生成器。
- 已退出的引擎会在下一个请求时重启。
- 就绪检查：qwen 在回环地址上轮询 `/health`，直到返回 200；如果引擎先退出或
  5 分钟内没有响应，请求会失败并附带引擎输出的末尾部分。`llama-server` 在模型加载
  完成后才响应；`mlx_lm.server` 在其工作线程启动后即响应，并在第一个请求等待时
  加载模型。
- 关闭：由退出清理发送 `SIGTERM`，1.5 秒后发送 `SIGKILL`；进程的 `exit` 监听器
  发送 `SIGKILL`，这也覆盖了崩溃处理器。被 `SIGKILL` 杀死的 qwen 进程会留下其引擎
  继续运行。
- 引擎可执行文件在 `PATH` 中查找（只使用绝对路径条目）。缺少引擎时，请求会失败并
  说明安装方法。

### 引擎隔离

- 引擎只绑定 `127.0.0.1`。qwen 通过绑定 `127.0.0.1:0` 并立即关闭来选择端口；它从不
  接受任何连接。
- 引擎以最小环境启动：`PATH`、`HOME`、`TMPDIR` 以及引擎自身的设置。会让引擎下载
  或启用工具的变量（`LLAMA_ARG_*`、`HF_TOKEN` 等）不会传入。
- `llama-server` 以 `--offline`、`--no-webui` 和 `--no-slots` 运行，并使用每个会话
  随机生成的 API 密钥；该密钥通过环境变量（`LLAMA_API_KEY`）传入，而不是放在命令
  行上。
- `mlx_lm.server` 以 `HF_HUB_OFFLINE=1` 和 `--allowed-origins none` 运行，因此浏览器
  得不到读取其响应的 CORS 授权。它会加载请求 `model` 字段指定的任何模型（联网时会
  下载），因此请求携带 `default_model`，即它启动时所用模型的名称。qwen 通过
  `extra_body` 设置该值，而 `extra_body` 最后应用：qwen 自身的处理，包括 Qwen 的
  `enable_thinking` 开关，仍然看到条目的 id。
- 两个引擎都使用 Qwen3 推荐的采样参数（`--temp 0.6 --top-p 0.95 --top-k 20
--min-p 0`），用于未自行设置采样参数的请求。否则 `mlx_lm.server` 会使用贪心解码，
  而 Qwen3 建议避免这样做。
- 在 macOS 上，每个引擎都在 `sandbox-exec` 下运行，其配置文件只允许网络流量发往本机
  自己的地址（回环地址及其网卡地址），并且只允许在临时目录和 `~/Library/Caches`
  中写文件，因此利用引擎漏洞的模型文件无法留下之后会运行的任何东西。当 qwen 本身运行在其 Seatbelt 沙箱中时，引擎
  改为继承该沙箱，因为沙箱不能嵌套。
- `QWEN_LOCAL_MODEL_KEY` 只保存占位值 `local`，用于满足 qwen 的“已配置 API 密钥”
  检查。内容生成器发送真实密钥，该密钥只存在于 qwen 的内存和引擎的环境中，因此 qwen
  运行的命令永远看不到它。

## 决策与备选方案

- **两种引擎，MLX 优先**，这是用户的选择。在 M4 上使用 Qwen3 4B 时，两者生成速度
  相同，MLX 读取长提示词快约 10%（见“验证”）。llama.cpp 读取 GGUF，可覆盖没有 MLX
  转换版本的模型以及非 Apple Silicon 的机器。
- **qwen 不负责下载。** 之前的每个阶段都移除了网络代码。由用户在知情的情况下运行
  `hf download`。
- **占位基础 URL**，而不是在启动时预留端口：持久化的选择保持有效，引擎重启时可以
  使用新端口。
- **按请求获取租约**，而不是只在 `/model` 时重启：辅助模型、子智能体和 Workflow 可以
  指定任何本地模型，并仍能访问到它。
- **qwen 中不开监听套接字。** 代理可以隐藏引擎端口，但该分支没有监听套接字。

## 风险与限制

- `mlx_lm.server` 没有认证。本机上的任何进程都可以使用已加载的模型，或让它从磁盘
  加载另一个模型。找到该端口的网页仍可以发送简单请求，但无法读取响应。两者都无法读取
  qwen 的对话。
- `mlx_lm.server` 加载失败的模型会使每个请求都返回其错误，直到引擎重启（一次
  `/model` 切换）。
- 会话的第一个请求较慢。qwen 的系统提示词和工具定义在 `qwen -p` 中约有 12,000 个
  token，在交互式界面中约有 17,500 个；Qwen3 4B 在 M4 上读取后者大约需要 80 秒。
  之后的请求会复用引擎的提示词缓存。qwen 的自动记忆提取器和提示建议会在每轮之后
  再发起请求。
- 在本地模型之间切换会重新加载引擎，小模型需要几秒，大模型更久。与主模型不同的快速、
  视觉和子智能体模型会引起这类切换。
- 每个 qwen 会话运行自己的引擎和自己的一份模型副本。
- 预置的仓库名和文件名来自作者的知识，qwen 无法核对。名称错误会在 `hf download`
  失败时暴露。
- 在 Linux 上，引擎在没有仅回环配置文件的情况下运行。

## 验证

- 单元测试（`packages/core/src/local-models/*.test.ts`）：配置校验、缓存查找（分片
  GGUF、不完整的 MLX 下载、不是提交哈希的 ref）、引擎命令与环境、使用替身引擎的启动、
  失败与停止、租约顺序、切换、中止与重启，以及内容生成器对地址、密钥和 `model` 的
  处理。
- CLI 测试：未配置任何内容时的默认模型、`localModels: []`、启动时和热重载时的无效
  条目、提供方回退，以及 `.env` 排除项。
- Seatbelt 配置文件，使用不发送任何数据包的 UDP `connect()` 探测：公网地址、路由器和
  另一个局域网地址被拒绝（`EPERM`）；回环地址和本机自己的局域网地址被允许。两个引擎在该配置文件下都能
  正常服务，而在其中向主目录写文件会以 `Operation not permitted` 失败。
- qwen 管理下的 `llama-server`：只绑定 `127.0.0.1`；无密钥返回 `401`，有密钥返回
  `200`；70 毫秒内停止。
- qwen 管理下的 `mlx_lm.server`：只绑定 `127.0.0.1`；对外部来源不给予 CORS 授权；
  指定其他模型的请求以“outgoing traffic has been disabled”失败，服务器继续正常服务。
- 端到端，`qwen -p` 使用两种格式的 Qwen3 4B：模型调用 `read_file` 并根据文件内容
  作答；在第二个测试中，模型编写了一个 Python 文件，用 shell 工具运行它并报告输出。
  没有遗留任何引擎进程。在只配置了 `localModels` 时，`qwen -p` 和交互式界面都运行了
  第一个本地模型，且没有弹出认证对话框。未下载的模型在一秒内失败，并给出
  `hf download` 命令。
- 交互式 `/model` 切换：Qwen3 4B MLX 回答了第一个提示（其请求携带
  `default_model`）；执行 `/model qwen3-4b-gguf` 后，下一个提示、提示建议和记忆
  提取器都发往 GGUF 引擎。`/quit` 后没有遗留任何引擎进程。
- 速度，Qwen3 4B，冷启动引擎，每项运行一次：
  - 4,580 个 token 的提示词：MLX 4-bit 读取提示词约 335 token/秒（含模型加载），
    生成 26.2 token/秒；llama.cpp Q4_K_M 读取提示词 332 token/秒，生成
    27.5 token/秒。
  - 含工具定义的 17,500 个 token 的交互式请求：MLX 在 78 秒后输出第一个 token，
    llama.cpp 在 87 秒后。

## 验收标准

- 没有任何配置时，`qwen` 选择第一个内置本地模型，并在第一个提示时启动其引擎。
- 未下载的模型以 `hf download` 命令失败。
- `/model` 可在两种格式的本地模型之间切换，请求到达新加载的模型。
- 引擎只绑定回环地址，并在 qwen 退出时停止。
- qwen 中没有任何代码路径连接回环地址以外的主机。

## 待解决问题

- 在多个 qwen 会话之间共享一个引擎，避免两个会话加载同一模型的两份副本。
