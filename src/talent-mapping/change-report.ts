import type {
  MappingCandidateObservation,
  MappingComparableField,
  MappingFieldEvidence,
  MappingRunCandidateChange,
  MappingRunCandidateSnapshot,
  MappingRunChangeReport,
  MappingRunRecord,
} from '../types/talent-mapping.js';

const comparableFields: MappingComparableField[] = [
  'name',
  'currentCompany',
  'currentTitle',
  'companyKey',
  'roleKey',
  'level',
  'location',
];

function latestObservationsForRun(
  observations: readonly MappingCandidateObservation[],
  runId: string,
): Map<string, MappingCandidateObservation> {
  const latest = new Map<string, MappingCandidateObservation>();
  for (const observation of observations) {
    if (observation.runId !== runId) continue;
    const current = latest.get(observation.platformCandidateKey);
    if (!current
      || current.observedAt.localeCompare(observation.observedAt) < 0
      || (current.observedAt === observation.observedAt && current.observationId.localeCompare(observation.observationId) < 0)) {
      latest.set(observation.platformCandidateKey, observation);
    }
  }
  return latest;
}

function observationValue(
  observation: MappingCandidateObservation,
  field: MappingComparableField,
): string | undefined {
  switch (field) {
    case 'name': return observation.name;
    case 'currentCompany': return observation.currentCompany;
    case 'currentTitle': return observation.currentTitle;
    case 'companyKey': return observation.normalized.companyKey;
    case 'roleKey': return observation.normalized.roleKey;
    case 'level': return observation.normalized.level;
    case 'location': return observation.normalized.location;
  }
}

function evidenceForField(
  observation: MappingCandidateObservation,
  field: MappingComparableField,
): MappingFieldEvidence[] {
  const evidenceField = field === 'name'
    ? 'name'
    : field === 'currentCompany' || field === 'companyKey'
      ? 'company'
      : field === 'currentTitle' || field === 'roleKey'
        ? 'role'
        : field;
  return observation.evidence.filter((evidence) => evidence.field === evidenceField);
}

function snapshot(observation: MappingCandidateObservation): MappingRunCandidateSnapshot {
  return {
    platform: observation.platform,
    platformCandidateKey: observation.platformCandidateKey,
    candidateId: observation.candidateId,
    name: observation.name,
    currentCompany: observation.currentCompany,
    currentTitle: observation.currentTitle,
    companyKey: observation.normalized.companyKey,
    roleKey: observation.normalized.roleKey,
    level: observation.normalized.level,
    location: observation.normalized.location,
    observedAt: observation.observedAt,
  };
}

function eligibleRuns(runs: readonly MappingRunRecord[]): MappingRunRecord[] {
  return runs
    .filter((run) => run.status !== 'failed' && (run.stage === 'scan' || run.stage === 'all'))
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

function resolveComparisonRuns(input: {
  runs: readonly MappingRunRecord[];
  baseRunId?: string;
  compareRunId?: string;
}): { base?: MappingRunRecord; compare?: MappingRunRecord } {
  const eligible = eligibleRuns(input.runs);
  const find = (runId: string | undefined, label: string) => {
    if (!runId) return undefined;
    const run = eligible.find((candidate) => candidate.runId === runId);
    if (!run) throw new Error(`${label} must reference a successful scan or all Talent Mapping run`);
    return run;
  };
  const compare = find(input.compareRunId, 'compareRunId') ?? eligible.at(-1);
  const base = find(input.baseRunId, 'baseRunId')
    ?? (compare ? eligible.filter((run) => run.startedAt.localeCompare(compare.startedAt) < 0).at(-1) : undefined);
  if (base && compare && base.runId === compare.runId) {
    throw new Error('baseRunId and compareRunId must be different');
  }
  if (base && compare && base.startedAt.localeCompare(compare.startedAt) > 0) {
    throw new Error('baseRunId must be earlier than compareRunId');
  }
  return { base, compare };
}

export function buildMappingRunChangeReport(input: {
  mappingKey: string;
  runs: readonly MappingRunRecord[];
  observations: readonly MappingCandidateObservation[];
  baseRunId?: string;
  compareRunId?: string;
  generatedAt?: string;
}): MappingRunChangeReport {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const caveat = '本轮未再次观察只表示 not-observed-this-run，不能解释为离职、跳槽或不再求职。';
  const { base, compare } = resolveComparisonRuns(input);
  if (!base || !compare) {
    return {
      status: 'insufficient-runs',
      mappingKey: input.mappingKey,
      baseRunId: base?.runId,
      compareRunId: compare?.runId,
      generatedAt,
      newProfiles: [],
      notObservedProfiles: [],
      changedProfiles: [],
      unchangedProfiles: 0,
      caveat,
    };
  }

  const before = latestObservationsForRun(input.observations, base.runId);
  const after = latestObservationsForRun(input.observations, compare.runId);
  const newProfiles = [...after.entries()]
    .filter(([key]) => !before.has(key))
    .map(([, observation]) => snapshot(observation));
  const notObservedProfiles = [...before.entries()]
    .filter(([key]) => !after.has(key))
    .map(([, observation]) => snapshot(observation));
  const changedProfiles: MappingRunCandidateChange[] = [];
  let unchangedProfiles = 0;

  for (const [key, previous] of before) {
    const current = after.get(key);
    if (!current) continue;
    const fields = comparableFields.flatMap((field) => {
      const previousValue = observationValue(previous, field);
      const currentValue = observationValue(current, field);
      if (previousValue === currentValue) return [];
      return [{
        field,
        previousValue,
        currentValue,
        previousEvidence: evidenceForField(previous, field),
        currentEvidence: evidenceForField(current, field),
      }];
    });
    if (fields.length === 0) {
      unchangedProfiles += 1;
      continue;
    }
    changedProfiles.push({
      platformCandidateKey: key,
      platform: current.platform,
      candidateId: current.candidateId,
      fields,
    });
  }

  const byKey = (left: { platformCandidateKey: string }, right: { platformCandidateKey: string }) =>
    left.platformCandidateKey.localeCompare(right.platformCandidateKey);
  return {
    status: 'ready',
    mappingKey: input.mappingKey,
    baseRunId: base.runId,
    compareRunId: compare.runId,
    generatedAt,
    newProfiles: newProfiles.sort(byKey),
    notObservedProfiles: notObservedProfiles.sort(byKey),
    changedProfiles: changedProfiles.sort(byKey),
    unchangedProfiles,
    caveat,
  };
}
