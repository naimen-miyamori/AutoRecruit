import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sharedDocumentationDirectory = 'docs';
const ignoredDocumentationPrefixes = [
  'docs/plan/',
  'docs/generated/',
  'docs/design/stitch-artifacts/',
] as const;

export const requiredDocumentationFiles = [
  '.gitignore',
  '.nvmrc',
  'package.json',
  'README.md',
  '项目说明文档.md',
  'AGENTS.md',
  'docs/README.md',
  'docs/rag功能说明.md',
  'docs/rag运营手册.md',
  'docs/项目面试问答.md',
  'docs/design/DESIGN.md',
  'docs/architecture/autorecruit-functional-architecture.html',
] as const;

export const requiredDocumentationIndexTargets = [
  'README.md',
  '项目说明文档.md',
  'AGENTS.md',
  'docs/rag功能说明.md',
  'docs/rag运营手册.md',
  'docs/项目面试问答.md',
  'docs/design/DESIGN.md',
  'docs/architecture/autorecruit-functional-architecture.html',
] as const;

const requiredIgnoreEntries = [
  'docs/plan/',
  'docs/generated/',
  'docs/design/stitch-artifacts/',
] as const;

const runtimeDocumentationAnchors: ReadonlyArray<{
  filePath: string;
  snippets: readonly string[];
}> = [
  { filePath: 'README.md', snippets: ['Node.js 24 LTS', '>=24 <27'] },
  { filePath: '项目说明文档.md', snippets: ['Node.js 24 LTS', '.nvmrc', '>=24 <27'] },
  { filePath: 'AGENTS.md', snippets: ['Node 24 LTS', '.nvmrc is 24', '>=24 <27'] },
];

export interface DocumentationValidation {
  valid: boolean;
  violations: string[];
  checkedMarkdownFiles: string[];
}

interface PackageManifest {
  engines?: { node?: unknown };
  scripts?: Record<string, unknown>;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

function toRelativePath(rootDir: string, filePath: string): string {
  return toPosixPath(path.relative(rootDir, filePath));
}

async function readFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function isIgnoredDocumentationPath(relativePath: string): boolean {
  const normalized = relativePath.endsWith('/') ? relativePath : `${relativePath}/`;
  return ignoredDocumentationPrefixes.some((prefix) => normalized.startsWith(prefix));
}

async function collectMarkdownFiles(rootDir: string, directoryPath: string): Promise<string[]> {
  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(directoryPath, { withFileTypes: true, encoding: 'utf8' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const filePath = path.join(directoryPath, entry.name);
    const relativePath = toRelativePath(rootDir, filePath);
    if (entry.isDirectory()) {
      if (isIgnoredDocumentationPath(relativePath)) continue;
      files.push(...await collectMarkdownFiles(rootDir, filePath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.md')) files.push(filePath);
  }
  return files;
}

function withoutFencedCodeBlocks(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '');
}

function extractMarkdownLinkTargets(content: string): string[] {
  const targets: string[] = [];
  const linkPattern = /!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+["'][^)\n]*["'])?\s*\)/g;
  for (const match of withoutFencedCodeBlocks(content).matchAll(linkPattern)) {
    const rawTarget = match[1];
    if (!rawTarget) continue;
    targets.push(rawTarget.startsWith('<') && rawTarget.endsWith('>')
      ? rawTarget.slice(1, -1)
      : rawTarget);
  }
  return targets;
}

function resolveLocalLinkTarget(
  rootDir: string,
  sourceFilePath: string,
  rawTarget: string,
): { relativePath?: string; violation?: string } {
  if (
    rawTarget.startsWith('#')
    || rawTarget.startsWith('//')
    || /^[a-z][a-z0-9+.-]*:/i.test(rawTarget)
  ) {
    return {};
  }
  const targetWithoutFragment = rawTarget.split('#', 1)[0]?.split('?', 1)[0] ?? '';
  if (!targetWithoutFragment) return {};

  let decodedTarget: string;
  try {
    decodedTarget = decodeURIComponent(targetWithoutFragment);
  } catch {
    return { violation: `contains an invalid encoded link target: ${rawTarget}` };
  }

  const resolvedPath = path.resolve(path.dirname(sourceFilePath), decodedTarget);
  const relativePath = toRelativePath(rootDir, resolvedPath);
  if (relativePath === '..' || relativePath.startsWith('../') || path.isAbsolute(relativePath)) {
    return { violation: `links outside the repository: ${rawTarget}` };
  }
  return { relativePath };
}

function parsePackageManifest(content: string): PackageManifest | undefined {
  try {
    const parsed = JSON.parse(content) as unknown;
    return typeof parsed === 'object' && parsed !== null ? parsed as PackageManifest : undefined;
  } catch {
    return undefined;
  }
}

function activeIgnoreLines(content: string): Set<string> {
  return new Set(content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#')));
}

export async function validateDocumentation(rootDir: string): Promise<DocumentationValidation> {
  const root = path.resolve(rootDir);
  const violations = new Set<string>();
  const contentByPath = new Map<string, string>();

  for (const filePath of requiredDocumentationFiles) {
    const content = await readFileIfExists(path.join(root, filePath));
    if (content === undefined) {
      violations.add(`${filePath} is required`);
    } else {
      contentByPath.set(filePath, content);
    }
  }

  const sharedMarkdownFiles = await collectMarkdownFiles(root, path.join(root, sharedDocumentationDirectory));
  const checkedMarkdownPaths = [
    'README.md',
    '项目说明文档.md',
    'AGENTS.md',
    ...sharedMarkdownFiles.map((filePath) => toRelativePath(root, filePath)),
  ].filter((filePath, index, all) => all.indexOf(filePath) === index).sort();

  for (const relativePath of checkedMarkdownPaths) {
    if (contentByPath.has(relativePath)) continue;
    const content = await readFileIfExists(path.join(root, relativePath));
    if (content !== undefined) contentByPath.set(relativePath, content);
  }

  const packageContent = contentByPath.get('package.json');
  const packageManifest = packageContent ? parsePackageManifest(packageContent) : undefined;
  if (packageContent && !packageManifest) {
    violations.add('package.json must contain a JSON object');
  }
  const scripts = new Set(Object.entries(packageManifest?.scripts ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([name]) => name));

  for (const relativePath of checkedMarkdownPaths) {
    const content = contentByPath.get(relativePath);
    if (content === undefined) continue;

    for (const rawTarget of extractMarkdownLinkTargets(content)) {
      const resolved = resolveLocalLinkTarget(root, path.join(root, relativePath), rawTarget);
      if (resolved.violation) {
        violations.add(`${relativePath} ${resolved.violation}`);
        continue;
      }
      if (resolved.relativePath && !await pathExists(path.join(root, resolved.relativePath))) {
        violations.add(`${relativePath} links to missing path: ${rawTarget}`);
      }
    }

    for (const match of content.matchAll(/\bnpm run ([a-zA-Z0-9:_-]+)/g)) {
      const scriptName = match[1];
      if (scriptName && !scripts.has(scriptName)) {
        violations.add(`${relativePath} references unknown npm script: ${scriptName}`);
      }
    }
  }

  const indexContent = contentByPath.get('docs/README.md');
  if (indexContent) {
    const indexedTargets = new Set<string>();
    for (const rawTarget of extractMarkdownLinkTargets(indexContent)) {
      const resolved = resolveLocalLinkTarget(root, path.join(root, 'docs', 'README.md'), rawTarget);
      if (resolved.relativePath) indexedTargets.add(resolved.relativePath);
    }
    for (const requiredTarget of requiredDocumentationIndexTargets) {
      if (!indexedTargets.has(requiredTarget)) {
        violations.add(`docs/README.md must link to ${requiredTarget}`);
      }
    }
    for (const sharedMarkdownPath of sharedMarkdownFiles.map((filePath) => toRelativePath(root, filePath))) {
      if (sharedMarkdownPath !== 'docs/README.md' && !indexedTargets.has(sharedMarkdownPath)) {
        violations.add(`docs/README.md must link to shared document ${sharedMarkdownPath}`);
      }
    }
  }

  const gitignoreContent = contentByPath.get('.gitignore');
  if (gitignoreContent) {
    const ignoreLines = activeIgnoreLines(gitignoreContent);
    if (ignoreLines.has('docs/') || ignoreLines.has('/docs/')) {
      violations.add('.gitignore must not ignore the shared docs/ directory');
    }
    for (const requiredEntry of requiredIgnoreEntries) {
      if (!ignoreLines.has(requiredEntry)) {
        violations.add(`.gitignore must include ${requiredEntry}`);
      }
    }
  }

  const nvmrc = contentByPath.get('.nvmrc');
  if (nvmrc !== undefined && nvmrc.trim() !== '24') {
    violations.add('.nvmrc must select Node 24');
  }
  if (packageManifest && packageManifest.engines?.node !== '>=24 <27') {
    violations.add('package.json engines.node must be >=24 <27');
  }
  for (const anchor of runtimeDocumentationAnchors) {
    const content = contentByPath.get(anchor.filePath);
    if (content === undefined) continue;
    for (const snippet of anchor.snippets) {
      if (!content.includes(snippet)) {
        violations.add(`${anchor.filePath} must document runtime anchor: ${snippet}`);
      }
    }
  }

  const sortedViolations = [...violations].sort();
  return {
    valid: sortedViolations.length === 0,
    violations: sortedViolations,
    checkedMarkdownFiles: checkedMarkdownPaths,
  };
}

export async function main(argv = process.argv.slice(2), rootDir = process.cwd()): Promise<void> {
  const [command = 'check', ...options] = argv;
  if (command !== 'check' || options.length > 0) {
    throw new Error('Usage: docs:check');
  }
  const validation = await validateDocumentation(rootDir);
  if (!validation.valid) {
    throw new Error(`Documentation validation failed:\n${validation.violations.map((violation) => `- ${violation}`).join('\n')}`);
  }
  console.log(`Documentation validation passed (${validation.checkedMarkdownFiles.length} Markdown files)`);
}

const entrypointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypointUrl === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
