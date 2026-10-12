# 沙箱化的 Workflow、HTML Artifact 与图片解码

[English](2026-10-12-sandboxed-workflows-artifacts-images.md) | [简体中文](2026-10-12-sandboxed-workflows-artifacts-images.zh-CN.md)

## 状态

已实现，2026-10-12，用于仅本地运行的分支。Workflow 宿主进程、Artifact
查看页和图片检查随跨文件加固变更发布。两个 QuickJS 宿主进程的 Node
权限模型以及 code mode 的栈上限随后续变更发布。

## 问题

对该分支的审查发现，有三个项目保留的功能在处理不可信输入时拥有超出需要的能力：

- Workflow 脚本由模型编写，此前在 CLI 进程内的 `node:vm` 中运行。`node:vm`
  不是安全边界。两个复现都触达了宿主 `process`，并由此触达
  `child_process`：一个通过被捕获的桥接错误，另一个通过在 `parallel()` 和
  `pipeline()` 期间覆盖原型。
- HTML Artifact 会在浏览器中运行模型编写的脚本。即使有 CSP，脚本仍可通过
  WebRTC ICE（一次 STUN 请求）或导航自身所在的 frame 访问网络。
- 图片预览把文件字节交给 sharp。libvips 根据字节选择解码器，因此其 SVG、PDF、
  TIFF 和 HEIF 加载器都可被触达，攻击面远大于预览实际渲染的三种格式。

删除这些功能的方案被否决。它们保留下来，并放入沙箱。

## 目标

- Workflow 脚本只能触达 workflow API 提供的内容：`agent()`、嵌套
  `workflow()`、`log`、`phase`、`args` 和 `budget`。
- Artifact 页面不能发起网络请求，也不能导航。
- 只有 PNG、JPEG 和 WebP 字节（预览）以及 GIF 字节（附件检查）会到达 libvips。
- 除此之外，Workflow、Artifact 和图片的行为保持不变。

## 非目标

- 宿主进程的网络隔离。Node 22 和 24 的权限模型不控制网络（见“风险与限制”）。
- 可运行脚本的 Artifact。以后若重新启用脚本，必须先封堵 WebRTC 和自身导航。
- Chrome 以外的浏览器；Artifact 测试组只在 Chrome 中运行过。

## 设计

### 在进程外 QuickJS 宿主中运行 Workflow 脚本

- 每次运行都会启动 `node <host>`（`agents/runtime/workflow-host-client.ts`）：
  打包版本使用 `dist/workflowHost.js`，否则使用 core 编译产物旁的
  `workflow-host.js`，测试中则通过 tsx 运行 `workflow-host.ts`。
- 宿主在编译为 WebAssembly 的 QuickJS
  （`@jitl/quickjs-singlefile-mjs-release-sync`）中运行脚本，内存上限
  512 MiB，栈上限 256 KiB。QuickJS 的中断处理器对每一段同步执行都强制 30 秒上限，
  而不只是第一段。
- 唯一的宿主函数是 `__wfPost(string)`。前置脚本（`workflow-guest.ts`）先保存它，
  然后在脚本运行前删除它以及 `process`、`require`、`fetch`、各类定时器、
  `WebAssembly`、`SharedArrayBuffer` 等全局对象。运行时会先保存自己需要的内置
  对象，因此覆盖原型的脚本只会改变它自己的代码。
- 父进程与宿主交换带长度前缀的 JSON 帧（4 字节大端长度，上限 64 MiB；
  `workflow-protocol.ts`）。父进程校验每条消息的类型和结构
  （`workflow-sandbox.ts`，`handle()`）。任何格式错误都会使运行失败并终止宿主。
  结果以带标记的 JSON 返回，由父进程重建（Error、Map、Set、BigInt、共享和循环
  引用），因此父进程从不持有来宾对象。
- 宿主的环境变量只有 `PATH`、`TMPDIR`、`TEMP`、`TMP`、`SystemRoot` 和
  `WINDIR`。
- `parallel()` 和 `pipeline()` 在来宾内部运行。依赖归属此前使用
  `AsyncLocalStorage`，现在改为在每个请求上显式携带 `{group, branch}`，并配合
  `fork` 和 `join` 消息。
- 语法检查在父进程中以只编译模式运行 QuickJS 解析器，因此不会运行任何脚本代码。
  Workflow 路径上不再使用 `node:vm`。
- 中止或超时会立即结束运行并发送 `abort`。已结束运行的宿主最多可用 10 秒处理
  尚未完成的请求，之后以 SIGKILL 终止。宿主崩溃会使其运行失败。

### QuickJS 宿主的 Node 权限模型

两个 QuickJS 宿主（Workflow 和 code mode，`code-mode/host-client.ts`）都在 Node
权限模型下启动（`utils/quickjs-host-permissions.ts`）：

- 打包的宿主：`node --permission <宿主文件的真实路径>`，不授予任何权限。它不能读写
  文件，不能创建子进程、工作线程，不能加载原生插件或使用 WASI。Node 仍会读取入口
  脚本，而打包产物内嵌了 WebAssembly。
- core 编译产物旁的宿主：在上述基础上增加
  `--allow-fs-read=<安装根目录>`，即提供 QuickJS 的最外层 `node_modules`
  的父目录。模块解析会一路向上读取各级 `package.json`，直到该目录，因此更窄的
  授权会失败。
- 22.13 之前的 Node 只接受 `--experimental-permission`；辅助函数会选用当前 Node
  接受的写法。
- 入口以真实路径传入。Node 在加载前会解析入口路径中的符号链接，而这一读取未被授权。
- 通过 tsx 运行源码（测试和开发）时不启用权限模型，因为 tsx 需要工作线程和缓存写入。

### Code mode 栈上限

Code mode 宿主的 QuickJS 栈上限从 1 MiB 降到 256 KiB，与 Workflow 相同。在
1 MiB 时，失控递归会先耗尽 Node 自身的栈。脚本无法捕获该错误，随后宿主在 QuickJS
内部中止（`JS_FreeRuntime` 断言失败）。在 256 KiB 时，QuickJS 抛出脚本可以捕获的
错误。

### 在空沙箱中作为静态页面的 HTML Artifact

- 发布的页面是一个固定的、不含脚本的查看页。模型生成的片段只会以属性转义的形式
  出现在 `<iframe sandbox="" srcdoc="…">` 中（`tools/artifact/html.ts`），因此
  无法向查看页添加标记。
- 查看页的 CSP（srcdoc frame 继承同一策略）：
  `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'`。
  空的 `sandbox` 提供不透明源，没有脚本、表单、弹窗、顶层导航、下载或模态框。
  DNS 预取已关闭，查看页不发送 referrer。
- 禁用脚本是因为没有任何 CSP 或沙箱设置能封堵 WebRTC ICE 或脚本导航自身 frame。
  Artifact 只包含静态 HTML、CSS 和 SVG。
- 在写入任何内容之前，校验器会拒绝外部 URL、location 赋值、
  `<meta http-equiv=refresh>`、`<base>`、任何 `<link>`、speculation rules、
  `serviceWorker.register` 和 `RTCPeerConnection`。Chrome 会无视 CSP 启动预渲染，
  因此对预渲染而言，校验器是唯一的控制手段。

### 图片解码

- 预览（`utils/image-view.ts`）：sharp 收到的是 Buffer，并且只有带 PNG、JPEG 或
  WebP 签名的字节。其他字节不经解码，直接报告为不支持。
- 附件（`utils/fileUtils.ts`）：只有以 `GIF8` 开头的 `.gif` 才会交给 sharp 检查。
  否则其数据不会放入请求，并附带说明。

## 决策与备选方案

- **在子进程中运行 QuickJS**，而不是 `node:vm`、工作线程或 `isolated-vm`。
  `node:vm` 和工作线程与 CLI 共用进程，`isolated-vm` 是原生插件。Code mode
  已在使用 QuickJS，因此没有新增依赖。
- **只传 JSON 的桥接。** 父进程收到的任何内容都不是活动对象，原型技巧无从下手。
- **每次运行一个进程。** 崩溃或挂起只影响该次运行，父进程会将其终止。
- **静态 Artifact。** 没有浏览器设置能封堵这两种脚本途径，因此禁用脚本。
- **打包宿主不授予任何权限。** 宿主不做任何需要授权的事。非打包运行只获得可用的
  最小授权：安装根目录以下的只读权限。

## 风险与限制

- Node 22 和 24 的权限模型不控制网络。QuickJS 逃逸再加上宿主缺陷，仍可能打开
  套接字。使用仅回环的 Seatbelt 配置文件时可以覆盖这一点。
- 在 `await null` 或脚本自行构造的 promise 之后，依赖归属会记到恢复脚本执行的那次
  结算上。
- 由于 QuickJS 没有 promise 拒绝跟踪器，async 包装函数中遗漏的 `await` 不再被镜像
  到日志中。
- Artifact 校验器按字节扫描。用字符引用拼写的 `rel` 值不会被解码，这也是拒绝所有
  `<link>` 的原因。
- 通过 tsx 运行的测试不会覆盖权限参数。`scripts/tests/quickjs-host-permissions.test.js`
  会在打包的宿主上覆盖它们。

## 验证

- Workflow 逃逸：变更前，被捕获的桥接错误能触达 `child_process`（执行了
  `id -u`），原型覆盖会泄漏宿主回调。变更后，两者都停留在来宾内部
  （`workflow-sandbox.test.ts` 的 “workflow guest isolation”；
  `workflow-orchestrator.test.ts`）。
- `utils/quickjs-host-permissions.test.ts`：在打包参数下，Node 报告没有读、写、
  子进程或工作线程权限；在非打包参数下，只能读取安装根目录以下的内容。
- `scripts/tests/quickjs-host-permissions.test.js`：两个宿主按发布构建选项打包后，
  在这些参数下成功运行脚本。
- 端到端，使用 127.0.0.1 上的模拟模型：
  - 通过 `dist/cli.js`，一次 Workflow 运行启动了
    `node --permission …/dist/workflowHost.js` 并成功完成。
  - 通过 `packages/cli/dist/index.js`，启动了
    `node --permission --allow-fs-read=<repo> …/workflow-host.js` 并成功完成。
- `code-mode.test.ts` 的 “turns runaway recursion into an error the script can
  catch”（在 1 MiB 时失败）。
- Artifact 测试组（无头 Chrome，在回环地址上监听 TCP、HTTP、WebSocket 和 UDP
  STUN）：
  - 不使用查看页时，36 个途径中有 30 个产生了真实的出站流量。
  - 使用发布的查看页时，只有三个建立了连接：预渲染，以及由 `<iframe src>` 和
    `<link rel=preconnect>` 产生、不携带数据的预连接套接字。校验器会在写入任何
    内容之前拒绝这三种情况。
  - `html.test.ts` 覆盖了 CSP、沙箱、转义和校验器。
- `image-view.sniff.test.ts` 和 `fileUtils.test.ts`：SVG、PDF、TIFF 和文本字节
  从不会到达 sharp。

## 验收标准

- Workflow 执行路径不使用 `node:vm`，逃逸复现均失败。
- 在 tsx 运行之外，两个 QuickJS 宿主都以 `--permission`（或
  `--experimental-permission`）启动。
- Artifact 页面带有上述 CSP 和 `sandbox=""`，查看页不含脚本。
- 只有列出的图片签名会到达 sharp。

## 待解决问题

- 一旦受支持的 Node 版本的权限模型能够控制网络，就禁止宿主访问网络。
