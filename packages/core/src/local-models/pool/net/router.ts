/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import type http from 'node:http';
import {
  lendableGpuBytes,
  locateEngine,
  planLocalModel,
  type LocalModelEngineOptions,
} from '../../engine.js';
import { RpcTunnel, rpcServerBinary } from './rpc-tunnel.js';
import { resolveLocalModelPath } from '../../hf-cache.js';
import type { LocalModelConfig } from '../../local-models.js';
import type { PoolLease, PoolRequest } from '../engine-host.js';
import type { HostPool } from '../host-pool.js';
import { POOL_WIRE_VERSION, type PoolMembership } from './membership.js';
import { PeerLink } from './peer-link.js';

/** What a member says about running a model. */
export interface CanRun {
  /** An engine serves it now. */
  running: boolean;
  /** The model file is on that member. */
  downloaded: boolean;
  /** It would fit in that member's memory now. */
  fits: boolean;
  /** GPU memory the member can give (to its own engine, or a split one). */
  gpuBytes?: number;
  /** What the model needs with its context, where it was planned. */
  needBytes?: number;
  /** It can lend its GPU to a split model (an rpc-server next to its engine). */
  rpc?: boolean;
}

/** Can this machine run `model` (with its own engine options)? */
export function localCanRun(host: HostPool, request: PoolRequest): CanRun {
  const running = host.serves(request);
  let downloaded = false;
  let fits = false;
  let needBytes: number | undefined;
  let gpuBytes: number | undefined;
  try {
    resolveLocalModelPath(request.model);
    downloaded = true;
    const planned = planLocalModel(request.model, request.options);
    fits = !('problem' in planned.fit);
    needBytes = planned.bytes + planned.headroomBytes;
    gpuBytes = planned.gpu?.limit;
  } catch {
    // Not downloaded, or not readable.
  }
  try {
    gpuBytes ??= lendableGpuBytes(request.options);
  } catch {
    // No GPU to lend.
  }
  const rpc = rpcServerBinary(locateEngine(request.options)) !== undefined;
  return {
    running,
    downloaded,
    fits,
    ...(gpuBytes !== undefined ? { gpuBytes } : {}),
    ...(needBytes !== undefined ? { needBytes } : {}),
    rpc,
  };
}

interface Peer {
  nodeId: string;
  name: string;
  link: PeerLink;
  wire: number;
  /** The attach connection that tells the peer we are here. */
  attached?: Promise<unknown>;
}

interface PeerLease {
  peer: Peer;
  remote: string;
  client: string;
}

/** Ask a member at most this long whether it can run a model. */
const ASK_TIMEOUT_MS = 1500;

/**
 * Sends each request to the engine that should serve it: this machine's,
 * or another member's. A member's own requests come first everywhere: what
 * other members ask for runs only where it does not cost the owner (see
 * the order in `acquire`).
 */
export class Router {
  private readonly peers = new Map<string, Peer>();
  private readonly peerLeases = new Map<string, PeerLease>();
  /** Where each model was last sent: kept until it fails. */
  private readonly routes = new Map<string, string>();
  /** Tunnels to the members a split model runs on, per model. */
  private readonly splits = new Map<
    string,
    {
      tunnels: RpcTunnel[];
      servers: string[];
      remoteBytes: number;
      peers: string[];
    }
  >();

  constructor(
    private readonly local: HostPool,
    private readonly membership: PoolMembership | undefined,
    /** Engine options this machine serves other members with. */
    private readonly ownOptions: () => LocalModelEngineOptions | undefined,
    /** Whether this machine can run a request's model (the planner's verdict by default). */
    private readonly canRunHere: (
      host: HostPool,
      request: PoolRequest,
    ) => CanRun = localCanRun,
  ) {}

  /** A member found by discovery, or configured. */
  async addPeer(address: string): Promise<void> {
    if (!this.membership) return;
    const link = new PeerLink(this.membership, address);
    try {
      const hello = await link.call('GET', '/pool/hello', undefined, {
        timeoutMs: ASK_TIMEOUT_MS,
      });
      const nodeId = String(hello.json['nodeId'] ?? '');
      if (
        hello.status !== 200 ||
        !nodeId ||
        nodeId === this.membership.nodeId
      ) {
        link.close();
        return;
      }
      const known = this.peers.get(nodeId);
      if (known && known.link.address === address) {
        link.close();
        return;
      }
      known?.link.close();
      this.peers.set(nodeId, {
        nodeId,
        name: String(hello.json['name'] ?? nodeId),
        link,
        wire: Number(hello.json['wire'] ?? 0),
      });
    } catch {
      link.close();
    }
  }

  /** Links to the members of this version, for copying model files. */
  compatiblePeers(): Array<{ name: string; link: PeerLink }> {
    return [...this.peers.values()]
      .filter((peer) => peer.wire === POOL_WIRE_VERSION)
      .map((peer) => ({ name: peer.name, link: peer.link }));
  }

  /** The members this one knows, for `qwen pool peers`. */
  peerList(): Array<{
    nodeId: string;
    name: string;
    address: string;
    compatible: boolean;
  }> {
    return [...this.peers.values()].map((peer) => ({
      nodeId: peer.nodeId,
      name: peer.name,
      address: peer.link.address,
      compatible: peer.wire === POOL_WIRE_VERSION,
    }));
  }

  /** Answer another member: could this machine run `model`? */
  canRun(model: LocalModelConfig): CanRun {
    return this.canRunHere(this.local, {
      client: 'peer',
      model,
      options: this.ownOptions() ?? { speculation: true },
      kind: 'side',
    });
  }

  /**
   * A lease on the engine that should serve `request`. Requests from other
   * members (`fromPeer`) only ever run here, so routing cannot loop.
   */
  async acquire(
    request: PoolRequest,
    signal: AbortSignal | undefined,
    fromPeer: boolean,
  ): Promise<{ id: string; slot?: number; where: string }> {
    if (fromPeer) {
      // Another member's request runs with this machine's own engine.
      const own = this.ownOptions();
      const lease = await this.local.acquire(
        own ? { ...request, options: own } : request,
        signal,
      );
      return { id: lease.id, slot: lease.slot, where: 'local' };
    }
    const target = await this.route(request);
    const split = this.splits.get(request.model.id);
    if (!target && split) {
      // Part of the model runs on other members, through tunnels.
      const lease = await this.local.acquire(
        {
          ...request,
          options: {
            ...request.options,
            rpc: { servers: split.servers, remoteBytes: split.remoteBytes },
          },
        },
        signal,
      );
      return { id: lease.id, slot: lease.slot, where: 'split' };
    }
    if (target) {
      try {
        return await this.acquireOn(target, request, signal);
      } catch {
        // The member failed: forget the route and run it here.
        this.routes.delete(request.model.id);
      }
    }
    const lease = await this.local.acquire(request, signal);
    return { id: lease.id, slot: lease.slot, where: 'local' };
  }

  release(id: string, saveState: boolean): void {
    const remote = this.peerLeases.get(id);
    if (!remote) {
      this.local.release(id, saveState);
      return;
    }
    this.peerLeases.delete(id);
    void remote.peer.link
      .call('POST', '/pool/release', { lease: remote.remote, saveState })
      .catch(() => {});
  }

  forgetClient(client: string): void {
    this.local.forgetClient(client);
    for (const [id, lease] of [...this.peerLeases]) {
      if (lease.client === client) this.release(id, false);
    }
  }

  /** The local lease `id`, or undefined when it is another member's. */
  localLease(id: string): PoolLease | undefined {
    return this.local.lease(id);
  }

  /** Forward an engine request under a lease held on another member. */
  forward(
    id: string,
    req: http.IncomingMessage,
    body: Buffer,
    res: http.ServerResponse,
    leaseHeader: string,
  ): boolean {
    const remote = this.peerLeases.get(id);
    if (!remote) return false;
    remote.peer.link.forward(req, body, res, remote.remote, leaseHeader);
    return true;
  }

  status() {
    return {
      engines: this.local.status(),
      peers: this.peerList(),
      routes: Object.fromEntries(this.routes),
      splits: Object.fromEntries(
        [...this.splits].map(([model, split]) => [model, split.peers]),
      ),
    };
  }

  async stop(): Promise<void> {
    for (const split of this.splits.values()) {
      for (const tunnel of split.tunnels) tunnel.close();
    }
    this.splits.clear();
    for (const id of [...this.peerLeases.keys()]) this.release(id, false);
    for (const peer of this.peers.values()) peer.link.close();
    this.peers.clear();
    await this.local.stop();
  }

  /** The member to send `request` to, or undefined to run it here. */
  private async route(request: PoolRequest): Promise<Peer | undefined> {
    if (!this.membership || this.peers.size === 0) return undefined;
    // 1. An engine here already serves it.
    if (this.local.serves(request)) return undefined;
    const sticky = this.peers.get(this.routes.get(request.model.id) ?? '');
    if (sticky) return sticky;
    const compatible = [...this.peers.values()].filter(
      (peer) => peer.wire === POOL_WIRE_VERSION,
    );
    const answers = await Promise.all(
      compatible.map(async (peer) => {
        try {
          const response = await peer.link.call(
            'POST',
            '/pool/can-run',
            { model: request.model },
            { timeoutMs: ASK_TIMEOUT_MS },
          );
          return response.status === 200
            ? { peer, can: response.json as unknown as CanRun }
            : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    const usable = answers.filter((answer) => answer !== undefined);
    // 2. Another member already runs it.
    const running = usable.find((answer) => answer.can.running);
    if (running) return this.remember(request, running.peer);
    // 3. It fits here.
    const here = this.canRunHere(this.local, request);
    if (here.fits) return undefined;
    // 4. It fits on another member.
    const fits = usable.find((answer) => answer.can.fits);
    if (fits) return this.remember(request, fits.peer);
    // 5. It fits nowhere alone: split it, here (where the file is) and on
    // the members that lend the most GPU memory, until it fits.
    if (
      here.downloaded &&
      here.needBytes &&
      !this.splits.has(request.model.id)
    ) {
      await this.planSplit(request, here, usable);
    }
    // 6. Here, where it waits for room or says why it cannot run.
    return undefined;
  }

  /** Open tunnels to enough lending members for `request`'s model to fit. */
  private async planSplit(
    request: PoolRequest,
    here: CanRun,
    answers: Array<{ peer: Peer; can: CanRun }>,
  ): Promise<void> {
    const lenders = answers
      .filter((answer) => answer.can.rpc && (answer.can.gpuBytes ?? 0) > 0)
      .sort((a, b) => (b.can.gpuBytes ?? 0) - (a.can.gpuBytes ?? 0));
    let total = here.gpuBytes ?? 0;
    const chosen: Array<{ peer: Peer; bytes: number }> = [];
    for (const lender of lenders) {
      if (total >= here.needBytes!) break;
      chosen.push({ peer: lender.peer, bytes: lender.can.gpuBytes! });
      total += lender.can.gpuBytes!;
    }
    if (chosen.length === 0 || total < here.needBytes!) return;
    const tunnels: RpcTunnel[] = [];
    const servers: string[] = [];
    try {
      for (const { peer } of chosen) {
        const tunnel = new RpcTunnel(peer.link);
        servers.push(await tunnel.open());
        tunnels.push(tunnel);
      }
    } catch {
      for (const tunnel of tunnels) tunnel.close();
      return;
    }
    this.splits.set(request.model.id, {
      tunnels,
      servers,
      remoteBytes: chosen.reduce((sum, lender) => sum + lender.bytes, 0),
      peers: chosen.map(({ peer }) => peer.nodeId),
    });
  }

  private remember(request: PoolRequest, peer: Peer): Peer {
    this.routes.set(request.model.id, peer.nodeId);
    return peer;
  }

  private async acquireOn(
    peer: Peer,
    request: PoolRequest,
    signal: AbortSignal | undefined,
  ): Promise<{ id: string; where: string }> {
    const self = `peer:${this.membership!.nodeId}`;
    peer.attached ??= peer.link
      .attach(self, () => {
        // The link dropped: its leases are gone with it.
        peer.attached = undefined;
        for (const [id, lease] of [...this.peerLeases]) {
          if (lease.peer === peer) this.peerLeases.delete(id);
        }
        this.routes.forEach((nodeId, model) => {
          if (nodeId === peer.nodeId) this.routes.delete(model);
        });
      })
      .catch((error: unknown) => {
        peer.attached = undefined;
        throw error;
      });
    await peer.attached;
    // The member uses its own engine and options; it needs only the model.
    const { options: _options, promptCacheDir: _dir, ...rest } = request;
    const response = await peer.link.call(
      'POST',
      '/pool/acquire',
      { ...rest, client: self },
      signal ? { signal } : {},
    );
    if (response.status !== 200) {
      throw new Error(String(response.json['error'] ?? response.status));
    }
    const id = `p.${randomBytes(8).toString('hex')}`;
    this.peerLeases.set(id, {
      peer,
      remote: String(response.json['lease']),
      client: request.client,
    });
    return { id, where: peer.nodeId };
  }
}
