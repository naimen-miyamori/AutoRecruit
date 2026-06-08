import fs from 'node:fs/promises';
import path from 'node:path';
import { parsePlatformArg } from '../platforms/registry.js';
import type { SupportedPlatform } from '../platforms/types.js';
import {
  buildResumeDocxFileName,
  type CandidatePhotoContentType,
  DEFAULT_RESUME_TEMPLATE_PATH,
  extractCandidatePhotoUrl,
  renderResumeDocxFile,
  type ResumeDocxCandidatePhoto,
  sanitizeDocxFileName,
} from '../reporting/resume-docx.js';
import { JobStore } from '../storage/job-store.js';
import type { CandidateResume } from '../types/job.js';

export interface ExportResumeDocxInput {
  platform?: SupportedPlatform;
  jobKey?: string;
  candidateId?: string;
  resumeFile?: string;
  snapshotFile?: string;
  templatePath?: string;
  outputPath?: string;
  outputDir?: string;
}

export interface ExportResumeDocxSummary {
  resume: CandidateResume;
  outputPath: string;
  templatePath: string;
  candidatePhotoUrl?: string;
  candidatePhotoIncluded: boolean;
}

const USAGE = [
  'Usage:',
  '  npm run export:resume-docx -- --platform <51job|liepin|zhilian> <jobKey> <candidateId> [--template <docx>] [--output <docx>]',
  '  npm run export:resume-docx -- <51job|liepin|zhilian> <jobKey> <candidateId> [--template <docx>] [--output-dir <dir>]',
  '  npm run export:resume-docx -- --resume-file <resume.json> [--snapshot-file <snapshot.txt>] [--template <docx>] [--output <docx>]',
].join('\n');

function requireFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

export function parseExportResumeDocxArgs(args: string[]): ExportResumeDocxInput {
  const input: ExportResumeDocxInput = {};
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--help' || arg === '-h') {
      throw new Error(USAGE);
    }

    if (arg === '--platform') {
      input.platform = parsePlatformArg(requireFlagValue(args, index, arg));
      index += 1;
      continue;
    }

    if (arg === '--resume-file') {
      input.resumeFile = requireFlagValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === '--snapshot-file') {
      input.snapshotFile = requireFlagValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === '--template' || arg === '--template-file') {
      input.templatePath = requireFlagValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === '--output') {
      input.outputPath = requireFlagValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === '--output-dir') {
      input.outputDir = requireFlagValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}\n${USAGE}`);
    }

    positional.push(arg);
  }

  if (input.platform) {
    [input.jobKey, input.candidateId] = positional;
  } else if (positional.length === 3) {
    input.platform = parsePlatformArg(positional[0]);
    [, input.jobKey, input.candidateId] = positional;
  } else if (positional.length > 0) {
    throw new Error(`Unexpected positional arguments: ${positional.join(' ')}\n${USAGE}`);
  }

  return input;
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

async function readTextFileIfConfigured(filePath?: string): Promise<string | undefined> {
  return filePath ? fs.readFile(filePath, 'utf8') : undefined;
}

function resolveConfiguredTemplatePath(templatePath?: string): string {
  return path.resolve(templatePath ?? DEFAULT_RESUME_TEMPLATE_PATH);
}

function validateInput(input: ExportResumeDocxInput): void {
  if (input.resumeFile) {
    if (input.platform || input.jobKey || input.candidateId) {
      throw new Error('--resume-file cannot be combined with platform/jobKey/candidateId arguments');
    }

    return;
  }

  if (!input.platform || !input.jobKey || !input.candidateId) {
    throw new Error(`${USAGE}\n\nMissing required platform, jobKey, or candidateId.`);
  }
}

function inferPhotoContentType(url: string, contentTypeHeader?: string | null): CandidatePhotoContentType | undefined {
  const contentType = contentTypeHeader?.split(';')[0]?.trim().toLowerCase();
  if (contentType === 'image/jpeg' || contentType === 'image/jpg') {
    return 'image/jpeg';
  }

  if (contentType === 'image/png') {
    return 'image/png';
  }

  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) {
    return 'image/jpeg';
  }

  if (pathname.endsWith('.png')) {
    return 'image/png';
  }

  return undefined;
}

async function fetchCandidatePhoto(resume: CandidateResume, sourceText?: string): Promise<{
  photo?: ResumeDocxCandidatePhoto;
  url?: string;
}> {
  const url = extractCandidatePhotoUrl(resume, sourceText);
  if (!url) {
    return {};
  }

  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0',
      },
    });

    if (!response.ok) {
      return { url };
    }

    const contentType = inferPhotoContentType(url, response.headers.get('content-type'));
    if (!contentType) {
      return { url };
    }

    return {
      url,
      photo: {
        data: Buffer.from(await response.arrayBuffer()),
        contentType,
      },
    };
  } catch {
    return { url };
  }
}

async function exportFromResumeFile(input: ExportResumeDocxInput): Promise<ExportResumeDocxSummary> {
  if (!input.resumeFile) {
    throw new Error('Missing resume file');
  }

  const resumeFile = path.resolve(input.resumeFile);
  const resume = await readJsonFile<CandidateResume>(resumeFile);
  const sourceText = await readTextFileIfConfigured(input.snapshotFile);
  const templatePath = resolveConfiguredTemplatePath(input.templatePath);
  const outputPath = path.resolve(
    input.outputPath
    ?? path.join(
      input.outputDir ? path.resolve(input.outputDir) : path.dirname(resumeFile),
      buildResumeDocxFileName(resume, sourceText),
    ),
  );
  const candidatePhoto = await fetchCandidatePhoto(resume, sourceText);
  const docx = await renderResumeDocxFile(resume, {
    templatePath,
    sourceText,
    candidatePhoto: candidatePhoto.photo,
  });

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, docx);

  return {
    resume,
    outputPath,
    templatePath,
    candidatePhotoUrl: candidatePhoto.url,
    candidatePhotoIncluded: Boolean(candidatePhoto.photo),
  };
}

async function exportFromStoredResume(input: ExportResumeDocxInput): Promise<ExportResumeDocxSummary> {
  if (!input.platform || !input.jobKey || !input.candidateId) {
    throw new Error('Missing stored resume coordinates');
  }

  const store = new JobStore();
  const [resume, sourceText] = await Promise.all([
    store.readCandidateResume(input.platform, input.jobKey, input.candidateId),
    store.readCandidateSnapshotIfExists(input.platform, input.jobKey, input.candidateId),
  ]);
  const templatePath = resolveConfiguredTemplatePath(input.templatePath);
  const fileName = input.outputPath
    ? path.basename(input.outputPath)
    : buildResumeDocxFileName(resume, sourceText);
  const candidatePhoto = await fetchCandidatePhoto(resume, sourceText);
  const docx = await renderResumeDocxFile(resume, {
    templatePath,
    sourceText,
    candidatePhoto: candidatePhoto.photo,
  });

  const outputPath = input.outputPath
    ? path.resolve(input.outputPath)
    : input.outputDir
      ? path.join(path.resolve(input.outputDir), sanitizeDocxFileName(fileName))
      : await store.saveCandidateResumeDocx(input.platform, input.jobKey, sanitizeDocxFileName(fileName), docx);

  if (input.outputPath || input.outputDir) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, docx);
  }

  return {
    resume,
    outputPath,
    templatePath,
    candidatePhotoUrl: candidatePhoto.url,
    candidatePhotoIncluded: Boolean(candidatePhoto.photo),
  };
}

export async function exportResumeDocx(input: ExportResumeDocxInput): Promise<ExportResumeDocxSummary> {
  validateInput(input);
  return input.resumeFile ? exportFromResumeFile(input) : exportFromStoredResume(input);
}

async function main(): Promise<void> {
  const result = await exportResumeDocx(parseExportResumeDocxArgs(process.argv.slice(2)));
  console.log(`DOCX exported: ${result.outputPath}`);
  if (result.candidatePhotoUrl) {
    console.log(`Candidate photo: ${result.candidatePhotoIncluded ? 'embedded' : 'not embedded'} (${result.candidatePhotoUrl})`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
