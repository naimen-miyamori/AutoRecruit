import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  createPlanDocument,
  initializePlanWorkspace,
  validatePlanDocuments,
} from './plan-documents.js';

async function withTemporaryRepository<T>(run: (rootDir: string) => Promise<T>): Promise<T> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-plan-documents-'));
  try {
    return await run(rootDir);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

describe('plan document conventions', () => {
  it('initializes the local archive, creates a canonical plan, and indexes it', async () => {
    await withTemporaryRepository(async (rootDir) => {
      const workspace = await initializePlanWorkspace(rootDir);
      const created = await createPlanDocument({
        rootDir,
        topic: 'talent-pipeline',
        title: '人才管道计划',
        date: '2026-07-29',
      });

      assert.equal(path.basename(created.filePath), '2026-07-29-talent-pipeline-plan.md');
      const [index, template, plan] = await Promise.all([
        fs.readFile(workspace.indexPath, 'utf8'),
        fs.readFile(workspace.templatePath, 'utf8'),
        fs.readFile(created.filePath, 'utf8'),
      ]);
      assert.match(index, /2026-07-29-talent-pipeline-plan\.md/);
      assert.match(template, /状态：计划中/);
      assert.match(plan, /^> 状态：计划中。/m);
      assert.match(plan, /^> 最近更新：2026-07-29。提交策略：/m);

      const validation = await validatePlanDocuments(rootDir);
      assert.equal(validation.valid, true);
      assert.deepStrictEqual(validation.planFiles, ['docs/plan/2026-07-29-talent-pipeline-plan.md']);
      await assert.rejects(
        () => createPlanDocument({
          rootDir,
          topic: 'talent-pipeline',
          title: '人才管道计划',
          date: '2026-07-29',
        }),
        /Plan already exists/,
      );
    });
  });

  it('rejects plan documents outside docs/plan and unindexed or malformed new plans', async () => {
    await withTemporaryRepository(async (rootDir) => {
      await initializePlanWorkspace(rootDir);
      await fs.writeFile(path.join(rootDir, 'root-plan.md'), '# 根目录计划\n', 'utf8');
      const malformedPath = path.join(rootDir, 'docs', 'plan', '2026-07-29-malformed-plan.md');
      await fs.writeFile(malformedPath, '# 缺少元数据\n', 'utf8');

      const validation = await validatePlanDocuments(rootDir);
      assert.equal(validation.valid, false);
      assert.deepStrictEqual(validation.violations, [
        'docs/plan/2026-07-29-malformed-plan.md must declare status, last-updated date, and Git submission policy at the top',
        'docs/plan/2026-07-29-malformed-plan.md is missing from docs/plan/README.md',
        'root-plan.md must be moved to docs/plan/',
      ]);
    });
  });
});
