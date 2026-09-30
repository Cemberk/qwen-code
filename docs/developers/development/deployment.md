# Qwen Code Execution and Deployment

This document describes how to run Qwen Code and explains how the CLI is built.

## Running Qwen Code

This fork is built and run from source. It is not published to a package
registry, and there is no installer or update channel.

### 1. Build from source

```bash
# From the root of the repository
corepack pnpm install --frozen-lockfile
npm run build
npm run bundle

# Run the bundled CLI
node dist/cli.js
```

To get a `qwen` command on your `PATH`, link the local package:

```bash
npm link packages/cli
qwen
```

### 2. Development mode

This method runs the CLI from the TypeScript sources and is useful for active
development.

```bash
# From the root of the repository
npm run start
```

### 3. Running in a sandbox (Docker/Podman)

For isolation, Qwen Code can run inside a container. The sandbox image is not
downloaded; build it locally first:

```bash
npm run build:sandbox
qwen --sandbox -p "your prompt here"
```

## Build architecture

Qwen Code is a monorepo with two main packages:

- `@qwen-code/qwen-code-core`: The backend, handling logic and tool execution.
- `@qwen-code/qwen-code`: The user-facing frontend.

`npm run build` transpiles the TypeScript sources of each package into its
`dist/` directory with the TypeScript Compiler (`tsc`). `npm run bundle` then
uses `esbuild` to bundle the application and its dependencies into
`dist/cli.js`.
