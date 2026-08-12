import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface AgentInstructionValidation {
  valid: boolean;
  violations: string[];
}

interface AgentDocumentRequirement {
  filePath: string;
  headings: readonly string[];
  requiredSnippets?: readonly string[];
}

interface ScopeRouteRequirement {
  parentPath: string;
  childPath: string;
  reference: string;
}

interface CrossReadRequirement {
  documentPath: string;
  targetPath: string;
  reference: string;
}

const scopedDocumentHeadings = ['Scope and Inheritance', 'Ownership and Boundaries', 'Verification'] as const;
const ignoredDirectoryNames = new Set([
  '.agents',
  '.assistant',
  '.git',
  '.resume-work',
  '.venv',
  'data',
  'dist',
  'node_modules',
  'playwright-report',
  'resume-output',
  'test-results',
  'tmp',
]);
const ignoredPathPrefixes = [
  'docs/design/stitch-artifacts/',
  'docs/generated/',
  'docs/plan/',
  'frontend/dist/',
] as const;

export const agentDocumentRequirements: readonly AgentDocumentRequirement[] = [
  {
    filePath: 'AGENTS.md',
    headings: ['Scope, Inheritance, and Routing', 'Screenshot Inspection Isolation', 'Verification Matrix'],
    requiredSnippets: [
      'must be delegated to a subagent',
      'primary agent must not invoke',
      'subagent must return text-only findings',
      'wait or report the screenshot inspection as blocked',
      'Never fall back to loading the image in the primary conversation context',
    ],
  },
  { filePath: 'src/browser/AGENTS.md', headings: scopedDocumentHeadings },
  { filePath: 'src/mode-runners/AGENTS.md', headings: scopedDocumentHeadings },
  { filePath: 'src/platforms/AGENTS.md', headings: scopedDocumentHeadings },
  { filePath: 'src/platforms/51job/AGENTS.md', headings: scopedDocumentHeadings },
  { filePath: 'src/platforms/liepin/AGENTS.md', headings: scopedDocumentHeadings },
  { filePath: 'src/platforms/zhilian/AGENTS.md', headings: scopedDocumentHeadings },
  { filePath: 'src/platforms/boss/AGENTS.md', headings: scopedDocumentHeadings },
  { filePath: 'src/talent-mapping/AGENTS.md', headings: scopedDocumentHeadings },
  { filePath: 'src/rag/AGENTS.md', headings: scopedDocumentHeadings },
  { filePath: 'src/server/AGENTS.md', headings: scopedDocumentHeadings },
  { filePath: 'frontend/AGENTS.md', headings: scopedDocumentHeadings },
];

export const agentScopeRouteRequirements: readonly ScopeRouteRequirement[] = [
  { parentPath: 'AGENTS.md', childPath: 'src/browser/AGENTS.md', reference: 'src/browser/AGENTS.md' },
  { parentPath: 'AGENTS.md', childPath: 'src/mode-runners/AGENTS.md', reference: 'src/mode-runners/AGENTS.md' },
  { parentPath: 'AGENTS.md', childPath: 'src/platforms/AGENTS.md', reference: 'src/platforms/AGENTS.md' },
  { parentPath: 'AGENTS.md', childPath: 'src/talent-mapping/AGENTS.md', reference: 'src/talent-mapping/AGENTS.md' },
  { parentPath: 'AGENTS.md', childPath: 'src/rag/AGENTS.md', reference: 'src/rag/AGENTS.md' },
  { parentPath: 'AGENTS.md', childPath: 'src/server/AGENTS.md', reference: 'src/server/AGENTS.md' },
  { parentPath: 'AGENTS.md', childPath: 'frontend/AGENTS.md', reference: 'frontend/AGENTS.md' },
  {
    parentPath: 'src/platforms/AGENTS.md',
    childPath: 'src/platforms/51job/AGENTS.md',
    reference: 'src/platforms/51job/AGENTS.md',
  },
  {
    parentPath: 'src/platforms/AGENTS.md',
    childPath: 'src/platforms/liepin/AGENTS.md',
    reference: 'src/platforms/liepin/AGENTS.md',
  },
  {
    parentPath: 'src/platforms/AGENTS.md',
    childPath: 'src/platforms/zhilian/AGENTS.md',
    reference: 'src/platforms/zhilian/AGENTS.md',
  },
  {
    parentPath: 'src/platforms/AGENTS.md',
    childPath: 'src/platforms/boss/AGENTS.md',
    reference: 'src/platforms/boss/AGENTS.md',
  },
];

export const agentCrossReadRequirements: readonly CrossReadRequirement[] = [
  {
    documentPath: 'src/platforms/AGENTS.md',
    targetPath: 'src/browser/AGENTS.md',
    reference: 'src/browser/AGENTS.md',
  },
  ...['51job', 'liepin', 'zhilian'].map((platform): CrossReadRequirement => ({
    documentPath: `src/platforms/${platform}/AGENTS.md`,
    targetPath: 'src/browser/AGENTS.md',
    reference: 'src/browser/AGENTS.md',
  })),
  {
    documentPath: 'src/platforms/boss/AGENTS.md',
    targetPath: 'src/browser/AGENTS.md',
    reference: 'src/browser/AGENTS.md',
  },
  {
    documentPath: 'src/platforms/boss/AGENTS.md',
    targetPath: 'src/server/AGENTS.md',
    reference: 'src/server/AGENTS.md',
  },
  {
    documentPath: 'src/talent-mapping/AGENTS.md',
    targetPath: 'src/platforms/AGENTS.md',
    reference: 'src/platforms/AGENTS.md',
  },
  {
    documentPath: 'src/talent-mapping/AGENTS.md',
    targetPath: 'src/server/AGENTS.md',
    reference: 'src/server/AGENTS.md',
  },
  {
    documentPath: 'src/talent-mapping/AGENTS.md',
    targetPath: 'frontend/AGENTS.md',
    reference: 'frontend/AGENTS.md',
  },
  {
    documentPath: 'src/rag/AGENTS.md',
    targetPath: 'src/server/AGENTS.md',
    reference: 'src/server/AGENTS.md',
  },
  {
    documentPath: 'src/server/AGENTS.md',
    targetPath: 'frontend/AGENTS.md',
    reference: 'frontend/AGENTS.md',
  },
  {
    documentPath: 'frontend/AGENTS.md',
    targetPath: 'src/server/AGENTS.md',
    reference: 'src/server/AGENTS.md',
  },
  ...[
    'src/browser/AGENTS.md',
    'src/platforms/AGENTS.md',
    'src/rag/AGENTS.md',
    'src/server/AGENTS.md',
    'src/talent-mapping/AGENTS.md',
  ].map((targetPath): CrossReadRequirement => ({
    documentPath: 'src/mode-runners/AGENTS.md',
    targetPath,
    reference: targetPath,
  })),
];

function escapeRegularExpression(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

function findSectionContent(content: string, heading: string): string | undefined {
  const headingPattern = new RegExp(`^## ${escapeRegularExpression(heading)}\\s*$`, 'm');
  const match = headingPattern.exec(content);
  if (!match) return undefined;
  const sectionStart = match.index + match[0].length;
  const nextHeading = /^## /m.exec(content.slice(sectionStart));
  const sectionEnd = nextHeading ? sectionStart + nextHeading.index : content.length;
  return content.slice(sectionStart, sectionEnd).trim();
}

function countSectionHeadings(content: string, heading: string): number {
  const headingPattern = new RegExp(`^## ${escapeRegularExpression(heading)}\\s*$`, 'gm');
  return [...content.matchAll(headingPattern)].length;
}

async function readFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function toRelativePath(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).split(path.sep).join('/');
}

function isIgnoredPath(relativePath: string): boolean {
  const normalized = relativePath.endsWith('/') ? relativePath : `${relativePath}/`;
  return ignoredPathPrefixes.some((prefix) => normalized.startsWith(prefix));
}

async function collectRepositoryFiles(
  rootDir: string,
  currentDirectory = rootDir,
): Promise<string[]> {
  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(currentDirectory, { withFileTypes: true, encoding: 'utf8' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const filePath = path.join(currentDirectory, entry.name);
    const relativePath = toRelativePath(rootDir, filePath);
    if (entry.isDirectory()) {
      if (ignoredDirectoryNames.has(entry.name) || isIgnoredPath(relativePath)) continue;
      files.push(...await collectRepositoryFiles(rootDir, filePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

function parsePackageScripts(content: string | undefined): Set<string> {
  if (!content) return new Set();
  try {
    const parsed = JSON.parse(content) as { scripts?: unknown };
    if (!parsed.scripts || typeof parsed.scripts !== 'object') return new Set();
    return new Set(Object.entries(parsed.scripts)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([name]) => name));
  } catch {
    return new Set();
  }
}

function filePatternMatches(pattern: string, repositoryFiles: readonly string[]): boolean {
  const expression = new RegExp(`^${escapeRegularExpression(pattern).replace(/\\\*/g, '[^/]*')}$`);
  return repositoryFiles.some((filePath) => expression.test(filePath));
}

function addReferenceViolations(
  documentPath: string,
  content: string,
  packageScripts: ReadonlySet<string>,
  repositoryFiles: readonly string[],
  violations: Set<string>,
): void {
  for (const match of content.matchAll(/\bnpm run ([a-zA-Z0-9:_-]+)/g)) {
    const scriptName = match[1];
    if (scriptName && !packageScripts.has(scriptName)) {
      violations.add(`${documentPath} references unknown npm script: ${scriptName}`);
    }
  }

  const referencedTestPatterns = new Set(
    [...content.matchAll(/\bsrc\/scripts\/test-[A-Za-z0-9*_.-]+\.ts\b/g)]
      .map((match) => match[0]),
  );
  for (const testPattern of referencedTestPatterns) {
    if (!filePatternMatches(testPattern, repositoryFiles)) {
      violations.add(`${documentPath} references missing test path or pattern: ${testPattern}`);
    }
  }

  const verification = findSectionContent(content, 'Verification');
  if (!verification) return;
  for (const match of verification.matchAll(/(?<!rtk )\bnpm run ([a-zA-Z0-9:_-]+)/g)) {
    violations.add(`${documentPath} Verification command must use rtk: npm run ${match[1]}`);
  }
  if (/(?<!rtk )\bgit diff --check\b/.test(verification)) {
    violations.add(`${documentPath} Verification command must use rtk: git diff --check`);
  }
}

export async function validateAgentInstructions(rootDir: string): Promise<AgentInstructionValidation> {
  const root = path.resolve(rootDir);
  const contentByPath = new Map<string, string>();
  const violations = new Set<string>();
  const repositoryFiles = await collectRepositoryFiles(root);
  const discoveredAgentDocuments = repositoryFiles
    .filter((filePath) => path.posix.basename(filePath) === 'AGENTS.md')
    .sort();
  const registeredPaths = new Set(agentDocumentRequirements.map((requirement) => requirement.filePath));

  const requirementCountByPath = new Map<string, number>();
  for (const requirement of agentDocumentRequirements) {
    requirementCountByPath.set(
      requirement.filePath,
      (requirementCountByPath.get(requirement.filePath) ?? 0) + 1,
    );
  }
  for (const [filePath, count] of requirementCountByPath) {
    if (count > 1) violations.add(`${filePath} is registered more than once`);
  }

  for (const discoveredPath of discoveredAgentDocuments) {
    if (!registeredPaths.has(discoveredPath)) {
      violations.add(`${discoveredPath} is an unregistered AGENTS.md document`);
    }
  }

  for (const requirement of agentDocumentRequirements) {
    const content = await readFileIfExists(path.join(root, requirement.filePath));
    if (content === undefined) {
      violations.add(`${requirement.filePath} is required`);
      continue;
    }
    contentByPath.set(requirement.filePath, content);
    const normalizedContent = content.replace(/\s+/g, ' ');
    for (const heading of requirement.headings) {
      const headingCount = countSectionHeadings(content, heading);
      if (headingCount > 1) {
        violations.add(`${requirement.filePath} must include exactly one ## ${heading}`);
        continue;
      }
      const section = findSectionContent(content, heading);
      if (section === undefined) {
        violations.add(`${requirement.filePath} must include ## ${heading}`);
      } else if (!section) {
        violations.add(`${requirement.filePath} must include content under ## ${heading}`);
      }
    }
    for (const snippet of requirement.requiredSnippets ?? []) {
      if (!normalizedContent.includes(snippet.replace(/\s+/g, ' '))) {
        violations.add(`${requirement.filePath} must retain required instruction: ${snippet}`);
      }
    }
  }

  const scopeParentByChild = new Map<string, string>();
  const scopeRouteKeys = new Set<string>();
  for (const route of agentScopeRouteRequirements) {
    if (!registeredPaths.has(route.parentPath)) {
      violations.add(`scope route parent is not registered: ${route.parentPath}`);
    }
    if (!registeredPaths.has(route.childPath)) {
      violations.add(`scope route child is not registered: ${route.childPath}`);
    }
    const routeKey = `${route.parentPath}\n${route.childPath}`;
    if (scopeRouteKeys.has(routeKey)) {
      violations.add(`${route.childPath} has a duplicate scope route from ${route.parentPath}`);
      continue;
    }
    scopeRouteKeys.add(routeKey);
    const existingParent = scopeParentByChild.get(route.childPath);
    if (existingParent && existingParent !== route.parentPath) {
      violations.add(`${route.childPath} has multiple scope parents: ${existingParent}, ${route.parentPath}`);
      continue;
    }
    scopeParentByChild.set(route.childPath, route.parentPath);
    const parent = contentByPath.get(route.parentPath);
    if (parent !== undefined && !parent.includes(route.reference)) {
      violations.add(`${route.parentPath} must scope-route to ${route.childPath}`);
    }
  }
  for (const requirement of agentDocumentRequirements) {
    if (requirement.filePath !== 'AGENTS.md' && !scopeParentByChild.has(requirement.filePath)) {
      violations.add(`${requirement.filePath} must have exactly one scope parent`);
    }
  }
  if (scopeParentByChild.has('AGENTS.md')) {
    violations.add('AGENTS.md must remain the root scope document');
  }
  for (const childPath of scopeParentByChild.keys()) {
    const visited = new Set<string>();
    let currentPath: string | undefined = childPath;
    while (currentPath) {
      if (visited.has(currentPath)) {
        violations.add(`${childPath} has a cyclic scope route`);
        break;
      }
      visited.add(currentPath);
      currentPath = scopeParentByChild.get(currentPath);
    }
  }

  const crossReadKeys = new Set<string>();
  for (const dependency of agentCrossReadRequirements) {
    const dependencyKey = `${dependency.documentPath}\n${dependency.targetPath}`;
    if (crossReadKeys.has(dependencyKey)) {
      violations.add(`${dependency.documentPath} has a duplicate cross-read target: ${dependency.targetPath}`);
      continue;
    }
    crossReadKeys.add(dependencyKey);
    if (!registeredPaths.has(dependency.documentPath)) {
      violations.add(`cross-read source is not registered: ${dependency.documentPath}`);
      continue;
    }
    if (!registeredPaths.has(dependency.targetPath)) {
      violations.add(`cross-read target is not registered: ${dependency.targetPath}`);
      continue;
    }
    const content = contentByPath.get(dependency.documentPath);
    if (content !== undefined && !content.includes(dependency.reference)) {
      violations.add(`${dependency.documentPath} must cross-read ${dependency.targetPath}`);
    }
  }

  const packageScripts = parsePackageScripts(await readFileIfExists(path.join(root, 'package.json')));
  for (const [documentPath, content] of contentByPath) {
    addReferenceViolations(documentPath, content, packageScripts, repositoryFiles, violations);
  }

  const sortedViolations = [...violations].sort();
  return { valid: sortedViolations.length === 0, violations: sortedViolations };
}

export async function main(argv = process.argv.slice(2), rootDir = process.cwd()): Promise<void> {
  const [command = 'check', ...options] = argv;
  if (command !== 'check' || options.length > 0) {
    throw new Error('Usage: agents:check');
  }
  const validation = await validateAgentInstructions(rootDir);
  if (!validation.valid) {
    throw new Error(`AGENTS validation failed:\n${validation.violations.map((violation) => `- ${violation}`).join('\n')}`);
  }
  console.log(`AGENTS validation passed (${agentDocumentRequirements.length} documents)`);
}

const entrypointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypointUrl === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
