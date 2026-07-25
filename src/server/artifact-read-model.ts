import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { parsePlatformArg } from '../platforms/registry.js';
import type { SupportedPlatform } from '../platforms/types.js';
import type { ArtifactDescriptor } from './api-contracts.js';

type ArtifactReference =
  | { kind: 'job-export'; platform: SupportedPlatform; jobKey: string }
  | { kind: 'candidate-snapshot'; platform: SupportedPlatform; jobKey: string; candidateId: string }
  | { kind: 'candidate-dom'; platform: SupportedPlatform; jobKey: string; candidateId: string }
  | { kind: 'boss-sync'; runId: string }
  | { kind: 'boss-review'; runId: string }
  | { kind: 'boss-receipt'; intentId: string };

export interface ReadArtifactResult {
  descriptor: ArtifactDescriptor;
  content: Buffer;
}

interface ArtifactReadModelOptions {
  dataDir?: string;
}

function assertSafeSegment(value: string, label: string): void {
  if (!value || value.includes('/') || value.includes('\\') || value === '.' || value === '..' || value.includes('\0')) {
    throw new Error(`${label} is invalid`);
  }
}

function encodeReference(reference: ArtifactReference): string {
  return Buffer.from(JSON.stringify(reference), 'utf8').toString('base64url');
}

function decodeReference(artifactId: string): ArtifactReference {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(artifactId, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new Error('artifactId is invalid');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('artifactId is invalid');
  }

  const item = parsed as Record<string, unknown>;
  if (typeof item.kind !== 'string') {
    throw new Error('artifactId is invalid');
  }

  if (item.kind === 'job-export' || item.kind === 'candidate-snapshot' || item.kind === 'candidate-dom') {
    const platform = parsePlatformArg(String(item.platform ?? ''));
    const jobKey = String(item.jobKey ?? '');
    assertSafeSegment(jobKey, 'jobKey');
    if (item.kind === 'job-export') {
      return { kind: item.kind, platform, jobKey };
    }
    const candidateId = String(item.candidateId ?? '');
    assertSafeSegment(candidateId, 'candidateId');
    return { kind: item.kind, platform, jobKey, candidateId };
  }

  if (item.kind === 'boss-sync' || item.kind === 'boss-review') {
    const runId = String(item.runId ?? '');
    assertSafeSegment(runId, 'runId');
    return { kind: item.kind, runId };
  }

  if (item.kind === 'boss-receipt') {
    const intentId = String(item.intentId ?? '').trim();
    if (!intentId || intentId.length > 240 || intentId.includes('\0')) {
      throw new Error('intentId is invalid');
    }
    return { kind: item.kind, intentId };
  }

  throw new Error('artifactId is invalid');
}

function descriptor(reference: ArtifactReference): ArtifactDescriptor {
  switch (reference.kind) {
    case 'job-export':
      return {
        artifactId: encodeReference(reference),
        label: '最新 Markdown 报告',
        fileName: `${reference.platform}-${reference.jobKey}-latest.md`,
        contentType: 'text/markdown; charset=utf-8',
      };
    case 'candidate-snapshot':
      return {
        artifactId: encodeReference(reference),
        label: '候选人文本快照',
        fileName: `${reference.platform}-${reference.jobKey}-${reference.candidateId}.txt`,
        contentType: 'text/plain; charset=utf-8',
      };
    case 'candidate-dom':
      return {
        artifactId: encodeReference(reference),
        label: '候选人 DOM 快照',
        fileName: `${reference.platform}-${reference.jobKey}-${reference.candidateId}.json`,
        contentType: 'application/json; charset=utf-8',
      };
    case 'boss-sync':
      return {
        artifactId: encodeReference(reference),
        label: 'Boss 职位同步记录',
        fileName: `boss-job-sync-${reference.runId}.json`,
        contentType: 'application/json; charset=utf-8',
      };
    case 'boss-review':
      return {
        artifactId: encodeReference(reference),
        label: 'Boss 自动沟通审核记录',
        fileName: `boss-chat-review-${reference.runId}.json`,
        contentType: 'application/json; charset=utf-8',
      };
    case 'boss-receipt':
      return {
        artifactId: encodeReference(reference),
        label: 'Boss 会话操作回执',
        fileName: `boss-chat-receipt-${crypto.createHash('sha256').update(reference.intentId).digest('hex').slice(0, 16)}.json`,
        contentType: 'application/json; charset=utf-8',
      };
  }
}

export function jobExportArtifact(platform: SupportedPlatform, jobKey: string): ArtifactDescriptor {
  return descriptor({ kind: 'job-export', platform, jobKey });
}

export function candidateSnapshotArtifact(
  platform: SupportedPlatform,
  jobKey: string,
  candidateId: string,
): ArtifactDescriptor {
  return descriptor({ kind: 'candidate-snapshot', platform, jobKey, candidateId });
}

export function candidateDomArtifact(
  platform: SupportedPlatform,
  jobKey: string,
  candidateId: string,
): ArtifactDescriptor {
  return descriptor({ kind: 'candidate-dom', platform, jobKey, candidateId });
}

export function bossSyncArtifact(runId: string): ArtifactDescriptor {
  return descriptor({ kind: 'boss-sync', runId });
}

export function bossReviewArtifact(runId: string): ArtifactDescriptor {
  return descriptor({ kind: 'boss-review', runId });
}

export function bossReceiptArtifact(intentId: string): ArtifactDescriptor {
  return descriptor({ kind: 'boss-receipt', intentId });
}

export class ArtifactReadModel {
  private readonly dataDir: string;

  constructor(options: ArtifactReadModelOptions = {}) {
    this.dataDir = options.dataDir ?? config.dataDir;
  }

  async readArtifact(artifactId: string): Promise<ReadArtifactResult | undefined> {
    const reference = decodeReference(artifactId);
    const filePath = this.resolvePath(reference);
    try {
      return {
        descriptor: descriptor(reference),
        content: await fs.readFile(filePath),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  private resolvePath(reference: ArtifactReference): string {
    switch (reference.kind) {
      case 'job-export':
        return path.join(this.dataDir, reference.platform, 'jobs', reference.jobKey, 'exports', 'latest.md');
      case 'candidate-snapshot':
        return path.join(this.dataDir, reference.platform, 'jobs', reference.jobKey, 'snapshots', `${reference.candidateId}.txt`);
      case 'candidate-dom':
        return path.join(this.dataDir, reference.platform, 'jobs', reference.jobKey, 'snapshots-dom', `${reference.candidateId}.json`);
      case 'boss-sync':
        return path.join(this.dataDir, 'boss', 'job-sync', 'runs', `${reference.runId}.json`);
      case 'boss-review':
        return path.join(this.dataDir, 'boss', 'chat-review', 'runs', `${reference.runId}.json`);
      case 'boss-receipt':
        return path.join(
          this.dataDir,
          'boss',
          'chat-operations',
          'runs',
          `${crypto.createHash('sha256').update(reference.intentId).digest('hex')}.json`,
        );
    }
  }
}
