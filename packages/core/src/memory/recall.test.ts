/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_FAST_RECALL_DOCS,
  resolveRelevantAutoMemoryPromptForQuery,
  selectRelevantAutoMemoryDocuments,
} from './recall.js';
import type { Config } from '../config/config.js';
import { selectRelevantAutoMemoryDocumentsByModel } from './relevanceSelector.js';
import {
  parseAutoMemoryTopicDocument,
  rereadAutoMemoryDocument,
  scanAllAutoMemoryTopicDocuments,
  scanAllUserAutoMemoryTopicDocuments,
  scanAutoMemorySnapshot,
  type MemorySourceStatus,
  type ScannedAutoMemoryDocument,
} from './scan.js';
import { logMemoryRecall } from '../telemetry/index.js';
import { toAutoMemoryRef } from './tree.js';

const debugLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => debugLogger,
}));

vi.mock('./scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scan.js')>();
  return {
    ...actual,
    scanAutoMemorySnapshot: vi.fn(),
    scanAllAutoMemoryTopicDocuments: vi.fn(),
    // Explicit mock: the real implementation silently scans the user's
    // memory directory when it exists, so the empty pool must stay hermetic.
    scanAllUserAutoMemoryTopicDocuments: vi.fn().mockResolvedValue([]),
    rereadAutoMemoryDocument: vi.fn(),
  };
});

vi.mock('./relevanceSelector.js', () => ({
  selectRelevantAutoMemoryDocumentsByModel: vi.fn(),
}));

vi.mock('../telemetry/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../telemetry/index.js')>()),
  logMemoryRecall: vi.fn(),
}));

const docs: ScannedAutoMemoryDocument[] = [
  {
    scope: 'project',
    type: 'reference',
    filePath: '/tmp/reference.md',
    relativePath: 'reference.md',
    filename: 'reference.md',
    title: 'Reference Memory',
    description: 'Dashboards and external docs',
    category: 'project_introduction',
    keywords: ['latency dashboard'],
    usageScenarios: ['checking latency dashboards'],
    body: 'Grafana dashboard: grafana.internal/d/api-latency',
    mtimeMs: 3,
  },
  {
    scope: 'project',
    type: 'project',
    filePath: '/tmp/project.md',
    relativePath: 'project.md',
    filename: 'project.md',
    title: 'Project Memory',
    description: 'Project constraints and release context',
    category: 'important_decision',
    keywords: [],
    usageScenarios: ['planning release work'],
    body: 'Release freeze starts Friday.',
    mtimeMs: 2,
  },
];

const activeToolDocs: ScannedAutoMemoryDocument[] = [
  {
    scope: 'project',
    type: 'reference',
    filePath: '/tmp/ata-tool.md',
    relativePath: 'ata-tool.md',
    filename: 'ata-tool.md',
    title: 'ATA tool schema notes',
    description:
      'article-list-query parameter schema and failed tool-call attempts',
    category: 'tool_experience',
    keywords: [],
    usageScenarios: ['using ATA tool schema'],
    body: 'ata::article-list-query failed with guessed field mappings.',
    mtimeMs: 4,
  },
  {
    scope: 'project',
    type: 'reference',
    filePath: '/tmp/ata-gotcha.md',
    relativePath: 'ata-gotcha.md',
    filename: 'ata-gotcha.md',
    title: 'ATA tool gotcha',
    description: 'article-list-query known workaround for transient failures',
    category: 'common_pitfall',
    keywords: [],
    usageScenarios: ['handling ATA failures'],
    body: 'Retry after checking the ATA oncall note.',
    mtimeMs: 6,
  },
  {
    scope: 'project',
    type: 'reference',
    filePath: '/tmp/ata-owner.md',
    relativePath: 'ata-owner.md',
    filename: 'ata-owner.md',
    title: 'ATA escalation',
    description: 'ATA service owner and escalation path',
    category: 'tool_experience',
    keywords: [],
    usageScenarios: ['escalating ATA issues'],
    body: 'Ask the ATA oncall when the service returns systemError.',
    mtimeMs: 5,
  },
];

const completeSourceStatus: MemorySourceStatus = {
  requestedScopes: ['project', 'user'],
  searchedScopes: ['project', 'user'],
  unavailableScopes: [],
  complete: true,
  incompleteScopes: [],
};

function mockSnapshot(snapshotDocs: ScannedAutoMemoryDocument[]): void {
  vi.mocked(scanAutoMemorySnapshot).mockResolvedValue({
    docs: snapshotDocs,
    sourceStatus: completeSourceStatus,
  });
}

function memoryDoc(
  filename: string,
  type: ScannedAutoMemoryDocument['type'],
  title: string,
  description: string,
  body: string,
): ScannedAutoMemoryDocument {
  return {
    scope: 'project',
    type,
    filePath: `/tmp/${filename}`,
    relativePath: filename,
    filename,
    title,
    description,
    category: 'uncategorized',
    keywords: [],
    usageScenarios: [],
    body,
    mtimeMs: 1,
  };
}

const multilingualDocs: ScannedAutoMemoryDocument[] = [
  memoryDoc(
    'ja-perf.md',
    'project',
    '性能改善目標',
    '四半期性能指標',
    '起動時間短縮。',
  ),
  memoryDoc(
    'ja-api.md',
    'reference',
    '応答遅延調査',
    'API 監視画面',
    'サービス応答時間と警告入口の記録。',
  ),
  memoryDoc(
    'ja-auth.md',
    'project',
    '認証設定ガイド',
    'ユーザーログイン構成',
    'セッション設定の確認手順。',
  ),
  memoryDoc(
    'ja-deploy.md',
    'reference',
    'デプロイ手順',
    'リリース運用',
    '本番反映前の確認事項。',
  ),
  memoryDoc(
    'ko-deploy.md',
    'project',
    '배포 절차',
    '릴리스 체크리스트',
    '운영 반영 전에 모니터링을 확인한다.',
  ),
  memoryDoc(
    'ko-auth.md',
    'reference',
    '인증 설정',
    '로그인 문제 해결',
    '세션 만료와 권한 구성을 확인한다.',
  ),
  memoryDoc(
    'en-release.md',
    'project',
    'Release process',
    'Production deployment checklist',
    'Verify monitoring before shipping.',
  ),
  memoryDoc(
    'en-style.md',
    'user',
    'Response preferences',
    'Concise answer style',
    'Keep explanations direct.',
  ),
  memoryDoc(
    'mixed-api.md',
    'reference',
    'Qwen API レート制限',
    'Rate limit dashboard',
    'quota とリクエスト速度を確認。',
  ),
  memoryDoc(
    'body-only.md',
    'feedback',
    'Operational notes',
    'Miscellaneous guidance',
    'Emergency rollback procedures require owner approval.',
  ),
  memoryDoc(
    'ja-hiragana.md',
    'user',
    'よくあるしつもん',
    'ひらがなだけでかいたあんない',
    'ひらがなのとうこにそなえたきろく。',
  ),
];

const multilingualRecallCases: Array<
  [name: string, query: string, expectedFilename: string | null]
> = [
  ['Japanese kanji-only title', '性能改善', 'ja-perf.md'],
  ['Japanese kanji-only description', '四半期指標', 'ja-perf.md'],
  ['Japanese API title', '応答遅延', 'ja-api.md'],
  ['Japanese troubleshooting', '遅延調査', 'ja-api.md'],
  ['Japanese mixed ASCII', 'API 遅延', 'ja-api.md'],
  ['Japanese Han title', '認証設定', 'ja-auth.md'],
  ['Japanese Katakana description', 'ログイン構成', 'ja-auth.md'],
  ['Japanese prolonged sound mark', 'ユーザー', 'ja-auth.md'],
  ['Japanese Katakana title', 'デプロイ手順', 'ja-deploy.md'],
  ['Japanese release description', 'リリース運用', 'ja-deploy.md'],
  ['Japanese Hiragana-only query', 'よくあるしつもん', 'ja-hiragana.md'],
  ['Korean title', '배포 절차', 'ko-deploy.md'],
  ['Korean description', '릴리스 체크', 'ko-deploy.md'],
  ['Korean auth title', '인증 설정', 'ko-auth.md'],
  ['Korean login description', '로그인 문제', 'ko-auth.md'],
  ['English title', 'release process', 'en-release.md'],
  ['English description', 'production deployment', 'en-release.md'],
  ['English style description', 'concise answer', 'en-style.md'],
  ['English preference title', 'response preferences', 'en-style.md'],
  ['Mixed-language title', 'qwen api レート制限', 'mixed-api.md'],
  ['Mixed-language description', 'rate limit', 'mixed-api.md'],
  ['Mixed ASCII and Han', 'API 制限', 'mixed-api.md'],
  ['Body-only English', 'rollback procedures', 'body-only.md'],
  ['Body-only phrase', 'emergency rollback', 'body-only.md'],
  ['NFKC full-width API', 'ＱＷＥＮ ＡＰＩ', 'mixed-api.md'],
  [
    'NFKC full-width English',
    'ＰＲＯＤＵＣＴＩＯＮ deployment',
    'en-release.md',
  ],
  ['No lexical match', 'vector database', null],
  ['Single Katakana character', 'デ', null],
  ['Single Japanese character', '認', null],
  ['Single Hangul character', '배', null],
  ['Short ASCII token', 'go', null],
  ['Unrelated English terms', 'empty mismatch', null],
];

describe('auto-memory relevant recall', () => {
  const bodyPresentVersions = new Map<string, number>();
  const config = {
    getFastModel: vi.fn().mockReturnValue('fast-model'),
    getMemoryRecallMode: vi.fn().mockReturnValue('structured'),
    getMemoryManager: vi.fn().mockReturnValue({
      getBodyPresentVersionsInHistory: vi
        .fn()
        .mockReturnValue(bodyPresentVersions),
    }),
  } as unknown as Config;

  beforeEach(() => {
    vi.clearAllMocks();
    bodyPresentVersions.clear();
    vi.mocked(config.getFastModel).mockReturnValue('fast-model');
    vi.mocked(config.getMemoryRecallMode).mockReturnValue('structured');
    mockSnapshot(docs);
    vi.mocked(scanAllAutoMemoryTopicDocuments).mockResolvedValue(docs);
    vi.mocked(scanAllUserAutoMemoryTopicDocuments).mockResolvedValue([]);
    vi.mocked(rereadAutoMemoryDocument).mockImplementation(async (doc) => doc);
  });

  it('selects matching documents in heuristic mode', () => {
    expect(
      selectRelevantAutoMemoryDocuments('check the latency dashboard', docs),
    ).toEqual([docs[0]]);
    expect(
      selectRelevantAutoMemoryDocuments('unrelated weather', docs),
    ).toEqual([]);
  });

  it('does not double-score text echoed across metadata fields', () => {
    const parseDoc = (
      relativePath: string,
      frontmatter: string[],
    ): ScannedAutoMemoryDocument => {
      const doc = parseAutoMemoryTopicDocument(
        `/tmp/${relativePath}`,
        ['---', ...frontmatter, '---', '', 'unrelated body text'].join('\n'),
        1,
        relativePath,
        'project',
      );
      expect(doc).not.toBeNull();
      return doc!;
    };

    // >64 chars: the legacy usage_scenarios fallback is the description cut
    // at 64 chars, which can never string-equal the full description.
    const description = `tersemarker ${'x'.repeat(70)}`;
    const echoDoc = parseDoc('echo.md', [
      'type: project',
      'name: Unrelated name',
      `description: ${description}`,
    ]);
    expect(echoDoc.usageScenarios).toHaveLength(1);
    const titleDoc = parseDoc('title.md', [
      'type: project',
      'name: tersemarker handbook',
      'description: Completely unrelated operational text',
      'usage_scenarios: []',
    ]);
    // Pre-fix the echoed scenario scored the same text a second time (+3),
    // outranking the exact title match.
    expect(
      selectRelevantAutoMemoryDocuments('tersemarker', [echoDoc, titleDoc]),
    ).toEqual([titleDoc, echoDoc]);

    const dupKeywordDoc = parseDoc('dup-keyword.md', [
      'type: project',
      'name: tersemarker',
      'description: Completely unrelated operational text',
      'keywords:',
      '  - tersemarker',
      'usage_scenarios: []',
    ]);
    const richDoc = parseDoc('rich.md', [
      'type: project',
      'name: tersemarker notes',
      'description: tersemarker in the description',
      'usage_scenarios: []',
    ]);
    // Pre-fix the title-duplicating keyword scored 4+4=8, beating the
    // title+description 4+3=7 of a genuinely richer match.
    expect(
      selectRelevantAutoMemoryDocuments('tersemarker', [
        dupKeywordDoc,
        richDoc,
      ]),
    ).toEqual([richDoc, dupKeywordDoc]);
  });

  it('scans the structured memory universe uncapped like the legacy branch', async () => {
    await resolveRelevantAutoMemoryPromptForQuery('/tmp/project', 'latency', {
      config,
    });

    expect(scanAutoMemorySnapshot).toHaveBeenCalledWith(
      '/tmp/project',
      expect.objectContaining({ uncapped: true }),
    );
  });

  it('uses keywords and usage scenarios in heuristic mode', () => {
    const metadataOnlyDoc: ScannedAutoMemoryDocument = {
      ...docs[1]!,
      title: 'Operational note',
      description: 'Durable operational context',
      keywords: ['provider fallback'],
      usageScenarios: ['diagnosing selector failures'],
      body: 'No matching query terms in this body.',
    };

    expect(
      selectRelevantAutoMemoryDocuments('provider fallback', [metadataOnlyDoc]),
    ).toEqual([metadataOnlyDoc]);
    expect(
      selectRelevantAutoMemoryDocuments('diagnosing selector failures', [
        metadataOnlyDoc,
      ]),
    ).toEqual([metadataOnlyDoc]);
  });

  it('does not score a description twice through its legacy scenario fallback', () => {
    const single = memoryDoc(
      'single.md',
      'reference',
      'Operational note',
      'shared match',
      '',
    );
    const duplicated = {
      ...single,
      filename: 'duplicated.md',
      filePath: '/tmp/duplicated.md',
      relativePath: 'duplicated.md',
      usageScenarios: ['shared match'],
    };

    expect(
      selectRelevantAutoMemoryDocuments('shared match', [single, duplicated]),
    ).toEqual([single, duplicated]);
  });

  it('matches Japanese metadata in heuristic mode', () => {
    const japaneseDoc: ScannedAutoMemoryDocument = {
      ...docs[1]!,
      title: 'リリースノート',
      description: 'データベース結合試験は実サービスに接続すること',
      keywords: ['データベース試験', '実依存'],
      usageScenarios: ['結合試験の失敗調査'],
      body: 'データベースの mock は使わない。',
    };

    expect(
      selectRelevantAutoMemoryDocuments(
        'なぜ結合試験で模擬データベースを使えないのか',
        [japaneseDoc],
      ),
    ).toEqual([japaneseDoc]);
    expect(
      selectRelevantAutoMemoryDocuments(
        'フロントエンドのボタンは何色にすべきか',
        [japaneseDoc],
      ),
    ).toEqual([]);
  });

  it('matches two-character kanji terms and NFKC-normalized metadata', () => {
    const normalizedDoc: ScannedAutoMemoryDocument = {
      ...docs[1]!,
      title: '想起確認',
      description: 'ＡＰＩ 呼出記録',
      keywords: ['想起'],
      usageScenarios: [],
      body: '',
    };

    expect(
      selectRelevantAutoMemoryDocuments('記憶想起の効果を確認', [
        normalizedDoc,
      ]),
    ).toEqual([normalizedDoc]);
    expect(
      selectRelevantAutoMemoryDocuments('API 呼出が失敗する理由', [
        normalizedDoc,
      ]),
    ).toEqual([normalizedDoc]);
  });

  it('returns no heuristic matches for empty or unrelated queries', () => {
    expect(selectRelevantAutoMemoryDocuments('   ', docs)).toEqual([]);
    expect(
      selectRelevantAutoMemoryDocuments('unrelated weather question', docs),
    ).toEqual([]);
  });

  it.each(multilingualRecallCases)('%s', (_name, query, expectedFilename) => {
    const selected = selectRelevantAutoMemoryDocuments(query, multilingualDocs);

    if (expectedFilename === null) {
      expect(selected).toEqual([]);
    } else {
      expect(selected[0]?.filename).toBe(expectedFilename);
    }
  });

  it('normalizes document text before matching', () => {
    expect(
      selectRelevantAutoMemoryDocuments('API', [
        memoryDoc('fw-api.md', 'reference', 'ＡＰＩ', '', ''),
      ])[0]?.filename,
    ).toBe('fw-api.md');
  });

  it('weights each title and description match above a body match', () => {
    const bodyMatch = memoryDoc(
      'body.md',
      'reference',
      'General notes',
      'Miscellaneous',
      'Latency dashboard troubleshooting.',
    );
    const titleMatch = memoryDoc(
      'title.md',
      'reference',
      'Latency dashboard',
      'Troubleshooting reference',
      'General notes.',
    );

    expect(
      selectRelevantAutoMemoryDocuments('latency dashboard', [
        bodyMatch,
        titleMatch,
      ])[0]?.filename,
    ).toBe('title.md');

    expect(
      selectRelevantAutoMemoryDocuments('user preferences background role', [
        memoryDoc('body.md', 'user', '', '', 'Background'),
        memoryDoc('title.md', 'project', 'Background', '', ''),
      ])[0]?.filename,
    ).toBe('title.md');
  });

  it('applies type boosts only after a lexical match', () => {
    const userDoc = memoryDoc(
      'user-cadence.md',
      'user',
      'Cadence summary',
      '',
      '',
    );
    const projectDoc = memoryDoc(
      'project-cadence.md',
      'project',
      'Cadence summary',
      '',
      '',
    );

    // Both docs tie on lexical score for 'cadence'; the 'preference' token
    // boosts only the user-typed doc, so it must win. Without the boost the
    // docs would also tie on mtime and input order would surface the project
    // doc instead.
    const selected = selectRelevantAutoMemoryDocuments('cadence preference', [
      projectDoc,
      userDoc,
    ]);

    expect(selected[0]?.filename).toBe('user-cadence.md');
    // Type keywords alone never surface a doc without a lexical match.
    expect(selectRelevantAutoMemoryDocuments('preference', [userDoc])).toEqual(
      [],
    );
  });

  it('tokenizes alphabetic scripts outside ASCII and CJK', () => {
    // `[a-z0-9]{3,}` produced no tokens at all for these, so the
    // deterministic path was unconditionally silent — no fast result, and a
    // silent selector-failure fallback.
    const cyrillic = memoryDoc(
      'ru.md',
      'project',
      'Процесс развёртывания',
      '',
      '',
    );
    const greek = memoryDoc('el.md', 'reference', 'Ρύθμιση σύνδεσης', '', '');
    const accented = memoryDoc('fr.md', 'project', 'Démarrage à froid', '', '');
    const docs = [cyrillic, greek, accented];

    expect(
      selectRelevantAutoMemoryDocuments('развёртывания', docs)[0]?.filename,
    ).toBe('ru.md');
    expect(
      selectRelevantAutoMemoryDocuments('σύνδεσης', docs)[0]?.filename,
    ).toBe('el.md');
    expect(
      selectRelevantAutoMemoryDocuments('démarrage', docs)[0]?.filename,
    ).toBe('fr.md');
  });

  it('does not let a Latin run swallow the CJK that follows it', () => {
    // `\p{L}` also matches Han, so a naive alphabetic class would tokenize
    // `abc東京` as one run and stop matching either half on its own.
    const latin = memoryDoc('latin.md', 'reference', 'abc', '', '');
    const han = memoryDoc('han.md', 'reference', '東京', '', '');

    expect(
      selectRelevantAutoMemoryDocuments('abc東京', [latin, han]).map(
        (doc) => doc.filename,
      ),
    ).toEqual(['latin.md', 'han.md']);
  });

  it('still ignores runs shorter than three characters', () => {
    const doc = memoryDoc('go.md', 'reference', 'go go go', '', '');

    expect(selectRelevantAutoMemoryDocuments('go', [doc])).toEqual([]);
    // Two Cyrillic letters are below the threshold for the same reason.
    expect(
      selectRelevantAutoMemoryDocuments('до', [
        memoryDoc('ru.md', 'reference', 'до свидания', '', ''),
      ]),
    ).toEqual([]);
  });

  it('breaks score ties by recency, not by document type', () => {
    // Every type carries the same title, so the only thing separating these
    // documents is the tie-break. An alphabetical type comparison orders them
    // feedback < project < reference < user, which pushes user memory out of
    // the two-document fast result entirely.
    const withMtime = (
      doc: ScannedAutoMemoryDocument,
      mtimeMs: number,
    ): ScannedAutoMemoryDocument => ({ ...doc, mtimeMs });
    const docs = [
      withMtime(memoryDoc('fb.md', 'feedback', 'Deploy notes', '', ''), 10),
      withMtime(memoryDoc('pr.md', 'project', 'Deploy notes', '', ''), 20),
      withMtime(memoryDoc('rf.md', 'reference', 'Deploy notes', '', ''), 30),
      withMtime(memoryDoc('us.md', 'user', 'Deploy notes', '', ''), 40),
    ];

    expect(
      selectRelevantAutoMemoryDocuments('deploy', docs).map(
        (doc) => doc.filename,
      ),
    ).toEqual(['us.md', 'rf.md', 'pr.md', 'fb.md']);

    // The fast path takes only the first MAX_FAST_RECALL_DOCS, so the
    // tie-break decides whether user memory reaches the model at all.
    expect(
      selectRelevantAutoMemoryDocuments('deploy', docs)
        .slice(0, MAX_FAST_RECALL_DOCS)
        .map((doc) => doc.type),
    ).toContain('user');
  });

  it('falls back to input order when score and recency both tie', () => {
    // Project-level documents are concatenated ahead of user-level ones in
    // `resolveRelevantAutoMemoryPromptForQuery`; the stable sort is what
    // preserves that precedence once every ranking key has tied.
    const projectDoc = memoryDoc('p.md', 'project', 'Deploy notes', '', '');
    const userDoc = memoryDoc('u.md', 'user', 'Deploy notes', '', '');

    expect(
      selectRelevantAutoMemoryDocuments('deploy', [projectDoc, userDoc])[0]
        ?.filename,
    ).toBe('p.md');
  });

  it('bounds long mixed queries while retaining their actual text edges', () => {
    const codePoints = Array.from({ length: 100 }, (_, index) =>
      String.fromCodePoint(0x4e00 + index),
    );
    const asciiTokens = Array.from(
      { length: 100 },
      (_, index) => `token${String(index).padStart(3, '0')}`,
    );
    const selected = selectRelevantAutoMemoryDocuments(
      `${codePoints.join('')} ${asciiTokens.join(' ')}`,
      [
        memoryDoc(
          'query-start.md',
          'reference',
          codePoints.slice(0, 2).join(''),
          '',
          '',
        ),
        memoryDoc(
          'query-middle.md',
          'reference',
          codePoints.slice(49, 51).join(''),
          '',
          '',
        ),
        memoryDoc('query-end.md', 'reference', asciiTokens.at(-1)!, '', ''),
      ],
    );

    expect(selected.map((doc) => doc.filename)).toEqual([
      'query-start.md',
      'query-end.md',
    ]);
  });

  it('refreshes repeated tokens near the query tail', () => {
    const tokens = Array.from(
      { length: 65 },
      (_, index) => `token${String(index).padStart(3, '0')}`,
    );
    const selected = selectRelevantAutoMemoryDocuments(
      [...tokens.slice(0, 64), tokens[32], tokens[64]].join(' '),
      [
        memoryDoc('repeated.md', 'reference', tokens[32], '', ''),
        memoryDoc('stale.md', 'reference', tokens[33], '', ''),
        memoryDoc('last.md', 'reference', tokens[64], '', ''),
      ],
    ).map((doc) => doc.filename);

    expect(selected).toContain('repeated.md');
    expect(selected).toContain('last.md');
    expect(selected).not.toContain('stale.md');
  });

  it('does not score body text outside the surfaced prompt window', () => {
    const doc = memoryDoc(
      'late-body.md',
      'reference',
      'General notes',
      '',
      `${'x'.repeat(1_200)}late marker`,
    );

    expect(selectRelevantAutoMemoryDocuments('late marker', [doc])).toEqual([]);
  });

  it('preserves Main body scoring in legacy mode', () => {
    const bodyOnly = memoryDoc(
      'legacy-body.md',
      'reference',
      'General note',
      '',
      '遅延調査の入口。',
    );

    expect(
      selectRelevantAutoMemoryDocuments('遅延調査', [bodyOnly], 5, false),
    ).toEqual([bodyOnly]);
  });

  it('returns selector-selected memory bodies in legacy mode without a tree', async () => {
    vi.mocked(config.getMemoryRecallMode).mockReturnValue('legacy');
    vi.mocked(selectRelevantAutoMemoryDocumentsByModel).mockResolvedValue([
      docs[0]!,
    ]);

    const result = await resolveRelevantAutoMemoryPromptForQuery(
      '/tmp/project',
      'check the latency dashboard',
      { config },
    );

    expect(result.treeSnapshot).toBeUndefined();
    expect(result.prompt).toContain('## Relevant memory');
    expect(result.prompt).toContain('grafana.internal/d/api-latency');
    expect(result.prompt).not.toContain('Complete memory tree');
  });

  it('threads folder trust into the legacy project scan universe', async () => {
    // The repo-local root only joins the scan for a trusted folder; an
    // untrusted folder must not have repo-shipped memory injected.
    vi.mocked(config.getMemoryRecallMode).mockReturnValue('legacy');
    vi.mocked(selectRelevantAutoMemoryDocumentsByModel).mockResolvedValue([]);
    const trusting = {
      ...config,
      isTrustedFolder: vi.fn().mockReturnValue(true),
    } as unknown as Config;
    const distrusting = {
      ...config,
      isTrustedFolder: vi.fn().mockReturnValue(false),
    } as unknown as Config;

    await resolveRelevantAutoMemoryPromptForQuery('/tmp/project', 'query', {
      config: trusting,
    });
    // Fourth argument: the recall scan is best-effort per root — one
    // unlistable repo-local root must not discard the healthy roots.
    expect(scanAllAutoMemoryTopicDocuments).toHaveBeenLastCalledWith(
      '/tmp/project',
      undefined,
      true,
      true,
    );

    await resolveRelevantAutoMemoryPromptForQuery('/tmp/project', 'query', {
      config: distrusting,
    });
    expect(scanAllAutoMemoryTopicDocuments).toHaveBeenLastCalledWith(
      '/tmp/project',
      undefined,
      false,
      true,
    );
  });

  it('preserves legacy exclusion of memory bodies already surfaced', async () => {
    vi.mocked(config.getMemoryRecallMode).mockReturnValue('legacy');
    vi.mocked(selectRelevantAutoMemoryDocumentsByModel).mockResolvedValue([]);

    const result = await resolveRelevantAutoMemoryPromptForQuery(
      '/tmp/project',
      'check the latency dashboard',
      { config, excludedFilePaths: [docs[0]!.filePath] },
    );

    expect(result.selectedDocs).toEqual([]);
    expect(result.prompt).toBe('');
    expect(selectRelevantAutoMemoryDocumentsByModel).toHaveBeenCalledWith(
      config,
      'check the latency dashboard',
      expect.not.arrayContaining([docs[0]]),
      5,
      [],
      undefined,
    );
  });

  it('uses a placeholder only when the selected body version is present', async () => {
    mockSnapshot(docs);
    bodyPresentVersions.set('project:reference.md', docs[0]!.mtimeMs);
    vi.mocked(selectRelevantAutoMemoryDocumentsByModel).mockResolvedValue([
      docs[0],
    ]);

    const result = await resolveRelevantAutoMemoryPromptForQuery(
      '/tmp/project',
      'check the latency dashboard',
      { config },
    );

    expect(result.prompt).toContain(
      '[already in current context] [project:reference.md]',
    );
    expect(result.prompt).toContain('Keywords: latency dashboard');
    expect(result.prompt).not.toContain('Dashboards and external docs');
  });

  it('does not use a placeholder for a body evicted from history', async () => {
    mockSnapshot(docs);
    vi.mocked(selectRelevantAutoMemoryDocumentsByModel).mockResolvedValue([
      docs[0],
    ]);

    const result = await resolveRelevantAutoMemoryPromptForQuery(
      '/tmp/project',
      'check the latency dashboard',
      { config },
    );

    expect(result.prompt).not.toContain('[already in current context]');
    expect(result.prompt).toContain('Summary: Dashboards and external docs');
  });

  it('publishes only strong metadata matches in the fast focused subtree', async () => {
    const bodyOnly = memoryDoc(
      'body-only-fast.md',
      'reference',
      'General operational note',
      '',
      'rare rollback marker',
    );
    mockSnapshot([bodyOnly]);
    vi.mocked(selectRelevantAutoMemoryDocumentsByModel).mockResolvedValue([]);
    const onFastResult = vi.fn();

    await resolveRelevantAutoMemoryPromptForQuery(
      '/tmp/project',
      'rare rollback marker',
      { config, onFastResult },
    );

    expect(onFastResult).toHaveBeenCalledOnce();
    expect(onFastResult.mock.calls[0]?.[0].selectedDocs).toEqual([]);
    expect(onFastResult.mock.calls[0]?.[0].treeSnapshot.routerPrompt).toContain(
      'Complete memory tree',
    );
  });

  it('admits an exact stored keyword to the fast focused subtree', async () => {
    const exact = {
      ...docs[0]!,
      keywords: ['provider fallback'],
    };
    mockSnapshot([exact]);
    vi.mocked(selectRelevantAutoMemoryDocumentsByModel).mockResolvedValue([]);
    const onFastResult = vi.fn();

    await resolveRelevantAutoMemoryPromptForQuery(
      '/tmp/project',
      'We hit provider fallback again.',
      { config, onFastResult },
    );

    expect(onFastResult.mock.calls[0]?.[0].selectedDocs).toEqual([exact]);
    expect(onFastResult.mock.calls[0]?.[0].focusedPrompt).toContain(
      '[project:reference.md]',
    );
  });

  it('does not treat a short keyword as a substring of a larger word', async () => {
    const shortKeyword = {
      ...docs[0]!,
      description: 'Explain notes',
      keywords: ['ai'],
    };
    mockSnapshot([shortKeyword]);
    vi.mocked(selectRelevantAutoMemoryDocumentsByModel).mockResolvedValue([]);
    const onFastResult = vi.fn();

    await resolveRelevantAutoMemoryPromptForQuery(
      '/tmp/project',
      'explain this behavior',
      { config, onFastResult },
    );

    expect(onFastResult.mock.calls[0]?.[0].selectedDocs).toEqual([]);
  });

  it('prioritizes a lexically matched memory whose body version is stale', async () => {
    const stale = {
      ...docs[0]!,
      title: 'Fork setup',
      description: 'Repository migration notes',
      keywords: [],
      usageScenarios: [],
      mtimeMs: 42,
    };
    const strong = {
      ...docs[1]!,
      keywords: ['migration update'],
    };
    mockSnapshot([strong, stale]);
    bodyPresentVersions.set('project:reference.md', 41);
    vi.mocked(selectRelevantAutoMemoryDocumentsByModel).mockResolvedValue([]);
    const onFastResult = vi.fn();

    await resolveRelevantAutoMemoryPromptForQuery(
      '/tmp/project',
      'Check the migration update.',
      { config, onFastResult },
    );

    expect(onFastResult.mock.calls[0]?.[0].selectedDocs[0]).toEqual(stale);
    expect(onFastResult.mock.calls[0]?.[0].focusedPrompt).toContain(
      '[updated, re-read needed] [project:reference.md]',
    );
  });

  it('does not include selected document rereads in selector duration', async () => {
    vi.useFakeTimers();
    mockSnapshot(docs);
    vi.mocked(selectRelevantAutoMemoryDocumentsByModel).mockImplementation(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return [docs[0]!];
      },
    );
    vi.mocked(rereadAutoMemoryDocument).mockImplementation(async (doc) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return doc;
    });

    const promise = resolveRelevantAutoMemoryPromptForQuery(
      '/tmp/project',
      'latency dashboard',
      { config },
    );
    await vi.advanceTimersByTimeAsync(140);
    await promise;

    expect(vi.mocked(logMemoryRecall)).toHaveBeenLastCalledWith(
      config,
      expect.objectContaining({ selector_duration_ms: 40 }),
    );
    vi.useRealTimers();
  });

  it('warns when a selected document disappears before injection', async () => {
    vi.mocked(selectRelevantAutoMemoryDocumentsByModel).mockResolvedValue(docs);
    vi.mocked(rereadAutoMemoryDocument).mockImplementation(async (doc) =>
      doc === docs[0] ? null : doc,
    );

    const result = await resolveRelevantAutoMemoryPromptForQuery(
      '/tmp/project',
      'project constraints',
      { config },
    );

    expect(result.selectedDocs).toEqual([docs[1]]);
    expect(debugLogger.warn).toHaveBeenCalledWith(
      'Selected memory dropped before injection (deleted, unreadable, or untrusted): project:reference.md',
    );
  });

  it('does not publish an unrelated stale memory in the fast result', async () => {
    const stale = {
      ...docs[0]!,
      title: 'Fork setup',
      description: 'Repository migration notes',
      keywords: [],
      usageScenarios: [],
      mtimeMs: 42,
    };
    mockSnapshot([stale]);
    bodyPresentVersions.set('project:reference.md', 41);
    vi.mocked(selectRelevantAutoMemoryDocumentsByModel).mockResolvedValue([]);
    const onFastResult = vi.fn();

    await resolveRelevantAutoMemoryPromptForQuery(
      '/tmp/project',
      'Explain HTTP status 429.',
      { config, onFastResult },
    );

    expect(onFastResult.mock.calls[0]?.[0].selectedDocs).toEqual([]);
  });

  it('bounds model candidates while retaining lexical and recent documents', async () => {
    const lexicalDocs = Array.from({ length: 200 }, (_, index) => ({
      ...memoryDoc(
        `lexical-${String(index).padStart(3, '0')}.md`,
        'reference',
        `Overflow memory ${index}`,
        'Matching historical context',
        '',
      ),
      mtimeMs: 0,
    }));
    const recentDocs = Array.from({ length: 20 }, (_, index) => ({
      ...memoryDoc(
        `recent-${String(index).padStart(2, '0')}.md`,
        'reference',
        `General memory ${index}`,
        'Unrelated recent context',
        '',
      ),
      mtimeMs: 20 - index,
    }));
    const lexicalTarget = {
      ...memoryDoc(
        'overflow-target.md',
        'reference',
        'Overflow Zephyr Marker',
        'Unique semantic target',
        '',
      ),
      mtimeMs: 0,
    };
    mockSnapshot([...lexicalDocs, ...recentDocs, lexicalTarget]);
    vi.mocked(selectRelevantAutoMemoryDocumentsByModel).mockImplementation(
      async (_config, _query, candidates) =>
        candidates.includes(lexicalTarget) ? [lexicalTarget] : [],
    );

    const result = await resolveRelevantAutoMemoryPromptForQuery(
      '/tmp/project',
      'find the overflow zephyr marker',
      { config },
    );

    const modelCandidates = vi.mocked(selectRelevantAutoMemoryDocumentsByModel)
      .mock.calls[0]![2];
    expect(modelCandidates).toHaveLength(200);
    expect(modelCandidates[0]).toBe(lexicalTarget);
    expect(modelCandidates.filter((doc) => recentDocs.includes(doc))).toEqual(
      recentDocs,
    );
    expect(modelCandidates[1]).toBe(recentDocs[0]);
    expect(result.selectedDocs).toEqual([lexicalTarget]);
  });

  it('fills sparse lexical candidates to the model limit with recent docs', async () => {
    const lexicalDocs = Array.from({ length: 3 }, (_, index) =>
      memoryDoc(
        `lexical-${index}.md`,
        'reference',
        `Sparse target ${index}`,
        '',
        '',
      ),
    );
    const recentDocs = Array.from({ length: 250 }, (_, index) => ({
      ...memoryDoc(
        `recent-${String(index).padStart(3, '0')}.md`,
        'reference',
        `General memory ${index}`,
        '',
        '',
      ),
      mtimeMs: 250 - index,
    }));
    mockSnapshot([...lexicalDocs, ...recentDocs]);
    vi.mocked(selectRelevantAutoMemoryDocumentsByModel).mockResolvedValue([]);

    await resolveRelevantAutoMemoryPromptForQuery(
      '/tmp/project',
      'find the sparse target',
      { config },
    );

    const modelCandidates = vi.mocked(selectRelevantAutoMemoryDocumentsByModel)
      .mock.calls[0]![2];
    expect(modelCandidates).toHaveLength(200);
    expect(modelCandidates.filter((doc) => lexicalDocs.includes(doc))).toEqual(
      lexicalDocs,
    );
    expect(modelCandidates).toContain(recentDocs[100]);
  });

  it('falls back to heuristic selection when model-driven selection fails', async () => {
    mockSnapshot(docs);
    vi.mocked(selectRelevantAutoMemoryDocumentsByModel).mockRejectedValue(
      new Error('selector unavailable'),
    );

    const result = await resolveRelevantAutoMemoryPromptForQuery(
      '/tmp/project',
      'check the latency dashboard',
      { config },
    );

    expect(result.strategy).toBe('heuristic');
    expect(result.selectedDocs).toEqual([docs[0]]);
  });

  it('excludes already surfaced bodies before legacy heuristic fallback', async () => {
    vi.mocked(config.getMemoryRecallMode).mockReturnValue('legacy');
    mockSnapshot(docs);
    vi.mocked(selectRelevantAutoMemoryDocumentsByModel).mockRejectedValue(
      new Error('selector unavailable'),
    );

    const result = await resolveRelevantAutoMemoryPromptForQuery(
      '/tmp/project',
      'check the latency dashboard',
      { config, excludedFilePaths: new Set([docs[0]!.filePath]) },
    );

    expect(result.strategy).toBe('none');
    expect(result.selectedDocs).not.toContain(docs[0]);
  });

  it('keeps model selection enabled when no fast model is configured', async () => {
    vi.mocked(config.getFastModel).mockReturnValue(undefined);
    vi.mocked(selectRelevantAutoMemoryDocumentsByModel).mockResolvedValue([
      docs[0],
    ]);

    const result = await resolveRelevantAutoMemoryPromptForQuery(
      '/tmp/project',
      'check the latency dashboard',
      { config },
    );

    expect(result.strategy).toBe('model');
    expect(result.selectedDocs).toEqual([docs[0]]);
    expect(selectRelevantAutoMemoryDocumentsByModel).toHaveBeenCalledOnce();
  });

  it('keeps active tool schemas out of heuristic fallback', async () => {
    mockSnapshot(activeToolDocs);
    let modelCandidates: ScannedAutoMemoryDocument[] = [];
    vi.mocked(selectRelevantAutoMemoryDocumentsByModel).mockImplementation(
      async (_config, _query, candidates) => {
        modelCandidates = candidates;
        throw new Error('selector failed');
      },
    );

    const result = await resolveRelevantAutoMemoryPromptForQuery(
      '/tmp/project',
      'read the ATA article with article-list-query',
      { config, recentTools: ['mcp__ata__article-list-query'] },
    );

    expect(modelCandidates.map((doc) => doc.filePath)).not.toContain(
      '/tmp/ata-tool.md',
    );
    expect(modelCandidates.map((doc) => doc.filePath)).toContain(
      '/tmp/ata-gotcha.md',
    );
    expect(result.strategy).toBe('heuristic');
    expect(result.selectedDocs.map((doc) => doc.filePath)).not.toContain(
      '/tmp/ata-tool.md',
    );
    expect(result.selectedDocs.map((doc) => doc.filePath)).toContain(
      '/tmp/ata-gotcha.md',
    );
    expect(result.selectedDocs.map((doc) => doc.filePath)).toContain(
      '/tmp/ata-owner.md',
    );
  });

  it('applies active tool filtering to keyword and scenario matches', async () => {
    const metadataToolDoc: ScannedAutoMemoryDocument = {
      ...docs[0]!,
      filePath: '/tmp/metadata-tool.md',
      relativePath: 'metadata-tool.md',
      title: 'Archived operational note',
      description: 'Generic historical details',
      keywords: ['article-list-query'],
      usageScenarios: ['checking parameter schema'],
      body: 'No active tool name or usage marker in the body.',
    };
    vi.mocked(scanAutoMemorySnapshot).mockResolvedValue({
      docs: [metadataToolDoc],
      sourceStatus: completeSourceStatus,
    });
    vi.mocked(selectRelevantAutoMemoryDocumentsByModel).mockRejectedValue(
      new Error('selector unavailable'),
    );

    const result = await resolveRelevantAutoMemoryPromptForQuery(
      '/tmp/project',
      'use article-list-query',
      { config, recentTools: ['mcp__ata__article-list-query'] },
    );

    expect(result.selectedDocs).toEqual([]);
  });

  it('never returns more than five documents', async () => {
    vi.mocked(config.getFastModel).mockReturnValue(undefined);
    vi.mocked(scanAutoMemorySnapshot).mockResolvedValue({
      docs: Array.from({ length: 8 }, (_, index) => ({
        ...docs[1],
        filePath: `/tmp/project-${index}.md`,
        relativePath: `project-${index}.md`,
        filename: `project-${index}.md`,
        description: `Shared release context ${index}`,
        mtimeMs: index,
      })),
      sourceStatus: completeSourceStatus,
    });

    const result = await resolveRelevantAutoMemoryPromptForQuery(
      '/tmp/project',
      'shared release context',
      { config, limit: 99 },
    );

    expect(result.selectedDocs).toHaveLength(5);
  });

  it('reports only the documents the focused prompt actually rendered', async () => {
    const capSizedDocs: ScannedAutoMemoryDocument[] = Array.from(
      { length: 5 },
      (_, index) => ({
        ...docs[1]!,
        filePath: `/tmp/cap-${index}.md`,
        relativePath: `cap-${index}.md`,
        filename: `cap-${index}.md`,
        title: `t${index}${'t'.repeat(253)}`,
        description: `d${index}${'d'.repeat(510)}`,
        keywords: Array.from(
          { length: 8 },
          (_, k) => `k${index}-${k}-${'k'.repeat(58)}`,
        ),
        usageScenarios: Array.from(
          { length: 3 },
          (_, k) => `s${index}-${k}-${'s'.repeat(57)}`,
        ),
        mtimeMs: index,
      }),
    );
    mockSnapshot(capSizedDocs);
    vi.mocked(selectRelevantAutoMemoryDocumentsByModel).mockResolvedValue(
      capSizedDocs,
    );

    const result = await resolveRelevantAutoMemoryPromptForQuery(
      '/tmp/project',
      'shared release context',
      { config },
    );

    // The five cap-sized documents overflow the 6000-char focused budget, so
    // the render trims the tail; selectedDocs must not claim undelivered docs.
    expect(result.selectedDocs.length).toBeGreaterThan(0);
    expect(result.selectedDocs.length).toBeLessThan(capSizedDocs.length);
    for (const doc of result.selectedDocs) {
      expect(result.focusedPrompt).toContain(toAutoMemoryRef(doc));
    }
    expect(result.focusedPrompt).toContain('more selected');
    const renderedRefs = new Set(result.selectedDocs.map(toAutoMemoryRef));
    for (const doc of capSizedDocs) {
      if (!renderedRefs.has(toAutoMemoryRef(doc))) {
        expect(result.focusedPrompt).not.toContain(toAutoMemoryRef(doc));
      }
    }
  });
});
