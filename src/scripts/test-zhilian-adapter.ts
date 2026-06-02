import assert from 'node:assert/strict';
import test from 'node:test';

import { config } from '../config.js';
import { zhilianAdapter, zhilianTestExports } from '../platforms/zhilian-adapter.js';

const zhilianShareLinkSelector = [
  'input',
  'textarea',
  '[contenteditable="true"]',
  'a[href*="zhaopin.com"]',
  '[data-clipboard-text]',
  '[data-clipboard]',
  '[data-copy]',
  '[data-url]',
  '[title*="zhaopin.com"]',
].join(', ');

function restoreGlobalProperty(propertyName: 'window' | 'navigator' | 'document', originalDescriptor: PropertyDescriptor | undefined): void {
  if (originalDescriptor) {
    Object.defineProperty(globalThis, propertyName, originalDescriptor);
    return;
  }

  delete (globalThis as Record<string, unknown>)[propertyName];
}

function defineGlobalProperty(propertyName: 'window' | 'navigator' | 'document', value: unknown): () => void {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, propertyName);
  Object.defineProperty(globalThis, propertyName, {
    configurable: true,
    writable: true,
    value,
  });
  return () => restoreGlobalProperty(propertyName, originalDescriptor);
}

async function captureDateNow(fn: () => Promise<void>): Promise<void> {
  const originalDateNow = Date.now;
  try {
    await fn();
  } finally {
    Date.now = originalDateNow;
  }
}

function createZhilianShareLinkPageStubs(
  clickCalls: string[] = [],
  shareUrl = 'https://m.zhaopin.com/b/resume-package?zhaopinToken=share-token-from-copy',
) {
  let copiedText = '';
  let interceptedClipboardText = '';
  let clipboardInstalled = false;

  const clickVisibleText = async (pattern: RegExp) => {
    clickCalls.push(pattern.source);
    if (/复制链接|复制/.test(pattern.source)) {
      copiedText = shareUrl;
      interceptedClipboardText = shareUrl;
    }
  };

  return {
    keyboard: {
      press: async (key: string) => {
        clickCalls.push(`key:${key}`);
      },
    },
    context: () => ({
      grantPermissions: async () => undefined,
    }),
    evaluate: async <T>(callback: () => T | Promise<T>): Promise<T> => {
      const windowStub = {
        __autorecruitZhilianCopiedText: interceptedClipboardText,
        __autorecruitZhilianClipboardInstalled: clipboardInstalled,
        location: { href: 'https://rd6.zhaopin.com/app/search' },
        getSelection: () => ({ toString: () => '' }),
      };
      const navigatorStub = {
        clipboard: {
          readText: async () => copiedText,
          writeText: async (value: string) => {
            copiedText = value;
            interceptedClipboardText = value;
            windowStub.__autorecruitZhilianCopiedText = value;
          },
        },
      };
      const documentStub = {
        addEventListener: () => undefined,
      };
      const restoreWindow = defineGlobalProperty('window', windowStub);
      const restoreNavigator = defineGlobalProperty('navigator', navigatorStub);
      const restoreDocument = defineGlobalProperty('document', documentStub);

      try {
        return await callback();
      } finally {
        interceptedClipboardText = windowStub.__autorecruitZhilianCopiedText ?? '';
        clipboardInstalled = Boolean(windowStub.__autorecruitZhilianClipboardInstalled);
        restoreDocument();
        restoreNavigator();
        restoreWindow();
      }
    },
    getByText: (pattern: RegExp) => ({
      count: async () => 1,
      nth: () => ({
        isVisible: async () => true,
        click: async () => clickVisibleText(pattern),
      }),
      first: () => ({
        waitFor: async () => undefined,
        click: async () => clickVisibleText(pattern),
      }),
    }),
  };
}

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
  let quickSearchApplied = false;
  const page = {
    url: () => 'https://rd6.zhaopin.com/app/search',
    waitForLoadState: async () => undefined,
    waitForFunction: async () => undefined,
    waitForTimeout: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => quickSearchApplied
            ? '智联招聘 搜索 人才管理 快捷搜索 上海 优衣库 李宁 无印良品 关键词：优衣库'
            : '智联招聘 搜索 人才管理 快捷搜索 上海 优衣库 李宁 无印良品',
        };
      }

      return {
        filter: () => ({
          first: () => ({
            waitFor: async () => undefined,
            click: async () => {
              quickSearchApplied = true;
              clickCalls.push(selector);
            },
          }),
        }),
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
  } as never;

  await assert.doesNotReject(() => zhilianAdapter.openSubscribeSearch(page, '优衣库'));
  assert.deepEqual(clickCalls, ['.search-quick-search-new__content-item']);
});

test('zhilian adapter detects whether saved quick-search conditions are active', () => {
  assert.equal(
    zhilianTestExports.hasAppliedZhilianQuickSearchKeyword(
      '快捷搜索 上海 | 优衣库 李宁 关键词：优衣库 李宁 学历要求：大专及以上 未看过',
      '优衣库',
    ),
    true,
  );
  assert.equal(
    zhilianTestExports.hasAppliedZhilianQuickSearchKeyword(
      '快捷搜索 上海 | 优衣库 李宁 学历要求：大专及以上 未看过',
      '优衣库',
    ),
    false,
  );
});

function createZhilianUnviewedFilterPageStub(options: { unviewedChecked: boolean }) {
  const clickCalls: string[] = [];
  const waitForTimeoutCalls: number[] = [];
  let unviewedChecked = options.unviewedChecked;
  let quickSearchApplied = false;
  let now = 1000;

  const unviewedFilterLocator = {
    waitFor: async () => undefined,
    evaluate: async (callback: (element: HTMLElement) => boolean) => {
      const restoreHTMLElement = defineGlobalProperty('window', {});
      const originalHTMLElement = (globalThis as { HTMLElement?: unknown }).HTMLElement;
      const originalHTMLInputElement = (globalThis as { HTMLInputElement?: unknown }).HTMLInputElement;
      class HTMLElementStub {
        className: string;
        constructor(className: string) {
          this.className = className;
        }

        closest() {
          return this;
        }

        querySelector() {
          return null;
        }

        getAttribute() {
          return null;
        }
      }

      Object.defineProperty(globalThis, 'HTMLElement', {
        configurable: true,
        writable: true,
        value: HTMLElementStub,
      });
      Object.defineProperty(globalThis, 'HTMLInputElement', {
        configurable: true,
        writable: true,
        value: class HTMLInputElementStub {},
      });

      try {
        return callback(new HTMLElementStub(unviewedChecked ? 'km-checkbox km-checkbox--checked' : 'km-checkbox') as unknown as HTMLElement);
      } finally {
        if (originalHTMLElement === undefined) {
          delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
        } else {
          Object.defineProperty(globalThis, 'HTMLElement', {
            configurable: true,
            writable: true,
            value: originalHTMLElement,
          });
        }

        if (originalHTMLInputElement === undefined) {
          delete (globalThis as { HTMLInputElement?: unknown }).HTMLInputElement;
        } else {
          Object.defineProperty(globalThis, 'HTMLInputElement', {
            configurable: true,
            writable: true,
            value: originalHTMLInputElement,
          });
        }

        restoreHTMLElement();
      }
    },
    click: async () => {
      clickCalls.push('未看过');
      unviewedChecked = false;
    },
  };
  const unviewedFilterListLocator = {
    filter: () => unviewedFilterListLocator,
    first: () => unviewedFilterLocator,
  };

  const page = {
    url: () => 'https://rd6.zhaopin.com/app/search',
    waitForLoadState: async () => undefined,
    waitForFunction: async () => undefined,
    waitForTimeout: async (timeout: number) => {
      waitForTimeoutCalls.push(timeout);
      now += timeout;
    },
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => quickSearchApplied
            ? '智联招聘 搜索 人才管理 快捷搜索 上海 优衣库 未看过 未聊过 关键词：优衣库'
            : '智联招聘 搜索 人才管理 快捷搜索 上海 优衣库 未看过 未聊过',
        };
      }

      if (selector.includes('未看过')) {
        return unviewedFilterListLocator;
      }

      if (selector.includes('未聊过')) {
        throw new Error('未聊过 should not be targeted when clearing viewed candidates');
      }

      return {
        filter: () => ({
          first: () => ({
            waitFor: async () => undefined,
            click: async () => {
              clickCalls.push('优衣库');
              quickSearchApplied = true;
              unviewedChecked = true;
            },
          }),
        }),
        evaluateAll: async () => [],
      };
    },
  } as never;

  return {
    page,
    getClickCalls: () => clickCalls,
    getWaitForTimeoutCalls: () => waitForTimeoutCalls,
    isUnviewedChecked: () => unviewedChecked,
    setDateNow: () => {
      Date.now = () => now;
    },
  };
}

test('zhilian adapter keeps the unviewed filter by default after opening saved search results', async () => {
  const stub = createZhilianUnviewedFilterPageStub({ unviewedChecked: true });

  await assert.doesNotReject(() => zhilianAdapter.openSubscribeSearch(stub.page, '优衣库'));

  assert.deepEqual(stub.getClickCalls(), ['优衣库']);
  assert.equal(stub.isUnviewedChecked(), true);
});

test('zhilian adapter clears only 未看过 when viewed candidates are explicitly included', async () => {
  const stub = createZhilianUnviewedFilterPageStub({ unviewedChecked: true });

  await captureDateNow(async () => {
    stub.setDateNow();
    await zhilianAdapter.openSubscribeSearch(stub.page, '优衣库', {
      deadline: Date.now() + 5000,
      includeViewedCandidates: true,
    });
  });

  assert.deepEqual(stub.getClickCalls(), ['优衣库', '未看过']);
  assert.equal(stub.isUnviewedChecked(), false);
  assert.ok(stub.getWaitForTimeoutCalls().length > 0);
});

test('zhilian search-subscription prepares the saved quick-search tag instead of replacing it with keyword input', async () => {
  const clickCalls: string[] = [];
  let quickSearchApplied = false;
  const page = {
    url: () => 'https://rd6.zhaopin.com/app/search',
    waitForLoadState: async () => undefined,
    waitForFunction: async () => undefined,
    waitForTimeout: async () => undefined,
    getByText: () => ({
      first: () => ({
        waitFor: async () => {
          throw new Error('advanced-search action is optional in this stub');
        },
      }),
    }),
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => quickSearchApplied
            ? '智联招聘 搜索 人才管理 快捷搜索 上海 优衣库 李宁 关键词：优衣库 李宁 未看过 未聊过'
            : '智联招聘 搜索 人才管理 快捷搜索 上海 优衣库 李宁',
        };
      }

      if (/input|button/.test(selector)) {
        return {
          first: () => ({
            waitFor: async () => {
              throw new Error(`search-subscription should not use raw keyword search selector: ${selector}`);
            },
            fill: async () => {
              throw new Error(`search-subscription should not fill raw keyword search selector: ${selector}`);
            },
            click: async () => {
              throw new Error(`search-subscription should not click raw keyword search selector: ${selector}`);
            },
          }),
          filter: () => ({
            first: () => ({
              waitFor: async () => {
                throw new Error(`search-subscription should not use raw keyword search selector: ${selector}`);
              },
            }),
          }),
        };
      }

      return {
        filter: () => ({
          first: () => ({
            waitFor: async () => undefined,
            click: async () => {
              clickCalls.push('quick-search');
              quickSearchApplied = true;
            },
          }),
        }),
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;

  await assert.doesNotReject(() => zhilianTestExports.prepareZhilianSearchConditionPage(page, '优衣库', {
    deadline: Date.now() + 5000,
  }));
  assert.deepEqual(clickCalls, ['quick-search']);
});

test('zhilian search-subscription reads explicit empty-result text as zero candidates', async () => {
  const page = {
    locator: (selector: string) => {
      assert.equal(selector, 'body');
      return {
        innerText: async () => '关键词：优衣库 未看过 未聊过 没有符合条件的人才 请修改搜索条件后再试',
      };
    },
  } as never;

  assert.deepEqual(
    await zhilianTestExports.readZhilianSearchConditionResultTotal(page),
    { resultTotal: 0, resultTotalSource: 'page' },
  );
});

test('zhilian adapter fails when no saved quick-search tag contains the raw keyword', async () => {
  const page = {
    url: () => 'https://rd6.zhaopin.com/app/search',
    waitForLoadState: async () => undefined,
    waitForFunction: async () => undefined,
    waitForTimeout: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '智联招聘 搜索 人才管理 快捷搜索 上海 优衣库 李宁 无印良品 猜你想搜 销售 课程顾问 招聘',
        };
      }

      return {
        filter: () => ({
          first: () => ({
            waitFor: async () => {
              throw new Error(`tag selector did not match: ${selector}`);
            },
          }),
        }),
        first: () => ({
          waitFor: async () => {
            throw new Error(`tag selector did not match: ${selector}`);
          },
        }),
      };
    },
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

test('zhilian adapter extracts candidate cards from Vue props when no resume links are exposed', () => {
  const candidates = zhilianTestExports.parseZhilianVueCandidateSnapshots([
    {
      rawText: '石女士\n23岁\n1年\n本科\n斐乐\n店长',
      containerOuterHtml: '<div class="search-resume-item-wrap">石女士 斐乐 店长</div>',
      candidate: {
        userMasterId: 1257585175,
        userName: '石女士',
        resumeNumber: 'yISBw6q(6hVzPPyKfEn(LTkV6flsN2rQ',
        resumeK: '2EE082F722425F6EF874282781E179D6',
        resumeT: '1780239013348',
        workExperiences: [
          {
            companyName: '斐乐',
            jobTitle: '店长',
          },
        ],
      },
    },
  ]);

  assert.deepEqual(candidates, [
    {
      candidateId: '1257585175',
      resumeUrl: 'https://rd6.zhaopin.com/app/search?resumeNumber=yISBw6q(6hVzPPyKfEn(LTkV6flsN2rQ',
      name: '石女士',
      currentCompany: '斐乐',
      currentTitle: '店长',
      cardText: '石女士 23岁 1年 本科 斐乐 店长',
      searchResultIndex: 0,
      sourceText: JSON.stringify({
        userMasterId: 1257585175,
        userName: '石女士',
        resumeNumber: 'yISBw6q(6hVzPPyKfEn(LTkV6flsN2rQ',
        resumeK: '2EE082F722425F6EF874282781E179D6',
        resumeT: '1780239013348',
        workExperiences: [
          {
            companyName: '斐乐',
            jobTitle: '店长',
          },
        ],
      }),
    },
  ]);
});

test('zhilian adapter returns DOM candidates without waiting for the candidate API', async () => {
  let waitForResponseCalls = 0;
  const page = {
    url: () => 'https://rd6.zhaopin.com/app/search',
    waitForLoadState: async () => undefined,
    waitForFunction: async () => undefined,
    waitForResponse: async () => {
      waitForResponseCalls += 1;
      throw new Error('candidate API should not block DOM results');
    },
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

  const result = await zhilianAdapter.extractCandidateList(page, { deadline: Date.now() + 1000 });

  assert.deepEqual(result.candidates.map((candidate) => candidate.candidateId), ['R654321']);
  assert.equal(waitForResponseCalls, 0);
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
      options?: { timeout?: number },
    ) => {
      assert.ok(options?.timeout !== undefined && options.timeout > 0 && options.timeout <= config.playwright.searchPageTimeoutMs);
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

test('zhilian adapter uses the shared deadline for shell and quick-search tag waits', async () => {
  const observedShellTimeouts: number[] = [];
  const observedTagTimeouts: number[] = [];
  let quickSearchApplied = false;
  const page = {
    url: () => 'https://rd6.zhaopin.com/app/search',
    waitForLoadState: async () => undefined,
    waitForFunction: async (_predicate: () => boolean, _arg: unknown, options?: { timeout?: number }) => {
      observedShellTimeouts.push(options?.timeout ?? 0);
    },
    waitForTimeout: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => quickSearchApplied
            ? '智联招聘 搜索 人才管理 快捷搜索 上海 优衣库 关键词：优衣库'
            : '智联招聘 搜索 人才管理 快捷搜索 上海 优衣库',
        };
      }

      return {
        filter: () => ({
          first: () => ({
            waitFor: async (options?: { timeout?: number }) => {
              observedTagTimeouts.push(options?.timeout ?? 0);
            },
            click: async () => {
              quickSearchApplied = true;
            },
          }),
        }),
        evaluateAll: async () => [],
      };
    },
  } as never;

  await zhilianAdapter.openSubscribeSearch(page, '优衣库', { deadline: Date.now() + 1000 });

  assert.ok(observedShellTimeouts.every((timeout) => timeout > 0 && timeout <= 1000));
  assert.ok(observedTagTimeouts.every((timeout) => timeout > 0 && timeout <= 1000));
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
  const shareLinkStubs = createZhilianShareLinkPageStubs();
  const page = {
    ...shareLinkStubs,
    url: () => 'https://rd6.zhaopin.com/resume/detail?resumeId=R123456',
    waitForLoadState: async () => undefined,
    waitForFunction: async () => undefined,
    locator: (selector: string) => {
      if (selector === zhilianShareLinkSelector) {
        return {
          evaluateAll: async () => [],
        };
      }

      return {
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
      };
    },
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
  const shareLinkStubs = createZhilianShareLinkPageStubs();
  const page = {
    ...shareLinkStubs,
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

      if (selector === zhilianShareLinkSelector) {
        return {
          evaluateAll: async () => [],
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

test('zhilian resume parser copies colleague-forward share links', async () => {
  const modalResumeText = [
    '黄先生',
    '要附件简历',
    '大专',
    '工作经历',
    '名创优品科技（广州）有限公司',
    '门店店长',
    '教育经历',
    '岳阳职业技术学院',
  ].join('\n');
  const clickCalls: string[] = [];
  const shareLinkStubs = createZhilianShareLinkPageStubs(clickCalls);
  const page = {
    ...shareLinkStubs,
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

      if (selector === zhilianShareLinkSelector) {
        return {
          evaluateAll: async () => [],
        };
      }

      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => `智联招聘 搜索 人才管理\n${modalResumeText}`,
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

  assert.equal(resume.candidateShareUrl, 'https://m.zhaopin.com/b/resume-package?zhaopinToken=share-token-from-copy');
  assert.deepEqual(clickCalls, ['转给同事', '链接转发', '复制链接|复制', 'key:Escape']);
});
