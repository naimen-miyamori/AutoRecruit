import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  agentDocumentRequirements,
  agentRouteRequirements,
  validateAgentInstructions,
} from './agent-instructions.js';

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
  if (!requirement) throw new Error('Unknown requirement: ' + filePath);
  const routes = agentRouteRequirements
    .filter((route) => route.parentPath === filePath)
    .map((route) => route.reference)
    .join('\n');
  return requirement.headings.map((heading) => '## ' + heading).join('\n\n') + '\n\n' + routes + '\n';
}

async function createCanonicalLayout(rootDir: string): Promise<void> {
  for (const requirement of agentDocumentRequirements) {
    const filePath = path.join(rootDir, requirement.filePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, renderDocument(requirement.filePath), 'utf8');
  }
}

describe('AGENTS instruction structure', () => {
  it('accepts the canonical routed document tree', async () => {
    await withTemporaryRepository(async (rootDir) => {
      await createCanonicalLayout(rootDir);
      const validation = await validateAgentInstructions(rootDir);
      assert.deepStrictEqual(validation, { valid: true, violations: [] });
    });
  });

  it('reports missing documents, headings, and parent routing', async () => {
    await withTemporaryRepository(async (rootDir) => {
      await createCanonicalLayout(rootDir);
      await fs.rm(path.join(rootDir, 'src', 'platforms', 'boss', 'AGENTS.md'));
      await fs.writeFile(
        path.join(rootDir, 'src', 'platforms', 'AGENTS.md'),
        '## Scope and Inheritance\n\n## Ownership and Boundaries\n',
        'utf8',
      );

      const validation = await validateAgentInstructions(rootDir);
      assert.equal(validation.valid, false);
      assert.deepStrictEqual(validation.violations, [
        'src/platforms/AGENTS.md must include ## Verification',
        'src/platforms/boss/AGENTS.md is required',
        'src/platforms/AGENTS.md must route to src/platforms/51job/AGENTS.md',
        'src/platforms/AGENTS.md must route to src/platforms/liepin/AGENTS.md',
        'src/platforms/AGENTS.md must route to src/platforms/zhilian/AGENTS.md',
        'src/platforms/AGENTS.md must route to src/platforms/boss/AGENTS.md',
      ]);
    });
  });
});
