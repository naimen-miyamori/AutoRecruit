import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  agentCrossReadRequirements,
  agentDocumentRequirements,
  agentScopeRouteRequirements,
  validateAgentInstructions,
} from './agent-instructions.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function withTemporaryRepository<T>(run: (rootDir: string) => Promise<T>): Promise<T> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-agent-instructions-'));
  try {
    return await run(rootDir);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

function renderDocument(filePath: string): string {
  const requirement = agentDocumentRequirements.find((item) => item.filePath === filePath);
  if (!requirement) throw new Error(`Unknown requirement: ${filePath}`);
  const references = [
    ...agentScopeRouteRequirements
      .filter((route) => route.parentPath === filePath)
      .map((route) => route.reference),
    ...agentCrossReadRequirements
      .filter((dependency) => dependency.documentPath === filePath)
      .map((dependency) => dependency.reference),
  ].filter((reference, index, all) => all.indexOf(reference) === index);
  const sections = requirement.headings
    .map((heading, index) => [
      `## ${heading}`,
      '',
      `Contract content for ${heading}.`,
      ...(index === 0 && references.length > 0 ? ['', ...references] : []),
      ...(index === 0 && requirement.requiredSnippets?.length
        ? ['', ...requirement.requiredSnippets]
        : []),
    ].join('\n'))
    .join('\n\n');
  return `# Instructions\n\n${sections}\n`;
}

async function createCanonicalLayout(rootDir: string): Promise<void> {
  for (const requirement of agentDocumentRequirements) {
    const filePath = path.join(rootDir, requirement.filePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, renderDocument(requirement.filePath), 'utf8');
  }
}

describe('AGENTS instruction structure', () => {
  it('accepts the repository and covers every current AGENTS document', async () => {
    const validation = await validateAgentInstructions(repositoryRoot);
    assert.deepStrictEqual(validation, { valid: true, violations: [] });
    assert.equal(agentDocumentRequirements.length, 12);
    assert.ok(agentDocumentRequirements.some((item) => item.filePath === 'src/mode-runners/AGENTS.md'));
    assert.ok(agentScopeRouteRequirements.some((route) => (
      route.parentPath === 'AGENTS.md' && route.childPath === 'src/mode-runners/AGENTS.md'
    )));
  });

  it('accepts the canonical scope tree and cyclic cross-read graph', async () => {
    await withTemporaryRepository(async (rootDir) => {
      await createCanonicalLayout(rootDir);
      const validation = await validateAgentInstructions(rootDir);
      assert.deepStrictEqual(validation, { valid: true, violations: [] });
    });
  });

  it('fails when the mode-runner scoped contract is deleted', async () => {
    await withTemporaryRepository(async (rootDir) => {
      await createCanonicalLayout(rootDir);
      await fs.rm(path.join(rootDir, 'src', 'mode-runners', 'AGENTS.md'));

      const validation = await validateAgentInstructions(rootDir);
      assert.equal(validation.valid, false);
      assert.ok(validation.violations.includes('src/mode-runners/AGENTS.md is required'));
    });
  });

  it('requires the root screenshot-inspection isolation contract', async () => {
    await withTemporaryRepository(async (rootDir) => {
      await createCanonicalLayout(rootDir);
      const rootPath = path.join(rootDir, 'AGENTS.md');
      const root = await fs.readFile(rootPath, 'utf8');
      await fs.writeFile(
        rootPath,
        root.replace('subagent must return text-only findings', 'subagent may return its findings'),
        'utf8',
      );

      const validation = await validateAgentInstructions(rootDir);
      assert.equal(validation.valid, false);
      assert.ok(validation.violations.includes(
        'AGENTS.md must retain required instruction: subagent must return text-only findings',
      ));
    });
  });

  it('reports missing documents, empty sections, and missing scope routing', async () => {
    await withTemporaryRepository(async (rootDir) => {
      await createCanonicalLayout(rootDir);
      await fs.rm(path.join(rootDir, 'src', 'platforms', 'boss', 'AGENTS.md'));

      const platformsPath = path.join(rootDir, 'src', 'platforms', 'AGENTS.md');
      const platforms = await fs.readFile(platformsPath, 'utf8');
      await fs.writeFile(
        platformsPath,
        platforms.replace(
          '## Verification\n\nContract content for Verification.',
          '## Verification\n',
        ),
        'utf8',
      );

      const rootPath = path.join(rootDir, 'AGENTS.md');
      const root = await fs.readFile(rootPath, 'utf8');
      await fs.writeFile(rootPath, root.replace('src/mode-runners/AGENTS.md', ''), 'utf8');

      const browserPath = path.join(rootDir, 'src', 'browser', 'AGENTS.md');
      const browser = await fs.readFile(browserPath, 'utf8');
      await fs.writeFile(browserPath, `${browser}\n## Verification\n\nDuplicate section.\n`, 'utf8');

      const validation = await validateAgentInstructions(rootDir);
      assert.equal(validation.valid, false);
      assert.ok(validation.violations.includes('src/platforms/boss/AGENTS.md is required'));
      assert.ok(validation.violations.includes('src/platforms/AGENTS.md must include content under ## Verification'));
      assert.ok(validation.violations.includes('AGENTS.md must scope-route to src/mode-runners/AGENTS.md'));
      assert.ok(validation.violations.includes('src/browser/AGENTS.md must include exactly one ## Verification'));
    });
  });

  it('rejects an automatically discovered but unregistered scoped document', async () => {
    await withTemporaryRepository(async (rootDir) => {
      await createCanonicalLayout(rootDir);
      const orphanPath = path.join(rootDir, 'src', 'orphan', 'AGENTS.md');
      await fs.mkdir(path.dirname(orphanPath), { recursive: true });
      await fs.writeFile(orphanPath, '# Orphan instructions\n', 'utf8');
      const ignoredPlanPath = path.join(rootDir, 'docs', 'plan', 'AGENTS.md');
      await fs.mkdir(path.dirname(ignoredPlanPath), { recursive: true });
      await fs.writeFile(ignoredPlanPath, '# Local plan instructions\n', 'utf8');

      const validation = await validateAgentInstructions(rootDir);
      assert.equal(validation.valid, false);
      assert.ok(validation.violations.includes('src/orphan/AGENTS.md is an unregistered AGENTS.md document'));
      assert.ok(!validation.violations.some((violation) => violation.startsWith('docs/plan/AGENTS.md')));
    });
  });

  it('validates cross-read references independently from scope parents', async () => {
    await withTemporaryRepository(async (rootDir) => {
      await createCanonicalLayout(rootDir);
      const ragPath = path.join(rootDir, 'src', 'rag', 'AGENTS.md');
      const rag = await fs.readFile(ragPath, 'utf8');
      await fs.writeFile(ragPath, rag.replace('src/server/AGENTS.md', 'server instructions'), 'utf8');

      const validation = await validateAgentInstructions(rootDir);
      assert.equal(validation.valid, false);
      assert.ok(validation.violations.includes('src/rag/AGENTS.md must cross-read src/server/AGENTS.md'));
      assert.ok(!validation.violations.some((violation) => violation.includes('multiple scope parents')));
    });
  });

  it('rejects missing test references, unknown scripts, and verification commands without rtk', async () => {
    await withTemporaryRepository(async (rootDir) => {
      await createCanonicalLayout(rootDir);
      await fs.writeFile(path.join(rootDir, 'package.json'), JSON.stringify({ scripts: {} }), 'utf8');
      const runnerPath = path.join(rootDir, 'src', 'mode-runners', 'AGENTS.md');
      const runner = await fs.readFile(runnerPath, 'utf8');
      await fs.writeFile(
        runnerPath,
        runner.replace(
          'Contract content for Verification.',
          'Contract content for Verification.\n\nnpm run missing-script\n\nsrc/scripts/test-missing.ts',
        ),
        'utf8',
      );

      const validation = await validateAgentInstructions(rootDir);
      assert.equal(validation.valid, false);
      assert.ok(validation.violations.includes(
        'src/mode-runners/AGENTS.md references unknown npm script: missing-script',
      ));
      assert.ok(validation.violations.includes(
        'src/mode-runners/AGENTS.md references missing test path or pattern: src/scripts/test-missing.ts',
      ));
      assert.ok(validation.violations.includes(
        'src/mode-runners/AGENTS.md Verification command must use rtk: npm run missing-script',
      ));
    });
  });
});
