/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { MCPServerConfig } from '../config/config.js';
import {
  connectionIdOf,
  fingerprint,
  isPoolable,
  mcpTransportOf,
  parseConnectionId,
  POOLED_TRANSPORTS_DEFAULT,
} from './mcp-pool-key.js';

describe('mcp-pool-key', () => {
  describe('fingerprint', () => {
    it('is stable across two MCPServerConfig instances with identical content', () => {
      const a = new MCPServerConfig('node', ['./srv.js'], { FOO: 'bar' });
      const b = new MCPServerConfig('node', ['./srv.js'], { FOO: 'bar' });
      expect(fingerprint(a)).toBe(fingerprint(b));
    });

    it('is stable across env-key permutations (sorted before hash)', () => {
      const a = new MCPServerConfig('node', undefined, { A: '1', B: '2' });
      const b = new MCPServerConfig('node', undefined, { B: '2', A: '1' });
      expect(fingerprint(a)).toBe(fingerprint(b));
    });

    it('diverges on any byte change in env value (critical for credential isolation)', () => {
      const a = new MCPServerConfig('node', undefined, { TOKEN: 'tokenA' });
      const b = new MCPServerConfig('node', undefined, { TOKEN: 'tokenB' });
      expect(fingerprint(a)).not.toBe(fingerprint(b));
    });

    it('SAME key when includeTools/excludeTools/trust/description differ (per-session filters excluded)', () => {
      const a = new MCPServerConfig(
        'node',
        ['s.js'],
        undefined,
        undefined,
        undefined,
        /*trust*/ false,
        /*description*/ 'A',
        ['onlyA'],
        ['notA'],
      );
      const b = new MCPServerConfig(
        'node',
        ['s.js'],
        undefined,
        undefined,
        undefined,
        /*trust*/ true,
        /*description*/ 'B',
      );
      expect(fingerprint(a)).toBe(fingerprint(b));
    });

    it.each([
      // In-range values on both sides: enforced policy differs, so the pool
      // must split. (Both 2_000_000 and 3_000_000 clamp to the same enforced
      // appResourceTimeoutMs ceiling, so the timeout arm needs in-range
      // values to keep asserting isolation.)
      { setting: 'appResourceMaxBytes', low: 2_000_000, high: 3_000_000 },
      { setting: 'appResourceTimeoutMs', low: 20_000, high: 30_000 },
    ] as const)(
      'isolates pooled tools with different $setting limits',
      ({ setting, low, high }) => {
        const base = { command: 'node' };
        expect(fingerprint(base)).not.toBe(
          fingerprint({ ...base, [setting]: low }),
        );
        expect(fingerprint({ ...base, [setting]: low })).not.toBe(
          fingerprint({ ...base, [setting]: high }),
        );
      },
    );

    it('hashes App resource limits at their enforced values', () => {
      const base = { command: 'node' };
      // Unset and the explicit default enforce the same 1 MiB limit.
      expect(fingerprint(base)).toBe(
        fingerprint({ ...base, appResourceMaxBytes: 1_048_576 }),
      );
      // Two over-ceiling values clamp to the same enforced limit.
      expect(fingerprint({ ...base, appResourceMaxBytes: 8_388_608 })).toBe(
        fingerprint({ ...base, appResourceMaxBytes: 4_194_304 }),
      );
      expect(fingerprint({ ...base, appResourceTimeoutMs: 2_000_000 })).toBe(
        fingerprint({ ...base, appResourceTimeoutMs: 3_000_000 }),
      );
      // A non-numeric value behaves exactly like unset at the read site.
      expect(fingerprint(base)).toBe(
        fingerprint({
          ...base,
          appResourceMaxBytes: '4194304' as unknown as number,
        }),
      );
      expect(fingerprint(base)).toBe(
        fingerprint({
          ...base,
          appResourceTimeoutMs: '30000' as unknown as number,
        }),
      );
    });

    it('produces a 16-char hex string', () => {
      const fp = fingerprint(new MCPServerConfig('node'));
      expect(fp).toMatch(/^[0-9a-f]{16}$/);
    });

    it('separates explicit automatic negotiation from the default legacy mode', () => {
      const base = { command: 'node' } as MCPServerConfig;
      const legacy = {
        ...base,
        versionNegotiation: 'legacy',
      } as MCPServerConfig;
      const automatic = {
        ...base,
        versionNegotiation: 'auto',
      } as MCPServerConfig;

      expect(fingerprint(base)).toBe(fingerprint(legacy));
      expect(fingerprint(base)).not.toBe(fingerprint(automatic));
    });
  });

  describe('mcpTransportOf', () => {
    it('classifies stdio when command present', () => {
      expect(mcpTransportOf(new MCPServerConfig('node'))).toBe('stdio');
    });
    it('classifies sdk via isSdkMcpServerConfig', () => {
      const cfg = new MCPServerConfig(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'sdk',
      );
      expect(mcpTransportOf(cfg)).toBe('sdk');
    });
    it('returns unknown when no transport-defining field', () => {
      expect(mcpTransportOf(new MCPServerConfig())).toBe('unknown');
    });
  });

  describe('isPoolable + POOLED_TRANSPORTS_DEFAULT', () => {
    it('stdio is poolable by default', () => {
      expect(
        isPoolable(new MCPServerConfig('node'), POOLED_TRANSPORTS_DEFAULT),
      ).toBe(true);
    });
    it('SDK MCP is never poolable (always bypass)', () => {
      const cfg = new MCPServerConfig(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'sdk',
      );
      // Even with sdk in pooledTransports, isPoolable returns false.
      expect(
        isPoolable(
          cfg,
          new Set(['stdio', 'sdk']) as ReadonlySet<
            ReturnType<typeof mcpTransportOf>
          >,
        ),
      ).toBe(false);
    });
  });

  describe('connectionIdOf + parseConnectionId', () => {
    it('round-trips for normal server names', () => {
      const cfg = new MCPServerConfig('node');
      const id = connectionIdOf('foo', cfg);
      const parsed = parseConnectionId(id);
      expect(parsed.serverName).toBe('foo');
      expect(parsed.fingerprint).toBe(fingerprint(cfg));
    });

    it('handles server names containing the :: separator by using lastIndexOf', () => {
      // Edge: user with namespaced server name like "ext::github".
      const cfg = new MCPServerConfig('node');
      const id = connectionIdOf('ext::github', cfg);
      const parsed = parseConnectionId(id);
      expect(parsed.serverName).toBe('ext::github');
      expect(parsed.fingerprint).toBe(fingerprint(cfg));
    });
  });
});
