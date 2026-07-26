import type { Page } from 'playwright';
import type {
  CandidateListItem,
  CandidateResume,
  EducationExperience,
  ProjectExperience,
  WorkExperience,
} from '../../../types/job.js';

export interface BossResumeApiPayload {
  code?: number;
  message?: string;
  zpData?: {
    expectId?: number | string;
    geekDetail?: Record<string, unknown>;
    geekDetailInfo?: Record<string, unknown>;
    showExpectPosition?: Record<string, unknown>;
  };
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.replace(/\s+/g, ' ').trim() || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  return isRecord(value) && isRecord(value[key]) ? value[key] : undefined;
}

function readArray(value: unknown, key: string): unknown[] {
  return isRecord(value) && Array.isArray(value[key]) ? value[key] : [];
}

function readString(value: unknown, key: string): string | undefined {
  return isRecord(value) ? normalizeOptionalText(value[key]) : undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => normalizeOptionalText(value)).filter((value): value is string => Boolean(value)))];
}

function parseBossAge(ageDesc?: string): number | undefined {
  const age = ageDesc?.match(/(\d{1,3})/)?.[1];
  return age ? Number.parseInt(age, 10) : undefined;
}

function readBossTextList(value: unknown): string[] {
  if (typeof value === 'string') return uniqueStrings([value]);
  if (Array.isArray(value)) return value.flatMap((entry) => readBossTextList(entry));
  if (!isRecord(value)) return [];
  return uniqueStrings([
    readString(value, 'content'),
    readString(value, 'text'),
    readString(value, 'desc'),
    readString(value, 'description'),
    readString(value, 'name'),
    readString(value, 'certName'),
    readString(value, 'certificateName'),
    readString(value, 'skillName'),
    readString(value, 'label'),
    readString(value, 'value'),
  ]);
}

function parseBossWorkExperiences(
  geekDetail: Record<string, unknown>,
  candidate: CandidateListItem,
): WorkExperience[] {
  const workExperiences = readArray(geekDetail, 'geekWorkExpList')
    .filter(isRecord)
    .map((entry) => {
      const responsibility = readString(entry, 'responsibility');
      const workPerformance = readString(entry, 'workPerformance');
      const department = readString(entry, 'department');
      const workYearDesc = readString(entry, 'workYearDesc');
      const workEmphasis = readBossTextList(entry.workEmphasisList);
      return {
        company: readString(entry, 'company'),
        title: readString(entry, 'positionName') ?? readString(entry, 'positionTitle'),
        start: readString(entry, 'startYearMonStr'),
        end: readString(entry, 'endYearMonStr'),
        details: uniqueStrings([
          department ? `部门：${department}` : undefined,
          workYearDesc ? `工作时长：${workYearDesc}` : undefined,
          responsibility,
          workPerformance,
          ...workEmphasis,
        ]),
      };
    })
    .filter((entry) => entry.company || entry.title || entry.details.length > 0);
  if (workExperiences.length > 0) return workExperiences;
  if (candidate.currentCompany || candidate.currentTitle) {
    return [{ company: candidate.currentCompany, title: candidate.currentTitle, details: [] }];
  }
  return [];
}

function parseBossProjectExperiences(geekDetail: Record<string, unknown>): ProjectExperience[] {
  return readArray(geekDetail, 'geekProjExpList')
    .filter(isRecord)
    .map((entry) => ({
      name: readString(entry, 'projectName') ?? readString(entry, 'name'),
      company: readString(entry, 'company') ?? readString(entry, 'companyName'),
      start: readString(entry, 'startYearMonStr') ?? readString(entry, 'startDate'),
      end: readString(entry, 'endYearMonStr') ?? readString(entry, 'endDate'),
      details: uniqueStrings([
        readString(entry, 'projectDescription'),
        readString(entry, 'responsibility'),
        readString(entry, 'performance'),
        ...readBossTextList(entry.projectEmphasisList),
      ]),
    }))
    .filter((entry) => entry.name || entry.company || entry.details.length > 0);
}

function parseBossEducationExperiences(
  geekDetail: Record<string, unknown>,
  fallbackEducation?: string,
): EducationExperience[] {
  const educationExperiences = readArray(geekDetail, 'geekEduExpList')
    .filter(isRecord)
    .map((entry) => ({
      school: readString(entry, 'school'),
      degree: readString(entry, 'degreeName') ?? fallbackEducation,
      major: readString(entry, 'major'),
      start: readString(entry, 'startYearStr'),
      end: readString(entry, 'endYearStr'),
      details: uniqueStrings([
        readString(entry, 'eduDescription'),
        readString(entry, 'majorRankingDesc'),
        readString(entry, 'thesisTitle'),
        readString(entry, 'thesisDesc'),
        ...readBossTextList(entry.courseDesc),
      ]),
    }))
    .filter((entry) => entry.school || entry.degree || entry.major || entry.details.length > 0);
  if (educationExperiences.length > 0) return educationExperiences;
  const highestEduExp = readRecord(geekDetail, 'highestEduExp');
  if (highestEduExp) {
    return [{
      school: readString(highestEduExp, 'school'),
      degree: readString(highestEduExp, 'degreeName') ?? fallbackEducation,
      major: readString(highestEduExp, 'major'),
      start: readString(highestEduExp, 'startYearStr'),
      end: readString(highestEduExp, 'endYearStr'),
      details: uniqueStrings([readString(highestEduExp, 'eduDescription')]),
    }];
  }
  return fallbackEducation ? [{ degree: fallbackEducation, details: [] }] : [];
}

function parseBossCertificates(geekDetail: Record<string, unknown>): string[] {
  return uniqueStrings([
    ...readBossTextList(geekDetail.geekCertificationList),
    ...readBossTextList(geekDetail.certList),
    ...readBossTextList(geekDetail.professionalSkill),
  ]);
}

export function parseBossResumePayload(
  payload: BossResumeApiPayload,
  page: Page,
  candidate: CandidateListItem,
): CandidateResume {
  const zpData = payload.zpData ?? {};
  const geekDetail = isRecord(zpData.geekDetail)
    ? zpData.geekDetail
    : (isRecord(zpData.geekDetailInfo) ? zpData.geekDetailInfo : {});
  const baseInfo = readRecord(geekDetail, 'geekBaseInfo') ?? {};
  const highestEduExp = readRecord(geekDetail, 'highestEduExp');
  const showExpectPosition = readRecord(geekDetail, 'showExpectPosition')
    ?? (isRecord(zpData.showExpectPosition) ? zpData.showExpectPosition : undefined);
  const expectList = readArray(geekDetail, 'geekExpectList').filter(isRecord);
  const nativePlaceRecord = readRecord(baseInfo, 'hometown')
    ?? readRecord(baseInfo, 'nativePlace')
    ?? readRecord(baseInfo, 'householdRegistration');
  const nativePlace = readString(baseInfo, 'hometownName')
    ?? readString(baseInfo, 'hometown')
    ?? readString(baseInfo, 'nativePlaceName')
    ?? readString(baseInfo, 'nativePlace')
    ?? readString(baseInfo, 'householdRegistration')
    ?? readString(nativePlaceRecord, 'name')
    ?? readString(nativePlaceRecord, 'cityName')
    ?? readString(nativePlaceRecord, 'label')
    ?? readString(geekDetail, 'hometownName')
    ?? readString(geekDetail, 'nativePlace');
  const education = readString(baseInfo, 'degreeCategory')
    ?? readString(highestEduExp, 'degreeName')
    ?? candidate.cardText?.match(/博士|硕士|本科|大专|中专\/中技|中专|高中/)?.[0];

  return {
    candidateId: candidate.candidateId || String(zpData.expectId ?? ''),
    resumeUrl: candidate.resumeUrl ?? page.url(),
    name: readString(baseInfo, 'name') ?? candidate.name,
    age: parseBossAge(readString(baseInfo, 'ageDesc')),
    nativePlace,
    education,
    regions: uniqueStrings([
      readString(showExpectPosition, 'locationName'),
      ...expectList.map((entry) => readString(entry, 'locationName')),
    ]),
    pr: uniqueStrings([
      readString(baseInfo, 'userDescription'),
      readString(baseInfo, 'userDesc'),
      ...readBossTextList(geekDetail.resumeSummary),
    ]),
    workExperiences: parseBossWorkExperiences(geekDetail, candidate),
    projectExperiences: parseBossProjectExperiences(geekDetail),
    educationExperiences: parseBossEducationExperiences(geekDetail, education),
    skill: [],
    certificates: parseBossCertificates(geekDetail),
  };
}

export function parseBossResumeData(
  geekDetail: Record<string, unknown>,
  page: Page,
  candidate: CandidateListItem,
): CandidateResume {
  return parseBossResumePayload({ zpData: { geekDetail } }, page, candidate);
}
