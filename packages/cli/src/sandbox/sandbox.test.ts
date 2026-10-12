/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { FatalSandboxError, QWEN_DIR } from '@qwen-code/qwen-code-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
const execSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    default: {
      ...actual,
      execSync: execSyncMock,
      spawn: spawnMock,
    },
    execSync: execSyncMock,
    spawn: spawnMock,
  };
});

import { isContainerPathWithinWorkdir } from '../utils/sandbox-path.js';
import {
  BUILTIN_SEATBELT_PROFILES,
  getSandboxPassthroughEnvArgs,
  resolveSeatbeltProfileFile,
  start_sandbox,
} from './sandbox.js';
import { parseSandboxImageName } from '../utils/sandboxImageName.js';
import { parseSandboxMountSpec } from '../utils/sandboxMounts.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function mockContainerHost() {
  vi.stubEnv('QWEN_HOME', '/host/qwen-home');
  vi.stubEnv('QWEN_RUNTIME_DIR', '/host/qwen-runtime');
  vi.spyOn(fs, 'existsSync').mockReturnValue(true);
  vi.spyOn(fs, 'realpathSync').mockImplementation((filePath) =>
    String(filePath),
  );
  const copyFileSync = vi.spyOn(fs, 'copyFileSync').mockReturnValue();
  vi.spyOn(fs, 'rmSync').mockReturnValue();
  execSyncMock.mockReturnValue(Buffer.from(''));
  return { copyFileSync };
}

async function runContainerSandbox(cliArgs: string[] = []) {
  const imageCheck = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
  });
  const child = new EventEmitter();
  spawnMock
    .mockImplementationOnce(() => {
      queueMicrotask(() => {
        imageCheck.stdout.emit('data', Buffer.from('image-id'));
        imageCheck.emit('close', 0);
      });
      return imageCheck;
    })
    .mockReturnValueOnce(child);

  const result = start_sandbox(
    { command: 'docker', image: 'qwen-code-sandbox:1.0.0' },
    [],
    undefined,
    [process.execPath, '/path/to/cli.js', ...cliArgs],
  );
  await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
  const [, args, options] = spawnMock.mock.calls[1] as [
    string,
    string[],
    { env: NodeJS.ProcessEnv },
  ];
  child.emit('close', 0);
  await expect(result).resolves.toBe(0);
  return { args, env: options.env };
}

function volumes(args: string[]): string[] {
  return args.flatMap((arg, i) => (args[i - 1] === '--volume' ? [arg] : []));
}

describe('start_sandbox', () => {
  it('passes the warnings file into a container sandbox', async () => {
    vi.stubEnv('SANDBOX_SET_UID_GID', 'false');
    vi.stubEnv('QWEN_CODE_WARNINGS_FILE', '/tmp/qwen-code-warnings-test.txt');
    mockContainerHost();

    const imageCheck = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
    });
    const child = new EventEmitter();
    spawnMock
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          imageCheck.stdout.emit('data', Buffer.from('image-id'));
          imageCheck.emit('close', 0);
        });
        return imageCheck;
      })
      .mockReturnValueOnce(child);

    const result = start_sandbox(
      { command: 'docker', image: 'example.com/qwen-code:latest' },
      [],
      undefined,
      [process.execPath, '/path/to/cli.js', '--debug'],
    );

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    const args = spawnMock.mock.calls[1]?.[1] as string[];
    expect(args[args.indexOf('--hostname') + 1]).toBe(
      args[args.indexOf('--name') + 1],
    );
    const warningsFlagIndex = args.indexOf(
      'QWEN_CODE_WARNINGS_FILE=/tmp/qwen-code-warnings-test.txt',
    );
    expect(args.slice(warningsFlagIndex - 1, warningsFlagIndex + 1)).toEqual([
      '--env',
      'QWEN_CODE_WARNINGS_FILE=/tmp/qwen-code-warnings-test.txt',
    ]);

    child.emit('close', 0);
    await expect(result).resolves.toBe(0);
  });

  it('lets the runtime choose a hostname for image-ID containers', async () => {
    vi.stubEnv('SANDBOX_SET_UID_GID', 'false');
    vi.stubEnv('QWEN_CODE_WARNINGS_FILE', '');
    mockContainerHost();

    const imageCheck = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
    });
    const child = new EventEmitter();
    spawnMock
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          imageCheck.stdout.emit('data', Buffer.from('image-id'));
          imageCheck.emit('close', 0);
        });
        return imageCheck;
      })
      .mockReturnValueOnce(child);

    const result = start_sandbox(
      { command: 'docker', image: `sha256:${'a'.repeat(64)}` },
      [],
      undefined,
      [process.execPath, '/path/to/cli.js', '--debug'],
    );

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    const args = spawnMock.mock.calls[1]?.[1] as string[];
    const containerName = args[args.indexOf('--name') + 1];
    expect(containerName.length).toBeGreaterThan(64);
    expect(args).not.toContain('--hostname');

    child.emit('close', 0);
    await expect(result).resolves.toBe(0);
  });

  it('omits the warnings file environment variable when it is unset', async () => {
    vi.stubEnv('SANDBOX_SET_UID_GID', 'false');
    vi.stubEnv('QWEN_CODE_WARNINGS_FILE', '');
    mockContainerHost();

    const imageCheck = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
    });
    const child = new EventEmitter();
    spawnMock
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          imageCheck.stdout.emit('data', Buffer.from('image-id'));
          imageCheck.emit('close', 0);
        });
        return imageCheck;
      })
      .mockReturnValueOnce(child);

    const result = start_sandbox(
      { command: 'docker', image: 'example.com/qwen-code:latest' },
      [],
      undefined,
      [process.execPath, '/path/to/cli.js'],
    );

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    const args = spawnMock.mock.calls[1]?.[1] as string[];
    expect(
      args.filter((arg) => arg.startsWith('QWEN_CODE_WARNINGS_FILE=')),
    ).toEqual([]);

    child.emit('close', 0);
    await expect(result).resolves.toBe(0);
  });

  it('translates the warnings file path before forwarding it on Windows', async () => {
    vi.stubEnv('SANDBOX_SET_UID_GID', 'false');
    vi.stubEnv(
      'QWEN_CODE_WARNINGS_FILE',
      'C:\\Users\\test\\Temp\\qwen-code-warnings-test.txt',
    );
    vi.spyOn(os, 'platform').mockReturnValue('win32');
    mockContainerHost();

    const imageCheck = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
    });
    const child = new EventEmitter();
    spawnMock
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          imageCheck.stdout.emit('data', Buffer.from('image-id'));
          imageCheck.emit('close', 0);
        });
        return imageCheck;
      })
      .mockReturnValueOnce(child);

    const result = start_sandbox(
      { command: 'docker', image: 'example.com/qwen-code:latest' },
      [],
      undefined,
      [process.execPath, '/path/to/cli.js'],
    );

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    const args = spawnMock.mock.calls[1]?.[1] as string[];
    const warningsFlagIndex = args.indexOf(
      'QWEN_CODE_WARNINGS_FILE=/c/Users/test/Temp/qwen-code-warnings-test.txt',
    );
    expect(args.slice(warningsFlagIndex - 1, warningsFlagIndex + 1)).toEqual([
      '--env',
      'QWEN_CODE_WARNINGS_FILE=/c/Users/test/Temp/qwen-code-warnings-test.txt',
    ]);

    child.emit('close', 0);
    await expect(result).resolves.toBe(0);
  });

  it('checks image presence with an offline inspect that sees digest references', async () => {
    vi.stubEnv('SANDBOX_SET_UID_GID', 'false');
    mockContainerHost();

    const digestImage =
      'ghcr.io/qwenlm/qwen-code@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

    const imageCheck = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
    });
    const child = new EventEmitter();
    spawnMock
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          imageCheck.stdout.emit('data', Buffer.from('sha256:local'));
          imageCheck.emit('close', 0);
        });
        return imageCheck;
      })
      .mockReturnValueOnce(child);

    const result = start_sandbox({ command: 'docker', image: digestImage }, []);

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    // Digest references never appear in a `docker images -q <image>` listing
    // even when the content is local; the presence check must be `image
    // inspect` (#9527 review).
    expect(spawnMock.mock.calls[0]).toEqual([
      'docker',
      ['image', 'inspect', '--format', '{{.Id}}', digestImage],
    ]);
    const runArgs = spawnMock.mock.calls[1]?.[1] as string[];
    expect(runArgs.slice(0, 2)).toEqual(['run', '--pull=never']);

    child.emit('close', 0);
    await expect(result).resolves.toBe(0);
  });

  it('fails with a build hint instead of pulling a missing image', async () => {
    vi.stubEnv('SANDBOX_SET_UID_GID', 'false');
    mockContainerHost();

    const imageCheck = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => imageCheck.emit('close', 1));
      return imageCheck;
    });

    await expect(
      start_sandbox(
        { command: 'docker', image: 'qwen-code-sandbox:1.0.0' },
        [],
      ),
    ).rejects.toThrow(
      "Sandbox image 'qwen-code-sandbox:1.0.0' was not found locally. Build it with `npm run build:sandbox`",
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe('container sandbox host boundary', () => {
  it('mounts the user settings dir read-only and gives the CLI its own home', async () => {
    vi.stubEnv('SANDBOX_SET_UID_GID', 'false');
    const { copyFileSync } = mockContainerHost();

    const { args } = await runContainerSandbox();

    const sandboxHome = path.join('/host/qwen-runtime', 'sandbox-home');
    const mounts = volumes(args);
    expect(mounts).toContain('/host/qwen-home:/home/node/.qwen:ro');
    expect(mounts).toContain('/host/qwen-home:/host/qwen-home:ro');
    expect(mounts).toContain(`${sandboxHome}:${sandboxHome}`);
    expect(mounts).toContain(
      `/host/qwen-home/extensions:${sandboxHome}/extensions:ro`,
    );
    expect(
      mounts.filter(
        (mount) =>
          mount.startsWith('/host/qwen-home') && !mount.endsWith(':ro'),
      ),
    ).toEqual([]);
    expect(mounts.some((m) => m.startsWith('/host/qwen-runtime:'))).toBe(false);
    expect(args).toContain(`QWEN_HOME=${sandboxHome}`);
    expect(args).toContain(`QWEN_RUNTIME_DIR=${sandboxHome}`);
    expect(copyFileSync).toHaveBeenCalledWith(
      '/host/qwen-home/settings.json',
      `${sandboxHome}/settings.json`,
      fs.constants.COPYFILE_EXCL,
    );
  });

  it('never writes a config copy through a link the container planted', async () => {
    vi.stubEnv('SANDBOX_SET_UID_GID', 'false');
    const { copyFileSync } = mockContainerHost();

    await runContainerSandbox();

    const copy = path.join('/host/qwen-runtime', 'sandbox-home', '.env');
    const rmOrder = vi
      .mocked(fs.rmSync)
      .mock.calls.findIndex(([target]) => target === copy);
    const copyOrder = copyFileSync.mock.calls.findIndex(
      ([, target]) => target === copy,
    );
    expect(rmOrder).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(fs.rmSync).mock.calls[rmOrder]?.[1]).toEqual({
      force: true,
      recursive: true,
    });
    expect(copyFileSync.mock.calls[copyOrder]?.[2]).toBe(
      fs.constants.COPYFILE_EXCL,
    );
    expect(vi.mocked(fs.rmSync).mock.invocationCallOrder[rmOrder]).toBeLessThan(
      copyFileSync.mock.invocationCallOrder[copyOrder]!,
    );
  });

  it('drops a stale sandbox copy when the host config file is gone', async () => {
    vi.stubEnv('SANDBOX_SET_UID_GID', 'false');
    mockContainerHost();
    vi.mocked(fs.existsSync).mockImplementation(
      (filePath) => filePath !== '/host/qwen-home/trustedFolders.json',
    );

    await runContainerSandbox();

    expect(fs.rmSync).toHaveBeenCalledWith(
      path.join('/host/qwen-runtime', 'sandbox-home', 'trustedFolders.json'),
      { force: true, recursive: true },
    );
    expect(fs.copyFileSync).not.toHaveBeenCalledWith(
      '/host/qwen-home/trustedFolders.json',
      expect.anything(),
    );
  });

  it('never sources a workspace bashrc at container start', async () => {
    vi.stubEnv('SANDBOX_SET_UID_GID', 'false');
    mockContainerHost();

    const { args } = await runContainerSandbox();

    const command = args[args.length - 1];
    expect(command).not.toContain('sandbox.bashrc');
    expect(command).not.toContain('source ');
  });

  it('keeps secrets off the container runtime command line', async () => {
    vi.stubEnv('SANDBOX_SET_UID_GID', 'false');
    vi.stubEnv('OPENAI_API_KEY', 'sk-local-secret');
    vi.stubEnv('SANDBOX_ENV', 'EXTRA_TOKEN=extra-secret');
    mockContainerHost();

    const { args, env } = await runContainerSandbox();

    expect(args.join(' ')).not.toContain('sk-local-secret');
    expect(args.join(' ')).not.toContain('extra-secret');
    expect(args).toContain('OPENAI_API_KEY');
    expect(args).toContain('EXTRA_TOKEN');
    expect(env['OPENAI_API_KEY']).toBe('sk-local-secret');
    expect(env['EXTRA_TOKEN']).toBe('extra-secret');
  });

  it('binds the debug inspector to loopback and publishes no ports', async () => {
    vi.stubEnv('SANDBOX_SET_UID_GID', 'false');
    vi.stubEnv('DEBUG', '1');
    vi.stubEnv('NODE_ENV', 'production');
    mockContainerHost();

    const { args } = await runContainerSandbox();

    const command = args[args.length - 1];
    expect(command).toContain('--inspect-brk=127.0.0.1:9229');
    expect(command).not.toContain('0.0.0.0');
    expect(args).not.toContain('--publish');
  });

  it('disables container networking unless SANDBOX_FLAGS chooses a network', async () => {
    vi.stubEnv('SANDBOX_SET_UID_GID', 'false');
    mockContainerHost();

    const { args } = await runContainerSandbox();
    const networkIndex = args.indexOf('--network');
    expect(args.slice(networkIndex, networkIndex + 2)).toEqual([
      '--network',
      'none',
    ]);
    expect(args).not.toContain('--add-host');
  });

  it('leaves networking to an explicit SANDBOX_FLAGS network choice', async () => {
    vi.stubEnv('SANDBOX_SET_UID_GID', 'false');
    vi.stubEnv('SANDBOX_FLAGS', '--network=host');
    mockContainerHost();

    const { args } = await runContainerSandbox();
    expect(args).toContain('--network=host');
    expect(args).not.toContain('--network');
  });
});

describe('resolveSeatbeltProfileFile', () => {
  it('strips the chunks segment from bundled seatbelt profile paths', () => {
    const bundleDir = path.resolve(path.sep, 'tmp', 'qwen', 'lib');
    const chunkUrl = pathToFileURL(
      path.join(bundleDir, 'chunks', 'sandbox-AAAA.js'),
    ).toString();

    expect(resolveSeatbeltProfileFile('permissive-open', chunkUrl)).toBe(
      path.join(bundleDir, 'sandbox-macos-permissive-open.sb'),
    );
  });

  it('keeps source-mode seatbelt profile paths next to the module', () => {
    const serveDir = path.resolve(
      path.sep,
      'repo',
      'packages',
      'cli',
      'src',
      'serve',
    );
    const sourceUrl = pathToFileURL(
      path.join(serveDir, 'sandbox.ts'),
    ).toString();

    expect(resolveSeatbeltProfileFile('restrictive-closed', sourceUrl)).toBe(
      path.join(serveDir, 'sandbox-macos-restrictive-closed.sb'),
    );
  });

  it('keeps every builtin seatbelt profile colocated with the real module', () => {
    // Uses the default `import.meta.url` (the real module location), so this
    // fails loudly if sandbox.ts or the .sb profiles move without the other.
    // Iterate the module's own list rather than a hand-copied snapshot, so a
    // profile added to `BUILTIN_SEATBELT_PROFILES` without its `.sb` file
    // fails here instead of on a `sandbox-exec` ENOENT at launch. The length
    // guard keeps an emptied list from passing the loop vacuously.
    expect(BUILTIN_SEATBELT_PROFILES.length).toBeGreaterThan(0);
    for (const profile of BUILTIN_SEATBELT_PROFILES) {
      const profileFile = resolveSeatbeltProfileFile(profile);
      expect(fs.existsSync(profileFile), `missing ${profileFile}`).toBe(true);
    }
  });

  it('rejects profiles that are not built in instead of loading a project file', async () => {
    expect(() => resolveSeatbeltProfileFile('project-profile')).toThrow(
      FatalSandboxError,
    );

    vi.stubEnv('SEATBELT_PROFILE', 'project-profile');
    const existsSync = vi.spyOn(fs, 'existsSync');
    await expect(
      start_sandbox({ command: 'sandbox-exec', image: '' }),
    ).rejects.toThrow("Unknown macos seatbelt profile 'project-profile'");
    expect(existsSync).not.toHaveBeenCalledWith(
      path.join(QWEN_DIR, 'sandbox-macos-project-profile.sb'),
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('creates the read-only extensions dir before entering the profile', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-seatbelt-'));
    try {
      vi.stubEnv('QWEN_HOME', home);
      vi.stubEnv('QWEN_RUNTIME_DIR', undefined);
      vi.stubEnv('SEATBELT_PROFILE', undefined);
      execSyncMock.mockReturnValue(Buffer.from(os.tmpdir()));
      const child = new EventEmitter();
      spawnMock.mockImplementationOnce(() => {
        expect(fs.statSync(path.join(home, 'extensions')).isDirectory()).toBe(
          true,
        );
        return child;
      });
      const cliConfig = {
        getTargetDir: () => process.cwd(),
        getWorkspaceContext: () => ({ getDirectories: () => [process.cwd()] }),
      } as unknown as Parameters<typeof start_sandbox>[2];

      const result = start_sandbox(
        { command: 'sandbox-exec', image: '' },
        [],
        cliConfig,
        [process.execPath, '/path/to/cli.js'],
      );
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
      const [command, args] = spawnMock.mock.calls[0] as [string, string[]];
      child.emit('close', 0);
      await expect(result).resolves.toBe(0);

      expect(command).toBe('sandbox-exec');
      expect(args[args.indexOf('-f') + 1]).toBe(
        resolveSeatbeltProfileFile('permissive-closed'),
      );
      expect(args).toContain(`QWEN_DIR=${fs.realpathSync(home)}`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('defaults to the profile that allows no listening', async () => {
    vi.stubEnv('SEATBELT_PROFILE', undefined);
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    await expect(
      start_sandbox({ command: 'sandbox-exec', image: '' }),
    ).rejects.toThrow('sandbox-macos-permissive-closed.sb');
    expect(process.env['SEATBELT_PROFILE']).toBe('permissive-closed');
  });

  it('throws missing file errors with the resolved seatbelt profile path', async () => {
    vi.stubEnv('SEATBELT_PROFILE', 'permissive-open');
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const expectedPath = resolveSeatbeltProfileFile('permissive-open');

    await expect(
      start_sandbox({ command: 'sandbox-exec', image: '' }),
    ).rejects.toThrow(
      new FatalSandboxError(
        `Missing macos seatbelt profile file '${expectedPath}'`,
      ),
    );
  });
});

describe('getSandboxPassthroughEnvArgs', () => {
  it('passes only the allowlisted variables into container sandboxes', () => {
    expect(
      getSandboxPassthroughEnvArgs({
        QWEN_DEBUG_LOG_FILE: '0',
        QWEN_CODE_LEGACY_MCP_BLOCKING: '1',
        // Removed daemon/desktop attribution markers are not forwarded.
        QWEN_CODE_SERVE: '1',
        QWEN_CODE_DESKTOP: '1',
      }),
    ).toEqual([
      '--env',
      'QWEN_DEBUG_LOG_FILE=0',
      '--env',
      'QWEN_CODE_LEGACY_MCP_BLOCKING=1',
    ]);
  });
});

describe('isContainerPathWithinWorkdir', () => {
  it('allows the workdir itself', () => {
    expect(isContainerPathWithinWorkdir('/repo/app', '/repo/app')).toBe(true);
  });

  it('allows paths under the workdir', () => {
    expect(isContainerPathWithinWorkdir('/repo/app', '/repo/app/bin')).toBe(
      true,
    );
  });

  it('rejects sibling paths with the same prefix', () => {
    expect(
      isContainerPathWithinWorkdir('/repo/app', '/repo/app-tools/bin'),
    ).toBe(false);
  });

  it('allows absolute paths under the filesystem root workdir', () => {
    expect(isContainerPathWithinWorkdir('/', '/bin')).toBe(true);
  });

  it('normalizes trailing slashes and case for container paths', () => {
    expect(
      isContainerPathWithinWorkdir('/C/Repo/App/', '/c/repo/app/bin'),
    ).toBe(true);
  });

  it('handles converted Windows drive roots without matching sibling drives', () => {
    expect(isContainerPathWithinWorkdir('/c', '/c/tools')).toBe(true);
    expect(isContainerPathWithinWorkdir('/c', '/c2/tools')).toBe(false);
  });
});

describe('parseSandboxImageName', () => {
  it('uses the image basename and tag for container names', () => {
    expect(parseSandboxImageName('ghcr.io/qwenlm/qwen-code:0.18.3')).toBe(
      'qwen-code-0.18.3',
    );
  });

  it('handles registry ports without treating them as tags', () => {
    expect(
      parseSandboxImageName('localhost:5000/team/qwen-code-sandbox:dev'),
    ).toBe('qwen-code-sandbox-dev');
  });

  it('handles registry ports when the image is untagged', () => {
    expect(parseSandboxImageName('localhost:5000/team/qwen-code-sandbox')).toBe(
      'qwen-code-sandbox',
    );
  });

  it('drops digests from generated container names', () => {
    expect(
      parseSandboxImageName(
        'registry.example.com/team/qwen-code-sandbox@sha256:abcdef',
      ),
    ).toBe('qwen-code-sandbox');
  });

  it('keeps tags when dropping digests from generated container names', () => {
    expect(
      parseSandboxImageName(
        'registry.example.com/team/qwen-code-sandbox:dev@sha256:abcdef',
      ),
    ).toBe('qwen-code-sandbox-dev');
  });
});

describe('parseSandboxMountSpec', () => {
  it('defaults container path and options', () => {
    expect(parseSandboxMountSpec('/host/path')).toEqual({
      from: '/host/path',
      to: '/host/path',
      opts: 'ro',
    });
  });

  it('parses explicit container path and options', () => {
    expect(parseSandboxMountSpec('/host/path:/container/path:rw')).toEqual({
      from: '/host/path',
      to: '/container/path',
      opts: 'rw',
    });
  });

  it('defaults an empty container path to the host path', () => {
    expect(parseSandboxMountSpec('/host/path::rw')).toEqual({
      from: '/host/path',
      to: '/host/path',
      opts: 'rw',
    });
  });

  it('keeps the drive-letter colon in Windows host paths', () => {
    expect(
      parseSandboxMountSpec('C:\\Users\\me:/workspace:rw', 'win32'),
    ).toEqual({
      from: 'C:\\Users\\me',
      to: '/workspace',
      opts: 'rw',
    });
  });

  it('keeps the drive-letter colon in Windows host paths with forward slashes', () => {
    expect(parseSandboxMountSpec('C:/Users/me:/workspace:rw', 'win32')).toEqual(
      {
        from: 'C:/Users/me',
        to: '/workspace',
        opts: 'rw',
      },
    );
  });

  it('keeps a bare Windows host path intact', () => {
    expect(parseSandboxMountSpec('C:\\Users\\me', 'win32')).toEqual({
      from: 'C:\\Users\\me',
      to: 'C:\\Users\\me',
      opts: 'ro',
    });
  });
});
