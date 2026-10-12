/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { quote, parse } from 'shell-quote';
import {
  getUserSettingsDir,
  SETTINGS_DIRECTORY_NAME,
} from '../config/settings.js';
import type {
  Config,
  SandboxConfig,
} from '@qwen-code/qwen-code-core/config/config.js';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { resolveBundleDir } from '@qwen-code/qwen-code-core/utils/bundlePaths.js';
import { FatalSandboxError } from '@qwen-code/qwen-code-core/utils/errors.js';
import { getAllMemoryFilenames } from '@qwen-code/qwen-code-core/utils/memory-constants.js';
import { TRUSTED_FOLDERS_FILENAME } from '../config/trustedFolders.js';
import { MCP_APPROVALS_FILENAME } from '../config/mcpApprovals.js';
import { BWRAP_MIGRATION_MESSAGE } from '../config/execution-sandbox-settings.js';
import { randomBytes } from 'node:crypto';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import { SANDBOX_STDIN_ENV } from '../utils/readStdin.js';
import { parseSandboxImageName } from '../utils/sandboxImageName.js';
import { isContainerPathWithinWorkdir } from '../utils/sandbox-path.js';
import { parseSandboxMountSpec } from '../utils/sandboxMounts.js';

function getContainerPath(hostPath: string): string {
  if (os.platform() !== 'win32') {
    return hostPath;
  }

  const withForwardSlashes = hostPath.replace(/\\/g, '/');
  const match = withForwardSlashes.match(/^([A-Z]):\/(.*)/i);
  if (match) {
    return `/${match[1].toLowerCase()}/${match[2]}`;
  }
  return hostPath;
}

function ensureDirectoryAndGetRealPath(dir: string): string {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return fs.realpathSync(dir);
}

/**
 * Exported so the colocation tripwire in `sandbox.test.ts` can iterate every
 * builtin profile by construction instead of pinning a hand-copied snapshot
 * that silently stops at the list as written.
 */
export const BUILTIN_SEATBELT_PROFILES = [
  'permissive-open',
  'permissive-closed',
  'restrictive-open',
  'restrictive-closed',
];

export function getSandboxPassthroughEnvArgs(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return ['QWEN_DEBUG_LOG_FILE', 'QWEN_CODE_LEGACY_MCP_BLOCKING'].flatMap(
    (envVar) =>
      env[envVar] === undefined ? [] : ['--env', `${envVar}=${env[envVar]}`],
  );
}

export function resolveSeatbeltProfileFile(
  profile: string,
  importMetaUrl = import.meta.url,
): string {
  // Only the shipped profiles exist: a profile file anywhere else (the
  // project's `.qwen` included) would let whoever wrote it choose the
  // sandbox's own rules.
  if (!BUILTIN_SEATBELT_PROFILES.includes(profile)) {
    throw new FatalSandboxError(
      `Unknown macos seatbelt profile '${profile}'. Use one of: ${BUILTIN_SEATBELT_PROFILES.join(', ')}.`,
    );
  }

  return path.join(
    resolveBundleDir(importMetaUrl),
    `sandbox-macos-${profile}.sb`,
  );
}

/**
 * Determines whether the sandbox container should be run with the current user's UID and GID.
 * This is often necessary on Linux systems when using rootful Docker without userns-remap
 * configured, to avoid permission issues with
 * mounted volumes.
 *
 * The behavior is controlled by the `SANDBOX_SET_UID_GID` environment variable:
 * - If `SANDBOX_SET_UID_GID` is "1" or "true", this function returns `true`.
 * - If `SANDBOX_SET_UID_GID` is "0" or "false", this function returns `false`.
 * - If `SANDBOX_SET_UID_GID` is not set:
 *   - On Linux, it defaults to `true`.
 *   - On other OSes, it defaults to `false`.
 *
 * For more context on running Docker containers as non-root, see:
 * https://medium.com/redbubble/running-a-docker-container-as-a-non-root-user-7d2e00f8ee15
 *
 * @returns {Promise<boolean>} A promise that resolves to true if the current user's UID/GID should be used, false otherwise.
 */
async function shouldUseCurrentUserInSandbox(): Promise<boolean> {
  const envVar = process.env['SANDBOX_SET_UID_GID']?.toLowerCase().trim();

  if (envVar === '1' || envVar === 'true') {
    return true;
  }
  if (envVar === '0' || envVar === 'false') {
    return false;
  }

  if (os.platform() === 'linux') {
    const debugEnv = [process.env['DEBUG'], process.env['DEBUG_MODE']].some(
      (v) => v === 'true' || v === '1',
    );
    if (debugEnv) {
      // Use stderr so it doesn't clutter normal STDOUT output (e.g. in `--prompt` runs).
      writeStderrLine(
        'INFO: Using current user UID/GID in Linux sandbox. Set SANDBOX_SET_UID_GID=false to disable.',
      );
    }
    return true;
  }

  return false;
}

const SANDBOX_HOME_DIR_NAME = 'sandbox-home';
const SANDBOX_HOME_CONFIG_DIRS = [
  'extensions',
  'skills',
  'commands',
  'agents',
  'workflows',
  'rules',
  'output-styles',
];

function prepareSandboxHome(userSettingsDir: string): string {
  const sandboxHome = ensureDirectoryAndGetRealPath(
    path.join(Storage.getRuntimeBaseDir(), SANDBOX_HOME_DIR_NAME),
  );
  const configFiles = [
    'settings.json',
    '.env',
    TRUSTED_FOLDERS_FILENAME,
    MCP_APPROVALS_FILENAME,
    ...getAllMemoryFilenames().filter((name) => path.basename(name) === name),
  ];
  for (const file of configFiles) {
    const source = path.join(userSettingsDir, file);
    const copy = path.join(sandboxHome, file);
    // The container can write this directory, so whatever sits at `copy` may
    // be a symlink it planted. Remove it and create the copy exclusively, so
    // the host never writes through a link to a file outside the sandbox home.
    fs.rmSync(copy, { force: true, recursive: true });
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, copy, fs.constants.COPYFILE_EXCL);
    }
  }
  return sandboxHome;
}

function hasNetworkFlag(args: string[]): boolean {
  return args.some((arg) => /^--net(work)?(=|$)/.test(arg));
}

function entrypoint(workdir: string, cliArgs: string[]): string[] {
  const isWindows = os.platform() === 'win32';
  const containerWorkdir = getContainerPath(workdir);
  const shellCmds = [];
  const pathSeparator = isWindows ? ';' : ':';

  let pathSuffix = '';
  if (process.env['PATH']) {
    const paths = process.env['PATH'].split(pathSeparator);
    for (const p of paths) {
      const containerPath = getContainerPath(p);
      if (isContainerPathWithinWorkdir(containerWorkdir, containerPath)) {
        pathSuffix += `:${containerPath}`;
      }
    }
  }
  if (pathSuffix) {
    shellCmds.push(`export PATH="$PATH${pathSuffix}";`);
  }

  let pythonPathSuffix = '';
  if (process.env['PYTHONPATH']) {
    const paths = process.env['PYTHONPATH'].split(pathSeparator);
    for (const p of paths) {
      const containerPath = getContainerPath(p);
      if (isContainerPathWithinWorkdir(containerWorkdir, containerPath)) {
        pythonPathSuffix += `:${containerPath}`;
      }
    }
  }
  if (pythonPathSuffix) {
    shellCmds.push(`export PYTHONPATH="$PYTHONPATH${pythonPathSuffix}";`);
  }

  const quotedCliArgs = cliArgs.slice(2).map((arg) => quote([arg]));
  const cliCmd =
    process.env['NODE_ENV'] === 'development'
      ? process.env['DEBUG']
        ? 'npm run debug --'
        : 'npm rebuild && npm run start --'
      : process.env['DEBUG']
        ? `node --inspect-brk=127.0.0.1:${process.env['DEBUG_PORT'] || '9229'} $(which qwen)`
        : 'qwen';

  const args = [...shellCmds, cliCmd, ...quotedCliArgs];
  return ['bash', '-c', args.join(' ')];
}

export async function start_sandbox(
  config: SandboxConfig,
  nodeArgs: string[] = [],
  cliConfig?: Config,
  cliArgs: string[] = [],
): Promise<number> {
  if (config.command === 'bwrap')
    throw new FatalSandboxError(BWRAP_MIGRATION_MESSAGE);
  if (config.command === 'sandbox-exec') {
    // disallow BUILD_SANDBOX
    if (process.env['BUILD_SANDBOX']) {
      throw new FatalSandboxError(
        'Cannot BUILD_SANDBOX when using macOS Seatbelt',
      );
    }

    const profile = (process.env['SEATBELT_PROFILE'] ??= 'permissive-closed');
    const profileFile = resolveSeatbeltProfileFile(profile);
    if (!fs.existsSync(profileFile)) {
      throw new FatalSandboxError(
        `Missing macos seatbelt profile file '${profileFile}'`,
      );
    }
    // Log on STDERR so it doesn't clutter the output on STDOUT
    writeStderrLine(`using macos seatbelt (profile: ${profile}) ...`);
    // if DEBUG is set, convert to --inspect-brk in NODE_OPTIONS
    const nodeOptions = [
      ...(process.env['DEBUG'] ? ['--inspect-brk'] : []),
      ...nodeArgs,
    ].join(' ');

    // Canonicalize via realpathSync so seatbelt's `subpath` matcher sees the
    // same path the kernel will. mkdirSync first because realpathSync throws
    // on missing dirs and a custom QWEN_HOME / QWEN_RUNTIME_DIR may not exist
    // yet on first run.
    const qwenDir = Storage.getGlobalQwenDir();
    const runtimeDir = Storage.getRuntimeBaseDir();
    fs.mkdirSync(qwenDir, { recursive: true });
    fs.mkdirSync(runtimeDir, { recursive: true });
    // The profiles keep the extensions directory read-only, and the sandboxed
    // CLI's extension store expects it to exist, so create it here first.
    fs.mkdirSync(path.join(qwenDir, 'extensions'), {
      recursive: true,
      mode: 0o700,
    });

    const args = [
      '-D',
      `TARGET_DIR=${fs.realpathSync(process.cwd())}`,
      '-D',
      `TMP_DIR=${fs.realpathSync(os.tmpdir())}`,
      '-D',
      `HOME_DIR=${fs.realpathSync(os.homedir())}`,
      '-D',
      `CACHE_DIR=${fs.realpathSync(execSync(`getconf DARWIN_USER_CACHE_DIR`).toString().trim())}`,
      '-D',
      `QWEN_DIR=${fs.realpathSync(qwenDir)}`,
      '-D',
      `RUNTIME_DIR=${fs.realpathSync(runtimeDir)}`,
    ];

    // Add included directories from the workspace context
    // Always add 5 INCLUDE_DIR parameters to ensure .sb files can reference them
    const MAX_INCLUDE_DIRS = 5;
    const targetDir = fs.realpathSync(cliConfig?.getTargetDir() || '');
    const includedDirs: string[] = [];

    if (cliConfig) {
      const workspaceContext = cliConfig.getWorkspaceContext();
      const directories = workspaceContext.getDirectories();

      // Filter out TARGET_DIR
      for (const dir of directories) {
        const realDir = fs.realpathSync(dir);
        if (realDir !== targetDir) {
          includedDirs.push(realDir);
        }
      }
    }

    for (let i = 0; i < MAX_INCLUDE_DIRS; i++) {
      let dirPath = '/dev/null'; // Default to a safe path that won't cause issues

      if (i < includedDirs.length) {
        dirPath = includedDirs[i];
      }

      args.push('-D', `INCLUDE_DIR_${i}=${dirPath}`);
    }

    const finalArgv = cliArgs;

    args.push(
      '-f',
      profileFile,
      'sh',
      '-c',
      [
        `SANDBOX=sandbox-exec`,
        `NODE_OPTIONS="${nodeOptions}"`,
        ...finalArgv.map((arg) => quote([arg])),
      ].join(' '),
    );
    // spawn child and let it inherit stdio
    process.stdin.pause();
    const sandboxProcess = spawn(config.command, args, {
      stdio: 'inherit',
    });
    return new Promise((resolve, reject) => {
      sandboxProcess.on('error', reject);
      sandboxProcess.on('close', (code) => {
        process.stdin.resume();
        resolve(code ?? 1);
      });
    });
  }

  writeStderrLine(`hopping into sandbox (command: ${config.command}) ...`);

  // determine full path for qwen-code to distinguish linked vs installed setting
  const gcPath = fs.realpathSync(process.argv[1]);

  const projectSandboxDockerfile = path.join(
    SETTINGS_DIRECTORY_NAME,
    'sandbox.Dockerfile',
  );
  const isCustomProjectSandbox = fs.existsSync(projectSandboxDockerfile);

  const image = config.image;
  // `image` is optional on SandboxConfig because the in-place backends never
  // use one; `loadSandboxConfig` only emits a container command together with
  // an image. Fail loudly rather than handing `undefined` to the runtime, where
  // it would stringify into an "undefined" image reference.
  if (!image) {
    throw new FatalSandboxError(
      `Sandbox command '${config.command}' requires an image`,
    );
  }
  const workdir = path.resolve(process.cwd());
  const containerWorkdir = getContainerPath(workdir);

  // if BUILD_SANDBOX is set, then call scripts/build_sandbox.js under qwen-code repo
  //
  // note this can only be done with binary linked from qwen-code repo
  if (process.env['BUILD_SANDBOX']) {
    if (!gcPath.includes('qwen-code/packages/')) {
      throw new FatalSandboxError(
        'Cannot build sandbox using installed Qwen Code binary; ' +
          'run `npm link ./packages/cli` under QwenCode-cli repo to switch to linked binary.',
      );
    } else {
      writeStderrLine('building sandbox ...');
      const gcRoot = gcPath.split('/packages/')[0];
      // if project folder has sandbox.Dockerfile under project settings folder, use that
      let buildArgs = '';
      const projectSandboxDockerfile = path.join(
        SETTINGS_DIRECTORY_NAME,
        'sandbox.Dockerfile',
      );
      if (isCustomProjectSandbox) {
        writeStderrLine(`using ${projectSandboxDockerfile} for sandbox`);
        buildArgs += `-f ${path.resolve(projectSandboxDockerfile)} -i ${image}`;
      }
      execSync(
        `cd ${gcRoot} && node scripts/build_sandbox.js -s ${buildArgs}`,
        {
          stdio: 'inherit',
          env: {
            ...process.env,
            QWEN_SANDBOX: config.command, // in case sandbox is enabled via flags (see config.ts under cli package)
          },
        },
      );
    }
  }

  // Images are never pulled: the sandbox only runs a locally built image.
  writeStderrLine(`Checking for sandbox image: ${image}`);
  if (!(await imageExists(config.command, image))) {
    throw new FatalSandboxError(
      `Sandbox image '${image}' was not found locally. Build it with \`npm run build:sandbox\` under the qwen-code repo, or set tools.sandboxImage / QWEN_SANDBOX_IMAGE to an image that is already present.`,
    );
  }

  // use interactive mode and auto-remove container on exit
  // run init binary inside container to forward signals & reap zombies
  const args = [
    'run',
    '--pull=never',
    '-i',
    '--rm',
    '--init',
    '--workdir',
    containerWorkdir,
  ];

  // add custom flags from SANDBOX_FLAGS
  if (process.env['SANDBOX_FLAGS']) {
    const flags = parse(process.env['SANDBOX_FLAGS'], process.env).filter(
      (f): f is string => typeof f === 'string',
    );
    args.push(...flags);
  }

  // add TTY only if stdin is TTY as well, i.e. for piped input don't init TTY in container
  if (process.stdin.isTTY) {
    args.push('-t');
  }

  // Containers get no network unless the user configures one explicitly.
  if (!hasNetworkFlag(args)) {
    args.push('--network', 'none');
  }

  // mount current directory as working directory in sandbox (set via --workdir)
  args.push('--volume', `${workdir}:${containerWorkdir}`);

  // The host CLI later loads and runs what lives in the user settings dir
  // (hooks, MCP servers, extensions, trusted folders), so the container only
  // ever sees it read-only. The sandboxed CLI gets a home of its own that the
  // host never reads, seeded with copies of the config files on every launch.
  const userSettingsDirRealPath =
    ensureDirectoryAndGetRealPath(getUserSettingsDir());
  const userSettingsDirInSandbox = getContainerPath(
    `/home/node/${SETTINGS_DIRECTORY_NAME}`,
  );
  const userSettingsDirContainerPath = getContainerPath(
    userSettingsDirRealPath,
  );
  args.push(
    '--volume',
    `${userSettingsDirRealPath}:${userSettingsDirInSandbox}:ro`,
  );
  if (userSettingsDirInSandbox !== userSettingsDirContainerPath) {
    args.push(
      '--volume',
      `${userSettingsDirRealPath}:${userSettingsDirContainerPath}:ro`,
    );
  }

  const sandboxHomeRealPath = prepareSandboxHome(userSettingsDirRealPath);
  const sandboxHomeContainerPath = getContainerPath(sandboxHomeRealPath);
  args.push('--volume', `${sandboxHomeRealPath}:${sandboxHomeContainerPath}`);
  for (const dir of SANDBOX_HOME_CONFIG_DIRS) {
    const hostDir = path.join(userSettingsDirRealPath, dir);
    if (fs.existsSync(hostDir)) {
      args.push(
        '--volume',
        `${hostDir}:${getContainerPath(path.join(sandboxHomeRealPath, dir))}:ro`,
      );
    }
  }
  args.push('--env', `QWEN_HOME=${sandboxHomeContainerPath}`);
  args.push('--env', `QWEN_RUNTIME_DIR=${sandboxHomeContainerPath}`);

  // mount os.tmpdir() as os.tmpdir() inside container
  args.push('--volume', `${os.tmpdir()}:${getContainerPath(os.tmpdir())}`);

  // mount paths listed in SANDBOX_MOUNTS
  if (process.env['SANDBOX_MOUNTS']) {
    for (let mount of process.env['SANDBOX_MOUNTS'].split(',')) {
      if (mount.trim()) {
        // parse mount as from:to:opts
        const { from, to, opts } = parseSandboxMountSpec(mount);
        mount = `${from}:${to}:${opts}`;
        // check that from path is absolute
        if (!path.isAbsolute(from)) {
          throw new FatalSandboxError(
            `Path '${from}' listed in SANDBOX_MOUNTS must be absolute`,
          );
        }
        // check that from path exists on host
        if (!fs.existsSync(from)) {
          throw new FatalSandboxError(
            `Missing mount path '${from}' listed in SANDBOX_MOUNTS`,
          );
        }
        writeStderrLine(`SANDBOX_MOUNTS: ${from} -> ${to} (${opts})`);
        args.push('--volume', mount);
      }
    }
  }

  // name container after image, plus random suffix to avoid conflicts
  const imageName = parseSandboxImageName(image);
  const isIntegrationTest =
    process.env['QWEN_CODE_INTEGRATION_TEST'] === 'true';
  let containerName;
  if (isIntegrationTest) {
    containerName = `qwen-code-integration-test-${randomBytes(4).toString(
      'hex',
    )}`;
    writeStderrLine(`ContainerName: ${containerName}`);
  } else {
    // Random suffix, NOT a counted index: several runner registrations can
    // share one docker daemon (the CI pool packs multiple runners per
    // host), and the old count-then-run window let concurrent launches
    // pick the same index — docker then rejects the loser's `docker run`
    // with a name Conflict (exit 125). Observed at scale: 7 of 14 legs of
    // one autofix scan lost that race in a single tick. Consumers that
    // need the name parse it from the line below rather than predicting
    // it, and cleanup tooling matches on the image-name prefix, so the
    // suffix shape is free to be collision-proof.
    containerName = `${imageName}-${randomBytes(4).toString('hex')}`;
    writeStderrLine(`ContainerName (regular): ${containerName}`);
  }
  args.push('--name', containerName);
  if (containerName.length <= 64) {
    args.push('--hostname', containerName);
  }

  // copy QWEN_CODE_TEST_VAR for integration tests
  if (process.env['QWEN_CODE_TEST_VAR']) {
    args.push(
      '--env',
      `QWEN_CODE_TEST_VAR=${process.env['QWEN_CODE_TEST_VAR']}`,
    );
  }
  args.push(...getSandboxPassthroughEnvArgs());
  if (process.env['QWEN_CODE_MCP_APPROVALS_PATH']) {
    args.push(
      '--env',
      `QWEN_CODE_MCP_APPROVALS_PATH=${getContainerPath(
        process.env['QWEN_CODE_MCP_APPROVALS_PATH'],
      )}`,
    );
  }
  if (process.env['QWEN_CODE_WARNINGS_FILE']) {
    args.push(
      '--env',
      `QWEN_CODE_WARNINGS_FILE=${getContainerPath(
        process.env['QWEN_CODE_WARNINGS_FILE'],
      )}`,
    );
  }

  // Values that may be secrets are passed by name: the runtime reads them
  // from its own environment, so they never appear on its command line.
  const sandboxProcessEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_MODEL',
    SANDBOX_STDIN_ENV,
  ]) {
    if (process.env[name]) {
      args.push('--env', name);
    }
  }

  // copy TERM and COLORTERM to try to maintain terminal setup
  if (process.env['TERM']) {
    args.push('--env', `TERM=${process.env['TERM']}`);
  }
  if (process.env['COLORTERM']) {
    args.push('--env', `COLORTERM=${process.env['COLORTERM']}`);
  }

  if (process.env['TERM_PROGRAM']) {
    args.push('--env', `TERM_PROGRAM=${process.env['TERM_PROGRAM']}`);
  }

  // copy VIRTUAL_ENV if under working directory
  // also mount-replace VIRTUAL_ENV directory with <project_settings>/sandbox.venv
  // directory will be empty if not set up, which is still preferable to having host binaries
  const virtualEnv = process.env['VIRTUAL_ENV'];
  if (
    virtualEnv &&
    isContainerPathWithinWorkdir(
      getContainerPath(workdir),
      getContainerPath(virtualEnv),
    )
  ) {
    const sandboxVenvPath = path.resolve(
      SETTINGS_DIRECTORY_NAME,
      'sandbox.venv',
    );
    if (!fs.existsSync(sandboxVenvPath)) {
      fs.mkdirSync(sandboxVenvPath, { recursive: true });
    }
    args.push('--volume', `${sandboxVenvPath}:${getContainerPath(virtualEnv)}`);
    args.push('--env', `VIRTUAL_ENV=${getContainerPath(virtualEnv)}`);
  }

  // copy additional environment variables from SANDBOX_ENV
  if (process.env['SANDBOX_ENV']) {
    for (let env of process.env['SANDBOX_ENV'].split(',')) {
      if ((env = env.trim())) {
        const separator = env.indexOf('=');
        if (separator > 0) {
          const name = env.slice(0, separator);
          writeStderrLine(`SANDBOX_ENV: ${name}`);
          sandboxProcessEnv[name] = env.slice(separator + 1);
          args.push('--env', name);
        } else {
          throw new FatalSandboxError(
            'SANDBOX_ENV must be a comma-separated list of key=value pairs',
          );
        }
      }
    }
  }

  // copy NODE_OPTIONS
  const existingNodeOptions = process.env['NODE_OPTIONS'] || '';
  const allNodeOptions = [
    ...(existingNodeOptions ? [existingNodeOptions] : []),
    ...nodeArgs,
  ].join(' ');

  if (allNodeOptions.length > 0) {
    args.push('--env', `NODE_OPTIONS="${allNodeOptions}"`);
  }

  // set SANDBOX as container name
  args.push('--env', `SANDBOX=${containerName}`);

  // for podman only, use empty --authfile to skip unnecessary auth refresh overhead
  if (config.command === 'podman') {
    const emptyAuthFilePath = path.join(os.tmpdir(), 'empty_auth.json');
    fs.writeFileSync(emptyAuthFilePath, '{}', 'utf-8');
    args.push('--authfile', emptyAuthFilePath);
  }

  // Determine if the current user's UID/GID should be passed to the sandbox.
  // See shouldUseCurrentUserInSandbox for more details.
  const finalEntrypoint = entrypoint(workdir, cliArgs);

  // Check if we should use current user's UID/GID in sandbox
  // In integration test mode, we still respect SANDBOX_SET_UID_GID to allow
  // tests that need to access host's ~/.qwen (e.g., --resume functionality)
  const useCurrentUser = await shouldUseCurrentUserInSandbox();

  if (useCurrentUser) {
    // SANDBOX_SET_UID_GID is enabled: create user with host's UID/GID
    // This includes integration test mode with SANDBOX_SET_UID_GID=true,
    // allowing tests that need to access host's ~/.qwen (e.g., --resume) to work.
    // For the user-creation logic to work, the container must start as root.
    // The entrypoint script then handles dropping privileges to the correct user.
    args.push('--user', 'root');

    const uid = execSync('id -u').toString().trim();
    const gid = execSync('id -g').toString().trim();

    // Instead of passing --user to the main sandbox container, we let it
    // start as root, then create a user with the host's UID/GID, and
    // finally switch to that user to run the qwen process. This is
    // necessary on Linux to ensure the user exists within the
    // container's /etc/passwd file, which is required by os.userInfo().
    const username = 'qwen';
    const homeDir = getContainerPath(os.homedir());

    const setupUserCommands = [
      // Use -f with groupadd to avoid errors if the group already exists.
      `groupadd -f -g ${gid} ${username}`,
      // Create user only if it doesn't exist. Use -o for non-unique UID.
      `id -u ${username} &>/dev/null || useradd -o -u ${uid} -g ${gid} -d ${homeDir} -s /bin/bash ${username}`,
    ].join(' && ');

    const originalCommand = finalEntrypoint[2];
    const escapedOriginalCommand = originalCommand.replace(/'/g, "'\\''");

    // Use `su -p` to preserve the environment.
    const suCommand = `su -p ${username} -c '${escapedOriginalCommand}'`;

    // The entrypoint is always `['bash', '-c', '<command>']`, so we modify the command part.
    finalEntrypoint[2] = `${setupUserCommands} && ${suCommand}`;

    // When forcing a UID in the sandbox, $HOME can be reset to '/', so we copy $HOME as well.
    args.push('--env', `HOME=${os.homedir()}`);
  } else if (isIntegrationTest) {
    // Integration test mode with UID/GID matching disabled: use root
    args.push('--user', 'root');
  }
  // else: non-IT mode with UID/GID matching disabled - use image default user (node)

  // push container image name
  args.push(image);

  // push container entrypoint (including args)
  args.push(...finalEntrypoint);

  // spawn child and let it inherit stdio
  process.stdin.pause();
  const sandboxProcess = spawn(config.command, args, {
    stdio: 'inherit',
    env: sandboxProcessEnv,
  });

  return new Promise<number>((resolve, reject) => {
    sandboxProcess.on('error', (err) => {
      writeStderrLine(`Sandbox process error: ${err}`);
      reject(err);
    });

    sandboxProcess.on('close', (code, signal) => {
      process.stdin.resume();
      if (code !== 0 && code !== null) {
        writeStderrLine(
          `Sandbox process exited with code: ${code}, signal: ${signal}`,
        );
      }
      resolve(code ?? 1);
    });
  });
}

async function imageExists(sandbox: string, image: string): Promise<boolean> {
  return new Promise((resolve) => {
    // `images -q` lists repository:tag entries only, so a digest reference
    // (`repo@sha256:…`) lists empty even when its content is local. `image
    // inspect` resolves digest references against local content (#9527).
    const args = ['image', 'inspect', '--format', '{{.Id}}', image];
    const checkProcess = spawn(sandbox, args);

    let stdoutData = '';
    if (checkProcess.stdout) {
      checkProcess.stdout.on('data', (data) => {
        stdoutData += data.toString();
      });
    }

    checkProcess.on('error', (err) => {
      writeStderrLine(
        `Failed to start '${sandbox}' command for image check: ${err.message}`,
      );
      resolve(false);
    });

    checkProcess.on('close', () => {
      // Non-zero exit code may indicate docker daemon not running, etc.
      // The primary success indicator is non-empty stdoutData.
      resolve(stdoutData.trim() !== '');
    });
  });
}
