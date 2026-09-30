# Package Overview

This monorepo contains two main packages: `@qwen-code/qwen-code` and `@qwen-code/qwen-code-core`.

## `@qwen-code/qwen-code`

This is the main package for Qwen Code. It is responsible for the user interface, command parsing, and all other user-facing functionality.

`npm run bundle` bundles it into a single executable file, `dist/cli.js`. This bundle includes all of the package's dependencies, including `@qwen-code/qwen-code-core`.

## `@qwen-code/qwen-code-core`

This package contains the core logic for the CLI. It is responsible for making API requests to the configured local model server, handling authentication, and managing the local cache.

`npm run build` transpiles it into its `dist` folder, which the CLI imports.

## NPM Workspaces

This project uses [NPM Workspaces](https://docs.npmjs.com/cli/v10/using-npm/workspaces) to manage the packages within this monorepo. This simplifies development by allowing us to manage dependencies and run scripts across multiple packages from the root of the project.

### How it Works

The root `package.json` file defines the workspaces for this project:

```json
{
  "workspaces": ["packages/*"]
}
```

This tells NPM that any folder inside the `packages` directory is a separate package that should be managed as part of the workspace.

### Benefits of Workspaces

- **Simplified Dependency Management**: Running `corepack pnpm install --frozen-lockfile` from the root of the project installs the dependencies of every package in the workspace and links the packages together, so you don't need to install in each package's directory.
- **Automatic Linking**: Packages within the workspace can depend on each other. When you install from the root, pnpm creates symlinks between the packages. This means that when you make changes to one package, the changes are immediately available to other packages that depend on it.
- **Simplified Script Execution**: You can run scripts in any package from the root of the project using the `--workspace` flag. For example, to run the `build` script in the `cli` package, you can run `npm run build --workspace @qwen-code/qwen-code`.
