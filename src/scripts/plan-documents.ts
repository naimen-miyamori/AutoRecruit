import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const planDirectoryRelativePath = path.join('docs', 'plan');
const indexFileName = 'README.md';
const templateFileName = 'TEMPLATE.md';
const indexStartMarker = '<!-- plan-index:active:start -->';
const indexEndMarker = '<!-- plan-index:active:end -->';
const canonicalPlanFileName = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*-plan\.md$/;
const planLikeFileName = /(?:^|[-_.])(plan|计划)(?:[-_.]|$)|(?:plan|计划)\.md$/i;
const legacyPlanFileNames = new Set([
  '2026-05-25-1200-plan.md',
  '2026-05-25-1410-plan.md',
  '2026-05-25-1601-plan.md',
  '2026-05-26-1124-plan.md',
  '2026-06-10-1805-plan.md',
  '2026-06-10-1948-plan.md',
  '2026-06-10-2344-plan.md',
  '2026-07-06-boss-platform-expansion-plan.md',
  '2026-07-14-1539-plan.md',
  '2026-07-20-recurring-workflow-scheduler-plan.md',
  '2026-07-25-frontend-client-rebuild-plan.md',
  '2026-07-26-boss-ui-action-modularization-plan.md',
  '2026-07-26-cross-platform-semantic-action-modularization-plan.md',
]);
const ignoredDirectoryNames = new Set([
  '.git',
  '.assistant',
  'data',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
]);

export const planDocumentTemplate = `# <计划标题>

> 状态：计划中。
>
> 最近更新：<YYYY-MM-DD>。提交策略：本地计划归档，受 \`docs/\` 忽略规则保护，不纳入 Git 提交。

## 1. 背景与目标

<!-- 说明要解决的问题、目标用户和完成后的可验证结果。 -->

## 2. 范围与非目标

<!-- 明确包含内容、排除内容和不可突破的产品/安全边界。 -->

## 3. 当前状态与约束

<!-- 记录已存在能力、兼容性要求、依赖和已知风险。 -->

## 4. 设计方案

<!-- 说明数据、模块、API、界面和失败语义的目标设计。 -->

## 5. 实施阶段

1. 第一阶段：
2. 第二阶段：
3. 第三阶段：

## 6. 测试与验收

<!-- 写明 focused tests、完整验证命令和验收条件。 -->

## 7. 实施结果

<!-- 完成后记录已落地的决策、验证结果与遗留事项。 -->
`;

export const planIndexTemplate = `# 计划文档索引

\`docs/plan/\` 是本仓库的本地计划归档。该目录受 \`.gitignore\` 保护，计划默认不随产品代码提交；已经落地的稳定行为仍须同步到根目录的 \`README.md\` 和 \`项目说明文档.md\`。

## 当前计划

| 文档 | 状态 | 最近更新 | 说明 |
| --- | --- | --- | --- |
${indexStartMarker}
${indexEndMarker}

## 约定

1. 新计划使用 \`YYYY-MM-DD-<主题>-plan.md\` 命名；同日多份计划可在日期后增加时间或简短区分符。
2. 文件开头必须说明状态（计划中、实施中、已完成或已废弃）、最近更新日期，以及是否已提交。
3. 计划记录范围、设计决策、实施顺序、风险与验收；不重复描述当前产品事实。
4. 功能落地后，将稳定的公开行为更新到 \`README.md\` 与 \`项目说明文档.md\`，并把计划状态改为已完成或已废弃。
5. 若未来需要让计划进入版本控制，应先调整 \`.gitignore\`，并在此索引中明确提交策略；不得混合本地计划和已跟踪计划。
`;

export interface CreatePlanDocumentInput {
  rootDir: string;
  topic: string;
  title: string;
  date?: string;
}

export interface PlanDocumentValidation {
  valid: boolean;
  violations: string[];
  planFiles: string[];
}

function normalizeTopic(topic: string): string {
  const value = topic.trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new Error('topic must be lower-case kebab-case, for example talent-mapping');
  }
  return value;
}

function normalizeTitle(title: string): string {
  const value = title.trim();
  if (!value || value.length > 160) {
    throw new Error('title must be a non-empty string of at most 160 characters');
  }
  return value;
}

function normalizeDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new Error('date must use YYYY-MM-DD');
  }
  return value;
}

function dateToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function toRelativePath(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).split(path.sep).join('/');
}

function planPaths(rootDir: string) {
  const planDir = path.join(rootDir, planDirectoryRelativePath);
  return {
    planDir,
    indexPath: path.join(planDir, indexFileName),
    templatePath: path.join(planDir, templateFileName),
  };
}

async function readFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeFileIfMissing(filePath: string, content: string): Promise<void> {
  try {
    await fs.writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

function withIndexMarkers(content: string): string {
  if (content.includes(indexStartMarker) && content.includes(indexEndMarker)) return content;
  return `${content.trimEnd()}\n\n## 当前计划\n\n${indexStartMarker}\n${indexEndMarker}\n`;
}

export async function initializePlanWorkspace(rootDir: string): Promise<{ indexPath: string; templatePath: string }> {
  const resolvedRoot = path.resolve(rootDir);
  const paths = planPaths(resolvedRoot);
  await fs.mkdir(paths.planDir, { recursive: true });
  await writeFileIfMissing(paths.indexPath, planIndexTemplate);
  await writeFileIfMissing(paths.templatePath, planDocumentTemplate);
  const index = await fs.readFile(paths.indexPath, 'utf8');
  const normalized = withIndexMarkers(index);
  if (normalized !== index) {
    await fs.writeFile(paths.indexPath, normalized, 'utf8');
  }
  return { indexPath: paths.indexPath, templatePath: paths.templatePath };
}

function renderPlanDocument(input: { title: string; date: string }): string {
  return planDocumentTemplate
    .replace('# <计划标题>', `# ${input.title}`)
    .replace('<YYYY-MM-DD>', input.date);
}

async function addPlanToIndex(indexPath: string, input: { fileName: string; date: string; title: string }): Promise<void> {
  const current = await fs.readFile(indexPath, 'utf8');
  const normalized = withIndexMarkers(current);
  const entry = `| [${input.fileName}](./${input.fileName}) | 计划中 | ${input.date} | ${input.title} |`;
  if (normalized.includes(`](./${input.fileName})`)) {
    throw new Error(`Plan index already contains ${input.fileName}`);
  }
  const marker = `${indexStartMarker}\n`;
  const next = normalized.replace(marker, `${marker}${entry}\n`);
  await fs.writeFile(indexPath, next, 'utf8');
}

export async function createPlanDocument(input: CreatePlanDocumentInput): Promise<{ filePath: string; indexPath: string }> {
  const rootDir = path.resolve(input.rootDir);
  const topic = normalizeTopic(input.topic);
  const title = normalizeTitle(input.title);
  const date = normalizeDate(input.date ?? dateToday());
  const workspace = await initializePlanWorkspace(rootDir);
  const fileName = `${date}-${topic}-plan.md`;
  const filePath = path.join(planPaths(rootDir).planDir, fileName);
  try {
    await fs.writeFile(filePath, renderPlanDocument({ title, date }), { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Plan already exists: ${toRelativePath(rootDir, filePath)}`);
    }
    throw error;
  }
  try {
    await addPlanToIndex(workspace.indexPath, { fileName, date, title });
  } catch (error) {
    await fs.unlink(filePath).catch(() => undefined);
    throw error;
  }
  return { filePath, indexPath: workspace.indexPath };
}

async function collectMarkdownFiles(rootDir: string, currentDir = rootDir): Promise<string[]> {
  const entries = (await fs.readdir(currentDir, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const files: string[] = [];
  for (const entry of entries) {
    const filePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirectoryNames.has(entry.name)) continue;
      files.push(...await collectMarkdownFiles(rootDir, filePath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(filePath);
    }
  }
  return files;
}

function hasRequiredMetadata(content: string): boolean {
  return /^> 状态：(计划中|实施中|已完成|已废弃)(?:（[^\n]*）)?。(?:[^\n]*)$/m.test(content)
    && /^> 最近更新：\d{4}-\d{2}-\d{2}。提交策略：/m.test(content);
}

export async function validatePlanDocuments(rootDir: string): Promise<PlanDocumentValidation> {
  const resolvedRoot = path.resolve(rootDir);
  const paths = planPaths(resolvedRoot);
  const index = await readFileIfExists(paths.indexPath);
  const markdownFiles = await collectMarkdownFiles(resolvedRoot);
  const planFiles: string[] = [];
  const violations: string[] = [];

  for (const filePath of markdownFiles) {
    const relativePath = toRelativePath(resolvedRoot, filePath);
    const inPlanDirectory = relativePath.startsWith('docs/plan/');
    const fileName = path.basename(filePath);
    if (inPlanDirectory && (fileName === indexFileName || fileName === templateFileName)) continue;
    const isPlan = inPlanDirectory || planLikeFileName.test(fileName);
    if (!isPlan) continue;
    planFiles.push(relativePath);
    if (!inPlanDirectory) {
      violations.push(`${relativePath} must be moved to docs/plan/`);
      continue;
    }
    if (legacyPlanFileNames.has(fileName)) continue;
    if (!canonicalPlanFileName.test(fileName)) {
      violations.push(`${relativePath} must use YYYY-MM-DD-<topic>-plan.md`);
    }
    const content = await fs.readFile(filePath, 'utf8');
    if (!hasRequiredMetadata(content)) {
      violations.push(`${relativePath} must declare status, last-updated date, and Git submission policy at the top`);
    }
    if (!index?.includes(`](./${fileName})`)) {
      violations.push(`${relativePath} is missing from docs/plan/README.md`);
    }
  }

  return { valid: violations.length === 0, violations, planFiles: planFiles.sort() };
}

function readOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function assertNoUnknownOptions(argv: readonly string[], allowed: readonly string[]): void {
  for (const value of argv) {
    if (value.startsWith('--') && !allowed.includes(value)) {
      throw new Error(`Unsupported option: ${value}`);
    }
  }
}

export async function main(argv = process.argv.slice(2), rootDir = process.cwd()): Promise<void> {
  const [command = 'check', ...options] = argv;
  if (command === 'init') {
    const workspace = await initializePlanWorkspace(rootDir);
    console.log(`Initialized ${toRelativePath(path.resolve(rootDir), workspace.indexPath)} and ${toRelativePath(path.resolve(rootDir), workspace.templatePath)}`);
    return;
  }
  if (command === 'new') {
    assertNoUnknownOptions(options, ['--topic', '--title', '--date']);
    const result = await createPlanDocument({
      rootDir,
      topic: readOption(options, '--topic') ?? '',
      title: readOption(options, '--title') ?? '',
      date: readOption(options, '--date'),
    });
    console.log(`Created ${toRelativePath(path.resolve(rootDir), result.filePath)}`);
    return;
  }
  if (command === 'check') {
    const result = await validatePlanDocuments(rootDir);
    if (!result.valid) {
      throw new Error(`Plan document validation failed:\n${result.violations.map((violation) => `- ${violation}`).join('\n')}`);
    }
    console.log(`Plan document validation passed (${result.planFiles.length} plan files)`);
    return;
  }
  throw new Error(`Unknown plan-document command: ${command}`);
}

const entrypointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypointUrl === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
