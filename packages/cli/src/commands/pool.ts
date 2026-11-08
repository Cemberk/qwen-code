/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import http from 'node:http';
import type { CommandModule } from 'yargs';

interface PoolArgs {
  action:
    | 'serve'
    | 'status'
    | 'stop'
    | 'create'
    | 'invite'
    | 'join'
    | 'share'
    | 'add-peer'
    | 'leave';
}

/** One request to the running daemon; undefined when none answers. */
async function ask(
  method: 'GET' | 'POST',
  path: string,
): Promise<Record<string, unknown> | undefined> {
  const { poolAddress, poolKey } = await import('@qwen-code/qwen-code-core');
  return new Promise((resolve) => {
    const request = http.request(
      {
        socketPath: poolAddress(),
        path,
        method,
        timeout: 5000,
        headers: { authorization: `Bearer ${poolKey()}` },
      },
      (response) => {
        let data = '';
        response.on('data', (chunk) => (data += chunk));
        response.on('end', () => {
          try {
            resolve(JSON.parse(data) as Record<string, unknown>);
          } catch {
            resolve(undefined);
          }
        });
      },
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(undefined));
    request.end();
  });
}

const ACTIONS = [
  'serve',
  'status',
  'stop',
  'create',
  'invite',
  'join',
  'share',
  'add-peer',
  'leave',
] as const;

export const poolCommand: CommandModule = {
  command: 'pool <action> [value]',
  describe:
    'The local model pool: one background process that runs local models for every qwen on this machine, and shares them with your other devices',
  builder: (yargs) =>
    yargs
      .positional('action', {
        type: 'string',
        choices: ACTIONS,
        describe: [
          'serve: run it (qwen starts it when needed)',
          'status: what it runs and the pool members it knows',
          'stop: stop it and its engines',
          'create: make a pool of your devices, with this one in it',
          'invite: print the token another device joins with',
          'join <token>: join the pool a token names',
          'share on|off: serve models to the other members (keeps the pool running)',
          'add-peer <host:port>: a member to reach where discovery cannot',
          'leave: leave the pool',
        ].join('; '),
      })
      .positional('value', { type: 'string' })
      .example('$0 pool status', 'Show the engines, sessions and pool members')
      .example('$0 pool create', 'Start a pool of your devices on this one')
      .example('$0 pool join qwen-pool:...', 'Join it from another device')
      .strict(),
  handler: async (argv) => {
    const { writeStdoutLine, writeStderrLine } = await import(
      '../utils/stdioHelpers.js'
    );
    const { action, value } = argv as unknown as PoolArgs & { value?: string };
    const core = await import('@qwen-code/qwen-code-core');
    if (action === 'serve') {
      const daemon = await core.startPoolDaemon({
        onExit: () => process.exit(0),
      });
      if (!daemon) {
        writeStdoutLine('The local model pool is already running.');
        return;
      }
      writeStdoutLine(
        `The local model pool listens on ${daemon.address} (log: ${core.poolLogFile()}).`,
      );
      const stop = () => void daemon.close();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      await daemon.closed;
      return;
    }
    if (action === 'status') {
      const status = await ask('GET', '/pool/status');
      const membership = core.readMembership();
      if (!status) {
        writeStdoutLine('The local model pool is not running.');
        if (membership) {
          writeStdoutLine(
            `  member of a pool as "${membership.name}"${membership.share ? ', sharing' : ''}`,
          );
        }
        return;
      }
      const engines = (status['engines'] ?? []) as Array<{
        model?: string;
        leases: number;
        waiting: number;
        conversations: number;
      }>;
      writeStdoutLine(`The local model pool runs (pid ${status['pid']}).`);
      writeStdoutLine(`  qwen sessions attached: ${status['clients']}`);
      if (engines.length === 0) writeStdoutLine('  engines: none running');
      for (const engine of engines) {
        writeStdoutLine(
          `  engine: ${engine.model ?? '(starting)'}, ${engine.conversations} conversation(s) in slots, ${engine.leases} request(s) running, ${engine.waiting} waiting`,
        );
      }
      const pool = status['pool'] as
        | { name: string; sharing: boolean; listening?: string }
        | undefined;
      if (pool) {
        writeStdoutLine(
          `  pool member "${pool.name}", ${pool.sharing ? 'sharing its models' : 'not sharing'}`,
        );
        const peers = (status['peers'] ?? []) as Array<{
          name: string;
          address: string;
          compatible: boolean;
        }>;
        if (peers.length === 0) writeStdoutLine('  no other members found yet');
        for (const peer of peers) {
          writeStdoutLine(
            `  member "${peer.name}" at ${peer.address}${peer.compatible ? '' : ' (another version: update it to use it)'}`,
          );
        }
        const routes = (status['routes'] ?? {}) as Record<string, string>;
        for (const [model, nodeId] of Object.entries(routes)) {
          const peer = peers.find(
            (candidate) => (candidate as { nodeId?: string }).nodeId === nodeId,
          );
          writeStdoutLine(`  ${model} runs on "${peer?.name ?? nodeId}"`);
        }
      }
      return;
    }
    if (action === 'stop') {
      const answer = await ask('POST', '/pool/stop');
      if (answer) writeStdoutLine('The local model pool is stopping.');
      else writeStderrLine('The local model pool is not running.');
      return;
    }

    // Membership changes: the running daemon picks them up when it starts
    // again, so stop it (the next qwen starts it).
    const restart = async () => {
      if (await ask('POST', '/pool/stop')) {
        writeStdoutLine(
          'Stopped the running pool: it starts again with the change at the next qwen, or with qwen pool serve.',
        );
      }
    };
    const membership = core.readMembership();
    if (action === 'create') {
      if (membership && value !== 'force') {
        writeStderrLine(
          'This device is already in a pool: qwen pool leave first (or qwen pool create force).',
        );
        process.exitCode = 1;
        return;
      }
      const created = core.createPool();
      writeStdoutLine(
        `Made a pool with this device ("${created.name}") in it.`,
      );
      writeStdoutLine(
        'Run qwen pool share on here to serve its models to the others, and qwen pool invite for the token another device joins with.',
      );
      await restart();
      return;
    }
    if (action === 'invite') {
      if (!membership) {
        writeStderrLine('This device is in no pool: qwen pool create first.');
        process.exitCode = 1;
        return;
      }
      writeStdoutLine(
        'On the other device, run this (the token holds the pool key: pass it only over a channel you trust):',
      );
      writeStdoutLine(`  qwen pool join ${core.inviteToken(membership)}`);
      return;
    }
    if (action === 'join') {
      if (!value) {
        writeStderrLine('Give the token qwen pool invite printed.');
        process.exitCode = 1;
        return;
      }
      try {
        const joined = core.joinPool(value);
        writeStdoutLine(
          `Joined the pool as "${joined.name}". Run qwen pool share on to serve this device's models to the others too.`,
        );
      } catch (error) {
        writeStderrLine(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
        return;
      }
      await restart();
      return;
    }
    if (!membership) {
      writeStderrLine(
        'This device is in no pool: qwen pool create or qwen pool join first.',
      );
      process.exitCode = 1;
      return;
    }
    if (action === 'share') {
      if (value !== 'on' && value !== 'off') {
        writeStderrLine('qwen pool share on, or qwen pool share off.');
        process.exitCode = 1;
        return;
      }
      core.writeMembership({ ...membership, share: value === 'on' });
      writeStdoutLine(
        value === 'on'
          ? `This device now serves its models to the pool's other members, on TCP port ${membership.port} (LAN only). The pool keeps running for them while qwen pool serve (or any qwen) runs here.`
          : 'This device no longer serves its models to the other members.',
      );
      await restart();
      return;
    }
    if (action === 'add-peer') {
      if (!value || !/^[^\s:]+:\d+$/.test(value)) {
        writeStderrLine(
          'Give the member as host:port, for example 192.168.1.20:52450.',
        );
        process.exitCode = 1;
        return;
      }
      core.writeMembership({
        ...membership,
        peers: [...new Set([...membership.peers, value])],
      });
      writeStdoutLine(`Will reach the member at ${value}.`);
      await restart();
      return;
    }
    // leave
    const { rmSync } = await import('node:fs');
    const path = await import('node:path');
    rmSync(path.join(core.poolDir(), 'membership.json'), { force: true });
    writeStdoutLine('Left the pool.');
    await restart();
  },
};
