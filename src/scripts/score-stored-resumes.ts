import { config } from '../config.js';
import { parsePlatformArg } from '../platforms/registry.js';
import type { SupportedPlatform } from '../platforms/types.js';
import { scoreResumeAgainstJob } from '../scoring/score-resume.js';
import { JobStore } from '../storage/job-store.js';
import type { CandidateResume, CandidateScoreArtifact, JobRecord } from '../types/job.js';

export const scoreResumeAgainstJobRef = { fn: scoreResumeAgainstJob };

export interface OfflineScoreSummary {
  jobKey: string;
  totalResumes: number;
  scoredCandidates: string[];
  failedCandidates: Array<{
    candidateId: string;
    error: string;
  }>;
}

export async function scoreStoredResumes(platform: SupportedPlatform, jobKey: string): Promise<OfflineScoreSummary> {
  const store = new JobStore();
  const jobRecord: JobRecord = await store.readJobRecord(platform, jobKey);
  const resumes: CandidateResume[] = await store.listStoredResumes(platform, jobKey);

  if (resumes.length === 0) {
    throw new Error(`No stored resumes found for job key ${jobKey}`);
  }

  const scoredCandidates: string[] = [];
  const failedCandidates: Array<{ candidateId: string; error: string }> = [];

  for (const resume of resumes) {
    const scoredAt = new Date().toISOString();

    try {
      const score = await scoreResumeAgainstJobRef.fn(jobRecord.normalizedJob, resume);
      const artifact: CandidateScoreArtifact = {
        candidateId: resume.candidateId,
        model: config.scoring.model,
        scoredAt,
        status: 'success',
        score,
      };
      await store.saveCandidateScoreArtifact(platform, jobKey, artifact);
      scoredCandidates.push(resume.candidateId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const artifact: CandidateScoreArtifact = {
        candidateId: resume.candidateId,
        model: config.scoring.model,
        scoredAt,
        status: 'failed',
        error: message,
      };
      await store.saveCandidateScoreArtifact(platform, jobKey, artifact);
      failedCandidates.push({ candidateId: resume.candidateId, error: message });
    }
  }

  return {
    jobKey,
    totalResumes: resumes.length,
    scoredCandidates,
    failedCandidates,
  };
}

async function main(): Promise<void> {
  const platform = parsePlatformArg(process.argv[2]);
  const jobKey = process.argv[3];

  if (!jobKey) {
    throw new Error('Usage: tsx src/scripts/score-stored-resumes.ts <platform> <jobKey>');
  }

  const result = await scoreStoredResumes(platform, jobKey);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
