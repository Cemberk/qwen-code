/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type http from 'node:http';
import https from 'node:https';
import type { TLSSocket } from 'node:tls';
import { poolTag, type PoolMembership } from './membership.js';

/**
 * Links between pool members: TLS 1.2 with the pool's key as a pre-shared
 * key, and an ephemeral (ECDHE) exchange on top so that recorded traffic
 * stays private even if the key leaks later. Only members hold the key, so
 * the handshake itself is the authentication; no certificates are needed.
 */
const CIPHERS = 'ECDHE-PSK-CHACHA20-POLY1305:ECDHE-PSK-AES256-CBC-SHA384';

/** The member a connection came from, set during its handshake. */
const PEER = Symbol('qwen-pool-peer');

type PeerSocket = TLSSocket & { [PEER]?: string };

/** TLS options for the member's listener. */
export function peerServerOptions(
  membership: PoolMembership,
): https.ServerOptions {
  const key = Buffer.from(membership.key, 'hex');
  return {
    ciphers: CIPHERS,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.2',
    pskIdentityHint: poolTag(membership.poolId),
    pskCallback: (socket, identity) => {
      // Identities are node ids; anything else is not a member.
      if (!/^[0-9a-f]{16}$/.test(identity)) return null;
      (socket as PeerSocket)[PEER] = identity;
      return key;
    },
  };
}

/** The node id of the member that sent `req`, from its TLS handshake. */
export function peerOf(req: http.IncomingMessage): string | undefined {
  return (req.socket as PeerSocket)[PEER];
}

export interface PeerResponse {
  status: number;
  json: Record<string, unknown>;
}

/** Requests from this member to another one, over a pooled TLS agent. */
export class PeerLink {
  private readonly agent: https.Agent;
  readonly host: string;
  readonly port: number;

  constructor(
    membership: PoolMembership,
    /** host:port */
    readonly address: string,
  ) {
    const index = address.lastIndexOf(':');
    this.host = address.slice(0, index);
    this.port = Number(address.slice(index + 1));
    const key = Buffer.from(membership.key, 'hex');
    this.agent = new https.Agent({
      keepAlive: true,
      ciphers: CIPHERS,
      maxVersion: 'TLSv1.2',
      // The pre-shared key authenticates the server; there is no
      // certificate to check.
      checkServerIdentity: () => undefined,
      pskCallback: () => ({ psk: key, identity: membership.nodeId }),
    });
  }

  /** One JSON request; rejects when the member cannot be reached. */
  call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<PeerResponse> {
    const text = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const request = https.request(
        {
          host: this.host,
          port: this.port,
          path,
          method,
          agent: this.agent,
          ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          headers:
            text === undefined
              ? {}
              : {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(text),
                },
        },
        (response) => {
          let data = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => (data += chunk));
          response.on('end', () => {
            let json: Record<string, unknown> = {};
            try {
              json = JSON.parse(data) as Record<string, unknown>;
            } catch {
              // Keep the status.
            }
            resolve({ status: response.statusCode ?? 0, json });
          });
        },
      );
      request.on('timeout', () => request.destroy(new Error('timed out')));
      request.on('error', reject);
      request.end(text);
    });
  }

  /**
   * Hold an attach connection on the member as `client`, so it knows when
   * this member goes away; resolves once attached, calls `onClose` when the
   * link drops.
   */
  attach(client: string, onClose: () => void): Promise<http.ClientRequest> {
    return new Promise((resolve, reject) => {
      const request = https.get(
        {
          host: this.host,
          port: this.port,
          path: `/pool/attach?client=${encodeURIComponent(client)}`,
          // Its own connection: the agent's sockets come and go.
          agent: new https.Agent({
            ciphers: CIPHERS,
            maxVersion: 'TLSv1.2',
            checkServerIdentity: () => undefined,
            pskCallback: this.agent.options.pskCallback,
          }),
        },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            reject(new Error(`attach refused: HTTP ${response.statusCode}`));
            return;
          }
          response.once('data', () => resolve(request));
          response.on('close', onClose);
        },
      );
      request.on('error', (error) => {
        reject(error);
        onClose();
      });
    });
  }

  /**
   * Forward an engine request to the member under its lease `remoteLease`,
   * streaming the answer back; the member stops generating if `res` closes.
   */
  forward(
    req: http.IncomingMessage,
    body: Buffer,
    res: http.ServerResponse,
    remoteLease: string,
    leaseHeader: string,
  ): void {
    const upstream = https.request(
      {
        host: this.host,
        port: this.port,
        path: req.url,
        method: req.method,
        agent: this.agent,
        headers: {
          ...(req.headers['content-type']
            ? { 'content-type': req.headers['content-type'] }
            : {}),
          accept: req.headers['accept'] ?? '*/*',
          [leaseHeader]: remoteLease,
          'content-length': body.length,
        },
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on('error', (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      } else {
        res.destroy();
      }
    });
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    upstream.end(body);
  }

  close(): void {
    this.agent.destroy();
  }
}
