/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LocalModelEngineOptions } from '../../engine.js';
import { ensurePoolDir, poolDir } from '../paths.js';

/** Changes whenever peers could no longer understand each other. */
export const POOL_WIRE_VERSION = 1;

/** The TCP port pool members listen on for each other (TLS). */
export const DEFAULT_POOL_PORT = 52450;

/**
 * This machine's place in a pool of the user's devices, kept in the pool
 * folder (readable by the user only). The key is the pool's secret: every
 * member has it, it authenticates and encrypts their links (TLS with a
 * pre-shared key), and it never goes over the network.
 */
export interface PoolMembership {
  /** Identifies the pool; its hash is all discovery announces. */
  poolId: string;
  /** 32 bytes, hex. */
  key: string;
  /** This member, stable across restarts. */
  nodeId: string;
  /** Shown to the other members. */
  name: string;
  /** Serve this machine's models to the other members. */
  share: boolean;
  port: number;
  /** Members to try beside the ones discovery finds: host:port. */
  peers: string[];
  /**
   * How this machine runs models for the other members: its own engine
   * and options, remembered from its local qwen sessions.
   */
  engine?: Pick<
    LocalModelEngineOptions,
    'enginePath' | 'extraArgs' | 'speculation'
  >;
}

const FILE = 'membership.json';

export function readMembership(
  dir: string = poolDir(),
): PoolMembership | undefined {
  try {
    const value = JSON.parse(
      readFileSync(path.join(dir, FILE), 'utf8'),
    ) as PoolMembership;
    return /^[0-9a-f]{64}$/.test(value.key) && value.poolId && value.nodeId
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

export function writeMembership(
  membership: PoolMembership,
  dir: string = poolDir(),
): void {
  const file = path.join(ensurePoolDir(dir), FILE);
  const temp = `${file}.${process.pid}`;
  writeFileSync(temp, JSON.stringify(membership, null, 2), { mode: 0o600 });
  renameSync(temp, file);
}

function newMember(poolId: string, key: string): PoolMembership {
  return {
    poolId,
    key,
    nodeId: randomBytes(8).toString('hex'),
    name: os.hostname(),
    share: false,
    port: DEFAULT_POOL_PORT,
    peers: [],
  };
}

/** Make a new pool with this machine as its first member. */
export function createPool(dir: string = poolDir()): PoolMembership {
  const membership = newMember(
    randomBytes(8).toString('hex'),
    randomBytes(32).toString('hex'),
  );
  writeMembership(membership, dir);
  return membership;
}

/** What a join token carries: the pool's secret and where to reach a member. */
interface JoinToken {
  v: number;
  poolId: string;
  key: string;
  peers: string[];
}

const TOKEN_PREFIX = 'qwen-pool:';

/**
 * A token another device joins with. It holds the pool's secret: pass it
 * only over a channel you trust (your own terminal, a private message).
 */
export function inviteToken(
  membership: PoolMembership,
  addresses: string[] = localAddresses().map(
    (address) => `${address}:${membership.port}`,
  ),
): string {
  const token: JoinToken = {
    v: POOL_WIRE_VERSION,
    poolId: membership.poolId,
    key: membership.key,
    peers: addresses,
  };
  return (
    TOKEN_PREFIX + Buffer.from(JSON.stringify(token)).toString('base64url')
  );
}

/** Join the pool a token names; this machine's membership is replaced. */
export function joinPool(
  token: string,
  dir: string = poolDir(),
): PoolMembership {
  if (!token.startsWith(TOKEN_PREFIX)) {
    throw new Error(
      'This is not a pool join token (it starts with "qwen-pool:").',
    );
  }
  let parsed: JoinToken;
  try {
    parsed = JSON.parse(
      Buffer.from(token.slice(TOKEN_PREFIX.length), 'base64url').toString(
        'utf8',
      ),
    ) as JoinToken;
  } catch {
    throw new Error('The join token is damaged: copy it again.');
  }
  if (parsed.v !== POOL_WIRE_VERSION) {
    throw new Error(
      'The join token comes from another version of Qwen Code: update both devices.',
    );
  }
  if (!/^[0-9a-f]{64}$/.test(parsed.key) || !parsed.poolId) {
    throw new Error('The join token is damaged: copy it again.');
  }
  const membership = {
    ...newMember(parsed.poolId, parsed.key),
    peers: parsed.peers.filter((peer) => /^[^\s:]+:\d+$/.test(peer)),
  };
  writeMembership(membership, dir);
  return membership;
}

/** The hash of the pool id that discovery announces. */
export function poolTag(poolId: string): string {
  return createHash('sha256')
    .update(`qwen-pool\0${poolId}`)
    .digest('hex')
    .slice(0, 16);
}

/** Private (LAN) addresses only: the pool never crosses the internet. */
export function isPrivateAddress(address: string): boolean {
  const v4 = address.replace(/^::ffff:/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) {
    const [a, b] = v4.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  const v6 = address.toLowerCase();
  return v6 === '::1' || v6.startsWith('fe80:') || /^f[cd]/.test(v6);
}

/** This machine's private IPv4 addresses, for invitations. */
export function localAddresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (
        entry.family === 'IPv4' &&
        !entry.internal &&
        isPrivateAddress(entry.address)
      ) {
        addresses.push(entry.address);
      }
    }
  }
  return addresses;
}
