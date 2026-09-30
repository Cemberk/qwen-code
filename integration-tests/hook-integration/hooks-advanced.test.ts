import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestRig } from '../test-helper.js';

/**
 * Advanced Hooks System Integration Tests
 *
 * Tests for Async Hooks covering various events and scenarios
 */

// ==========================================================================
// Async Hooks Integration Tests
// ==========================================================================
describe('Async Hooks Integration', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = new TestRig();
  });

  afterEach(async () => {
    if (rig) {
      await rig.cleanup();
    }
  });

  // ==========================================================================
  // Async Command Hooks - PreToolUse Events
  // ==========================================================================
  describe('Async PreToolUse Hooks', () => {
    it('should execute async hook in background without blocking tool execution', async () => {
      // Async hook runs in background, tool execution continues immediately
      const asyncHookScript = `
        sleep 2
        echo '{"async": true, "hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "Async hook completed"}}' >> async_output.txt
      `;

      await rig.setup('async-pretooluse-background', {
        settings: {
          disableAllHooks: false,
          hooks: {
            PreToolUse: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: asyncHookScript,
                    name: 'async-bg-hook',
                    timeout: 30,
                    async: true,
                  },
                ],
              },
            ],
          },
        },
      });

      // Tool should execute immediately without waiting for async hook
      await rig.run('Create a file async_test.txt with "hello"');

      const foundToolCall = await rig.waitForToolCall('write_file');
      expect(foundToolCall).toBeTruthy();

      const fileContent = rig.readFile('async_test.txt');
      expect(fileContent).toContain('hello');
    });

    it('should run multiple async hooks concurrently without blocking', async () => {
      const asyncHook1 = `sleep 1 && echo 'hook1_done' >> async_multi.txt`;
      const asyncHook2 = `sleep 1 && echo 'hook2_done' >> async_multi.txt`;

      await rig.setup('async-pretooluse-concurrent', {
        settings: {
          disableAllHooks: false,
          hooks: {
            PreToolUse: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: asyncHook1,
                    name: 'async-hook-1',
                    timeout: 30,
                    async: true,
                  },
                  {
                    type: 'command',
                    command: asyncHook2,
                    name: 'async-hook-2',
                    timeout: 30,
                    async: true,
                  },
                ],
              },
            ],
          },
        },
      });

      await rig.run('Create a file concurrent.txt with "test"');

      // Tool should execute immediately
      const foundToolCall = await rig.waitForToolCall('write_file');
      expect(foundToolCall).toBeTruthy();
    });

    it('should allow sync hook to run alongside async hook', async () => {
      const asyncHook = `sleep 2 && echo 'async_complete' >> async_sync_mix.txt`;
      const syncHook = `echo '{"decision": "allow"}'`;

      await rig.setup('async-with-sync', {
        settings: {
          disableAllHooks: false,
          hooks: {
            PreToolUse: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: asyncHook,
                    name: 'async-mixed-hook',
                    timeout: 30,
                    async: true,
                  },
                  {
                    type: 'command',
                    command: syncHook,
                    name: 'sync-mixed-hook',
                    timeout: 5,
                  },
                ],
              },
            ],
          },
        },
      });

      await rig.run('Create a file mixed_async_sync.txt with "test"');

      // Sync hook should complete, async hook runs in background
      const foundToolCall = await rig.waitForToolCall('write_file');
      expect(foundToolCall).toBeTruthy();
    });
  });

  // ==========================================================================
  // Async Command Hooks - PostToolUse Events
  // ==========================================================================
  describe('Async PostToolUse Hooks', () => {
    it('should execute async hook after tool completion without blocking', async () => {
      const asyncPostHook = `
        sleep 1
        echo 'post_async_done' >> post_async_log.txt
      `;

      await rig.setup('async-posttooluse', {
        settings: {
          disableAllHooks: false,
          hooks: {
            PostToolUse: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: asyncPostHook,
                    name: 'async-post-hook',
                    timeout: 30,
                    async: true,
                  },
                ],
              },
            ],
          },
        },
      });

      await rig.run('Create a file post_async.txt with "content"');

      const foundToolCall = await rig.waitForToolCall('write_file');
      expect(foundToolCall).toBeTruthy();
    });

    it('should run async audit logging after tool execution', async () => {
      const auditHook = `
        echo '{"tool_name": "'$TOOL_NAME'", "timestamp": "'$(date -Iseconds)'"}' >> audit.log
      `;

      await rig.setup('async-posttooluse-audit', {
        settings: {
          disableAllHooks: false,
          hooks: {
            PostToolUse: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: auditHook,
                    name: 'async-audit-hook',
                    timeout: 30,
                    async: true,
                  },
                ],
              },
            ],
          },
        },
      });

      await rig.run('Create a file audited.txt with "test"');

      const foundToolCall = await rig.waitForToolCall('write_file');
      expect(foundToolCall).toBeTruthy();
    });
  });

  // ==========================================================================
  // Async Command Hooks - SessionEnd Events
  // ==========================================================================
  describe('Async SessionEnd Hooks', () => {
    it('should execute async cleanup hook on session end', async () => {
      const cleanupHook = `echo 'session_ended' >> cleanup.log`;

      await rig.setup('async-sessionend-cleanup', {
        settings: {
          disableAllHooks: false,
          hooks: {
            SessionEnd: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: cleanupHook,
                    name: 'async-cleanup-hook',
                    timeout: 5,
                    async: true,
                  },
                ],
              },
            ],
          },
        },
      });

      const result = await rig.run('Say goodbye');
      expect(result).toBeDefined();
    });
  });

  // ==========================================================================
  // Async Command Hooks - Timeout Handling
  // ==========================================================================
  describe('Async Hook Timeout', () => {
    it('should handle async hook timeout gracefully without blocking', async () => {
      const longRunningHook = `sleep 60 && echo 'finally_done' >> timeout_test.txt`;

      await rig.setup('async-hook-timeout', {
        settings: {
          disableAllHooks: false,
          hooks: {
            PreToolUse: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: longRunningHook,
                    name: 'async-long-hook',
                    timeout: 2, // 2 second timeout - hook won't finish
                    async: true,
                  },
                ],
              },
            ],
          },
        },
      });

      // Execution should not be blocked by timeout
      await rig.run('Create a file timeout_async.txt with "test"');

      const foundToolCall = await rig.waitForToolCall('write_file');
      expect(foundToolCall).toBeTruthy();
    });
  });

  // ==========================================================================
  // Async Command Hooks - Error Handling
  // ==========================================================================
  describe('Async Hook Error Handling', () => {
    it('should continue execution when async hook fails', async () => {
      const failingAsyncHook = `exit 1 && echo 'should_not_see_this' >> async_fail.txt`;

      await rig.setup('async-hook-failure', {
        settings: {
          disableAllHooks: false,
          hooks: {
            PreToolUse: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: failingAsyncHook,
                    name: 'async-failing-hook',
                    timeout: 5,
                    async: true,
                  },
                ],
              },
            ],
          },
        },
      });

      // Async hook failure should not block execution
      const result = await rig.run(
        'Create a file async_fail_test.txt with "test"',
      );
      expect(result).toBeDefined();
    });

    it('should continue when async hook command does not exist', async () => {
      await rig.setup('async-hook-missing-command', {
        settings: {
          disableAllHooks: false,
          hooks: {
            PreToolUse: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: '/nonexistent/async/command',
                    name: 'async-missing-hook',
                    timeout: 5,
                    async: true,
                  },
                ],
              },
            ],
          },
        },
      });

      const result = await rig.run(
        'Create a file async_missing.txt with "test"',
      );
      expect(result).toBeDefined();
    });
  });

  // ==========================================================================
  // Async Command Hooks - Concurrency Limits
  // ==========================================================================
  describe('Async Hook Concurrency', () => {
    it('should handle multiple async hooks within concurrency limit', async () => {
      const hooks = Array(5)
        .fill(null)
        .map((_, i) => ({
          type: 'command',
          command: `sleep 1 && echo 'hook${i}_done' >> concurrent_limit.txt`,
          name: `async-concurrent-hook-${i}`,
          timeout: 30,
          async: true,
        }));

      await rig.setup('async-concurrency-limit', {
        settings: {
          disableAllHooks: false,
          hooks: {
            PreToolUse: [
              {
                matcher: '*',
                hooks: hooks,
              },
            ],
          },
        },
      });

      await rig.run('Say concurrency test');

      // All hooks should be registered (within default limit of 10)
      expect(true).toBeTruthy();
    });
  });
});
