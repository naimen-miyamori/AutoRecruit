import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractJsonObjectFromModelText, extractNormalizedJobFromTextResponse } from '../parsers/jd-parser.js';
import { resolveOpenAISettings } from '../llm/openai-client.js';

describe('extractJsonObjectFromModelText', () => {
  it('returns raw JSON when the model responds with a bare object', () => {
    const jsonText = JSON.stringify({
      title: '店长',
      majors: ['市场营销'],
      languageRequirements: ['普通话'],
      responsibilities: ['负责门店运营'],
      hardRequirements: ['3年以上零售管理经验'],
      preferredRequirements: ['英语优先'],
      regionPreferences: ['上海'],
      industryTags: ['零售'],
    });

    assert.equal(extractJsonObjectFromModelText(jsonText), jsonText);
  });

  it('extracts JSON from a fenced code block', () => {
    const jsonText = `\
\`\`\`json
{"title":"店长","majors":[],"languageRequirements":[],"responsibilities":[],"hardRequirements":[],"preferredRequirements":[],"regionPreferences":[],"industryTags":[]}
\`\`\`
`;

    assert.equal(
      extractJsonObjectFromModelText(jsonText),
      '{"title":"店长","majors":[],"languageRequirements":[],"responsibilities":[],"hardRequirements":[],"preferredRequirements":[],"regionPreferences":[],"industryTags":[]}',
    );
  });

  it('rejects non-JSON model text', () => {
    assert.throws(
      () => extractJsonObjectFromModelText('这是岗位总结，不是 JSON。'),
      /did not return parseable JSON text/,
    );
  });
});

describe('extractNormalizedJobFromTextResponse', () => {
  it('parses and sanitizes a raw JSON response', () => {
    const job = extractNormalizedJobFromTextResponse({
      output_text: JSON.stringify({
        title: ' 店长 ',
        location: ' 上海 ',
        education: ' 大专以上 ',
        majors: [' 市场营销 ', '市场营销', ''],
        languageRequirements: [' 普通话 ', '英语书面和口头表达优先', ''],
        responsibilities: [' 负责门店运营 ', '负责门店运营'],
        hardRequirements: [' 3年以上零售管理经验 ', ''],
        preferredRequirements: [' 英语优先 ', '英语优先'],
        experienceYearsMin: 3,
        regionPreferences: [' 上海 ', '上海'],
        industryTags: [' 零售 ', '零售'],
        salaryRange: { raw: ' 税前8-12k ' },
        ageRange: { raw: ' ' },
      }),
    });

    assert.deepStrictEqual(job, {
      title: '店长',
      location: '上海',
      department: undefined,
      salaryRange: { min: undefined, max: undefined, currency: undefined, period: undefined, raw: '税前8-12k' },
      ageRange: undefined,
      education: '大专以上',
      majors: ['市场营销'],
      languageRequirements: ['普通话', '英语书面和口头表达优先'],
      responsibilities: ['负责门店运营'],
      hardRequirements: ['3年以上零售管理经验'],
      preferredRequirements: ['英语优先'],
      experienceYearsMin: 3,
      regionPreferences: ['上海'],
      industryTags: ['零售'],
    });
  });

  it('rejects a response without parseable text JSON', () => {
    assert.throws(
      () => extractNormalizedJobFromTextResponse({ output_text: '我认为这个岗位适合零售管理者。' }),
      /did not return parseable JSON text/,
    );
  });
});

describe('resolveOpenAISettings', () => {
  it('rejects missing OpenAI credentials even when legacy env vars are present', () => {
    const originalOpenAIKey = process.env.OPENAI_API_KEY;
    const originalOpenAIModel = process.env.OPENAI_MODEL;
    const originalLegacyKey = process.env.LEGACY_API_KEY;
    const originalLegacyModel = process.env.LEGACY_MODEL;

    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_MODEL;
    process.env.LEGACY_API_KEY = 'legacy-test-key';
    process.env.LEGACY_MODEL = 'legacy-model';

    try {
      assert.throws(
        () => resolveOpenAISettings('JD parsing', 'JD_PARSING_MODEL'),
        /Missing required environment variable: OPENAI_API_KEY/,
      );
    } finally {
      if (originalOpenAIKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAIKey;
      }

      if (originalOpenAIModel === undefined) {
        delete process.env.OPENAI_MODEL;
      } else {
        process.env.OPENAI_MODEL = originalOpenAIModel;
      }

      if (originalLegacyKey === undefined) {
        delete process.env.LEGACY_API_KEY;
      } else {
        process.env.LEGACY_API_KEY = originalLegacyKey;
      }

      if (originalLegacyModel === undefined) {
        delete process.env.LEGACY_MODEL;
      } else {
        process.env.LEGACY_MODEL = originalLegacyModel;
      }
    }
  });
});
