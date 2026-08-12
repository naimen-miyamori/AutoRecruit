import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  requiredDocumentationIndexTargets,
  validateDocumentation,
} from './documentation.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function withTemporaryRepository<T>(run: (rootDir: string) => Promise<T>): Promise<T> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-documentation-'));
  try {
    return await run(rootDir);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

async function writeFile(rootDir: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(rootDir, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

function indexLink(target: string): string {
  const relativeTarget = path.posix.relative('docs', target);
  const normalizedTarget = relativeTarget.startsWith('.') ? relativeTarget : `./${relativeTarget}`;
  return `- [${target}](${normalizedTarget})`;
}

async function createCanonicalDocumentation(rootDir: string): Promise<void> {
  await writeFile(rootDir, '.gitignore', [
    'docs/plan/',
    'docs/generated/',
    'docs/design/stitch-artifacts/',
    '',
  ].join('\n'));
  await writeFile(rootDir, '.nvmrc', '24\n');
  await writeFile(rootDir, 'package.json', JSON.stringify({
    engines: { node: '>=24 <27' },
    scripts: { dev: 'node app.js', 'docs:check': 'node documentation.js' },
  }));
  await writeFile(rootDir, 'README.md', '# README\n\nNode.js 24 LTS supports `>=24 <27`.\n\n`npm run dev`\n');
  await writeFile(
    rootDir,
    '项目说明文档.md',
    '# 项目说明文档\n\nNode.js 24 LTS uses `.nvmrc` and `>=24 <27`.\n',
  );
  await writeFile(
    rootDir,
    'AGENTS.md',
    '# AGENTS\n\nUse Node 24 LTS by default. .nvmrc is 24 and package.json supports >=24 <27.\n',
  );
  await writeFile(
    rootDir,
    'docs/README.md',
    `# 文档中心\n\n${requiredDocumentationIndexTargets.map(indexLink).join('\n')}\n`,
  );
  await writeFile(rootDir, 'docs/rag功能说明.md', '# RAG 功能说明\n');
  await writeFile(rootDir, 'docs/rag运营手册.md', '# RAG 运营手册\n');
  await writeFile(rootDir, 'docs/项目面试问答.md', '# 项目面试问答\n');
  await writeFile(rootDir, 'docs/design/DESIGN.md', '# Design\n');
  await writeFile(rootDir, 'docs/architecture/autorecruit-functional-architecture.html', '<!doctype html>\n');
}

describe('documentation governance', () => {
  it('accepts the repository documentation', async () => {
    const validation = await validateDocumentation(repositoryRoot);
    assert.deepStrictEqual(validation.violations, []);
    assert.equal(validation.valid, true);
    assert.ok(validation.checkedMarkdownFiles.includes('docs/README.md'));
  });

  it('accepts the canonical shared/local/generated boundary', async () => {
    await withTemporaryRepository(async (rootDir) => {
      await createCanonicalDocumentation(rootDir);
      const validation = await validateDocumentation(rootDir);
      assert.deepStrictEqual(validation.violations, []);
      assert.equal(validation.valid, true);
    });
  });

  it('reports broken navigation, unknown scripts, runtime drift, and broad docs ignores', async () => {
    await withTemporaryRepository(async (rootDir) => {
      await createCanonicalDocumentation(rootDir);
      await writeFile(rootDir, '.gitignore', 'docs/\n');
      await writeFile(rootDir, '.nvmrc', '22\n');
      await writeFile(rootDir, 'package.json', JSON.stringify({
        engines: { node: '>=22 <23' },
        scripts: {},
      }));
      await writeFile(rootDir, 'README.md', [
        '# README',
        '',
        'Node.js 22.',
        '',
        '[missing](./missing.md)',
        '',
        '`npm run missing-script`',
      ].join('\n'));
      await writeFile(rootDir, 'docs/README.md', '# 文档中心\n');
      await writeFile(rootDir, 'docs/orphan-guide.md', '# Orphan\n');

      const validation = await validateDocumentation(rootDir);
      assert.equal(validation.valid, false);
      assert.ok(validation.violations.includes('.gitignore must not ignore the shared docs/ directory'));
      assert.ok(validation.violations.includes('.gitignore must include docs/plan/'));
      assert.ok(validation.violations.includes('.nvmrc must select Node 24'));
      assert.ok(validation.violations.includes('package.json engines.node must be >=24 <27'));
      assert.ok(validation.violations.includes('README.md links to missing path: ./missing.md'));
      assert.ok(validation.violations.includes('README.md references unknown npm script: missing-script'));
      assert.ok(validation.violations.includes('docs/README.md must link to README.md'));
      assert.ok(validation.violations.includes('docs/README.md must link to shared document docs/orphan-guide.md'));
      assert.ok(validation.violations.includes('README.md must document runtime anchor: Node.js 24 LTS'));
    });
  });
});
