/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  extensionForMimeType,
  looksLikeText,
  sniffFileKind,
} from './binary-content.js';

describe('looksLikeText', () => {
  it('accepts printable UTF-8, rejects NUL bytes and invalid sequences', () => {
    expect(looksLikeText(Buffer.from('plain text\nwith 日本語 too\n'))).toBe(
      true,
    );
    expect(looksLikeText(Buffer.from([0x68, 0x00, 0x69]))).toBe(false);
    expect(looksLikeText(Buffer.alloc(64, 0x81))).toBe(false);
  });
});

describe('extensionForMimeType', () => {
  it.each([
    ['application/pdf', 'pdf'],
    ['application/pdf; charset=binary', 'pdf'],
    [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'xlsx',
    ],
    ['image/jpeg', 'jpg'],
    ['application/vnd.ms-powerpoint', 'ppt'],
    ['application/x-gzip', 'gz'],
    ['application/x-tar', 'tar'],
    ['application/x-7z-compressed', '7z'],
    ['application/vnd.rar', 'rar'],
    ['application/wasm', 'wasm'],
    ['application/octet-stream', 'bin'],
    ['who/knows', 'bin'],
    [undefined, 'bin'],
  ])('%s → %s', (mimeType, expected) => {
    expect(extensionForMimeType(mimeType)).toBe(expected);
  });
});

describe('sniffFileKind', () => {
  const PDF = Buffer.from('%PDF-1.4 junk');
  const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
  const GZ = Buffer.from([0x1f, 0x8b, 0x08]);
  const TEXT = Buffer.from('plain old text');
  const URL = 'https://example.com/files/download';

  it('identifies PDFs by magic bytes regardless of content type', () => {
    const kind = sniffFileKind(PDF, 'application/octet-stream', '', URL);
    expect(kind).toEqual({
      extension: 'pdf',
      mimeType: 'application/pdf',
      magicMatched: true,
      extensionSource: 'magic',
    });
  });

  it('refines ZIP magic to office extensions via Content-Disposition', () => {
    const kind = sniffFileKind(
      ZIP,
      'application/octet-stream',
      'attachment; filename="report.xlsx"',
      URL,
    );
    expect(kind.extension).toBe('xlsx');
    expect(kind.magicMatched).toBe(true);
  });

  it('refines ZIP magic to office extensions via URL path', () => {
    const kind = sniffFileKind(
      ZIP,
      'application/octet-stream',
      '',
      'https://example.com/deck.pptx',
    );
    expect(kind.extension).toBe('pptx');
  });

  it('falls back to zip for unrefined ZIP containers', () => {
    expect(sniffFileKind(ZIP, '', '', URL).extension).toBe('zip');
  });

  it('refines ZIP magic via the declared Content-Type when names are generic', () => {
    const kind = sniffFileKind(
      ZIP,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '',
      URL, // generic /files/download — no useful extension
    );
    expect(kind.extension).toBe('xlsx');
  });

  it('reports how the extension was determined', () => {
    expect(
      sniffFileKind(TEXT, '', 'attachment; filename="fw.bin"', URL)
        .extensionSource,
    ).toBe('name');
    expect(
      sniffFileKind(TEXT, 'application/pdf', '', URL).extensionSource,
    ).toBe('mime');
    expect(sniffFileKind(TEXT, '', '', URL).extensionSource).toBe('fallback');
  });

  it('identifies gzip by magic bytes', () => {
    expect(sniffFileKind(GZ, '', '', URL).extension).toBe('gz');
  });

  it.each([
    // RAR4: Rar!\x1A\x07\x00
    [Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00, 0x33])],
    // RAR5: Rar!\x1A\x07\x01\x00
    [Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])],
  ])('identifies RAR archives by magic bytes', (bytes) => {
    const kind = sniffFileKind(bytes, 'application/octet-stream', '', URL);
    expect(kind).toEqual({
      extension: 'rar',
      mimeType: 'application/vnd.rar',
      magicMatched: true,
      extensionSource: 'magic',
    });
  });

  it('refines ZIP magic to jar via filename or Content-Type', () => {
    const byName = sniffFileKind(
      ZIP,
      'application/octet-stream',
      'attachment; filename="library.jar"',
      URL,
    );
    expect(byName.extension).toBe('jar');
    expect(byName.magicMatched).toBe(true);
    // Every real JAR carries ZIP magic, so the java-archive mime mapping
    // must survive the ZIP refinement rather than degrade to .zip.
    const byMime = sniffFileKind(ZIP, 'application/java-archive', '', URL);
    expect(byMime.extension).toBe('jar');
  });

  it.each([
    [
      Buffer.concat([
        Buffer.from([0x89]),
        Buffer.from('PNG\r\n'),
        Buffer.from([0x1a, 0x0a]),
      ]),
      'png',
      'image/png',
    ],
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), 'jpg', 'image/jpeg'],
    [Buffer.from('GIF89a....'), 'gif', 'image/gif'],
    [
      Buffer.concat([
        Buffer.from('RIFF'),
        Buffer.from([0, 0, 0, 0]),
        Buffer.from('WEBPVP8 '),
      ]),
      'webp',
      'image/webp',
    ],
  ])('identifies image magic bytes → %s', (bytes, ext, mime) => {
    const kind = sniffFileKind(bytes as Buffer, '', '', URL);
    expect(kind.extension).toBe(ext);
    expect(kind.mimeType).toBe(mime);
    expect(kind.magicMatched).toBe(true);
  });

  it('uses RFC 5987 filename* when present', () => {
    const kind = sniffFileKind(
      TEXT,
      'application/octet-stream',
      "attachment; filename*=UTF-8''r13031cp.pdf",
      URL,
    );
    expect(kind.extension).toBe('pdf');
    expect(kind.magicMatched).toBe(false);
    // RFC 5987 allows a non-empty language tag between the quotes.
    expect(
      sniffFileKind(TEXT, '', "attachment; filename*=UTF-8'en'report.xlsx", URL)
        .extension,
    ).toBe('xlsx');
  });

  it('recognizes archive extensions from headerless URLs', () => {
    const kind = sniffFileKind(
      TEXT,
      '',
      '',
      'https://example.com/backup/archive.tar',
    );
    expect(kind.extension).toBe('tar');
    expect(kind.extensionSource).toBe('name');
  });

  it('uses the URL extension when headers say nothing', () => {
    const kind = sniffFileKind(
      TEXT,
      'application/octet-stream',
      '',
      'https://example.com/audio/track.mp3?sig=abc',
    );
    expect(kind.extension).toBe('mp3');
  });

  it('falls back to the content-type map, then bin', () => {
    expect(sniffFileKind(TEXT, 'application/pdf', '', URL).extension).toBe(
      'pdf',
    );
    expect(sniffFileKind(TEXT, 'who/knows', '', URL).extension).toBe('bin');
  });

  it('ignores unknown extensions in filenames', () => {
    const kind = sniffFileKind(
      TEXT,
      '',
      'attachment; filename="script.exe"',
      URL,
    );
    expect(kind.extension).toBe('bin');
  });
});
