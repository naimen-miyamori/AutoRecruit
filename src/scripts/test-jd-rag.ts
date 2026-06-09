import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { retrieveJdFragments } from '../rag/jd-question-answering.js';
import type { NormalizedJob } from '../types/job.js';

const normalizedJob: NormalizedJob = {
  title: '东南亚销售经理',
  location: '上海',
  salaryRange: { raw: '15-25K，13薪' },
  education: '本科',
  majors: ['国际贸易', '市场营销'],
  languageRequirements: ['英语可作为工作语言'],
  responsibilities: ['负责东南亚区域客户开发', '维护渠道伙伴关系'],
  hardRequirements: ['5年以上海外销售经验'],
  preferredRequirements: ['有阀门或化工行业客户资源优先'],
  experienceYearsMin: 5,
  regionPreferences: ['东南亚'],
  industryTags: ['阀门', '化工', '销售'],
};

describe('JD RAG retrieval', () => {
  it('retrieves relevant JD fragments for candidate questions', () => {
    const sources = retrieveJdFragments(
      [
        '职位名称：东南亚销售经理',
        '薪资范围：15-25K，13薪',
        '岗位职责：负责东南亚区域客户开发，维护渠道伙伴关系。',
        '任职要求：英语可作为工作语言，5年以上海外销售经验。',
      ].join('\n'),
      '这个岗位薪资范围是多少？',
      normalizedJob,
      3,
    );

    assert.ok(sources.length > 0);
    assert.ok(
      sources.some((source) => source.text.includes('15-25K')),
      `expected salary source, got ${JSON.stringify(sources)}`,
    );
  });

  it('falls back to available JD context when no query terms match directly', () => {
    const sources = retrieveJdFragments(
      '职位名称：东南亚销售经理\n岗位职责：负责客户开发。',
      '公司附近停车方便吗？',
      undefined,
      2,
    );

    assert.equal(sources.length, 1);
    assert.deepStrictEqual(sources.map((source) => source.id), ['jd-1']);
  });
});
