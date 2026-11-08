/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import dgram from 'node:dgram';
import {
  isPrivateAddress,
  poolTag,
  POOL_WIRE_VERSION,
  type PoolMembership,
} from './membership.js';

/** Where members announce themselves on the local network. */
export const DISCOVERY_GROUP = '239.255.42.99';
export const DISCOVERY_PORT = 52451;
const ANNOUNCE_MS = 5000;

export interface Announcement {
  /** host:port of the member's TLS listener. */
  address: string;
  nodeId: string;
  wire: number;
  seenAt: number;
}

/**
 * Announce this member on the LAN and listen for the others of the same
 * pool. An announcement carries only a hash of the pool id, the node id, the
 * port and the wire version: nothing that lets anyone in. Members of other
 * pools, and announcements from public addresses, are ignored.
 */
export class Discovery {
  private socket?: dgram.Socket;
  private timer?: NodeJS.Timeout;
  readonly seen = new Map<string, Announcement>();

  constructor(
    private readonly membership: PoolMembership,
    private readonly announce: boolean,
    private readonly onPeer: (announcement: Announcement) => void = () => {},
  ) {}

  start(): void {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;
    const tag = poolTag(this.membership.poolId);
    socket.on('error', () => {
      // No multicast here (a VPN, a locked-down network): configured
      // peers still work.
      this.stop();
    });
    socket.on('message', (data, remote) => {
      if (!isPrivateAddress(remote.address)) return;
      let message: { p?: string; n?: string; port?: number; w?: number };
      try {
        message = JSON.parse(data.toString('utf8')) as typeof message;
      } catch {
        return;
      }
      if (
        message.p !== tag ||
        !message.n ||
        message.n === this.membership.nodeId ||
        typeof message.port !== 'number'
      ) {
        return;
      }
      const announcement: Announcement = {
        address: `${remote.address}:${message.port}`,
        nodeId: message.n,
        wire: message.w ?? 0,
        seenAt: Date.now(),
      };
      this.seen.set(message.n, announcement);
      this.onPeer(announcement);
    });
    socket.bind(DISCOVERY_PORT, () => {
      try {
        socket.addMembership(DISCOVERY_GROUP);
        socket.setMulticastTTL(1);
      } catch {
        this.stop();
        return;
      }
      if (!this.announce) return;
      const message = Buffer.from(
        JSON.stringify({
          p: tag,
          n: this.membership.nodeId,
          port: this.membership.port,
          w: POOL_WIRE_VERSION,
        }),
      );
      const send = () =>
        socket.send(message, DISCOVERY_PORT, DISCOVERY_GROUP, () => {});
      send();
      this.timer = setInterval(send, ANNOUNCE_MS);
      this.timer.unref?.();
    });
    socket.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    try {
      this.socket?.close();
    } catch {
      // Already closed.
    }
    this.socket = undefined;
  }
}
