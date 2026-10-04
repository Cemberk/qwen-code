/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AsyncHookRegistry, generateHookId } from './asyncHookRegistry.js';
import { HookEventName } from './types.js';

describe('AsyncHookRegistry', () => {
  let registry: AsyncHookRegistry;

  beforeEach(() => {
    registry = new AsyncHookRegistry();
  });

  describe('generateHookId', () => {
    it('should generate unique hook IDs', () => {
      const id1 = generateHookId();
      const id2 = generateHookId();
      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^hook_\d+_[a-z0-9]+$/);
    });
  });

  describe('register', () => {
    it('should register a new async hook', () => {
      const hookId = registry.register({
        hookId: 'test-hook-1',
        hookName: 'Test Hook',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: Date.now(),
        timeout: 60000,
        stdout: '',
        stderr: '',
      });

      expect(hookId).toBe('test-hook-1');
      expect(registry['pendingHooks'].size > 0).toBe(true);
    });
  });

  describe('updateOutput', () => {
    it('should update stdout', () => {
      registry.register({
        hookId: 'test-hook-1',
        hookName: 'Test Hook',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: Date.now(),
        timeout: 60000,
        stdout: '',
        stderr: '',
      });

      registry.updateOutput('test-hook-1', 'stdout data', undefined);

      const pending = Array.from(registry['pendingHooks'].values());
      expect(pending[0].stdout).toBe('stdout data');
    });

    it('should update stderr', () => {
      registry.register({
        hookId: 'test-hook-1',
        hookName: 'Test Hook',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: Date.now(),
        timeout: 60000,
        stdout: '',
        stderr: '',
      });

      registry.updateOutput('test-hook-1', undefined, 'stderr data');

      const pending = Array.from(registry['pendingHooks'].values());
      expect(pending[0].stderr).toBe('stderr data');
    });
  });

  describe('complete', () => {
    it('should mark hook as completed and remove from pending', () => {
      registry.register({
        hookId: 'test-hook-1',
        hookName: 'Test Hook',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: Date.now(),
        timeout: 60000,
        stdout: '',
        stderr: '',
      });

      registry.complete('test-hook-1', { continue: true });

      expect(registry['pendingHooks'].size > 0).toBe(false);
    });

    it('should process JSON output for system message', () => {
      registry.register({
        hookId: 'test-hook-1',
        hookName: 'Test Hook',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: Date.now(),
        timeout: 60000,
        stdout: '{"systemMessage": "Build completed"}',
        stderr: '',
      });

      registry.complete('test-hook-1');

      const messages = registry['completedOutputs'];
      expect(messages.length).toBe(1);
      expect(messages[0].message).toBe('Build completed');
      expect(messages[0].type).toBe('system');
    });
  });

  describe('fail', () => {
    it('should mark hook as failed and add error message', () => {
      registry.register({
        hookId: 'test-hook-1',
        hookName: 'Test Hook',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: Date.now(),
        timeout: 60000,
        stdout: '',
        stderr: '',
      });

      registry.fail('test-hook-1', new Error('Hook failed'));

      expect(registry['pendingHooks'].size > 0).toBe(false);
      const messages = registry['completedOutputs'];
      expect(messages.length).toBe(1);
      expect(messages[0].type).toBe('error');
      expect(messages[0].message).toContain('Hook failed');
    });
  });

  describe('timeout', () => {
    it('should mark hook as timed out', () => {
      registry.register({
        hookId: 'test-hook-1',
        hookName: 'Test Hook',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: Date.now(),
        timeout: 1500,
        stdout: '',
        stderr: '',
      });
      const [hook] = Array.from(registry['pendingHooks'].values());

      registry.timeout('test-hook-1');

      expect(registry['pendingHooks'].size > 0).toBe(false);
      // The registered timeout is in milliseconds; both messages report seconds.
      expect(hook?.error?.message).toBe('Hook timed out after 1.5s');
      const messages = registry['completedOutputs'];
      expect(messages.length).toBe(1);
      expect(messages[0].type).toBe('warning');
      expect(messages[0].message).toBe(
        'Async hook Test Hook timed out after 1.5s',
      );
    });

    it('should terminate process on timeout', () => {
      const mockProcess = {
        killed: false,
        kill: vi.fn(),
        once: vi.fn(),
      };

      registry.register({
        hookId: 'test-hook-1',
        hookName: 'Test Hook',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: Date.now(),
        timeout: 1000,
        stdout: '',
        stderr: '',
        process: mockProcess as unknown as import('child_process').ChildProcess,
      });

      registry.timeout('test-hook-1');

      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mockProcess.once).toHaveBeenCalledWith(
        'exit',
        expect.any(Function),
      );
    });

    it('should not call kill if process is already killed', () => {
      const mockProcess = {
        killed: true,
        kill: vi.fn(),
        once: vi.fn(),
      };

      registry.register({
        hookId: 'test-hook-1',
        hookName: 'Test Hook',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: Date.now(),
        timeout: 1000,
        stdout: '',
        stderr: '',
        process: mockProcess as unknown as import('child_process').ChildProcess,
      });

      registry.timeout('test-hook-1');

      expect(mockProcess.kill).not.toHaveBeenCalled();
    });
  });

  describe('getPendingHooks', () => {
    it('should return all pending hooks', () => {
      registry.register({
        hookId: 'test-hook-1',
        hookName: 'Hook 1',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: Date.now(),
        timeout: 60000,
        stdout: '',
        stderr: '',
      });

      registry.register({
        hookId: 'test-hook-2',
        hookName: 'Hook 2',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: Date.now(),
        timeout: 60000,
        stdout: '',
        stderr: '',
      });

      const pending = Array.from(registry['pendingHooks'].values());
      expect(pending.length).toBe(2);
    });
  });

  describe('getPendingHooksForSession', () => {
    it('should return hooks for specific session', () => {
      registry.register({
        hookId: 'test-hook-1',
        hookName: 'Hook 1',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: Date.now(),
        timeout: 60000,
        stdout: '',
        stderr: '',
      });

      registry.register({
        hookId: 'test-hook-2',
        hookName: 'Hook 2',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-2',
        startTime: Date.now(),
        timeout: 60000,
        stdout: '',
        stderr: '',
      });

      const session1Hooks = Array.from(
        registry['pendingHooks'].values(),
      ).filter((hook) => hook.sessionId === 'session-1');
      expect(session1Hooks.length).toBe(1);
      expect(session1Hooks[0].hookId).toBe('test-hook-1');
    });
  });

  describe('clearSession', () => {
    it('should clear all hooks for a session', () => {
      registry.register({
        hookId: 'test-hook-1',
        hookName: 'Hook 1',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: Date.now(),
        timeout: 60000,
        stdout: '',
        stderr: '',
      });

      registry.register({
        hookId: 'test-hook-2',
        hookName: 'Hook 2',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-2',
        startTime: Date.now(),
        timeout: 60000,
        stdout: '',
        stderr: '',
      });

      registry.clearSession('session-1');

      const pending = Array.from(registry['pendingHooks'].values());
      expect(pending.length).toBe(1);
      expect(pending[0].sessionId).toBe('session-2');
    });
  });

  describe('checkTimeouts', () => {
    it('should timeout expired hooks', () => {
      const pastTime = Date.now() - 70000; // 70 seconds ago

      registry.register({
        hookId: 'test-hook-1',
        hookName: 'Test Hook',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: pastTime,
        timeout: 60000, // 60 second timeout
        stdout: '',
        stderr: '',
      });

      registry.checkTimeouts();

      expect(registry['pendingHooks'].size > 0).toBe(false);
      expect(registry['completedOutputs'].length).toBeGreaterThan(0);
    });
  });

  describe('concurrency limits', () => {
    it('should respect maxConcurrentHooks limit', () => {
      const limitedRegistry = new AsyncHookRegistry({ maxConcurrentHooks: 2 });

      // Register first hook
      const id1 = limitedRegistry.register({
        hookId: 'test-hook-1',
        hookName: 'Hook 1',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: Date.now(),
        timeout: 60000,
        stdout: '',
        stderr: '',
      });
      expect(id1).toBe('test-hook-1');

      // Register second hook
      const id2 = limitedRegistry.register({
        hookId: 'test-hook-2',
        hookName: 'Hook 2',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: Date.now(),
        timeout: 60000,
        stdout: '',
        stderr: '',
      });
      expect(id2).toBe('test-hook-2');

      // Third hook should be rejected
      const id3 = limitedRegistry.register({
        hookId: 'test-hook-3',
        hookName: 'Hook 3',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: Date.now(),
        timeout: 60000,
        stdout: '',
        stderr: '',
      });
      expect(id3).toBeNull();
    });

    it('should allow registration after hook completes', () => {
      const limitedRegistry = new AsyncHookRegistry({ maxConcurrentHooks: 1 });

      // Register first hook
      limitedRegistry.register({
        hookId: 'test-hook-1',
        hookName: 'Hook 1',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: Date.now(),
        timeout: 60000,
        stdout: '',
        stderr: '',
      });

      // Second hook should be rejected
      const id2Before = limitedRegistry.register({
        hookId: 'test-hook-2',
        hookName: 'Hook 2',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: Date.now(),
        timeout: 60000,
        stdout: '',
        stderr: '',
      });
      expect(id2Before).toBeNull();

      // Complete first hook
      limitedRegistry.complete('test-hook-1');

      // Now second hook should be accepted
      const id2After = limitedRegistry.register({
        hookId: 'test-hook-2',
        hookName: 'Hook 2',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: Date.now(),
        timeout: 60000,
        stdout: '',
        stderr: '',
      });
      expect(id2After).toBe('test-hook-2');
    });

    it('should report correct running count', () => {
      const limitedRegistry = new AsyncHookRegistry({ maxConcurrentHooks: 5 });

      expect(limitedRegistry.getRunningCount()).toBe(0);
      expect(limitedRegistry.canAcceptMore()).toBe(true);

      limitedRegistry.register({
        hookId: 'test-hook-1',
        hookName: 'Hook 1',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: Date.now(),
        timeout: 60000,
        stdout: '',
        stderr: '',
      });

      expect(limitedRegistry.getRunningCount()).toBe(1);
      expect(limitedRegistry.canAcceptMore()).toBe(true);

      limitedRegistry.fail('test-hook-1', new Error('test'));

      expect(limitedRegistry.getRunningCount()).toBe(0);
    });
  });

  describe('auto timeout checker', () => {
    it('leaves an expired hook for an explicit timeout check once the checker stops', () => {
      const autoRegistry = new AsyncHookRegistry({
        enableAutoTimeoutCheck: true,
        timeoutCheckInterval: 100,
      });

      // Register an expired hook
      const pastTime = Date.now() - 70000;
      autoRegistry.register({
        hookId: 'test-hook-1',
        hookName: 'Test Hook',
        hookEvent: HookEventName.PostToolUse,
        sessionId: 'session-1',
        startTime: pastTime,
        timeout: 60000,
        stdout: '',
        stderr: '',
      });

      // Stop the checker to prevent interference with other tests
      clearInterval(autoRegistry['timeoutCheckTimer']);

      // Manually check - hook should still be there since we stopped the checker
      // before it could run
      expect(autoRegistry['pendingHooks'].size > 0).toBe(true);

      // Now manually trigger timeout check
      autoRegistry.checkTimeouts();
      expect(autoRegistry['pendingHooks'].size > 0).toBe(false);
    });
  });
});
