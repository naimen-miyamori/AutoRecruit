import assert from 'node:assert/strict';
import test from 'node:test';

import { zhilianAdapter, zhilianTestExports } from '../platforms/zhilian-adapter.js';

test('zhilian adapter exposes the expected platform metadata', () => {
  assert.equal(zhilianAdapter.platform, 'zhilian');
  assert.equal(zhilianAdapter.displayName, 'Zhilian');
  assert.equal(zhilianAdapter.subscribeSearchUrl, 'https://rd6.zhaopin.com/app/search');
  assert.equal(zhilianAdapter.loginUrl, 'https://passport.zhaopin.com/org/login');
  assert.equal(zhilianAdapter.storageStateFileName, 'storage-state.zhilian.json');
});

test('zhilian adapter rejects login fallback pages', async () => {
  const page = {
    url: () => 'https://passport.zhaopin.com/org/login',
    waitForLoadState: async () => undefined,
    locator: () => ({
      waitFor: async () => undefined,
      innerText: async () => '智联招聘 企业登录 扫码登录 验证码登录',
    }),
  } as never;

  await assert.rejects(
    () => zhilianAdapter.assertAuthenticated(page),
    /Zhilian authenticated page is not available because the session has fallen back to the login screen\./,
  );
});

test('zhilian adapter accepts authenticated recruiter shell text', async () => {
  const page = {
    url: () => 'https://rd6.zhaopin.com/app/search',
    waitForLoadState: async () => undefined,
    locator: () => ({
      waitFor: async () => undefined,
      innerText: async () => '智联招聘 招聘管理 职位管理 简历管理 候选人 面试 沟通',
    }),
  } as never;

  await assert.doesNotReject(() => zhilianAdapter.assertAuthenticated(page));
});

test('zhilian adapter accepts the real /app/search page text as authenticated', async () => {
  const page = {
    url: () => 'https://rd6.zhaopin.com/app/search',
    waitForLoadState: async () => undefined,
    locator: () => ({
      waitFor: async () => undefined,
      innerText: async () => '职位 推荐 搜索 聊天 互动 人才管理 道具 企业管理 更多 个人中心 搜公司、职位、专业、学校、行业、技能等 使用高级搜索 清空筛选 学历要求',
    }),
  } as never;

  await assert.doesNotReject(() => zhilianAdapter.assertAuthenticated(page));
});

test('zhilian adapter treats the real /app/search page as ready even when spinner markup remains in the DOM', async () => {
  const originalDocument = (globalThis as { document?: unknown }).document;
  const originalWindow = (globalThis as { window?: unknown }).window;
  const page = {
    url: () => 'https://rd6.zhaopin.com/app/search',
    waitForLoadState: async () => undefined,
    waitForFunction: async (predicate: () => boolean) => {
      (globalThis as { document?: unknown }).document = {
        body: {
          innerText: '智联招聘 搜索 人才管理 推荐 使用高级搜索 搜公司、职位、专业、学校、行业、技能等',
        },
        querySelector: () => ({ className: 'ant-spin-spinning' }),
      };
      (globalThis as { window?: unknown }).window = {
        location: {
          href: 'https://rd6.zhaopin.com/app/search',
        },
      };

      try {
        if (!predicate()) {
          throw new Error('page.waitForFunction: Timeout 15000ms exceeded.');
        }
      } finally {
        (globalThis as { document?: unknown }).document = originalDocument;
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    },
    locator: () => ({
      waitFor: async () => undefined,
      innerText: async () => '智联招聘 搜索 人才管理 推荐 使用高级搜索 搜公司、职位、专业、学校、行业、技能等',
    }),
  } as never;

  await assert.doesNotReject(() => zhilianAdapter.openAuthenticatedHome(page));
});

test('zhilian adapter accepts blank rd6 shell when authenticated cookies exist', async () => {
  const page = {
    context: () => ({
      cookies: async () => [
        { name: 'at' },
        { name: 'rt' },
      ],
    }),
    url: () => 'https://rd6.zhaopin.com/desktop',
    waitForLoadState: async () => undefined,
    locator: () => ({
      waitFor: async () => undefined,
      innerText: async () => '',
    }),
  } as never;

  await assert.doesNotReject(() => zhilianAdapter.assertAuthenticated(page));
});

test('zhilian adapter clicks a saved quick-search tag whose text contains the raw keyword', async () => {
  const clickCalls: string[] = [];
  const page = {
    url: () => 'https://rd6.zhaopin.com/app/search',
    waitForLoadState: async () => undefined,
    waitForFunction: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '智联招聘 搜索 人才管理 快捷搜索 上海 优衣库 李宁 无印良品',
        };
      }

      return {
        first: () => ({
          waitFor: async () => {
            if (selector.includes('快捷搜索') || selector.includes('猜你想搜') || selector.includes('tag')) {
              return undefined;
            }

            throw new Error(`unexpected selector wait: ${selector}`);
          },
          click: async () => {
            clickCalls.push(selector);
          },
        }),
      };
    },
    getByText: (matcher: RegExp) => {
      if (matcher.source.includes('优衣库')) {
        return {
          first: () => ({
            waitFor: async () => undefined,
            click: async () => {
              clickCalls.push('优衣库');
            },
          }),
        };
      }
      throw new Error(`unexpected matcher: ${matcher.source}`);
    },
  } as never;

  await assert.doesNotReject(() => zhilianAdapter.openSubscribeSearch(page, '优衣库'));
  assert.deepEqual(clickCalls, ['优衣库']);
});

test('zhilian adapter fails when no saved quick-search tag contains the raw keyword', async () => {
  const page = {
    url: () => 'https://rd6.zhaopin.com/app/search',
    waitForLoadState: async () => undefined,
    waitForFunction: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '智联招聘 搜索 人才管理 快捷搜索 上海 优衣库 李宁 无印良品 猜你想搜 销售 课程顾问 招聘',
        };
      }

      return {
        first: () => ({
          waitFor: async () => {
            throw new Error(`tag selector did not match: ${selector}`);
          },
        }),
      };
    },
    getByText: () => ({
      first: () => ({
        waitFor: async () => {
          throw new Error('raw keyword tag not found');
        },
      }),
    }),
  } as never;

  await assert.rejects(
    () => zhilianAdapter.openSubscribeSearch(page, '不存在的标签'),
    /Could not find a saved Zhilian quick-search tag containing keyword "不存在的标签".*优衣库.*李宁.*无印良品/s,
  );
});

test('zhilian candidate API parser extracts common candidate fields', () => {
  const candidates = zhilianTestExports.parseZhilianApiCandidates(JSON.stringify({
    data: {
      list: [
        {
          resumeId: 'R123456',
          name: '张三',
          companyName: '上海测试科技有限公司',
          jobTitle: '海外销售经理',
          detailUrl: '/resume/detail?resumeId=R123456',
        },
      ],
    },
  }));

  assert.deepEqual(candidates, [
    {
      candidateId: 'R123456',
      resumeUrl: 'https://rd6.zhaopin.com/resume/detail?resumeId=R123456',
      name: '张三',
      currentCompany: '上海测试科技有限公司',
      currentTitle: '海外销售经理',
      cardText: '张三\n上海测试科技有限公司\n海外销售经理',
      searchResultIndex: 0,
      sourceText: JSON.stringify({
        resumeId: 'R123456',
        name: '张三',
        companyName: '上海测试科技有限公司',
        jobTitle: '海外销售经理',
        detailUrl: '/resume/detail?resumeId=R123456',
      }),
    },
  ]);
});

test('zhilian candidate API parser extracts candidates from real talent search payload fields', () => {
  const candidates = zhilianTestExports.parseZhilianApiCandidates(JSON.stringify({
    data: {
      list: [
        {
          userMasterId: 1236130414,
          userName: '李先生',
          desiredJobType: '销售助理',
          resumeNumber: 'yISBw6q(6hVzPPyKfEn(LQ7ONVlsN2rQ',
          resumeK: 'FB7B7BCB788E29B0EB4E88E6E7779BD7',
          resumeT: '1779027400144',
          workExperiences: [
            {
              companyName: '波司登羽绒服装',
              jobTitle: '门店店长',
            },
          ],
        },
      ],
    },
  }));

  assert.deepEqual(candidates, [
    {
      candidateId: '1236130414',
      resumeUrl: 'https://rd6.zhaopin.com/app/search?resumeNumber=yISBw6q(6hVzPPyKfEn(LQ7ONVlsN2rQ',
      name: '李先生',
      currentCompany: '波司登羽绒服装',
      currentTitle: '门店店长',
      cardText: '李先生\n波司登羽绒服装\n门店店长',
      searchResultIndex: 0,
      sourceText: JSON.stringify({
        userMasterId: 1236130414,
        userName: '李先生',
        desiredJobType: '销售助理',
        resumeNumber: 'yISBw6q(6hVzPPyKfEn(LQ7ONVlsN2rQ',
        resumeK: 'FB7B7BCB788E29B0EB4E88E6E7779BD7',
        resumeT: '1779027400144',
        workExperiences: [
          {
            companyName: '波司登羽绒服装',
            jobTitle: '门店店长',
          },
        ],
      }),
    },
  ]);
});

test('zhilian adapter extracts candidate cards from DOM fallback', async () => {
  const page = {
    url: () => 'https://rd6.zhaopin.com/app/search',
    waitForLoadState: async () => undefined,
    waitForFunction: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '智联招聘 招聘管理 职位管理 简历管理 候选人 搜索',
        };
      }

      return {
        evaluateAll: async (fn: (elements: Element[]) => unknown) => {
          const container = {
            textContent: '李四\n上海测试科技有限公司\n海外销售经理',
            outerHTML: '<div>李四 上海测试科技有限公司 海外销售经理</div>',
            getAttribute: () => null,
          };
          const anchor = {
            href: 'https://rd6.zhaopin.com/resume/detail?resumeId=R654321',
            outerHTML: '<a data-resume-id="R654321" href="https://rd6.zhaopin.com/resume/detail?resumeId=R654321">李四</a>',
            textContent: '李四',
            getAttribute: (name: string) => (name === 'data-resume-id' ? 'R654321' : null),
            closest: () => container,
          };
          return fn([anchor as unknown as Element]);
        },
      };
    },
  } as never;

  const result = await zhilianAdapter.extractCandidateList(page);
  assert.deepEqual(result.candidates, [
    {
      candidateId: 'R654321',
      resumeUrl: 'https://rd6.zhaopin.com/resume/detail?resumeId=R654321',
      name: '李四',
      currentCompany: '上海测试科技有限公司',
      currentTitle: '海外销售经理',
      cardText: '李四 上海测试科技有限公司 海外销售经理',
      sourceText: 'https://rd6.zhaopin.com/resume/detail?resumeId=R654321 <a data-resume-id="R654321" href="https://rd6.zhaopin.com/resume/detail?resumeId=R654321">李四</a> <div>李四 上海测试科技有限公司 海外销售经理</div> 李四 上海测试科技有限公司 海外销售经理',
    },
  ]);
});

test('zhilian adapter treats an empty visible list as a successful zero-candidate extraction', async () => {
  const page = {
    url: () => 'https://rd6.zhaopin.com/app/search',
    waitForLoadState: async () => undefined,
    waitForFunction: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '智联招聘 招聘管理 职位管理 简历管理 候选人 搜索 暂无符合条件的人才',
        };
      }

      return {
        evaluateAll: async () => [],
      };
    },
  } as never;

  const result = await zhilianAdapter.extractCandidateList(page);
  assert.deepEqual(result, { candidates: [] });
});

test('zhilian adapter waits for the real talent search list response instead of unrelated search APIs', async () => {
  const unrelatedResponse = {
    url: () => 'https://rd6.zhaopin.com/api/talent/search/getQuickSearchConditions',
    status: () => 200,
    text: async () => JSON.stringify({
      code: 200,
      data: [{ id: 1, conditions: '{}' }],
    }),
  };
  const listResponse = {
    url: () => 'https://rd6.zhaopin.com/api/talent/search/list',
    status: () => 200,
    text: async () => JSON.stringify({
      code: 200,
      data: {
        list: [
          {
            userMasterId: 1236130414,
            userName: '李先生',
            resumeNumber: 'resume-no-1',
            resumeK: 'resume-k-1',
            resumeT: 'resume-t-1',
            workExperiences: [
              {
                companyName: '波司登羽绒服装',
                jobTitle: '门店店长',
              },
            ],
          },
        ],
      },
    }),
  };
  const page = {
    on: () => undefined,
    url: () => 'https://rd6.zhaopin.com/app/search',
    waitForLoadState: async () => undefined,
    waitForFunction: async () => undefined,
    waitForResponse: async (
      predicate: (response: { url(): string; status(): number }) => boolean,
    ) => {
      const responses = [unrelatedResponse, listResponse];
      const match = responses.find((response) => predicate(response));
      if (!match) {
        throw new Error('no matching response');
      }
      return match;
    },
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '智联招聘 搜索 人才管理 使用高级搜索 候选人',
        };
      }

      return {
        evaluateAll: async () => [],
      };
    },
  } as never;

  const result = await zhilianAdapter.extractCandidateList(page);
  assert.deepEqual(result.candidates, [
    {
      candidateId: '1236130414',
      resumeUrl: 'https://rd6.zhaopin.com/app/search?resumeNumber=resume-no-1',
      name: '李先生',
      currentCompany: '波司登羽绒服装',
      currentTitle: '门店店长',
      cardText: '李先生\n波司登羽绒服装\n门店店长',
      searchResultIndex: 0,
      sourceText: JSON.stringify({
        userMasterId: 1236130414,
        userName: '李先生',
        resumeNumber: 'resume-no-1',
        resumeK: 'resume-k-1',
        resumeT: 'resume-t-1',
        workExperiences: [
          {
            companyName: '波司登羽绒服装',
            jobTitle: '门店店长',
          },
        ],
      }),
    },
  ]);
});

test('zhilian adapter opens resume detail by clicking the matching result card when no resume link is exposed', async () => {
  const clickCalls: string[] = [];
  const searchPage = {
    url: () => 'https://rd6.zhaopin.com/app/search',
    waitForLoadState: async () => undefined,
    waitForFunction: async (predicate: () => boolean) => {
      const originalDocument = (globalThis as { document?: unknown }).document;
      try {
        (globalThis as { document?: unknown }).document = {
          body: {
            innerText: '工作经历 教育经历 项目经历 求职意向',
          },
          querySelector: (selector: string) => {
            if (selector === '.km-modal__wrapper.new-shortcut-resume__modal') {
              return { className: 'km-modal__wrapper new-shortcut-resume__modal' };
            }

            return null;
          },
        };
        if (!predicate()) {
          throw new Error('page.waitForFunction: Timeout 15000ms exceeded.');
        }
      } finally {
        (globalThis as { document?: unknown }).document = originalDocument;
      }
    },
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '智联招聘 搜索 人才管理 工作经历 教育经历 项目经历 求职意向',
        };
      }

      if (selector.includes('1236130414')) {
        return {
          first: () => ({
            waitFor: async () => {
              throw new Error('link-based locator should not match');
            },
            click: async () => {
              clickCalls.push('link');
            },
          }),
        };
      }

      if (selector === '.search-resume-item-wrap') {
        return {
          evaluateAll: async () => [
            {
              index: 0,
              text: '李先生 25岁 波司登羽绒服装 门店店长',
              html: '<div class="search-resume-item-wrap">李先生 波司登羽绒服装 门店店长</div>',
            },
          ],
          nth: (index: number) => ({
            click: async () => {
              clickCalls.push(`card:${index}`);
            },
          }),
        };
      }

      if (selector === '.search-resume-item-wrap .resume-item__content') {
        return {
          evaluateAll: async () => [
            {
              index: 0,
              text: '李先生 25岁 波司登羽绒服装 门店店长',
              html: '<div class="resume-item__content">李先生 波司登羽绒服装 门店店长</div>',
            },
          ],
          nth: (index: number) => ({
            click: async () => {
              clickCalls.push(`content:${index}`);
            },
          }),
        };
      }

      throw new Error(`unexpected selector: ${selector}`);
    },
  } as never;
  const context = {
    waitForEvent: async () => null,
  } as never;

  const detailPage = await zhilianAdapter.openResumeDetail(context, searchPage, {
    candidateId: '1236130414',
    name: '李先生',
    currentCompany: '波司登羽绒服装',
    currentTitle: '门店店长',
  });

  assert.equal(detailPage, searchPage);
  assert.deepEqual(clickCalls, ['content:0']);
});

test('zhilian adapter keeps resume detail in the current search page even when the candidate carries a resumeUrl', async () => {
  const clickCalls: string[] = [];
  const searchPage = {
    url: () => 'https://rd6.zhaopin.com/app/search?resumeNumber=resume-no-1',
    waitForLoadState: async () => undefined,
    waitForFunction: async (predicate: () => boolean) => {
      const originalDocument = (globalThis as { document?: unknown }).document;
      const originalWindow = (globalThis as { window?: unknown }).window;
      try {
        (globalThis as { document?: unknown }).document = {
          body: {
            innerText: [
              '智联招聘 搜索 人才管理',
              '黄先生',
              '要附件简历',
              '工作经历',
              '名创优品科技（广州）有限公司',
              '门店店长',
              '教育经历',
            ].join('\n'),
          },
          querySelector: (selector: string) => {
            if (selector === '.km-modal__wrapper.new-shortcut-resume__modal') {
              return { className: 'km-modal__wrapper new-shortcut-resume__modal' };
            }

            return null;
          },
        };
        (globalThis as { window?: unknown }).window = {
          location: {
            href: 'https://rd6.zhaopin.com/app/search?resumeNumber=resume-no-1',
          },
        };

        if (!predicate()) {
          throw new Error('page.waitForFunction: Timeout 15000ms exceeded.');
        }
      } finally {
        (globalThis as { document?: unknown }).document = originalDocument;
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    },
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => [
            '智联招聘 搜索 人才管理',
            '黄先生',
            '要附件简历',
            '工作经历',
            '名创优品科技（广州）有限公司',
            '门店店长',
            '教育经历',
          ].join('\n'),
        };
      }

      if (selector === '.search-resume-item-wrap .resume-item__content') {
        return {
          evaluateAll: async () => [
            {
              index: 0,
              text: '黄先生 24岁 名创优品科技 门店店长',
              html: '<div class="resume-item__content">黄先生 名创优品科技 门店店长</div>',
            },
          ],
          nth: (index: number) => ({
            click: async () => {
              clickCalls.push(`content:${index}`);
            },
          }),
        };
      }

      if (selector === '.search-resume-item-wrap') {
        return {
          evaluateAll: async () => [
            {
              index: 0,
              text: '黄先生 24岁 名创优品科技 门店店长',
              html: '<div class="search-resume-item-wrap">黄先生 名创优品科技 门店店长</div>',
            },
          ],
          nth: (index: number) => ({
            click: async () => {
              clickCalls.push(`card:${index}`);
            },
          }),
        };
      }

      throw new Error(`unexpected selector: ${selector}`);
    },
  } as never;
  const context = {
    newPage: async () => {
      throw new Error('newPage should not be called for Zhilian resume detail');
    },
    waitForEvent: async () => {
      throw new Error('waitForEvent should not be called for Zhilian resume detail');
    },
  } as never;

  const detailPage = await zhilianAdapter.openResumeDetail(context, searchPage, {
    candidateId: '1236130414',
    resumeUrl: 'https://rd6.zhaopin.com/app/search?resumeNumber=resume-no-1',
    name: '黄先生',
    currentCompany: '名创优品科技',
    currentTitle: '门店店长',
  });

  assert.equal(detailPage, searchPage);
  assert.deepEqual(clickCalls, ['content:0']);
});

test('zhilian adapter prefers clicking the result card over a matching resume link to avoid opening a new tab', async () => {
  const clickCalls: string[] = [];
  const searchPage = {
    url: () => 'https://rd6.zhaopin.com/app/search?resumeNumber=resume-no-1',
    waitForLoadState: async () => undefined,
    waitForFunction: async (predicate: () => boolean) => {
      const originalDocument = (globalThis as { document?: unknown }).document;
      const originalWindow = (globalThis as { window?: unknown }).window;
      try {
        (globalThis as { document?: unknown }).document = {
          body: {
            innerText: [
              '智联招聘 搜索 人才管理',
              '黄先生',
              '要附件简历',
              '工作经历',
              '名创优品科技（广州）有限公司',
              '门店店长',
              '教育经历',
            ].join('\n'),
          },
          querySelector: (selector: string) => {
            if (selector === '.km-modal__wrapper.new-shortcut-resume__modal') {
              return { className: 'km-modal__wrapper new-shortcut-resume__modal' };
            }

            return null;
          },
        };
        (globalThis as { window?: unknown }).window = {
          location: {
            href: 'https://rd6.zhaopin.com/app/search?resumeNumber=resume-no-1',
          },
        };

        if (!predicate()) {
          throw new Error('page.waitForFunction: Timeout 15000ms exceeded.');
        }
      } finally {
        (globalThis as { document?: unknown }).document = originalDocument;
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    },
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => [
            '智联招聘 搜索 人才管理',
            '黄先生',
            '要附件简历',
            '工作经历',
            '名创优品科技（广州）有限公司',
            '门店店长',
            '教育经历',
          ].join('\n'),
        };
      }

      if (selector.includes('1236130414')) {
        return {
          first: () => ({
            waitFor: async () => undefined,
            click: async () => {
              clickCalls.push('link');
            },
          }),
        };
      }

      if (selector === '.search-resume-item-wrap .resume-item__content') {
        return {
          evaluateAll: async () => [
            {
              index: 0,
              text: '黄先生 24岁 名创优品科技 门店店长',
              html: '<div class="resume-item__content">黄先生 名创优品科技 门店店长</div>',
            },
          ],
          nth: (index: number) => ({
            click: async () => {
              clickCalls.push(`content:${index}`);
            },
          }),
        };
      }

      if (selector === '.search-resume-item-wrap') {
        return {
          evaluateAll: async () => [
            {
              index: 0,
              text: '黄先生 24岁 名创优品科技 门店店长',
              html: '<div class="search-resume-item-wrap">黄先生 名创优品科技 门店店长</div>',
            },
          ],
          nth: (index: number) => ({
            click: async () => {
              clickCalls.push(`card:${index}`);
            },
          }),
        };
      }

      throw new Error(`unexpected selector: ${selector}`);
    },
  } as never;
  const context = {
    newPage: async () => {
      throw new Error('newPage should not be called for Zhilian resume detail');
    },
    waitForEvent: async () => {
      throw new Error('waitForEvent should not be called for Zhilian resume detail');
    },
  } as never;

  const detailPage = await zhilianAdapter.openResumeDetail(context, searchPage, {
    candidateId: '1236130414',
    resumeUrl: 'https://rd6.zhaopin.com/app/search?resumeNumber=resume-no-1',
    name: '黄先生',
    currentCompany: '名创优品科技',
    currentTitle: '门店店长',
  });

  assert.equal(detailPage, searchPage);
  assert.deepEqual(clickCalls, ['content:0']);
});

test('zhilian adapter closes an existing resume modal before clicking the next result card', async () => {
  const clickCalls: string[] = [];
  const searchPage = {
    url: () => 'https://rd6.zhaopin.com/app/search?resumeNumber=resume-no-2',
    waitForLoadState: async () => undefined,
    waitForFunction: async (predicate: () => boolean) => {
      const originalDocument = (globalThis as { document?: unknown }).document;
      const originalWindow = (globalThis as { window?: unknown }).window;
      try {
        (globalThis as { document?: unknown }).document = {
          body: {
            innerText: [
              '智联招聘 搜索 人才管理',
              '方女士',
              '要附件简历',
              '工作经历',
              '斐乐服饰',
              '店长',
              '教育经历',
            ].join('\n'),
          },
          querySelector: (selector: string) => {
            if (selector === '.km-modal__wrapper.new-shortcut-resume__modal') {
              return { className: 'km-modal__wrapper new-shortcut-resume__modal' };
            }

            return null;
          },
        };
        (globalThis as { window?: unknown }).window = {
          location: {
            href: 'https://rd6.zhaopin.com/app/search?resumeNumber=resume-no-2',
          },
        };

        if (!predicate()) {
          throw new Error('page.waitForFunction: Timeout 15000ms exceeded.');
        }
      } finally {
        (globalThis as { document?: unknown }).document = originalDocument;
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    },
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => [
            '智联招聘 搜索 人才管理',
            '方女士',
            '要附件简历',
            '工作经历',
            '斐乐服饰',
            '店长',
            '教育经历',
          ].join('\n'),
        };
      }

      if (selector === '.km-modal__wrapper.new-shortcut-resume__modal .km-modal__close, .km-modal__wrapper.new-shortcut-resume__modal [aria-label=\"关闭\"], .km-modal__wrapper.new-shortcut-resume__modal .ant-modal-close, .km-modal__wrapper.new-shortcut-resume__modal .close, .km-modal__wrapper.new-shortcut-resume__modal [class*=\"close\"]') {
        return {
          first: () => ({
            click: async () => {
              clickCalls.push('close-modal');
            },
          }),
        };
      }

      if (selector === '.search-resume-item-wrap .resume-item__content') {
        return {
          evaluateAll: async () => [
            {
              index: 0,
              text: '黄先生 24岁 名创优品科技 门店店长',
              html: '<div class="resume-item__content">黄先生 名创优品科技 门店店长</div>',
            },
            {
              index: 1,
              text: '方女士 31岁 斐乐服饰 店长',
              html: '<div class="resume-item__content">方女士 斐乐服饰 店长</div>',
            },
          ],
          nth: (index: number) => ({
            click: async () => {
              clickCalls.push(`content:${index}`);
            },
          }),
        };
      }

      if (selector === '.search-resume-item-wrap') {
        return {
          evaluateAll: async () => [
            {
              index: 0,
              text: '黄先生 24岁 名创优品科技 门店店长',
              html: '<div class="search-resume-item-wrap">黄先生 名创优品科技 门店店长</div>',
            },
            {
              index: 1,
              text: '方女士 31岁 斐乐服饰 店长',
              html: '<div class="search-resume-item-wrap">方女士 斐乐服饰 店长</div>',
            },
          ],
          nth: (index: number) => ({
            click: async () => {
              clickCalls.push(`card:${index}`);
            },
          }),
        };
      }

      throw new Error(`unexpected selector: ${selector}`);
    },
  } as never;
  const context = {} as never;

  const detailPage = await zhilianAdapter.openResumeDetail(context, searchPage, {
    candidateId: '1101693489',
    resumeUrl: 'https://rd6.zhaopin.com/app/search?resumeNumber=resume-no-2',
    name: '方女士',
    currentCompany: '斐乐服饰',
    currentTitle: '店长',
    searchResultIndex: 1,
  });

  assert.equal(detailPage, searchPage);
  assert.deepEqual(clickCalls, ['close-modal', 'content:1']);
});

test('zhilian adapter treats same-page modal resume detail as ready after clicking a result card', async () => {
  const clickCalls: string[] = [];
  const originalDocument = (globalThis as { document?: unknown }).document;
  const originalWindow = (globalThis as { window?: unknown }).window;
  const searchPage = {
    url: () => 'https://rd6.zhaopin.com/app/search?resumeNumber=resume-no-1',
    waitForLoadState: async () => undefined,
    waitForFunction: async (predicate: () => boolean) => {
      (globalThis as { document?: unknown }).document = {
        body: {
          innerText: [
            '智联招聘 搜索 人才管理',
            '黄先生',
            '要附件简历',
            '工作经历',
            '名创优品科技（广州）有限公司',
            '门店店长',
            '教育经历',
            '岳阳职业技术学院',
            '个人优势',
          ].join('\n'),
        },
        querySelector: (selector: string) => {
          if (selector === '.km-modal__wrapper.new-shortcut-resume__modal') {
            return { className: 'km-modal__wrapper new-shortcut-resume__modal' };
          }

          return null;
        },
        querySelectorAll: (selector: string) => {
          if (selector === '.km-modal__wrapper.new-shortcut-resume__modal') {
            return [{ className: 'km-modal__wrapper new-shortcut-resume__modal' }];
          }

          return [];
        },
      };
      (globalThis as { window?: unknown }).window = {
        location: {
          href: 'https://rd6.zhaopin.com/app/search?resumeNumber=resume-no-1',
        },
      };

      try {
        if (!predicate()) {
          throw new Error('page.waitForFunction: Timeout 15000ms exceeded.');
        }
      } finally {
        (globalThis as { document?: unknown }).document = originalDocument;
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    },
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => [
            '智联招聘 搜索 人才管理',
            '黄先生',
            '要附件简历',
            '工作经历',
            '名创优品科技（广州）有限公司',
            '门店店长',
            '教育经历',
            '岳阳职业技术学院',
            '个人优势',
          ].join('\n'),
        };
      }

      if (selector.includes('1236130414')) {
        return {
          first: () => ({
            waitFor: async () => {
              throw new Error('link-based locator should not match');
            },
            click: async () => {
              clickCalls.push('link');
            },
          }),
        };
      }

      if (selector === '.search-resume-item-wrap') {
        return {
          evaluateAll: async () => [
            {
              index: 0,
              text: '黄先生 24岁 名创优品科技 门店店长',
              html: '<div class="search-resume-item-wrap">黄先生 名创优品科技 门店店长</div>',
            },
          ],
          nth: (index: number) => ({
            click: async () => {
              clickCalls.push(`card:${index}`);
            },
          }),
        };
      }

      if (selector === '.search-resume-item-wrap .resume-item__content') {
        return {
          evaluateAll: async () => [
            {
              index: 0,
              text: '黄先生 24岁 名创优品科技 门店店长',
              html: '<div class="resume-item__content">黄先生 名创优品科技 门店店长</div>',
            },
          ],
          nth: (index: number) => ({
            click: async () => {
              clickCalls.push(`content:${index}`);
            },
          }),
        };
      }

      throw new Error(`unexpected selector: ${selector}`);
    },
  } as never;
  const context = {
    waitForEvent: async () => null,
  } as never;

  const detailPage = await zhilianAdapter.openResumeDetail(context, searchPage, {
    candidateId: '1236130414',
    name: '黄先生',
    currentCompany: '名创优品科技',
    currentTitle: '门店店长',
  });

  assert.equal(detailPage, searchPage);
  assert.deepEqual(clickCalls, ['content:0']);
});

test('zhilian adapter clicks the result content area instead of the outer card root for same-page resume detail', async () => {
  const clickCalls: string[] = [];
  const originalDocument = (globalThis as { document?: unknown }).document;
  const originalWindow = (globalThis as { window?: unknown }).window;
  const searchPage = {
    url: () => 'https://rd6.zhaopin.com/app/search?resumeNumber=resume-no-1',
    waitForLoadState: async () => undefined,
    waitForFunction: async (predicate: () => boolean) => {
      (globalThis as { document?: unknown }).document = {
        body: {
          innerText: [
            '智联招聘 搜索 人才管理',
            '黄先生',
            '要附件简历',
            '工作经历',
            '名创优品科技（广州）有限公司',
            '门店店长',
            '教育经历',
          ].join('\n'),
        },
        querySelector: (selector: string) => {
          if (selector === '.km-modal__wrapper.new-shortcut-resume__modal') {
            return { className: 'km-modal__wrapper new-shortcut-resume__modal' };
          }

          return null;
        },
      };
      (globalThis as { window?: unknown }).window = {
        location: {
          href: 'https://rd6.zhaopin.com/app/search?resumeNumber=resume-no-1',
        },
      };

      try {
        if (!predicate()) {
          throw new Error('page.waitForFunction: Timeout 15000ms exceeded.');
        }
      } finally {
        (globalThis as { document?: unknown }).document = originalDocument;
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    },
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => [
            '智联招聘 搜索 人才管理',
            '黄先生',
            '要附件简历',
            '工作经历',
            '名创优品科技（广州）有限公司',
            '门店店长',
            '教育经历',
          ].join('\n'),
        };
      }

      if (selector.includes('1236130414')) {
        return {
          first: () => ({
            waitFor: async () => {
              throw new Error('link-based locator should not match');
            },
            click: async () => {
              clickCalls.push('link');
            },
          }),
        };
      }

      if (selector === '.search-resume-item-wrap .resume-item__content') {
        return {
          evaluateAll: async () => [
            {
              index: 0,
              text: '黄先生 24岁 名创优品科技 门店店长',
              html: '<div class="resume-item__content">黄先生 名创优品科技 门店店长</div>',
            },
          ],
          nth: (index: number) => ({
            click: async () => {
              clickCalls.push(`content:${index}`);
            },
          }),
        };
      }

      if (selector === '.search-resume-item-wrap') {
        return {
          evaluateAll: async () => [
            {
              index: 0,
              text: '黄先生 24岁 名创优品科技 门店店长',
              html: '<div class="search-resume-item-wrap">黄先生 名创优品科技 门店店长</div>',
            },
          ],
          nth: (index: number) => ({
            click: async () => {
              clickCalls.push(`card:${index}`);
            },
          }),
        };
      }

      throw new Error(`unexpected selector: ${selector}`);
    },
  } as never;
  const context = {
    waitForEvent: async () => null,
  } as never;

  const detailPage = await zhilianAdapter.openResumeDetail(context, searchPage, {
    candidateId: '1236130414',
    name: '黄先生',
    currentCompany: '名创优品科技',
    currentTitle: '门店店长',
  });

  assert.equal(detailPage, searchPage);
  assert.deepEqual(clickCalls, ['content:0']);
});

test('zhilian resume parser preserves section text without inventing same-company sub-records', async () => {
  const page = {
    url: () => 'https://rd6.zhaopin.com/resume/detail?resumeId=R123456',
    waitForLoadState: async () => undefined,
    waitForFunction: async () => undefined,
    locator: () => ({
      waitFor: async () => undefined,
      innerText: async () => [
        '智联招聘 简历管理 候选人',
        '张三',
        '本科',
        '现居住地：上海',
        '工作经历',
        '2020.01-至今',
        '上海测试科技有限公司',
        '海外销售经理',
        '负责东南亚渠道开发',
        '教育经历',
        '2015.09-2019.06 上海大学 本科 国际贸易',
      ].join('\n'),
    }),
  } as never;

  const resume = await zhilianAdapter.parseResumeDetail(page, {
    candidateId: 'R123456',
    resumeUrl: 'https://rd6.zhaopin.com/resume/detail?resumeId=R123456',
    name: undefined,
    currentCompany: undefined,
    currentTitle: undefined,
  });

  assert.equal(resume.candidateId, 'R123456');
  assert.equal(resume.name, '张三');
  assert.equal(resume.education, '本科');
  assert.deepEqual(resume.regions, ['现居住地：上海']);
  assert.equal(resume.workExperiences.length, 1);
  assert.match(resume.workExperiences[0].details.join('\n'), /负责东南亚渠道开发/);
});

test('zhilian resume parser reads modal resume detail content instead of the underlying search list', async () => {
  const modalResumeText = [
    '黄先生',
    '要附件简历',
    '24岁 (2002年5月)',
    '3年',
    '大专',
    '现居上海 浦东新区',
    '求职期望',
    '[上海]',
    '门店店长',
    '7千-8千/月',
    '工作经历',
    '名创优品科技（广州）有限公司',
    '门店店长',
    '2024.03 - 至今 (2年 2个月)',
    '1.负责门店日常管理和员工管理',
    '教育经历',
    '岳阳职业技术学院',
    '2020.09 - 2023.06',
    '工业机器人技术',
    '大专',
    '个人优势',
    '勤奋好学有责任心，有较强的销售能力',
  ].join('\n');
  const page = {
    url: () => 'https://rd6.zhaopin.com/app/search?resumeNumber=resume-no-1',
    waitForLoadState: async () => undefined,
    waitForFunction: async () => undefined,
    locator: (selector: string) => {
      if (selector === '.km-modal__wrapper.new-shortcut-resume__modal') {
        return {
          first: () => ({
            innerText: async () => modalResumeText,
          }),
        };
      }

      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => [
            '智联招聘 搜索 人才管理',
            '李先生',
            '波司登羽绒服装',
            '门店店长',
            '方女士',
            '斐乐服饰',
            '店长',
            modalResumeText,
          ].join('\n'),
        };
      }

      throw new Error(`unexpected selector: ${selector}`);
    },
  } as never;

  const resume = await zhilianAdapter.parseResumeDetail(page, {
    candidateId: '1151819900',
    resumeUrl: 'https://rd6.zhaopin.com/app/search?resumeNumber=resume-no-1',
    name: undefined,
    currentCompany: undefined,
    currentTitle: undefined,
  });

  assert.equal(resume.candidateId, '1151819900');
  assert.equal(resume.name, '黄先生');
  assert.equal(resume.education, '大专');
  assert.match(resume.workExperiences[0].details.join('\n'), /名创优品科技（广州）有限公司/);
  assert.doesNotMatch(resume.workExperiences[0].details.join('\n'), /方女士/);
});
