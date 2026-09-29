/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Storage,
  type Config,
  type SkillLevel,
} from '@qwen-code/qwen-code-core';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  deleteManagedSkill,
  setManagedSkillEnabled,
} from './skill-management.js';

type SkillManager = NonNullable<ReturnType<Config['getSkillManager']>>;

function configWith(skillManager: object): Config {
  return {
    getSkillManager: () => skillManager as SkillManager,
  } as unknown as Config;
}

function managerFor(name: string) {
  const parseSkillContent = vi.fn(
    (_content: string, filePath: string, level: SkillLevel) => ({
      name,
      description: `${name} skill`,
      level,
      filePath,
      skillRoot: path.dirname(filePath),
      body: 'Body',
    }),
  );
  const refreshCache = vi.fn().mockResolvedValue(undefined);
  return { parseSkillContent, refreshCache };
}

async function writeSkill(root: string, relativeDir: string, name: string) {
  const skillDir = path.join(root, relativeDir, name);
  const skillFile = path.join(skillDir, 'SKILL.md');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    skillFile,
    `---\nname: ${name}\ndescription: ${name} skill\n---\nBody\n`,
    'utf8',
  );
  return { skillDir, skillFile };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('managed Skill mutations', () => {
  it('enables, disables, and deletes a global Skill', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(tempHome);
    const { skillDir, skillFile } = await writeSkill(
      tempHome,
      'skills',
      'pptx',
    );
    const manager = managerFor('pptx');
    const config = configWith(manager);

    try {
      await expect(
        setManagedSkillEnabled(config, {
          skill: { slug: 'pptx', enabled: false },
        }),
      ).resolves.toMatchObject({
        slug: 'pptx',
        enabled: false,
        installedPath: skillFile,
      });
      await expect(fs.readFile(skillFile, 'utf8')).resolves.toContain(
        'disable-model-invocation: true',
      );

      await setManagedSkillEnabled(config, {
        skill: { slug: 'pptx', enabled: true },
      });
      await expect(fs.readFile(skillFile, 'utf8')).resolves.not.toContain(
        'disable-model-invocation',
      );

      await expect(
        deleteManagedSkill(config, { skill: { slug: 'pptx' } }),
      ).resolves.toEqual({ slug: 'pptx', deleted: true });
      await expect(fs.stat(skillDir)).rejects.toThrow();
      expect(manager.refreshCache).toHaveBeenCalledTimes(3);
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it('can disable and delete a legacy artifact-shaped global Skill', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(tempHome);
    const slug = 'foo.backup-1-2';
    const { skillDir, skillFile } = await writeSkill(tempHome, 'skills', slug);
    const manager = managerFor(slug);
    const config = configWith(manager);

    try {
      await expect(
        setManagedSkillEnabled(config, {
          skill: { slug, enabled: false },
        }),
      ).resolves.toMatchObject({
        slug,
        enabled: false,
        installedPath: skillFile,
      });
      await expect(fs.readFile(skillFile, 'utf8')).resolves.toContain(
        'disable-model-invocation: true',
      );

      await expect(
        deleteManagedSkill(config, { skill: { slug } }),
      ).resolves.toEqual({ slug, deleted: true });
      await expect(fs.stat(skillDir)).rejects.toThrow();
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it('preserves comments and nested hooks when toggling frontmatter', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(tempHome);
    const skillDir = path.join(tempHome, 'skills', 'pptx');
    const skillFile = path.join(skillDir, 'SKILL.md');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      skillFile,
      '---\n# keep this comment\nname: pptx\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      command: echo hi\n---\nBody\n',
      'utf8',
    );
    const config = configWith(managerFor('pptx'));

    try {
      await setManagedSkillEnabled(config, {
        skill: { slug: 'pptx', enabled: false },
      });
      let content = await fs.readFile(skillFile, 'utf8');
      expect(content).toContain('# keep this comment');
      expect(content).toContain('hooks:');
      expect(content).toContain('matcher: Bash');
      expect(content).toContain('disable-model-invocation: true');

      await setManagedSkillEnabled(config, {
        skill: { slug: 'pptx', enabled: true },
      });
      content = await fs.readFile(skillFile, 'utf8');
      expect(content).toContain('# keep this comment');
      expect(content).toContain('hooks:');
      expect(content).not.toContain('disable-model-invocation');
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it('resolves user and project Skills through the existing manager fallbacks', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    const tempProject = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-project-skill-'),
    );
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(tempHome);
    const userSkill = await writeSkill(tempHome, '.agents/skills', 'course');
    const projectSkill = await writeSkill(
      tempProject,
      '.qwen/skills',
      'project-course',
    );
    const manager = managerFor('unused');
    manager.parseSkillContent.mockImplementation(
      (content: string, filePath: string, level: SkillLevel) => {
        const name = content.match(/^name:\s*(.+)$/m)?.[1] ?? 'unknown';
        return {
          name,
          description: `${name} skill`,
          level,
          filePath,
          skillRoot: path.dirname(filePath),
          body: 'Body',
        };
      },
    );
    const listSkills = vi.fn(({ level }: { level: 'user' | 'project' }) =>
      Promise.resolve(
        level === 'user'
          ? [{ name: 'course', filePath: userSkill.skillFile }]
          : [{ name: 'project-course', filePath: projectSkill.skillFile }],
      ),
    );
    const config = configWith({ ...manager, listSkills });

    try {
      await setManagedSkillEnabled(config, {
        skill: { slug: 'course', enabled: false },
      });
      await setManagedSkillEnabled(config, {
        skill: {
          slug: 'project-course',
          enabled: false,
          scope: 'project',
        },
      });

      await expect(fs.readFile(userSkill.skillFile, 'utf8')).resolves.toContain(
        'disable-model-invocation: true',
      );
      await expect(
        fs.readFile(projectSkill.skillFile, 'utf8'),
      ).resolves.toContain('disable-model-invocation: true');
      expect(listSkills).toHaveBeenCalledWith({ level: 'user' });
      expect(listSkills).toHaveBeenCalledWith({ level: 'project' });
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
      await fs.rm(tempProject, { recursive: true, force: true });
    }
  });

  it('resolves project Skills from the requested working directory', async () => {
    const tempProject = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-project-cwd-skill-'),
    );
    const skillDir = path.join(tempProject, '.qwen', 'skills', 'issue-fixer');
    const skillFile = path.join(skillDir, 'SKILL.md');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      skillFile,
      '---\nname: bugfix\ndescription: Bugfix skill\n---\nBody\n',
      'utf8',
    );
    const manager = managerFor('bugfix');
    const loadSkillsFromDir = vi.fn().mockResolvedValue([
      {
        name: 'bugfix',
        filePath: skillFile,
      },
    ]);
    const listSkills = vi.fn().mockResolvedValue([]);
    const config = configWith({ ...manager, loadSkillsFromDir, listSkills });

    try {
      await expect(
        setManagedSkillEnabled(
          config,
          {
            skill: { slug: 'bugfix', enabled: false, scope: 'project' },
          },
          tempProject,
        ),
      ).resolves.toMatchObject({
        slug: 'bugfix',
        enabled: false,
        installedPath: skillFile,
      });
      expect(loadSkillsFromDir).toHaveBeenCalledWith(
        path.join(tempProject, '.qwen', 'skills'),
        'project',
      );
      expect(listSkills).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempProject, { recursive: true, force: true });
    }
  });

  it('rejects traversal slugs before touching disk', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(tempHome);
    const sentinel = path.join(tempHome, 'settings.json');
    await fs.writeFile(sentinel, '{"keep":true}', 'utf8');
    const config = configWith(managerFor('unused'));

    try {
      for (const slug of ['..', '.']) {
        await expect(
          deleteManagedSkill(config, { skill: { slug } }),
        ).rejects.toThrow('Invalid skill.slug');
        await expect(
          setManagedSkillEnabled(config, {
            skill: { slug, enabled: false },
          }),
        ).rejects.toThrow('Invalid skill.slug');
      }
      await expect(fs.readFile(sentinel, 'utf8')).resolves.toContain('keep');
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });
});
