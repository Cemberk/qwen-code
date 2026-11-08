/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import http from 'node:http';
import type { CommandModule } from 'yargs';

interface PoolArgs {
  action: 'serve' | 'status' | 'stop';
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

export const poolCommand: CommandModule = {
  command: 'pool <action>',
  describe:
    'The local model pool: one background process that runs local models for every qwen on this machine',
  builder: (yargs) =>
    yargs
      .positional('action', {
        type: 'string',
        choices: ['serve', 'status', 'stop'],
        describe:
          'serve: run it (qwen starts it when needed); status: what it runs; stop: stop it and its engines',
      })
      .example('$0 pool status', 'Show the engines and sessions it serves')
      .strict(),
  handler: async (argv) => {
    const { writeStdoutLine, writeStderrLine } = await import(
      '../utils/stdioHelpers.js'
    );
    const { action } = argv as unknown as PoolArgs;
    if (action === 'serve') {
      const { startPoolDaemon, poolLogFile } = await import(
        '@qwen-code/qwen-code-core'
      );
      const daemon = await startPoolDaemon({ onExit: () => process.exit(0) });
      if (!daemon) {
        writeStdoutLine('The local model pool is already running.');
        return;
      }
      writeStdoutLine(
        `The local model pool listens on ${daemon.address} (log: ${poolLogFile()}).`,
      );
      const stop = () => void daemon.close();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      await daemon.closed;
      return;
    }
    if (action === 'status') {
      const status = await ask('GET', '/pool/status');
      if (!status) {
        writeStdoutLine('The local model pool is not running.');
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
      return;
    }
    const answer = await ask('POST', '/pool/stop');
    if (answer) writeStdoutLine('The local model pool is stopping.');
    else writeStderrLine('The local model pool is not running.');
  },
};
