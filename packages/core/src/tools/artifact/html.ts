/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure helpers for the Artifact tool: wrap a body-only HTML fragment into a
 * self-contained document, validate it has no external dependencies, and
 * normalize the title. No I/O — kept side-effect free so it is trivially
 * unit-testable and reused by every publisher backend.
 */

/** Upload/byte ceiling for a published artifact (mirrors CC's MAX_ARTIFACT_BYTES). */
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024; // 16 MB

/** Minimal CSS reset injected into every artifact so bare fragments look sane. */
const CSS_RESET = `*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;padding:1.5rem;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5;color:#1a1a1a;background:#fff}
img,svg,video,canvas{max-width:100%;height:auto}
pre,table{max-width:100%;overflow-x:auto}
:where(a){color:#0969da}`;

const DEFAULT_TITLE = 'Artifact';

/**
 * Collapses whitespace and clamps an artifact title to a sane length. Falls
 * back to a default so the document always has a usable <title>.
 */
export function sanitizeArtifactTitle(raw: string | undefined): string {
  const cleaned = (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return cleaned || DEFAULT_TITLE;
}

/** HTML-escapes the few characters that matter inside a <title> element. */
function escapeForTitle(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Heuristic check that a fragment is a self-contained body fragment with no
 * external dependencies. Returns an error string (model-facing, actionable) or
 * null when the fragment passes.
 *
 * This is a deliberately simple scanner, not a full HTML/CSS/JS parser: it
 * catches the common mistakes (full-document wrappers, CDN scripts, external
 * stylesheets/fonts/images, JS network calls, navigation, protocol-relative
 * URLs). It is defence in depth: the sandboxed viewer from
 * {@link wrapArtifactHtml} is the actual no-egress boundary.
 */
export function validateSelfContained(fragment: string): string | null {
  if (!fragment.trim()) {
    return 'Artifact file is empty — write the page content (a body-only HTML fragment) first.';
  }
  const scan = normalizeAttributeQuotes(fragment);

  // Must be a fragment, not a whole document — publishing adds the skeleton.
  // Only inspect the start (after leading whitespace and HTML comments) so a
  // page that merely mentions these tags in its body — a comment, or an escaped
  // code sample — is not falsely rejected.
  const head = fragment
    .replace(/^\s+/, '')
    .replace(/^(?:<!--[\s\S]*?-->\s*)+/, '');
  const wrapperTag = /^(?:<!doctype\b|<html[\s>]|<head[\s>]|<body[\s>])/i.exec(
    head,
  );
  if (wrapperTag) {
    return `Write a body-only fragment — it starts with a full-document tag (${wrapperTag[0].trim()}). Omit <!doctype>, <html>, <head>, and <body>; they are added at publish time.`;
  }

  // External resource references (src=/href=/srcset=/poster= → http(s):// or //).
  const extResource =
    /\b(?:src|srcset|poster)\s*=\s*["']?\s*(?:https?:)?\/\//i.exec(scan) ??
    /<link\b[^>]*\bhref\s*=\s*["']?\s*(?:https?:)?\/\//i.exec(scan);
  if (extResource) {
    return `Artifact must be self-contained — found an external reference (${truncate(extResource[0])}). Inline scripts/styles and embed assets as data: URIs.`;
  }

  const jsUri = /\b(?:href|src)\s*=\s*["']?\s*javascript\s*:/i.exec(scan);
  if (jsUri) {
    return `Artifact must be self-contained — found a javascript: URI (${truncate(jsUri[0])}). Use inline <script> blocks instead.`;
  }

  const extScript =
    /\b(?:fetch|WebSocket|XMLHttpRequest)\s*\(\s*["']\s*(?:https?|wss?):\/\//i.exec(
      scan,
    ) ??
    /\bimport\s*\(\s*["'](?:https?:)?\/\//i.exec(scan) ??
    /\bwindow\.open\s*\(/i.exec(scan) ??
    /\blocation\.\w+\s*[=(]/i.exec(scan) ??
    /\bnavigator\.sendBeacon\s*\(\s*["']\s*(?:https?:)?\/\//i.exec(scan);
  if (extScript) {
    return `Artifact must be self-contained — found browser network egress (${truncate(extScript[0])}). Embed data in the artifact instead of fetching it at runtime.`;
  }

  const navigation =
    /(?:^|[^\w$.])location\s*=(?!=)/i.exec(scan) ??
    /\b(?:top|parent|opener|self|window|document|globalThis)\s*\.\s*location\b/i.exec(
      scan,
    ) ??
    /<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i.exec(scan) ??
    /<base\b/i.exec(scan) ??
    // Any <link>: the CSP leaves nothing for one to load, and Chrome runs
    // rel=prerender/preconnect/dns-prefetch below the CSP — a rel value
    // spelled with character references would slip past a rel check.
    /<link\b/i.exec(scan) ??
    /<script\b[^>]*\btype\s*=\s*["']?speculationrules/i.exec(scan) ??
    /\bserviceWorker\s*\.\s*register\b/i.exec(scan) ??
    /\b(?:webkit)?RTCPeerConnection\b/i.exec(scan);
  if (navigation) {
    return `Artifact must be self-contained — found page navigation or network setup (${truncate(navigation[0])}). Artifacts cannot redirect, prefetch, register workers, or open peer connections.`;
  }

  // External CSS via @import or url(...) (fonts, background images, etc.).
  const extCss =
    /(?:@import\s+(?:url\()?|url\()\s*["']?\s*(?:https?:)?\/\//i.exec(scan);
  if (extCss) {
    return `Artifact must be self-contained — found an external CSS reference (${truncate(extCss[0])}). Inline CSS and embed fonts/images as data: URIs.`;
  }

  return null;
}

function normalizeAttributeQuotes(s: string): string {
  return s
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/&apos;|&#39;|&#x27;/gi, "'");
}

function truncate(s: string, max = 60): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Policy of the viewer page. The srcdoc artifact frame inherits it, so it is
 * also the artifact's policy.
 *
 * Scripts are disabled (`script-src 'none'` and no `allow-scripts` sandbox
 * token). With scripts, two vectors stay open with no nameable mechanism that
 * closes them across browsers: a frame can open an `RTCPeerConnection` to a
 * STUN/TURN server (CSP does not govern ICE and a sandboxed frame keeps WebRTC)
 * and a script can navigate its own frame to a remote URL. Without scripts,
 * every battery vector collapses to a declarative one that CSP or the sandbox
 * blocks. Artifacts are therefore static HTML/CSS/SVG only.
 */
export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  'media-src data:',
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "manifest-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

/**
 * Empty sandbox: an opaque origin with no scripts, forms, popups, top
 * navigation, same-origin access, modals or downloads.
 */
export const ARTIFACT_SANDBOX = '';

function escapeForAttribute(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Builds the published page: a fixed, script-free viewer that renders the
 * body-only fragment inside a sandboxed srcdoc iframe. The fragment only ever
 * appears attribute-escaped, so it cannot add markup to the viewer itself.
 */
export function wrapArtifactHtml(
  bodyFragment: string,
  title: string | undefined,
): string {
  const cleanTitle = sanitizeArtifactTitle(title);
  const safeTitle = escapeForTitle(cleanTitle);
  const artifactDocument = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="x-dns-prefetch-control" content="off">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${CSS_RESET}</style>
</head>
<body>
${bodyFragment}
</body>
</html>
`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">
<meta http-equiv="x-dns-prefetch-control" content="off">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>html,body{margin:0;height:100%}iframe{display:block;width:100%;height:100%;border:0}</style>
</head>
<body>
<iframe sandbox="${ARTIFACT_SANDBOX}" title="${escapeForAttribute(cleanTitle)}" srcdoc="${escapeForAttribute(artifactDocument)}"></iframe>
</body>
</html>
`;
}

/** UTF-8 byte length of a string. */
export function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}
