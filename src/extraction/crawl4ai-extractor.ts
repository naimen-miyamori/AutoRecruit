import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CandidateListItem, ResumeDomSnapshot } from '../types/job.js';
import { ResumeExtractionResult, validateResumeExtraction } from './extractor.js';
import { RawPageSource } from './page-source.js';
import { parseResumeFromSource } from '../browser/resume-detail.js';

interface AdapterOutput {
  source: RawPageSource;
  metadata?: {
    success?: boolean;
    error?: string;
  };
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '..', '..');
const pythonExecutable = path.join(repoRoot, '.venv', 'bin', 'python');
const adapterScript = path.join(repoRoot, 'src', 'scripts', 'crawl4ai_resume_adapter.py');

function runAdapter(source: RawPageSource): Promise<AdapterOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable, [adapterScript], {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Crawl4AI adapter exited with code ${code}.`));
        return;
      }

      try {
        resolve(JSON.parse(stdout) as AdapterOutput);
      } catch (error) {
        reject(new Error(`Failed to parse Crawl4AI adapter output: ${error instanceof Error ? error.message : String(error)}`));
      }
    });

    child.stdin.write(JSON.stringify(source));
    child.stdin.end();
  });
}

function normalizeVisibleText(source: RawPageSource, adapted?: AdapterOutput): RawPageSource {
  const visibleText = adapted?.source.visibleText?.trim();
  return {
    ...source,
    visibleText: visibleText || source.visibleText,
  };
}

export function isCrawl4aiAdapterAvailable(): boolean {
  return fs.existsSync(pythonExecutable) && fs.existsSync(adapterScript);
}

export async function extractResumeFromSource(source: RawPageSource, candidate: CandidateListItem, domSnapshot?: ResumeDomSnapshot): Promise<ResumeExtractionResult> {
  const parseWithSource = (effectiveSource: RawPageSource): ResumeExtractionResult => validateResumeExtraction({
    resume: parseResumeFromSource(effectiveSource, candidate, domSnapshot),
    domSnapshot,
    source: effectiveSource,
  });

  if (!isCrawl4aiAdapterAvailable()) {
    return parseWithSource(source);
  }

  try {
    const adapted = await runAdapter(source);
    const normalizedSource = normalizeVisibleText(source, adapted);
    return parseWithSource(normalizedSource);
  } catch {
    return parseWithSource(source);
  }
}
