import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import JSZip from 'jszip';

import { config } from '../config.js';
import {
  extractCandidatePhotoUrl,
  renderResumeDocxFromTemplateBuffer,
  renderResumeDocumentXml,
} from '../reporting/resume-docx.js';
import { JobStore } from '../storage/job-store.js';
import type { CandidateResume } from '../types/job.js';
import { exportResumeDocx, parseExportResumeDocxArgs } from './export-resume-docx.js';

let tempDir: string;
let originalDataDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-resume-docx-'));
  originalDataDir = config.dataDir;
  (config as { dataDir: string }).dataDir = tempDir;
});

afterEach(async () => {
  (config as { dataDir: string }).dataDir = originalDataDir;
  await fs.rm(tempDir, { recursive: true, force: true });
});

function minimalTemplateXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '<w:body>',
    '<w:p><w:r><w:t>模板姓名</w:t></w:r></w:p>',
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>',
    '</w:body>',
    '</w:document>',
  ].join('');
}

function minimalPhotoTemplateXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    [
      '<w:document',
      ' xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
      ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
      ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
      ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
      ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
      '>',
    ].join(''),
    '<w:body>',
    '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="979170" cy="1148715"/><wp:docPr id="1" name="图片 2"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rId5"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r><w:r><w:t>模板姓名</w:t></w:r></w:p>',
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>',
    '</w:body>',
    '</w:document>',
  ].join('');
}

async function createMinimalDocxTemplate(filePath: string): Promise<void> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.folder('word')?.file('document.xml', minimalTemplateXml());
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await fs.writeFile(filePath, buffer);
}

async function createMinimalPhotoDocxTemplateBuffer(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.folder('word')?.file('document.xml', minimalPhotoTemplateXml());
  zip.folder('word')?.folder('_rels')?.file('document.xml.rels', [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image2.jpeg"/>',
    '</Relationships>',
  ].join(''));
  zip.folder('word')?.folder('media')?.file('image2.jpeg', Buffer.from('old-photo'));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function readDocumentXml(docxPath: string): Promise<string> {
  const zip = await JSZip.loadAsync(await fs.readFile(docxPath));
  const documentFile = zip.file('word/document.xml');
  assert.ok(documentFile);
  return documentFile.async('string');
}

function buildResume(): CandidateResume {
  return {
    candidateId: 'cand-1',
    age: 29,
    education: '本科',
    regions: ['上海'],
    pr: ['熟悉门店运营，具备团队管理经验。'],
    workExperiences: [
      {
        company: '迅销商贸',
        title: '门店店长',
        start: '2023.07',
        end: '2025.06',
        duration: '1年11个月',
        details: ['负责部下育成与营业额利润达成。', '![](https://example.com/noise.png)', '展开'],
      },
    ],
    projectExperiences: [
      {
        name: '新店开业项目',
        company: '迅销商贸',
        start: '2024.01',
        end: '2024.03',
        details: ['统筹开业陈列与人员排班。'],
      },
    ],
    educationExperiences: [
      {
        school: '四川工商学院',
        degree: '本科',
        major: '英语',
        start: '2018.09',
        end: '2022.06',
        details: ['统招'],
      },
    ],
    skill: [{ english: 'CET-6' }],
    certificates: ['普通话等级证书', '![](https://example.com/cert.png)'],
  };
}

describe('resume docx rendering', () => {
  it('extracts the real 51job candidate avatar and ignores template/default images', () => {
    const resume: CandidateResume = {
      ...buildResume(),
      educationExperiences: [
        {
          school: '上海济光职业技术学院',
          details: [
            '![](https://img01.51jobcdn.com/im/school/school.jpg)',
            '![](https://img07.51jobcdn.com/imehire/ehire2021/micro/gaea/assets/telescope-VIP-icon-2a1482cd.png?version=1.0)',
            '![](https://prod-51job.51jobcdn.com/ra9/361/360201/360201000/360201000_avatar_1492426498.jpg?sign=abc&time=1781142928&x-oss-process=image/resize,w_512)![](https://img07.51jobcdn.com/imehire/ehire2007/defaultnew/image/resumenew/woman.png)',
            '虞女士 虞女士',
          ],
        },
      ],
    };

    assert.equal(
      extractCandidatePhotoUrl(resume, '虞女士\n个人优势'),
      'https://prod-51job.51jobcdn.com/ra9/361/360201/360201000/360201000_avatar_1492426498.jpg?sign=abc&time=1781142928&x-oss-process=image/resize,w_512',
    );
  });

  it('replaces template body with stored resume fields and keeps section properties', () => {
    const xml = renderResumeDocumentXml(minimalTemplateXml(), buildResume(), {
      sourceText: '周女士\n在职（一个月内到岗）',
    });

    assert.match(xml, /周女士/);
    assert.match(xml, /性别：女/);
    assert.match(xml, /年龄：29岁/);
    assert.match(xml, /学历：本科/);
    assert.match(xml, /现住地：上海/);
    assert.match(xml, /目前状态：在职（一个月内到岗）/);
    assert.match(xml, /自我评价/);
    assert.match(xml, /工作经历/);
    assert.match(xml, /迅销商贸 2023\.07 - 2025\.06（1年11个月）/);
    assert.match(xml, /项目经历/);
    assert.match(xml, /教育经历/);
    assert.match(xml, /技能证书/);
    assert.match(xml, /<w:sectPr>/);
    assert.doesNotMatch(xml, /模板姓名/);
    assert.doesNotMatch(xml, /https:\/\/example\.com\/noise/);
  });

  it('produces a docx zip with updated word/document.xml', async () => {
    const sourceZip = new JSZip();
    sourceZip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
    sourceZip.folder('word')?.file('document.xml', minimalTemplateXml());
    const templateBuffer = await sourceZip.generateAsync({ type: 'nodebuffer' });

    const docxBuffer = await renderResumeDocxFromTemplateBuffer(templateBuffer, buildResume(), {
      sourceText: '周女士',
    });
    const outputZip = await JSZip.loadAsync(docxBuffer);
    const xml = await outputZip.file('word/document.xml')?.async('string');

    assert.ok(xml);
    assert.match(xml, /周女士/);
    assert.match(xml, /门店店长/);
  });

  it('embeds a candidate photo into the template photo relationship', async () => {
    const templateBuffer = await createMinimalPhotoDocxTemplateBuffer();
    const photoBytes = Buffer.from('new-photo');

    const docxBuffer = await renderResumeDocxFromTemplateBuffer(templateBuffer, buildResume(), {
      sourceText: '周女士',
      candidatePhoto: {
        data: photoBytes,
        contentType: 'image/png',
      },
    });
    const outputZip = await JSZip.loadAsync(docxBuffer);
    const documentXml = await outputZip.file('word/document.xml')?.async('string');
    const relsXml = await outputZip.file('word/_rels/document.xml.rels')?.async('string');
    const contentTypesXml = await outputZip.file('[Content_Types].xml')?.async('string');
    const outputPhotoBytes = await outputZip.file('word/media/candidate-photo.png')?.async('nodebuffer');

    assert.ok(documentXml);
    assert.match(documentXml, /r:embed="rId5"/);
    assert.match(documentXml, /周女士/);
    assert.doesNotMatch(documentXml, /模板姓名/);
    assert.ok(relsXml);
    assert.match(relsXml, /Target="media\/candidate-photo\.png"/);
    assert.ok(contentTypesXml);
    assert.match(contentTypesXml, /Extension="png" ContentType="image\/png"/);
    assert.deepEqual(outputPhotoBytes, photoBytes);
  });
});

describe('exportResumeDocx', () => {
  it('exports a stored resume to exports/resumes by platform, job key, and candidate id', async () => {
    const store = new JobStore();
    const jobKey = 'resume-docx-job';
    const resume = buildResume();
    const templatePath = path.join(tempDir, 'template.docx');
    await createMinimalDocxTemplate(templatePath);
    await store.saveCandidateResume('zhilian', jobKey, resume, '周女士\n在职（一个月内到岗）');

    const result = await exportResumeDocx({
      platform: 'zhilian',
      jobKey,
      candidateId: resume.candidateId,
      templatePath,
    });

    assert.equal(result.outputPath, path.join(tempDir, 'zhilian', 'jobs', jobKey, 'exports', 'resumes', 'cand-1-周女士.docx'));
    const xml = await readDocumentXml(result.outputPath);
    assert.match(xml, /周女士/);
    assert.match(xml, /目前状态：在职（一个月内到岗）/);
  });

  it('fills missing age, location, and education major from nearby snapshot card text when available', async () => {
    const store = new JobStore();
    const jobKey = 'resume-docx-snapshot-fallback';
    const resume: CandidateResume = {
      ...buildResume(),
      name: '周女士',
      age: undefined,
      regions: [],
      educationExperiences: [
        {
          degree: '本科',
          details: ['四川工商学院', '2018.09 - 2022.06', '英语', '本科', '统招'],
        },
      ],
    };
    const templatePath = path.join(tempDir, 'template.docx');
    await createMinimalDocxTemplate(templatePath);
    await store.saveCandidateResume('zhilian', jobKey, resume, [
      '谭先生',
      '24岁',
      '离职-正在找工作',
      '周女士',
      '48小时前在线',
      '26岁',
      '3年',
      '本科',
      '在职-暂不找工作',
      '期望：',
      '上海',
      '门店店长',
    ].join('\n'));

    const result = await exportResumeDocx({
      platform: 'zhilian',
      jobKey,
      candidateId: resume.candidateId,
      templatePath,
    });
    const xml = await readDocumentXml(result.outputPath);

    assert.match(xml, /年龄：26岁/);
    assert.match(xml, /现住地：上海/);
    assert.match(xml, /目前状态：在职-暂不找工作/);
    assert.match(xml, /四川工商学院 2018\.09 - 2022\.06/);
    assert.match(xml, /本科 英语专业/);
    assert.doesNotMatch(xml, /本科 四川工商学院专业/);
  });

  it('prefers 51job source personal-advantage text over platform tag blocks in stored pr', async () => {
    const store = new JobStore();
    const jobKey = 'resume-docx-51job-self-evaluation';
    const resume: CandidateResume = {
      ...buildResume(),
      candidateId: 'cand-51job',
      age: 30,
      education: '大专',
      regions: ['上海'],
      pr: [
        [
          '「销售主管」技能&经验',
          '该标签由候选人提供，请HR与候选人自行沟通确认',
          '销售方式',
          '门店/柜台销售',
          '智能标签',
          '以下标签根据人才信息智能提取',
          '商品陈列展示',
        ].join('\n'),
      ],
    };
    const templatePath = path.join(tempDir, 'template.docx');
    await createMinimalDocxTemplate(templatePath);
    await store.saveCandidateResume('51job', jobKey, resume, [
      '虞女士',
      '在职（一个月内到岗）',
      '30岁  9年经验  大专 现居·上海 户口·上海',
      '求职意向',
      '销售主管上海全职7千-1万/月',
      '个人优势',
      '门店/柜台销售',
      '工作经历',
      '广东快客电子商务有限公司',
    ].join('\n'));

    const result = await exportResumeDocx({
      platform: '51job',
      jobKey,
      candidateId: resume.candidateId,
      templatePath,
    });
    const xml = await readDocumentXml(result.outputPath);

    assert.match(xml, /自我评价/);
    assert.match(xml, /门店\/柜台销售/);
    assert.doesNotMatch(xml, /销售主管/);
    assert.doesNotMatch(xml, /技能&amp;经验|技能&经验/);
    assert.doesNotMatch(xml, /智能标签/);
    assert.doesNotMatch(xml, /商品陈列展示/);
  });

  it('exports a specified resume json file to a specified output path', async () => {
    const templatePath = path.join(tempDir, 'template.docx');
    const resumePath = path.join(tempDir, 'resume.json');
    const snapshotPath = path.join(tempDir, 'snapshot.txt');
    const outputPath = path.join(tempDir, 'out', 'resume.docx');
    await createMinimalDocxTemplate(templatePath);
    await fs.writeFile(resumePath, `${JSON.stringify(buildResume())}\n`, 'utf8');
    await fs.writeFile(snapshotPath, '周女士\n离职', 'utf8');

    const result = await exportResumeDocx({
      resumeFile: resumePath,
      snapshotFile: snapshotPath,
      templatePath,
      outputPath,
    });

    assert.equal(result.outputPath, outputPath);
    const xml = await readDocumentXml(outputPath);
    assert.match(xml, /周女士/);
    assert.match(xml, /目前状态：离职/);
  });

  it('parses both flagged and positional CLI forms', () => {
    assert.deepStrictEqual(parseExportResumeDocxArgs(['--platform', '51job', '优衣库', '609819046']), {
      platform: '51job',
      jobKey: '优衣库',
      candidateId: '609819046',
    });
    assert.deepStrictEqual(parseExportResumeDocxArgs(['zhilian', '优衣库', '1140153075', '--output-dir', './resume-output']), {
      platform: 'zhilian',
      jobKey: '优衣库',
      candidateId: '1140153075',
      outputDir: './resume-output',
    });
    assert.deepStrictEqual(parseExportResumeDocxArgs(['--resume-file', './resume.json', '--snapshot-file', './snapshot.txt']), {
      resumeFile: './resume.json',
      snapshotFile: './snapshot.txt',
    });
  });
});
