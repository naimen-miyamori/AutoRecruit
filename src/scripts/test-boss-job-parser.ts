import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeBossPositionDetail } from '../platforms/boss/parsing/job-parser.js';
import type { BossPositionDetail } from '../types/boss.js';

function detail(overrides: Partial<BossPositionDetail> = {}): BossPositionDetail {
  return {
    bossJobId: 'boss-job-1',
    name: '全铝箱包设计',
    status: 'open',
    location: '肇庆',
    department: '设计部',
    rawJd: '',
    ...overrides,
  };
}

describe('Boss deterministic job parser', () => {
  it('maps page fields and explicitly headed JD sections without model inference', () => {
    const parsed = normalizeBossPositionDetail(detail({
      salaryText: '15-20K',
      rawJd: [
        '【岗位职责】',
        '1. 负责全铝箱包产品设计与工艺落地',
        '2. 推进样品打样与跨部门协作',
        '【任职要求】',
        '1. 本科及以上学历，工业设计相关专业',
        '2. 3年以上产品设计工作经验',
        '3. 具备英语读写能力',
        '4. 有箱包行业经验者优先',
        '年龄要求：25-35岁',
        '【优先条件】',
        '- 熟悉海外市场需求',
        '福利待遇：五险一金',
      ].join('\n'),
    }));

    assert.deepEqual(parsed, {
      title: '全铝箱包设计',
      location: '肇庆',
      department: '设计部',
      salaryRange: { raw: '15-20K' },
      ageRange: { min: 25, max: 35, raw: '年龄要求：25-35岁' },
      education: '本科及以上学历',
      majors: [],
      languageRequirements: ['具备英语读写能力'],
      responsibilities: ['负责全铝箱包产品设计与工艺落地', '推进样品打样与跨部门协作'],
      hardRequirements: ['本科及以上学历，工业设计相关专业', '3年以上产品设计工作经验', '具备英语读写能力', '年龄要求：25-35岁'],
      preferredRequirements: ['熟悉海外市场需求', '有箱包行业经验者优先'],
      experienceYearsMin: 3,
      regionPreferences: [],
      industryTags: [],
    });
  });

  it('leaves unheaded free text and unsupported semantic fields empty', () => {
    const parsed = normalizeBossPositionDetail(detail({
      rawJd: '负责产品设计和项目交付\n需要良好的沟通能力\n面向海外市场',
    }));

    assert.deepEqual(parsed, {
      title: '全铝箱包设计',
      location: '肇庆',
      department: '设计部',
      salaryRange: undefined,
      ageRange: undefined,
      education: undefined,
      majors: [],
      languageRequirements: [],
      responsibilities: [],
      hardRequirements: [],
      preferredRequirements: [],
      experienceYearsMin: undefined,
      regionPreferences: [],
      industryTags: [],
    });
  });

  it('does not choose among conflicting education or experience requirements', () => {
    const parsed = normalizeBossPositionDetail(detail({
      salaryText: undefined,
      rawJd: [
        '任职资格：',
        '本科及以上学历',
        '大专及以上学历',
        '3年以上相关工作经验',
        '5年以上相关工作经验',
        '薪资范围：12-18K',
      ].join('\n'),
    }));

    assert.equal(parsed.education, undefined);
    assert.equal(parsed.experienceYearsMin, undefined);
    assert.deepEqual(parsed.salaryRange, { raw: '薪资范围：12-18K' });
    assert.deepEqual(parsed.hardRequirements, [
      '本科及以上学历',
      '大专及以上学历',
      '3年以上相关工作经验',
      '5年以上相关工作经验',
      '薪资范围：12-18K',
    ]);
  });

  it('keeps the non-preferred clause when a single requirement line ends in an explicit preference', () => {
    const parsed = normalizeBossPositionDetail(detail({
      rawJd: '【任职要求】\n大专及以上学历；2年以上箱包设计工作经验，有铝箱案例者优先。',
    }));

    assert.equal(parsed.education, '大专及以上学历');
    assert.equal(parsed.experienceYearsMin, 2);
    assert.deepEqual(parsed.hardRequirements, ['大专及以上学历；2年以上箱包设计工作经验']);
    assert.deepEqual(parsed.preferredRequirements, ['有铝箱案例者优先。']);
  });
});
