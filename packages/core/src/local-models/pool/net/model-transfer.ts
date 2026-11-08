/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import {
  huggingFaceHubCacheDir,
  resolveLocalModelFiles,
} from '../../hf-cache.js';
import type { LocalModelConfig } from '../../local-models.js';
import type { PeerLink } from './peer-link.js';

/** One file of a model, as a member describes it. */
export interface ModelPart {
  name: string;
  size: number;
  sha256: string;
}

export interface ModelInfo {
  /** The Hugging Face snapshot the files belong to. */
  commit: string;
  parts: ModelPart[];
}

/** SHA-256 of a file, computed once per size and modification time. */
async function fileHash(file: string, cacheFile: string): Promise<string> {
  const stat = statSync(file);
  const key = `${file}\0${stat.size}\0${stat.mtimeMs}`;
  let cache: Record<string, string> = {};
  try {
    cache = JSON.parse(readFileSync(cacheFile, 'utf8')) as Record<
      string,
      string
    >;
  } catch {
    // None yet.
  }
  if (cache[key]) return cache[key];
  const hash = await new Promise<string>((resolve, reject) => {
    const digest = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => digest.update(chunk))
      .on('end', () => resolve(digest.digest('hex')))
      .on('error', reject);
  });
  cache[key] = hash;
  try {
    mkdirSync(path.dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(cache));
  } catch {
    // Computed again next time.
  }
  return hash;
}

/** What a member says about a model it has downloaded; undefined when it has not. */
export async function localModelInfo(
  model: LocalModelConfig,
  hashCacheFile: string,
  cacheDir: string = huggingFaceHubCacheDir(),
): Promise<ModelInfo | undefined> {
  let files: string[];
  try {
    files = resolveLocalModelFiles(model, cacheDir);
  } catch {
    return undefined;
  }
  const commit = path.basename(path.dirname(files[0]));
  const parts: ModelPart[] = [];
  for (const file of files) {
    parts.push({
      name: path.basename(file),
      size: statSync(file).size,
      sha256: await fileHash(file, hashCacheFile),
    });
  }
  return { commit, parts };
}

/**
 * Serve one file of a downloaded model to a member, from `start` (a Range
 * request resumes an interrupted copy).
 */
export function serveModelFile(
  model: LocalModelConfig,
  name: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cacheDir: string = huggingFaceHubCacheDir(),
): void {
  let file: string | undefined;
  try {
    file = resolveLocalModelFiles(model, cacheDir).find(
      (candidate) => path.basename(candidate) === name,
    );
  } catch {
    file = undefined;
  }
  if (!file) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'no such model file here' }));
    return;
  }
  const size = statSync(file).size;
  const range = /^bytes=(\d+)-$/.exec(String(req.headers['range'] ?? ''));
  const start = range ? Math.min(Number(range[1]), size) : 0;
  res.writeHead(range ? 206 : 200, {
    'content-type': 'application/octet-stream',
    'content-length': size - start,
  });
  if (start >= size) {
    res.end();
    return;
  }
  createReadStream(file, { start }).pipe(res);
}

/** Where a model's files go in this machine's Hugging Face cache. */
function snapshotDir(
  model: LocalModelConfig,
  commit: string,
  cacheDir: string,
): { repoDir: string; snapshot: string } {
  const repoDir = path.join(
    cacheDir,
    `models--${model.repo.replace('/', '--')}`,
  );
  return { repoDir, snapshot: path.join(repoDir, 'snapshots', commit) };
}

/**
 * Copy a model from a member into this machine's Hugging Face cache, where
 * everything else looks for it (as `hf download` would have put it). Resumes
 * a copy that was cut off; checks every file's SHA-256 before using it.
 *
 * @throws Error when the member does not have it, or a file arrives damaged.
 */
export async function fetchModelFromMember(
  link: PeerLink,
  model: LocalModelConfig,
  onProgress: (done: number, total: number) => void = () => {},
  cacheDir: string = huggingFaceHubCacheDir(),
): Promise<void> {
  const answer = await link.call('POST', '/pool/model-info', { model });
  if (answer.status !== 200) {
    throw new Error(
      String(answer.json['error'] ?? 'the member does not have it'),
    );
  }
  const info = answer.json as unknown as ModelInfo;
  if (!/^[0-9a-f]{40}$/.test(info.commit)) {
    throw new Error('the member sent no usable snapshot');
  }
  const { repoDir, snapshot } = snapshotDir(model, info.commit, cacheDir);
  mkdirSync(snapshot, { recursive: true });
  const total = info.parts.reduce((sum, part) => sum + part.size, 0);
  let done = 0;
  for (const part of info.parts) {
    if (!/^[\w.-]+\.gguf$/.test(part.name)) {
      throw new Error(`the member named an odd file: ${part.name}`);
    }
    const target = path.join(snapshot, part.name);
    if (existsSync(target) && statSync(target).size === part.size) {
      done += part.size;
      onProgress(done, total);
      continue;
    }
    const partial = `${target}.part`;
    const have = existsSync(partial) ? statSync(partial).size : 0;
    done += have;
    await download(link, model, part.name, partial, have, (bytes) => {
      done += bytes;
      onProgress(done, total);
    });
    const hash = await fileHash(
      partial,
      path.join(cacheDir, '.qwen-hashes.json'),
    );
    if (hash !== part.sha256 || statSync(partial).size !== part.size) {
      // Start this file over next time.
      renameSync(partial, `${partial}.bad`);
      throw new Error(`${part.name} arrived damaged; try again`);
    }
    renameSync(partial, target);
  }
  mkdirSync(path.join(repoDir, 'refs'), { recursive: true });
  writeFileSync(path.join(repoDir, 'refs', 'main'), info.commit);
}

function download(
  link: PeerLink,
  model: LocalModelConfig,
  name: string,
  file: string,
  from: number,
  onBytes: (bytes: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams({
      model: JSON.stringify(model),
      name,
    });
    const request = https.get(
      {
        host: link.host,
        port: link.port,
        path: `/pool/model-file?${query.toString()}`,
        agent: link.agentForTransfers(),
        headers: from > 0 ? { range: `bytes=${from}-` } : {},
      },
      (response) => {
        if (response.statusCode !== 200 && response.statusCode !== 206) {
          response.resume();
          reject(new Error(`the member answered HTTP ${response.statusCode}`));
          return;
        }
        // A plain 200 restarts the file from its beginning.
        const out = createWriteStream(file, {
          flags: response.statusCode === 206 ? 'a' : 'w',
        });
        response.on('data', (chunk: Buffer) => onBytes(chunk.length));
        response.pipe(out);
        out.on('finish', () => resolve());
        out.on('error', reject);
        response.on('error', reject);
      },
    );
    request.on('error', reject);
  });
}
