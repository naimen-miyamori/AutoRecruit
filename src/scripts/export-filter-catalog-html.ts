import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { parsePlatformArg } from '../platforms/registry.js';
import type { SupportedPlatform } from '../platforms/types.js';
import { buildCascadeApplicationMapping } from '../search/filter-cascade-mapping.js';
import type { SearchFilterCatalog, SearchFilterDefinition, SearchFilterOption } from '../search/filter-catalog.js';
import { buildTextInputApplicationMapping } from '../search/filter-input-mapping.js';
import { buildSingleSelectApplicationMapping } from '../search/filter-single-select-mapping.js';
import { JobStore } from '../storage/job-store.js';

export interface ExportFilterCatalogHtmlCliInput {
  platform: SupportedPlatform;
  outputPath?: string;
}

export interface ExportFilterCatalogHtmlSummary {
  platform: SupportedPlatform;
  outputPath: string;
  filterCount: number;
}

function normalizeText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseArgs(argv: readonly string[]): ExportFilterCatalogHtmlCliInput {
  const platform = parsePlatformArg(argv[0]);
  const outputPath = argv[1]?.trim() || undefined;
  return {
    platform,
    outputPath,
  };
}

function buildDefaultOutputPath(platform: SupportedPlatform): string {
  return path.join(config.dataDir, platform, 'filter-catalog', 'catalog-check.latest.html');
}

function renderBadge(text: string, tone: 'neutral' | 'ok' | 'warn' | 'error' = 'neutral'): string {
  return `<span class="badge badge-${tone}">${escapeHtml(text)}</span>`;
}

function renderSelectorHints(filter: SearchFilterDefinition): string {
  if ((filter.selectorHints?.length ?? 0) === 0) {
    return '<div class="muted">无</div>';
  }

  return `
    <ul class="hint-list">
      ${filter.selectorHints.map((hint) => `<li><code>${escapeHtml(hint.kind)}</code> ${escapeHtml(hint.value)}</li>`).join('')}
    </ul>
  `;
}

function renderOptionRows(options: SearchFilterOption[] | undefined, limit = 200): string {
  if (!options || options.length === 0) {
    return '<div class="muted">无选项</div>';
  }

  const sliced = options.slice(0, limit);
  const remaining = options.length - sliced.length;

  return `
    <table class="option-table">
      <thead>
        <tr>
          <th>#</th>
          <th>depth</th>
          <th>label</th>
          <th>value</th>
          <th>parentPathLabels</th>
          <th>pathLabels</th>
        </tr>
      </thead>
      <tbody>
        ${sliced.map((option, index) => `
          <tr>
            <td>${index + 1}</td>
            <td>${option.depth ?? ''}</td>
            <td>${escapeHtml(normalizeText(option.label))}</td>
            <td>${escapeHtml(normalizeText(option.value))}</td>
            <td>${escapeHtml((option.parentPathLabels ?? []).join(' / '))}</td>
            <td>${escapeHtml((option.pathLabels ?? []).join(' / '))}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    ${remaining > 0 ? `<div class="muted">仅展示前 ${limit} 项，剩余 ${remaining} 项请看 JSON。</div>` : ''}
  `;
}

function renderTreeNode(node: { label: string; pathLabels: string[]; children: Array<{ label: string; pathLabels: string[]; children: unknown[] }> }): string {
  const children = node.children ?? [];
  return `
    <li>
      <div class="tree-node">
        <span class="tree-label">${escapeHtml(node.label)}</span>
        <code>${escapeHtml(node.pathLabels.join(' / '))}</code>
      </div>
      ${children.length > 0 ? `<ul>${children.map((child) => renderTreeNode(child as never)).join('')}</ul>` : ''}
    </li>
  `;
}

function renderCascadeGroupedByParent(
  cascadeField: NonNullable<ReturnType<typeof buildCascadeApplicationMapping>['fieldsById'][string]>,
): string {
  if (!cascadeField.tree || cascadeField.tree.length === 0) {
    return '<div class="muted">无级联树</div>';
  }

  const note = cascadeField.fieldId === 'expected_salary'
    ? `
      <div class="cascade-note">
        期望月薪无需按左侧逐项映射右侧；应用层只需保证右侧不低于左侧，并按 <code>orderedRootLabels</code> 的顺序比较。
      </div>
    `
    : `
      <div class="cascade-note">
        重复的子级 label 需要按 <code>pathLabels</code> 判断；同一个文案出现在不同父级下是合法结果。
      </div>
    `;

  return `
    ${note}
    <div class="cascade-groups">
      ${cascadeField.tree.map((root) => `
        <details class="cascade-group">
          <summary>
            <span class="tree-label">${escapeHtml(root.label)}</span>
            <span class="muted">直接子项 ${root.children.length}</span>
            <code>${escapeHtml(root.pathLabels.join(' / '))}</code>
          </summary>
          ${root.children.length > 0 ? `
            <div class="chip-row cascade-chip-row">
              ${root.children.map((child) => `<span class="chip" title="${escapeHtml(child.pathLabels.join(' / '))}">${escapeHtml(child.label)}</span>`).join('')}
            </div>
          ` : '<div class="muted">无下级选项</div>'}
        </details>
      `).join('')}
    </div>
  `;
}

function listUniqueOptionLabels(options: SearchFilterOption[] | undefined, depth: number): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();

  for (const option of options ?? []) {
    if ((option.depth ?? 0) !== depth) {
      continue;
    }

    const label = normalizeText(option.label);
    if (!label || seen.has(label)) {
      continue;
    }

    seen.add(label);
    labels.push(label);
  }

  return labels;
}

function renderFilterCard(
  filter: SearchFilterDefinition,
  index: number,
  singleSelectMapping: ReturnType<typeof buildSingleSelectApplicationMapping>,
  textInputMapping: ReturnType<typeof buildTextInputApplicationMapping>,
  cascadeMapping: ReturnType<typeof buildCascadeApplicationMapping>,
): string {
  const singleFieldId = singleSelectMapping.fieldIdByLabel[filter.label];
  const textInputFieldId = textInputMapping.fieldIdByLabel[filter.label];
  const cascadeFieldId = cascadeMapping.fieldIdByLabel[filter.label];
  const optionCount = filter.options?.length ?? 0;
  const depthSet = Array.from(new Set((filter.options ?? []).map((option) => option.depth ?? 0))).sort((a, b) => a - b);
  const rootOptionsSample = (filter.options ?? []).filter((option) => (option.depth ?? 0) === 0).slice(0, 12);
  const sampleChildren = (filter.options ?? []).filter((option) => (option.depth ?? 0) > 0).slice(0, 20);
  const cascadeField = cascadeFieldId ? cascadeMapping.fieldsById[cascadeFieldId] : undefined;
  const hideCascadeParentMapping = cascadeField?.fieldId === 'expected_salary';
  const hideFullOptionTable = cascadeField?.fieldId === 'expected_salary';
  const expectedSalaryRootOptions = hideCascadeParentMapping ? (cascadeField?.rootOptions ?? []) : [];
  const expectedSalaryUpperOptions = hideCascadeParentMapping ? listUniqueOptionLabels(filter.options, 1) : [];

  return `
    <section class="filter-card" id="filter-${index + 1}">
      <div class="filter-card-head">
        <h2>${index + 1}. ${escapeHtml(filter.label)}</h2>
        <div class="badges">
          ${renderBadge(filter.controlType, filter.controlType === 'unknown' ? 'error' : 'ok')}
          ${renderBadge(filter.status, filter.status === 'failed' ? 'error' : filter.status === 'optionsExtracted' ? 'ok' : 'warn')}
          ${renderBadge(filter.valueShape)}
          ${renderBadge(`options ${optionCount}`)}
          ${filter.childrenLazy ? renderBadge('childrenLazy', 'warn') : ''}
        </div>
      </div>
      <div class="meta-grid">
        <div><strong>key</strong><div><code>${escapeHtml(filter.key)}</code></div></div>
        <div><strong>depths</strong><div>${escapeHtml(depthSet.join(', ')) || '无'}</div></div>
        <div><strong>singleSelect fieldId</strong><div>${singleFieldId ? `<code>${escapeHtml(singleFieldId)}</code>` : '<span class="muted">无</span>'}</div></div>
        <div><strong>textInput fieldId</strong><div>${textInputFieldId ? `<code>${escapeHtml(textInputFieldId)}</code>` : '<span class="muted">无</span>'}</div></div>
        <div><strong>cascade fieldId</strong><div>${cascadeFieldId ? `<code>${escapeHtml(cascadeFieldId)}</code>` : '<span class="muted">无</span>'}</div></div>
      </div>
      ${filter.message ? `<div class="message"><strong>message</strong><pre>${escapeHtml(filter.message)}</pre></div>` : ''}
      <details open>
        <summary>Selector Hints</summary>
        ${renderSelectorHints(filter)}
      </details>
      ${!hideFullOptionTable ? `
        <details ${optionCount > 0 ? 'open' : ''}>
          <summary>Options Table</summary>
          ${renderOptionRows(filter.options)}
        </details>
      ` : ''}
      ${rootOptionsSample.length > 0 && !hideCascadeParentMapping ? `
        <details>
          <summary>Root Options Sample</summary>
          <div class="chip-row">${rootOptionsSample.map((option) => `<span class="chip">${escapeHtml(option.label)}</span>`).join('')}</div>
        </details>
      ` : ''}
      ${expectedSalaryRootOptions.length > 0 ? `
        <div class="always-visible-panel">
          <div class="always-visible-title">左侧薪资下限选项</div>
          <div class="chip-row">${expectedSalaryRootOptions.map((option) => `<span class="chip">${escapeHtml(option.label)}</span>`).join('')}</div>
        </div>
      ` : ''}
      ${expectedSalaryUpperOptions.length > 0 ? `
        <div class="always-visible-panel">
          <div class="always-visible-title">右侧薪资上限选项</div>
          <div class="chip-row">${expectedSalaryUpperOptions.map((label) => `<span class="chip">${escapeHtml(label)}</span>`).join('')}</div>
        </div>
      ` : ''}
      ${sampleChildren.length > 0 && !hideCascadeParentMapping ? `
        <details>
          <summary>Child Options Sample</summary>
          <div class="chip-row">${sampleChildren.map((option) => `<span class="chip">${escapeHtml((option.pathLabels ?? [option.label]).join(' / '))}</span>`).join('')}</div>
        </details>
      ` : ''}
      ${cascadeField && !hideCascadeParentMapping ? `
        <details>
          <summary>Grouped Children By Parent</summary>
          ${renderCascadeGroupedByParent(cascadeField)}
        </details>
      ` : ''}
      ${hideCascadeParentMapping ? `
        <details>
          <summary>Selection Rule</summary>
          <div class="cascade-note">
            期望月薪无需展示父级映射；应用层只需保证右侧薪资上限不低于左侧薪资下限，并按薪资数值比较。
          </div>
        </details>
      ` : ''}
      ${cascadeField && !hideCascadeParentMapping && cascadeField.tree ? `
        <details>
          <summary>Cascade Tree Sample</summary>
          <ul class="tree">
            ${cascadeField.tree.slice(0, 12).map((node) => renderTreeNode(node as never)).join('')}
          </ul>
        </details>
      ` : ''}
    </section>
  `;
}

function buildHtmlDocument(
  catalog: SearchFilterCatalog,
  singleSelectMapping: ReturnType<typeof buildSingleSelectApplicationMapping>,
  textInputMapping: ReturnType<typeof buildTextInputApplicationMapping>,
  cascadeMapping: ReturnType<typeof buildCascadeApplicationMapping>,
): string {
  const summaryCards = [
    { label: 'Filters', value: String(catalog.filters.length) },
    { label: 'Failures', value: String(catalog.failures.length) },
    { label: 'Single Select Fields', value: String(singleSelectMapping.fieldCount) },
    { label: 'Text Input Fields', value: String(textInputMapping.fieldCount) },
    { label: 'Cascade Fields', value: String(cascadeMapping.fieldCount) },
  ];

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(catalog.platform)} filter catalog check</title>
  <style>
    :root {
      --bg: #f5efe4;
      --panel: #fffdf8;
      --panel-2: #f8f1e6;
      --text: #1d1b16;
      --muted: #6b6458;
      --line: #d7ccb8;
      --accent: #a34d2d;
      --accent-2: #2d6a5f;
      --warn: #a3711f;
      --error: #a3362d;
      --shadow: 0 18px 40px rgba(64, 44, 20, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.5 "SF Mono", "Menlo", "Monaco", monospace;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(163, 77, 45, 0.12), transparent 28%),
        radial-gradient(circle at top right, rgba(45, 106, 95, 0.10), transparent 30%),
        linear-gradient(180deg, #f8f3eb 0%, var(--bg) 100%);
    }
    .page {
      width: min(1440px, calc(100vw - 32px));
      margin: 24px auto 48px;
    }
    .hero {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 20px;
      padding: 24px;
      box-shadow: var(--shadow);
      margin-bottom: 20px;
    }
    h1, h2, h3, summary { margin: 0; font-weight: 700; }
    h1 { font-size: 28px; }
    .hero p { margin: 8px 0 0; color: var(--muted); }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-top: 18px;
    }
    .summary-card, .filter-card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 16px;
      box-shadow: var(--shadow);
    }
    .summary-card {
      padding: 14px 16px;
    }
    .summary-card strong {
      display: block;
      font-size: 22px;
      margin-top: 4px;
    }
    .summary-card span { color: var(--muted); }
    .catalog {
      display: grid;
      gap: 16px;
    }
    .filter-card {
      padding: 18px;
    }
    .filter-card-head {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      margin-bottom: 14px;
    }
    .badges, .chip-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .badge, .chip {
      display: inline-flex;
      align-items: center;
      padding: 3px 9px;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: var(--panel-2);
      white-space: nowrap;
    }
    .badge-ok { border-color: rgba(45, 106, 95, 0.25); color: var(--accent-2); }
    .badge-warn { border-color: rgba(163, 113, 31, 0.25); color: var(--warn); }
    .badge-error { border-color: rgba(163, 54, 45, 0.25); color: var(--error); }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 10px;
      margin-bottom: 12px;
    }
    .meta-grid strong {
      display: block;
      color: var(--muted);
      margin-bottom: 4px;
    }
    .message {
      margin: 10px 0 14px;
      padding: 12px;
      border-radius: 12px;
      background: #fff6f3;
      border: 1px solid #edd2c8;
    }
    .cascade-note {
      margin-top: 8px;
      padding: 10px 12px;
      border-radius: 10px;
      background: #f7f1e5;
      border: 1px solid #e5d5b8;
      color: var(--muted);
    }
    .always-visible-panel {
      margin-top: 10px;
      padding: 12px;
      border-radius: 12px;
      background: #fffcf7;
      border: 1px solid #eadfcf;
    }
    .always-visible-title {
      font-weight: 700;
      margin-bottom: 10px;
    }
    pre {
      margin: 8px 0 0;
      white-space: pre-wrap;
      word-break: break-word;
    }
    details {
      margin-top: 10px;
      background: #fffcf7;
      border: 1px solid #eadfcf;
      border-radius: 12px;
      padding: 10px 12px;
    }
    summary {
      cursor: pointer;
      list-style: none;
    }
    summary::-webkit-details-marker { display: none; }
    .muted { color: var(--muted); }
    code {
      font: inherit;
      background: #f4ebdf;
      padding: 1px 5px;
      border-radius: 6px;
    }
    .hint-list, .tree {
      margin: 8px 0 0;
      padding-left: 18px;
    }
    .hint-list li, .tree li {
      margin: 6px 0;
    }
    .tree-node {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .tree-label {
      font-weight: 700;
    }
    .cascade-groups {
      display: grid;
      gap: 8px;
      margin-top: 10px;
    }
    .cascade-group {
      margin-top: 0;
    }
    .cascade-chip-row {
      margin-top: 10px;
    }
    .option-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 8px;
      table-layout: fixed;
    }
    .option-table th, .option-table td {
      border: 1px solid var(--line);
      padding: 6px 8px;
      vertical-align: top;
      text-align: left;
      word-break: break-word;
    }
    .option-table th {
      background: #f3eadc;
      position: sticky;
      top: 0;
    }
    .toc {
      margin-top: 18px;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 8px;
    }
    .toc a {
      text-decoration: none;
      color: var(--accent);
      border: 1px solid var(--line);
      background: #fff9ef;
      border-radius: 10px;
      padding: 8px 10px;
    }
    @media (max-width: 720px) {
      .page { width: min(100vw - 16px, 1440px); margin: 8px auto 24px; }
      .hero, .filter-card { padding: 14px; }
      .filter-card-head { flex-direction: column; }
    }
  </style>
</head>
<body>
  <main class="page">
    <section class="hero">
      <h1>${escapeHtml(catalog.platform)} Filter Catalog Check</h1>
      <p>keyword: <code>${escapeHtml(catalog.keyword)}</code> | capturedAt: <code>${escapeHtml(catalog.capturedAt)}</code></p>
      <p>pageUrl: <code>${escapeHtml(catalog.pageUrl)}</code></p>
      <div class="summary-grid">
        ${summaryCards.map((card) => `<div class="summary-card"><span>${escapeHtml(card.label)}</span><strong>${escapeHtml(card.value)}</strong></div>`).join('')}
      </div>
      <div class="toc">
        ${catalog.filters.map((filter, index) => `<a href="#filter-${index + 1}">${index + 1}. ${escapeHtml(filter.label)} <span class="muted">(${escapeHtml(filter.controlType)})</span></a>`).join('')}
      </div>
    </section>
    <section class="catalog">
      ${catalog.filters.map((filter, index) => renderFilterCard(filter, index, singleSelectMapping, textInputMapping, cascadeMapping)).join('')}
    </section>
  </main>
</body>
</html>`;
}

export async function exportFilterCatalogHtml(
  input: ExportFilterCatalogHtmlCliInput,
): Promise<ExportFilterCatalogHtmlSummary> {
  const store = new JobStore();
  const catalog = await store.readLatestSearchFilterCatalog(input.platform);
  if (!catalog) {
    throw new Error(`Missing latest filter catalog for ${input.platform}. Run discover:filters first.`);
  }

  const singleSelectMapping = buildSingleSelectApplicationMapping(catalog);
  const textInputMapping = buildTextInputApplicationMapping(catalog);
  const cascadeMapping = buildCascadeApplicationMapping(catalog);
  const html = buildHtmlDocument(catalog, singleSelectMapping, textInputMapping, cascadeMapping);
  const outputPath = path.resolve(input.outputPath ?? buildDefaultOutputPath(input.platform));
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, html, 'utf8');

  return {
    platform: input.platform,
    outputPath,
    filterCount: catalog.filters.length,
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const result = await exportFilterCatalogHtml(parseArgs(argv));
  console.log(JSON.stringify(result, null, 2));
}

const entrypointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';

if (import.meta.url === entrypointUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
