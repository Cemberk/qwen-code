/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../config/config.js';
import { ToolErrorType } from './tool-error.js';
import {
  WebFetchTool,
  fetchWebPage,
  formatPage,
  htmlToText,
} from './web-fetch.js';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

let handler: Handler;
let requests: string[];
let server: http.Server;
let origin: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    handler(req, res);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  requests = [];
  handler = (_req, res) => res.end('ok');
});

const signal = () => new AbortController().signal;

function tool(enabled = true) {
  const config = { isWebFetchEnabled: () => enabled } as unknown as Config;
  return new WebFetchTool(config);
}

describe('htmlToText', () => {
  it('keeps the readable text and drops scripts, styles and comments', () => {
    const text = htmlToText(
      `<html><head><title>Docs &amp; more</title><style>p{}</style></head>
       <body><script>alert(1)</script><!-- hidden -->
       <h2>Install</h2><p>Run   it&nbsp;now.</p><p>1 &lt; 2 and a < b</p>
       <ul><li>one</li><li>two</li></ul></body></html>`,
      'https://example.com/',
    );
    expect(text).toBe(
      '# Docs & more\n\n## Install\n\nRun it now.\n\n1 < 2 and a < b\n\n- one\n\n- two',
    );
  });

  it('shows links with absolute URLs and drops page anchors', () => {
    const text = htmlToText(
      '<p><a href="/guide">Guide</a>, <a href="#top">Top</a>, <a href="javascript:x()">Run</a></p>',
      'https://example.com/docs/',
    );
    expect(text).toBe('Guide (https://example.com/guide), Top, Run');
  });

  it('keeps the whitespace of preformatted blocks', () => {
    const text = htmlToText(
      '<p>Example:</p><pre><code>if (a &amp;&amp; b) {\n  run();\n}</code></pre>',
      'https://example.com/',
    );
    expect(text).toBe('Example:\n\n```\nif (a && b) {\n  run();\n}\n```');
  });
});

describe('formatPage', () => {
  const page = (contentType: string, body: string | Buffer) => ({
    kind: 'page' as const,
    url: 'https://example.com/a',
    status: 200,
    statusText: 'OK',
    contentType,
    body: Buffer.isBuffer(body) ? body : Buffer.from(body),
    truncated: false,
  });

  it('marks the content as untrusted', () => {
    const text = formatPage(page('application/json', '{"a":1}'));
    expect(text).toContain('Status: 200 OK');
    expect(text).toContain('untrusted data from the web');
    expect(text).toContain('{"a":1}');
  });

  it('does not return binary content', () => {
    const text = formatPage(page('image/png', Buffer.from([0x89, 0, 1, 2])));
    expect(text).toContain('4 bytes of image/png content');
    expect(text).not.toContain('untrusted data');
  });

  it('decodes the declared charset', () => {
    const text = formatPage(
      page(
        'text/plain; charset=iso-8859-1',
        Buffer.from([0x63, 0x61, 0x66, 0xe9]),
      ),
    );
    expect(text).toContain('café');
  });

  it('cuts long text and says so', () => {
    const text = formatPage(page('text/plain', 'x'.repeat(50_000)));
    expect(text).toContain('Showing the first 40000 of 50000 characters.');
    expect(text).not.toContain('x'.repeat(40_001));
  });
});

describe('fetchWebPage', () => {
  it('follows a redirect on the same host', async () => {
    handler = (req, res) => {
      if (req.url === '/old') {
        res.writeHead(301, { Location: '/new' }).end();
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' }).end('moved');
      }
    };
    const outcome = await fetchWebPage(`${origin}/old`, signal());
    expect(outcome).toMatchObject({ kind: 'page', url: `${origin}/new` });
    expect(requests).toEqual(['/old', '/new']);
  });

  it('returns a redirect to another host without following it', async () => {
    const elsewhere = origin.replace('127.0.0.1', 'localhost') + '/x';
    handler = (_req, res) => res.writeHead(302, { Location: elsewhere }).end();
    const outcome = await fetchWebPage(`${origin}/a`, signal());
    expect(outcome).toEqual({
      kind: 'redirect',
      url: `${origin}/a`,
      location: elsewhere,
    });
    expect(requests).toEqual(['/a']);
  });

  it('stops after too many redirects', async () => {
    handler = (req, res) =>
      res.writeHead(302, { Location: `${req.url}x` }).end();
    await expect(fetchWebPage(`${origin}/r`, signal())).rejects.toThrow(
      'Too many redirects',
    );
  });

  it('stops downloading at the size limit', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(Buffer.alloc(3 * 1024 * 1024, 'a'));
    };
    const outcome = await fetchWebPage(`${origin}/big`, signal());
    expect(outcome).toMatchObject({ kind: 'page', truncated: true });
    if (outcome.kind === 'page') {
      expect(outcome.body.length).toBe(2 * 1024 * 1024);
    }
  });

  it('sends no cookies or credentials', async () => {
    let headers: http.IncomingHttpHeaders = {};
    handler = (req, res) => {
      headers = req.headers;
      res.end('ok');
    };
    await fetchWebPage(`${origin}/h`, signal());
    expect(headers['cookie']).toBeUndefined();
    expect(headers['authorization']).toBeUndefined();
    expect(headers['user-agent']).toBe('Mozilla/5.0 (compatible; QwenCode)');
  });
});

describe('WebFetchTool', () => {
  it.each([
    ['ftp://example.com/file', 'must start with http:// or https://'],
    ['https://user:pass@example.com/', 'must not contain a user name'],
    ['not a url', 'is not a valid URL'],
  ])('rejects %s', (url, message) => {
    expect(tool().validateToolParams({ url })).toContain(message);
  });

  it('asks the user before every fetch, without an always-allow option', async () => {
    const invocation = tool().build({ url: 'https://example.com/' });
    expect(await invocation.getDefaultPermission()).toBe('ask');
    expect(invocation.requiresUserInteraction?.()).toBe(true);
    expect(await invocation.getConfirmationDetails(signal())).toMatchObject({
      type: 'info',
      prompt: 'https://example.com/',
      hideAlwaysAllow: true,
    });
  });

  it('returns the page text', async () => {
    handler = (_req, res) =>
      res
        .writeHead(200, { 'Content-Type': 'text/html' })
        .end('<title>Hi</title><p>Hello</p>');
    const result = await tool()
      .build({ url: `${origin}/page` })
      .execute(signal());
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('# Hi\n\nHello');
    expect(result.returnDisplay).toBe(
      `Fetched ${origin}/page (HTTP 200, 29 bytes)`,
    );
  });

  it('reports HTTP errors', async () => {
    handler = (_req, res) => res.writeHead(404).end('missing');
    const result = await tool()
      .build({ url: `${origin}/missing` })
      .execute(signal());
    expect(result.error?.type).toBe(ToolErrorType.EXECUTION_FAILED);
    expect(result.error?.message).toContain('HTTP 404');
  });

  it('fetches nothing when web access was turned off', async () => {
    const result = await tool(false)
      .build({ url: `${origin}/page` })
      .execute(signal());
    expect(result.error?.type).toBe(ToolErrorType.EXECUTION_DENIED);
    expect(requests).toEqual([]);
  });
});
