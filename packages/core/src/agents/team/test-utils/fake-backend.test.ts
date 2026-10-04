/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { FakeBackend } from './fake-backend.js';
import { FakeAgent } from './fake-agent.js';
import { AgentStatus } from '../../runtime/agent-types.js';
import { DISPLAY_MODE } from '../../backends/types.js';
import type { AgentSpawnConfig } from '../../backends/types.js';

/** Minimal spawn config for testing. */
function spawnConfig(agentId: string, agentName = agentId): AgentSpawnConfig {
  return {
    agentId,
    cwd: '/tmp',
    inProcess: {
      agentName,
      runtimeConfig: {
        promptConfig: {},
        modelConfig: {},
        runConfig: {},
      },
    },
  };
}

describe('FakeBackend', () => {
  // ─── Construction & init ─────────────────────────────────────

  it('has IN_PROCESS type', () => {
    const backend = new FakeBackend();
    expect(backend.type).toBe(DISPLAY_MODE.IN_PROCESS);
  });

  it('init resolves without error', async () => {
    const backend = new FakeBackend();
    await expect(backend.init()).resolves.toBeUndefined();
  });

  // ─── spawnAgent ──────────────────────────────────────────────

  it('spawns a FakeAgent and makes it accessible via getAgent', async () => {
    const backend = new FakeBackend();
    await backend.spawnAgent(spawnConfig('agent-1', 'Agent 1'));

    const agent = backend.getAgent('agent-1');
    expect(agent).toBeInstanceOf(FakeAgent);
    expect(agent!.agentName).toBe('Agent 1');
    expect(agent!.getStatus()).toBe(AgentStatus.IDLE);
  });

  it('throws on duplicate agentId', async () => {
    const backend = new FakeBackend();
    await backend.spawnAgent(spawnConfig('agent-1'));

    await expect(backend.spawnAgent(spawnConfig('agent-1'))).rejects.toThrow(
      'already exists',
    );
  });

  it('uses pre-registered script', async () => {
    const onMessage = vi.fn();
    const backend = new FakeBackend();
    backend.setScript('agent-1', { onMessage });

    await backend.spawnAgent(spawnConfig('agent-1', 'A1'));
    backend.getAgent('agent-1')!.enqueueMessage('hello');

    expect(onMessage).toHaveBeenCalledOnce();
  });

  // ─── getAgentIds ─────────────────────────────────────────────

  it('returns all spawned agent IDs', async () => {
    const backend = new FakeBackend();
    await backend.spawnAgent(spawnConfig('a1'));
    await backend.spawnAgent(spawnConfig('a2'));

    expect(backend.getAgentIds()).toEqual(['a1', 'a2']);
  });

  // ─── stopAgent / stopAll ─────────────────────────────────────

  it('stopAgent cancels a specific agent', async () => {
    const backend = new FakeBackend();
    await backend.spawnAgent(spawnConfig('a1'));
    await backend.spawnAgent(spawnConfig('a2'));

    backend.stopAgent('a1');

    expect(backend.getAgent('a1')!.getStatus()).toBe(AgentStatus.CANCELLED);
    expect(backend.getAgent('a2')!.getStatus()).toBe(AgentStatus.IDLE);
  });

  it('stopAll cancels all agents', async () => {
    const backend = new FakeBackend();
    await backend.spawnAgent(spawnConfig('a1'));
    await backend.spawnAgent(spawnConfig('a2'));

    backend.stopAll();

    expect(backend.getAgent('a1')!.getStatus()).toBe(AgentStatus.CANCELLED);
    expect(backend.getAgent('a2')!.getStatus()).toBe(AgentStatus.CANCELLED);
  });

  // ─── cleanup ─────────────────────────────────────────────────

  it('cleanup stops all agents and clears state', async () => {
    const backend = new FakeBackend();
    await backend.spawnAgent(spawnConfig('a1'));

    await backend.cleanup();

    expect(backend.getAgent('a1')).toBeUndefined();
    expect(backend.getAgentIds()).toEqual([]);
  });

  // ─── setOnAgentExit ──────────────────────────────────────────

  it('fires exit callback when agent reaches terminal status', async () => {
    const backend = new FakeBackend();
    const exitCb = vi.fn();
    backend.setOnAgentExit(exitCb);

    await backend.spawnAgent(spawnConfig('a1'));
    const agent = backend.getAgent('a1')!;

    agent.setStatus(AgentStatus.COMPLETED);
    // waitForCompletion().then() is async; give it a tick
    await new Promise((r) => setTimeout(r, 0));

    expect(exitCb).toHaveBeenCalledWith('a1', 0, null);
  });

  it('fires exit callback with code 1 for FAILED', async () => {
    const backend = new FakeBackend();
    const exitCb = vi.fn();
    backend.setOnAgentExit(exitCb);

    await backend.spawnAgent(spawnConfig('a1'));
    backend.getAgent('a1')!.setStatus(AgentStatus.FAILED);
    await new Promise((r) => setTimeout(r, 0));

    expect(exitCb).toHaveBeenCalledWith('a1', 1, null);
  });

  it('fires exit callback with null code for CANCELLED', async () => {
    const backend = new FakeBackend();
    const exitCb = vi.fn();
    backend.setOnAgentExit(exitCb);

    await backend.spawnAgent(spawnConfig('a1'));
    backend.getAgent('a1')!.abort();
    await new Promise((r) => setTimeout(r, 0));

    expect(exitCb).toHaveBeenCalledWith('a1', null, null);
  });

  // ─── waitForAll ──────────────────────────────────────────────

  it('waitForAll resolves when all agents complete', async () => {
    const backend = new FakeBackend();
    await backend.spawnAgent(spawnConfig('a1'));
    await backend.spawnAgent(spawnConfig('a2'));

    backend.getAgent('a1')!.setStatus(AgentStatus.COMPLETED);
    backend.getAgent('a2')!.setStatus(AgentStatus.COMPLETED);

    const result = await backend.waitForAll();
    expect(result).toBe(true);
  });

  it('waitForAll returns false on timeout', async () => {
    const backend = new FakeBackend();
    await backend.spawnAgent(spawnConfig('a1'));
    // a1 stays IDLE — never terminal

    const result = await backend.waitForAll(50);
    expect(result).toBe(false);
  });
});
