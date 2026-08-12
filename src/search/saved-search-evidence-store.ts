import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config.js';
import { assertPlatformSavedSearchOpenEvidence } from './saved-search-target.js';
import type { PlatformSavedSearchOpenEvidence } from '../types/job.js';

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporaryPath, filePath);
}

export class SavedSearchEvidenceStore {
  private readonly rootDir: string;

  constructor(options: { dataDir?: string } = {}) {
    this.rootDir = path.join(path.resolve(options.dataDir ?? config.dataDir), 'maintenance', 'saved-search-open-evidence');
  }

  private pathFor(evidenceHash: string): string {
    if (!/^[a-f0-9]{64}$/u.test(evidenceHash)) throw new Error('Saved-search evidence hash is invalid.');
    return path.join(this.rootDir, `${evidenceHash}.json`);
  }

  async save(evidence: PlatformSavedSearchOpenEvidence): Promise<PlatformSavedSearchOpenEvidence> {
    const inspected = assertPlatformSavedSearchOpenEvidence(evidence);
    const filePath = this.pathFor(inspected.evidenceHash);
    try {
      const current = await this.read(inspected.evidenceHash);
      if (JSON.stringify(current) !== JSON.stringify(inspected)) {
        throw new Error(`Saved-search evidence ${inspected.evidenceHash} conflicts with its existing artifact.`);
      }
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await writeJsonAtomically(filePath, inspected);
    return inspected;
  }

  async read(evidenceHash: string): Promise<PlatformSavedSearchOpenEvidence> {
    const value: unknown = JSON.parse(await fs.readFile(this.pathFor(evidenceHash), 'utf8'));
    const inspected = assertPlatformSavedSearchOpenEvidence(value, 'saved-search evidence artifact');
    if (inspected.evidenceHash !== evidenceHash) {
      throw new Error('Saved-search evidence artifact belongs to another evidence hash.');
    }
    return inspected;
  }
}
