import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import type {
  CandidateResume,
  EducationExperience,
  LanguageSkill,
  ProjectExperience,
  WorkExperience,
} from '../types/job.js';

export const DEFAULT_RESUME_TEMPLATE_PATH = '/Users/Admin/Downloads/简历模板.docx';

export type CandidatePhotoContentType = 'image/jpeg' | 'image/png';

export interface ResumeDocxCandidatePhoto {
  data: Buffer;
  contentType: CandidatePhotoContentType;
}

export interface ResumeDocxRenderOptions {
  sourceText?: string;
  candidatePhoto?: ResumeDocxCandidatePhoto;
}

export interface ResumeDocxFileOptions extends ResumeDocxRenderOptions {
  templatePath?: string;
}

interface ParagraphOptions {
  bold?: boolean;
  size?: number;
  spacingBefore?: number;
  spacingAfter?: number;
  drawingXml?: string;
}

interface ResumeBodyRenderOptions extends ResumeDocxRenderOptions {
  candidatePhotoDrawingXml?: string;
}

interface ImageRelationship {
  id: string;
  target: string;
}

interface ImageUrlCandidate {
  url: string;
  stringIndex: number;
  score: number;
}

const XML_BODY_START = '<w:body>';
const XML_BODY_END = '</w:body>';
const IMAGE_RELATIONSHIP_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const CANDIDATE_PHOTO_RELATIONSHIP_ID = 'rId5';

const NOISE_LINE_PATTERNS = [
  /^举报$/,
  /^扫码分享$/,
  /^电话沟通$/,
  /^附件个人信息$/,
  /^展开$/,
  /^收起$/,
  /^询问[他她]$/,
  /^智能标签$/,
  /^自定义标签$/,
  /^以下标签根据人才信息智能提取$/,
  /^该标签由候选人提供，请HR与候选人自行沟通确认$/,
  /^全选已选：/,
  /^评论$/,
  /^评论Ta$/,
  /^0\s*\/\s*500$/,
  /^根据你感兴趣的人才，找到了更多相似人才/,
];

const SELF_EVALUATION_TITLES = ['个人优势', '自我评价'];
const SOURCE_SECTION_BOUNDARY_TITLES = [
  '求职意向',
  '工作经历',
  '项目经历',
  '项目经验',
  '教育经历',
  '教育背景',
  '技能',
  '技能标签',
  '语言能力',
  '证书',
  '技能证书',
  '相似人才',
  '操作动态',
];

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function removeMarkdownImages(value: string): string {
  return value.replace(/!\[[^\]]*]\([^)]+\)/g, '');
}

function removeMarkdownLinks(value: string): string {
  return value.replace(/\[([^\]]+)]\(([^)]+)\)/g, '$1');
}

function collectStrings(value: unknown, result: string[] = []): string[] {
  if (typeof value === 'string') {
    result.push(value);
    return result;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, result));
    return result;
  }

  if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((item) => collectStrings(item, result));
  }

  return result;
}

function extractImageUrlCandidates(value: unknown): ImageUrlCandidate[] {
  const strings = collectStrings(value);

  return strings.flatMap((text, stringIndex) => (
    [...text.matchAll(/https?:\/\/[^\s)"']+\.(?:png|jpe?g|webp)(?:\?[^\s)"']*)?/gi)]
      .map((match) => match[0])
      .map((url) => ({
        url,
        stringIndex,
        score: 0,
      }))
  ));
}

function isBlockedPhotoAssetUrl(url: string): boolean {
  return /school|icon|logo|defaultnew|woman\.png|man\.png|svg|telescope|realname|empty|assets|avatar_toc_/i.test(url);
}

function scoreCandidatePhotoUrl(candidate: ImageUrlCandidate, strings: string[], name?: string): number {
  const url = candidate.url;
  if (isBlockedPhotoAssetUrl(url)) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = Number.NEGATIVE_INFINITY;
  if (/prod-51job\.51jobcdn\.com\/.*_avatar_/i.test(url)) {
    score = 100;
  } else if (/_avatar_/i.test(url)) {
    score = 70;
  } else if (/\/avatar[\/_-]?|portrait|head/i.test(url)) {
    score = 40;
  } else if (/candidate/i.test(url)) {
    score = 20;
  }

  if (score === Number.NEGATIVE_INFINITY) {
    return score;
  }

  if (/w_512\b/i.test(url)) {
    score += 5;
  } else if (/w_128\b/i.test(url)) {
    score += 2;
  }

  if (name) {
    const nearbyText = strings.slice(candidate.stringIndex, candidate.stringIndex + 8).join('\n');
    if (!nearbyText.includes(name)) {
      return Number.NEGATIVE_INFINITY;
    }

    score += 100;
  }

  return score;
}

export function extractCandidatePhotoUrl(resume: CandidateResume, sourceText?: string): string | undefined {
  const strings = collectStrings(resume);
  const name = resume.name ?? inferNameFromSource(sourceText);
  const seenUrls = new Set<string>();
  const candidates = extractImageUrlCandidates(resume)
    .filter((candidate) => {
      if (seenUrls.has(candidate.url)) {
        return false;
      }

      seenUrls.add(candidate.url);
      return true;
    })
    .map((candidate) => ({
      ...candidate,
      score: scoreCandidatePhotoUrl(candidate, strings, name),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.stringIndex - right.stringIndex);

  return candidates[0]?.url;
}

function cleanTextLine(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return undefined;
  }

  const normalized = normalizeSpaces(removeMarkdownLinks(removeMarkdownImages(String(value))));
  if (!normalized || /^https?:\/\//i.test(normalized)) {
    return undefined;
  }

  if (NOISE_LINE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return undefined;
  }

  return normalized;
}

function splitCleanLines(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }

  return String(value)
    .split(/\r?\n/)
    .map((line) => cleanTextLine(line))
    .filter((line): line is string => Boolean(line));
}

function uniqueStable(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    result.push(value);
  }

  return result;
}

function cleanTextArray(values: unknown[] | undefined): string[] {
  return uniqueStable((values ?? []).flatMap((value) => splitCleanLines(value)));
}

function getStringProperty(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = cleanTextLine(source[key]);
    if (value) {
      return value;
    }
  }

  return undefined;
}

function sourceLines(sourceText?: string): string[] {
  return sourceText
    ? sourceText.split(/\r?\n/).map((line) => cleanTextLine(line)).filter((line): line is string => Boolean(line))
    : [];
}

function inferNameFromSource(sourceText?: string): string | undefined {
  return sourceLines(sourceText).find((line) => /^[\u4e00-\u9fa5·]{1,8}(先生|女士|小姐)$/.test(line));
}

function candidateSourceWindow(sourceText: string | undefined, name?: string): string[] {
  const lines = sourceLines(sourceText);
  if (!name) {
    return lines.slice(0, 40);
  }

  const index = lines.findIndex((line) => line === name);
  return index === -1 ? lines.slice(0, 40) : lines.slice(index, index + 30);
}

function inferAgeFromSource(sourceText: string | undefined, name?: string): string | undefined {
  const ageLine = candidateSourceWindow(sourceText, name).find((line) => /^\d{2}岁$/.test(line));
  return ageLine;
}

function inferStatusFromSource(sourceText: string | undefined, name?: string): string | undefined {
  return candidateSourceWindow(sourceText, name)
    .find((line) => /(在职|离职|到岗|求职状态|目前状态)/.test(line));
}

function inferLocationFromSource(sourceText: string | undefined, name?: string): string | undefined {
  const lines = candidateSourceWindow(sourceText, name);
  const explicitLocation = lines.find((line) => /^(现居|现居住地|所在地|期望工作地)[:：]/.test(line));
  if (explicitLocation) {
    return explicitLocation.replace(/^(现居|现居住地|所在地|期望工作地)[:：]\s*/, '');
  }

  const expectationIndex = lines.findIndex((line) => line === '期望：');
  if (expectationIndex >= 0) {
    return lines.slice(expectationIndex + 1, expectationIndex + 4).find((line) => /^[\u4e00-\u9fa5]{2,12}$/.test(line));
  }

  return undefined;
}

function inferGender(name?: string): string | undefined {
  if (!name) {
    return undefined;
  }

  if (/(先生|男士)$/.test(name)) {
    return '男';
  }

  if (/(女士|小姐|女士)$/.test(name)) {
    return '女';
  }

  return undefined;
}

function getResumeName(resume: CandidateResume, sourceText?: string): string {
  return resume.name ?? inferNameFromSource(sourceText) ?? resume.candidateId;
}

function extractSelfEvaluationFromSource(sourceText: string | undefined, name?: string): string[] {
  const lines = sourceLines(sourceText);
  const nameIndex = name ? lines.findIndex((line) => line === name) : -1;
  const startSearchIndex = nameIndex >= 0 ? nameIndex : 0;
  const titleIndex = lines.findIndex((line, index) => (
    index >= startSearchIndex && SELF_EVALUATION_TITLES.includes(line)
  ));

  if (titleIndex === -1) {
    return [];
  }

  const sectionLines: string[] = [];
  for (let index = titleIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (SOURCE_SECTION_BOUNDARY_TITLES.includes(line)) {
      break;
    }

    sectionLines.push(line);
  }

  return uniqueStable(sectionLines);
}

function isPlatformTagBlock(lines: string[]): boolean {
  return lines.some((line) => /^「.+」技能&经验$/.test(line) || line === '智能标签' || line === '销售方式');
}

function buildSelfEvaluationLines(resume: CandidateResume, sourceText?: string): string[] {
  const sourceLinesForSelfEvaluation = extractSelfEvaluationFromSource(sourceText, getResumeName(resume, sourceText));
  if (sourceLinesForSelfEvaluation.length > 0) {
    return sourceLinesForSelfEvaluation;
  }

  const lines = cleanTextArray((resume.pr ?? []) as unknown[]);
  return isPlatformTagBlock(lines) ? [] : lines;
}

function getResumeFieldData(resume: CandidateResume, sourceText?: string): {
  name: string;
  gender: string;
  age: string;
  education: string;
  currentLocation: string;
  hukou: string;
  status: string;
} {
  const source = resume as CandidateResume & Record<string, unknown>;
  const name = getResumeName(resume, sourceText);
  const gender = getStringProperty(source, ['gender', 'sex', '性别']) ?? inferGender(name) ?? '';

  return {
    name,
    gender,
    age: resume.age === undefined ? inferAgeFromSource(sourceText, name) ?? '' : `${resume.age}岁`,
    education: resume.education ?? '',
    currentLocation: resume.regions.length > 0 ? resume.regions.join('、') : inferLocationFromSource(sourceText, name) ?? '',
    hukou: getStringProperty(source, ['hukou', 'householdRegistration', '户口']) ?? '',
    status: getStringProperty(source, ['currentStatus', 'status', 'jobStatus', '目前状态']) ?? inferStatusFromSource(sourceText, name) ?? '',
  };
}

function runProperties(options: ParagraphOptions = {}): string {
  const properties = ['<w:rFonts w:hint="eastAsia"/>'];

  if (options.bold) {
    properties.push('<w:b/>', '<w:bCs/>');
  }

  if (options.size) {
    properties.push(`<w:sz w:val="${options.size}"/>`, `<w:szCs w:val="${options.size}"/>`);
  }

  return `<w:rPr>${properties.join('')}</w:rPr>`;
}

function paragraphProperties(options: ParagraphOptions = {}): string {
  const properties: string[] = [];

  if (options.spacingBefore !== undefined || options.spacingAfter !== undefined) {
    const spacingAttributes = [
      options.spacingBefore === undefined ? undefined : `w:before="${options.spacingBefore}"`,
      options.spacingAfter === undefined ? undefined : `w:after="${options.spacingAfter}"`,
    ].filter(Boolean).join(' ');
    properties.push(`<w:spacing ${spacingAttributes}/>`);
  }

  properties.push(runProperties(options));
  return `<w:pPr>${properties.join('')}</w:pPr>`;
}

function textRun(text: string, options: ParagraphOptions = {}): string {
  const spaceAttribute = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
  return `<w:r>${runProperties(options)}<w:t${spaceAttribute}>${escapeXml(text)}</w:t></w:r>`;
}

function paragraph(text = '', options: ParagraphOptions = {}): string {
  return `<w:p>${paragraphProperties(options)}${options.drawingXml ? `<w:r>${runProperties(options)}${options.drawingXml}</w:r>` : ''}${text ? textRun(text, options) : ''}</w:p>`;
}

function blankParagraph(): string {
  return paragraph('');
}

function sectionHeading(text: string): string {
  return paragraph(text, { bold: true, size: 28, spacingBefore: 120, spacingAfter: 80 });
}

function formatDateRange(start?: string, end?: string, duration?: string): string {
  const range = start && end ? `${start} - ${end}` : start ?? end ?? '';
  return duration && range ? `${range}（${duration}）` : range;
}

function renderWorkExperience(work: WorkExperience): string[] {
  const paragraphs: string[] = [];
  const dateRange = formatDateRange(work.start, work.end, work.duration);
  const heading = [work.company, dateRange].filter(Boolean).join(' ');

  if (heading) {
    paragraphs.push(paragraph(heading, { bold: true }));
  }

  if (work.title) {
    paragraphs.push(paragraph(work.title, { bold: true }));
  }

  const details = cleanTextArray(work.details);
  if (details.length > 0) {
    paragraphs.push(paragraph('职责业绩：'));
    paragraphs.push(...details.map((detail) => paragraph(detail)));
  }

  return paragraphs;
}

function renderProjectExperience(project: ProjectExperience): string[] {
  const paragraphs: string[] = [];
  const dateRange = formatDateRange(project.start, project.end, project.duration);
  const heading = [project.name, project.company, dateRange].filter(Boolean).join(' ');

  if (heading) {
    paragraphs.push(paragraph(heading, { bold: true }));
  }

  paragraphs.push(...cleanTextArray(project.details).map((detail) => paragraph(detail)));
  return paragraphs;
}

function inferEducationDetail(education: EducationExperience, kind: 'school' | 'date'): string | undefined {
  const details = cleanTextArray(education.details);

  if (kind === 'date') {
    return details.find((detail) => /\d{4}\.\d{1,2}\s*-\s*(\d{4}\.\d{1,2}|至今)/.test(detail));
  }

  return details.find((detail) => (
    !/\d{4}\.\d{1,2}/.test(detail)
    && detail !== education.degree
    && detail !== education.major
    && !/^(统招|非统招|985|211|双一流学校|双一流学科|留学)$/.test(detail)
  ));
}

function inferEducationMajor(education: EducationExperience, school?: string): string | undefined {
  return cleanTextArray(education.details).find((detail) => (
    detail !== school
    && detail !== education.school
    && detail !== education.degree
    && !/\d{4}\.\d{1,2}/.test(detail)
    && !/^(统招|非统招|985|211|双一流学校|双一流学科|留学)$/.test(detail)
  ));
}

function renderEducationExperience(education: EducationExperience): string[] {
  const school = education.school ?? inferEducationDetail(education, 'school');
  const explicitRange = formatDateRange(education.start, education.end);
  const dateRange = explicitRange || inferEducationDetail(education, 'date');
  const major = education.major ?? inferEducationMajor(education, school);
  const paragraphs: string[] = [];

  const heading = [school, dateRange].filter(Boolean).join(' ');
  if (heading) {
    paragraphs.push(paragraph(heading));
  }

  const degreeAndMajor = [
    education.degree,
    major ? `${major}专业` : undefined,
  ].filter(Boolean).join(' ');
  if (degreeAndMajor) {
    paragraphs.push(paragraph(degreeAndMajor));
  }

  return paragraphs;
}

function languageSkillToLines(skill: LanguageSkill): string[] {
  return Object.entries(skill)
    .map(([key, value]) => {
      const cleaned = cleanTextLine(value);
      if (!cleaned) {
        return undefined;
      }

      return key === 'english' || key === 'english level' ? cleaned : `${key}：${cleaned}`;
    })
    .filter((line): line is string => Boolean(line));
}

function renderResumeBody(resume: CandidateResume, options: ResumeBodyRenderOptions = {}): string {
  const fieldData = getResumeFieldData(resume, options.sourceText);
  const selfEvaluation = buildSelfEvaluationLines(resume, options.sourceText);
  const skillLines = uniqueStable([
    ...resume.skill.flatMap((skill) => languageSkillToLines(skill)),
    ...cleanTextArray(resume.certificates).filter((line) => line.length <= 80),
  ]);

  const body: string[] = [
    paragraph(fieldData.name, {
      bold: true,
      size: 32,
      spacingAfter: 80,
      drawingXml: options.candidatePhotoDrawingXml,
    }),
    paragraph(`性别：${fieldData.gender}`),
    paragraph(`年龄：${fieldData.age}`),
    paragraph(`学历：${fieldData.education}`),
    paragraph(`现住地：${fieldData.currentLocation}`),
    paragraph(`户口：${fieldData.hukou}`),
    paragraph(`目前状态：${fieldData.status}`),
    blankParagraph(),
  ];

  if (selfEvaluation.length > 0) {
    body.push(sectionHeading('自我评价'));
    body.push(...selfEvaluation.map((line) => paragraph(line)));
    body.push(blankParagraph());
  }

  if (resume.workExperiences.length > 0) {
    body.push(sectionHeading('工作经历'));
    resume.workExperiences.forEach((work, index) => {
      if (index > 0) {
        body.push(blankParagraph());
      }

      body.push(...renderWorkExperience(work));
    });
    body.push(blankParagraph());
  }

  if (resume.projectExperiences.length > 0) {
    body.push(sectionHeading('项目经历'));
    resume.projectExperiences.forEach((project, index) => {
      if (index > 0) {
        body.push(blankParagraph());
      }

      body.push(...renderProjectExperience(project));
    });
    body.push(blankParagraph());
  }

  if (resume.educationExperiences.length > 0) {
    body.push(sectionHeading('教育经历'));
    resume.educationExperiences.forEach((education, index) => {
      if (index > 0) {
        body.push(blankParagraph());
      }

      body.push(...renderEducationExperience(education));
    });
    body.push(blankParagraph());
  }

  if (skillLines.length > 0) {
    body.push(sectionHeading('技能证书'));
    body.push(...skillLines.map((line) => paragraph(line)));
  }

  return body.join('');
}

function extractCandidatePhotoDrawingXml(templateDocumentXml: string): string | undefined {
  const drawingMatches = templateDocumentXml.matchAll(/<w:drawing>[\s\S]*?<\/w:drawing>/g);

  for (const match of drawingMatches) {
    if (match[0].includes(`r:embed="${CANDIDATE_PHOTO_RELATIONSHIP_ID}"`)) {
      return match[0];
    }
  }

  return undefined;
}

function extractSectionProperties(bodyXml: string): string {
  const match = bodyXml.match(/<w:sectPr[\s\S]*?<\/w:sectPr>\s*$/);
  return match?.[0].trim() ?? '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="851" w:footer="992" w:gutter="0"/><w:cols w:space="720" w:num="1"/></w:sectPr>';
}

export function renderResumeDocumentXml(
  templateDocumentXml: string,
  resume: CandidateResume,
  options: ResumeDocxRenderOptions = {},
): string {
  const bodyStartIndex = templateDocumentXml.indexOf(XML_BODY_START);
  const bodyEndIndex = templateDocumentXml.lastIndexOf(XML_BODY_END);

  if (bodyStartIndex === -1 || bodyEndIndex === -1 || bodyEndIndex <= bodyStartIndex) {
    throw new Error('Invalid DOCX template: word/document.xml is missing a w:body element');
  }

  const beforeBodyContent = templateDocumentXml.slice(0, bodyStartIndex + XML_BODY_START.length);
  const bodyContent = templateDocumentXml.slice(bodyStartIndex + XML_BODY_START.length, bodyEndIndex);
  const afterBodyContent = templateDocumentXml.slice(bodyEndIndex);
  const sectionProperties = extractSectionProperties(bodyContent);
  const candidatePhotoDrawingXml = options.candidatePhoto
    ? extractCandidatePhotoDrawingXml(templateDocumentXml)
    : undefined;

  return `${beforeBodyContent}${renderResumeBody(resume, {
    ...options,
    candidatePhotoDrawingXml,
  })}${sectionProperties}${afterBodyContent}`;
}

function parseImageRelationships(relsXml: string): ImageRelationship[] {
  return [...relsXml.matchAll(/<Relationship\b([^>]*?)\/>/g)]
    .map((match) => {
      const attributes = match[1];
      const id = attributes.match(/\bId="([^"]+)"/)?.[1];
      const type = attributes.match(/\bType="([^"]+)"/)?.[1];
      const target = attributes.match(/\bTarget="([^"]+)"/)?.[1];
      return id && type === IMAGE_RELATIONSHIP_TYPE && target ? { id, target } : undefined;
    })
    .filter((relationship): relationship is ImageRelationship => Boolean(relationship));
}

function replaceRelationshipTarget(relsXml: string, relationshipId: string, target: string): string {
  return relsXml.replace(
    new RegExp(`(<Relationship\\b(?=[^>]*\\bId="${relationshipId}")[^>]*\\bTarget=")[^"]+("[^>]*/>)`),
    `$1${target}$2`,
  );
}

function ensureContentTypeDefault(contentTypesXml: string, extension: string, contentType: string): string {
  if (new RegExp(`<Default\\b[^>]*\\bExtension="${extension}"`).test(contentTypesXml)) {
    return contentTypesXml;
  }

  return contentTypesXml.replace('</Types>', `<Default Extension="${extension}" ContentType="${contentType}"/></Types>`);
}

function candidatePhotoTarget(contentType: CandidatePhotoContentType): string {
  return contentType === 'image/png' ? 'media/candidate-photo.png' : 'media/candidate-photo.jpeg';
}

export async function renderResumeDocxFromTemplateBuffer(
  templateBuffer: Buffer,
  resume: CandidateResume,
  options: ResumeDocxRenderOptions = {},
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(templateBuffer);
  const documentFile = zip.file('word/document.xml');

  if (!documentFile) {
    throw new Error('Invalid DOCX template: missing word/document.xml');
  }

  const templateDocumentXml = await documentFile.async('string');
  const relsFile = zip.file('word/_rels/document.xml.rels');
  const relsXml = relsFile ? await relsFile.async('string') : undefined;
  const existingCandidatePhotoRelationship = relsXml
    ? parseImageRelationships(relsXml).find((relationship) => relationship.id === CANDIDATE_PHOTO_RELATIONSHIP_ID)
    : undefined;
  const candidatePhoto = existingCandidatePhotoRelationship ? options.candidatePhoto : undefined;

  zip.file('word/document.xml', renderResumeDocumentXml(templateDocumentXml, resume, {
    ...options,
    candidatePhoto,
  }));

  if (candidatePhoto && relsXml && existingCandidatePhotoRelationship) {
    const target = candidatePhotoTarget(candidatePhoto.contentType);
    const targetPath = `word/${target}`;

    zip.file(targetPath, candidatePhoto.data);

    if (existingCandidatePhotoRelationship.target !== target) {
      zip.file('word/_rels/document.xml.rels', replaceRelationshipTarget(relsXml, CANDIDATE_PHOTO_RELATIONSHIP_ID, target));
    }

    const contentTypesFile = zip.file('[Content_Types].xml');
    if (contentTypesFile) {
      const extension = candidatePhoto.contentType === 'image/png' ? 'png' : 'jpeg';
      zip.file(
        '[Content_Types].xml',
        ensureContentTypeDefault(await contentTypesFile.async('string'), extension, candidatePhoto.contentType),
      );
    }
  }

  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  });
}

export async function renderResumeDocxFile(
  resume: CandidateResume,
  options: ResumeDocxFileOptions = {},
): Promise<Buffer> {
  const templatePath = path.resolve(options.templatePath ?? DEFAULT_RESUME_TEMPLATE_PATH);
  const templateBuffer = await fs.readFile(templatePath);
  return renderResumeDocxFromTemplateBuffer(templateBuffer, resume, options);
}

export function sanitizeDocxFileName(value: string): string {
  const sanitized = value.replace(/[/:\\?%*"<>|]/g, '-').replace(/\s+/g, ' ').trim();
  return sanitized.slice(0, 120) || 'resume';
}

export function buildResumeDocxFileName(resume: CandidateResume, sourceText?: string): string {
  const name = getResumeName(resume, sourceText);
  return `${sanitizeDocxFileName(`${resume.candidateId}-${name}`)}.docx`;
}

export async function writeResumeDocxFile(
  outputPath: string,
  resume: CandidateResume,
  options: ResumeDocxFileOptions = {},
): Promise<string> {
  const resolvedOutputPath = path.resolve(outputPath);
  const buffer = await renderResumeDocxFile(resume, options);
  await fs.mkdir(path.dirname(resolvedOutputPath), { recursive: true });
  await fs.writeFile(resolvedOutputPath, buffer);
  return resolvedOutputPath;
}
