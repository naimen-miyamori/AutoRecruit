import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { config } from '../config.js';
import { liepinAdapter } from '../platforms/liepin-adapter.js';

function runInIsolatedPageContext<TArg, TResult>(fn: (arg: TArg) => TResult, arg: TArg): TResult {
  return vm.runInNewContext(`(${fn.toString()})(arg)`, { arg }) as TResult;
}

const liepinSearchReadyText = '搜简历 搜索条件 人才搜索 快捷搜索 优衣库 订阅 隐藏已查看';

function liepinHideViewedState(checked = true, bodyText = liepinSearchReadyText) {
  return {
    found: true,
    checked,
    clickSelector: '#hide-viewed',
    bodyText,
  };
}

test('liepin adapter clicks the matching Liepin quick-search tag before treating search as ready', async () => {
  const clickCalls: string[] = [];
  const gotoCalls: Array<{ url: string; waitUntil?: string }> = [];
  const page = {
    goto: async (url: string, options?: { waitUntil?: string }) => {
      gotoCalls.push({ url, waitUntil: options?.waitUntil });
    },
    url: () => 'https://h.liepin.com/search/getConditionItem?key=%E4%BC%98%E8%A1%A3%E5%BA%93',
    waitForLoadState: async () => undefined,
    waitForResponse: async () => undefined,
    waitForFunction: async () => undefined,
    evaluate: async () => liepinHideViewedState(true),
    getByText: (text: string, options?: { exact?: boolean }) => {
      assert.equal(text, '优衣库');
      assert.equal(options?.exact, true);
      return {
        first: () => ({
          waitFor: async () => undefined,
          click: async () => {
            clickCalls.push(text);
          },
        }),
      };
    },
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => liepinSearchReadyText,
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;

  await assert.doesNotReject(() => liepinAdapter.openSubscribeSearch(page, '优衣库'));
  assert.deepStrictEqual(gotoCalls, []);
  assert.deepStrictEqual(clickCalls, ['优衣库']);
});

test('liepin adapter enables hide-viewed after clicking the quick-search tag and waits for final readiness', async () => {
  const calls: string[] = [];
  let hideViewedChecked = false;
  const page = {
    goto: async () => undefined,
    url: () => 'https://h.liepin.com/search/getConditionItem?key=%E4%BC%98%E8%A1%A3%E5%BA%93',
    waitForLoadState: async () => undefined,
    waitForResponse: async () => undefined,
    waitForFunction: async () => {
      calls.push('ready');
    },
    evaluate: async () => liepinHideViewedState(hideViewedChecked),
    getByText: (text: string, options?: { exact?: boolean }) => {
      assert.equal(text, '优衣库');
      assert.equal(options?.exact, true);
      return {
        first: () => ({
          waitFor: async () => undefined,
          click: async () => {
            calls.push('quick-search');
          },
        }),
      };
    },
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => liepinSearchReadyText,
        };
      }

      if (selector === '#hide-viewed') {
        return {
          first: () => ({
            waitFor: async () => undefined,
            click: async () => {
              hideViewedChecked = true;
              calls.push('hide-viewed');
            },
          }),
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;

  await assert.doesNotReject(() => liepinAdapter.openSubscribeSearch(page, '优衣库'));
  assert.deepStrictEqual(calls, ['ready', 'quick-search', 'ready', 'hide-viewed', 'ready']);
});

test('liepin adapter clicks the search button when hide-viewed is only available on the results list', async () => {
  const calls: string[] = [];
  let resultListVisible = false;
  let hideViewedChecked = false;
  const page = {
    goto: async () => undefined,
    url: () => 'https://h.liepin.com/search/getConditionItem?key=%E4%BC%98%E8%A1%A3%E5%BA%93',
    waitForLoadState: async () => undefined,
    waitForResponse: async () => undefined,
    waitForFunction: async () => {
      calls.push('ready');
    },
    evaluate: async () => resultListVisible
      ? liepinHideViewedState(hideViewedChecked)
      : {
        found: false,
        checked: false,
        searchButtonSelector: '#search-button',
        bodyText: '搜简历 搜索条件 人才搜索 快捷搜索 优衣库 订阅 搜 索',
      },
    getByText: () => ({
      first: () => ({
        waitFor: async () => undefined,
        click: async () => {
          calls.push('quick-search');
        },
      }),
    }),
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => resultListVisible ? liepinSearchReadyText : '搜简历 搜索条件 人才搜索 快捷搜索 优衣库 订阅 搜 索',
        };
      }

      if (selector === '#search-button') {
        return {
          first: () => ({
            waitFor: async () => undefined,
            click: async () => {
              resultListVisible = true;
              calls.push('search-button');
            },
          }),
        };
      }

      if (selector === '#hide-viewed') {
        return {
          first: () => ({
            waitFor: async () => undefined,
            click: async () => {
              hideViewedChecked = true;
              calls.push('hide-viewed');
            },
          }),
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;

  await assert.doesNotReject(() => liepinAdapter.openSubscribeSearch(page, '优衣库'));
  assert.deepStrictEqual(calls, ['ready', 'quick-search', 'ready', 'search-button', 'ready', 'hide-viewed', 'ready']);
});

test('liepin adapter does not click hide-viewed again when it is already checked', async () => {
  const calls: string[] = [];
  const page = {
    goto: async () => undefined,
    url: () => 'https://h.liepin.com/search/getConditionItem?key=%E4%BC%98%E8%A1%A3%E5%BA%93',
    waitForLoadState: async () => undefined,
    waitForResponse: async () => undefined,
    waitForFunction: async () => {
      calls.push('ready');
    },
    evaluate: async () => liepinHideViewedState(true),
    getByText: () => ({
      first: () => ({
        waitFor: async () => undefined,
        click: async () => {
          calls.push('quick-search');
        },
      }),
    }),
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => liepinSearchReadyText,
        };
      }

      if (selector === '#hide-viewed') {
        return {
          first: () => ({
            waitFor: async () => undefined,
            click: async () => {
              calls.push('hide-viewed');
            },
          }),
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;

  await assert.doesNotReject(() => liepinAdapter.openSubscribeSearch(page, '优衣库'));
  assert.deepStrictEqual(calls, ['ready', 'quick-search', 'ready', 'ready']);
});

test('liepin adapter discards quick-search search-resumes responses before hide-viewed is applied', async () => {
  let responseListener: ((response: { url(): string; status(): number; text(): string }) => void) | undefined;
  let resultListVisible = false;
  let hideViewedChecked = false;
  const makeSearchResponse = (candidateId: string) => ({
    url: () => 'https://api-h.liepin.com/api/com.liepin.searchfront4r.h.search-resumes',
    status: () => 200,
    request: () => ({
      timing: () => ({ startTime: Date.now() + 1 }),
    }),
    text: () => JSON.stringify({
      data: {
        resList: [
          {
            resIdEncode: candidateId,
            resName: candidateId,
            detailUrl: `/resume/showresumedetail/?res_id_encode=${candidateId}`,
          },
        ],
      },
    }),
  });
  const page = {
    goto: async () => undefined,
    url: () => 'https://h.liepin.com/search/getConditionItem?key=%E4%BC%98%E8%A1%A3%E5%BA%93',
    waitForLoadState: async () => undefined,
    waitForFunction: async () => undefined,
    on: (event: string, listener: (response: { url(): string; status(): number; text(): string }) => void) => {
      assert.equal(event, 'response');
      responseListener = listener;
    },
    evaluate: async () => resultListVisible
      ? liepinHideViewedState(hideViewedChecked)
      : {
        found: false,
        checked: false,
        searchButtonSelector: '#search-button',
        bodyText: '搜简历 搜索条件 人才搜索 快捷搜索 优衣库 订阅 搜 索',
      },
    getByText: () => ({
      first: () => ({
        waitFor: async () => undefined,
        click: async () => {
          responseListener?.(makeSearchResponse('stale-candidate'));
        },
      }),
    }),
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => resultListVisible
            ? '搜简历 搜索条件 人才搜索 快捷搜索 优衣库 隐藏已查看 共1位人选'
            : '搜简历 搜索条件 人才搜索 快捷搜索 优衣库 订阅 搜 索',
        };
      }

      if (selector === '#search-button') {
        return {
          first: () => ({
            waitFor: async () => undefined,
            click: async () => {
              resultListVisible = true;
            },
          }),
        };
      }

      if (selector === '#hide-viewed') {
        return {
          first: () => ({
            waitFor: async () => undefined,
            click: async () => {
              hideViewedChecked = true;
              responseListener?.(makeSearchResponse('filtered-candidate'));
            },
          }),
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
        evaluateAll: async () => [],
      };
    },
  } as never;

  const searchPage = await liepinAdapter.openSubscribeSearch(page, '优衣库');
  const result = await liepinAdapter.extractCandidateList(searchPage);

  assert.deepStrictEqual(result.candidates.map((candidate) => candidate.candidateId), ['filtered-candidate']);
});

test('liepin adapter ignores delayed pre-filter search-resumes responses after hide-viewed is clicked', async () => {
  let responseListener: ((response: { url(): string; status(): number; text(): string; request(): { timing(): { startTime: number } } }) => void) | undefined;
  let resultListVisible = false;
  let hideViewedChecked = false;
  const makeSearchResponse = (candidateId: string, startTime: number) => ({
    url: () => 'https://api-h.liepin.com/api/com.liepin.searchfront4r.h.search-resumes',
    status: () => 200,
    request: () => ({
      timing: () => ({ startTime }),
    }),
    text: () => JSON.stringify({
      data: {
        resList: [
          {
            resIdEncode: candidateId,
            resName: candidateId,
            detailUrl: `/resume/showresumedetail/?res_id_encode=${candidateId}`,
          },
        ],
      },
    }),
  });
  const page = {
    goto: async () => undefined,
    url: () => 'https://h.liepin.com/search/getConditionItem?key=%E4%BC%98%E8%A1%A3%E5%BA%93',
    waitForLoadState: async () => undefined,
    waitForFunction: async () => undefined,
    waitForResponse: async (
      predicate: (response: { url(): string; status(): number; text(): string; request(): { timing(): { startTime: number } } }) => boolean,
    ) => {
      const staleResponse = makeSearchResponse('late-stale-candidate', 100);
      responseListener?.(staleResponse);
      assert.equal(predicate(staleResponse), false);

      const filteredResponse = makeSearchResponse('filtered-candidate', Date.now() + 1);
      responseListener?.(filteredResponse);
      return predicate(filteredResponse) ? filteredResponse : Promise.reject(new Error('filtered response was rejected'));
    },
    on: (event: string, listener: (response: { url(): string; status(): number; text(): string; request(): { timing(): { startTime: number } } }) => void) => {
      assert.equal(event, 'response');
      responseListener = listener;
    },
    evaluate: async () => resultListVisible
      ? liepinHideViewedState(hideViewedChecked)
      : {
        found: false,
        checked: false,
        searchButtonSelector: '#search-button',
        bodyText: '搜简历 搜索条件 人才搜索 快捷搜索 优衣库 订阅 搜 索',
      },
    getByText: () => ({
      first: () => ({
        waitFor: async () => undefined,
        click: async () => {
          responseListener?.(makeSearchResponse('quick-search-stale-candidate', 50));
        },
      }),
    }),
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => resultListVisible
            ? '搜简历 搜索条件 人才搜索 快捷搜索 优衣库 隐藏已查看 共1位人选'
            : '搜简历 搜索条件 人才搜索 快捷搜索 优衣库 订阅 搜 索',
        };
      }

      if (selector === '#search-button') {
        return {
          first: () => ({
            waitFor: async () => undefined,
            click: async () => {
              resultListVisible = true;
            },
          }),
        };
      }

      if (selector === '#hide-viewed') {
        return {
          first: () => ({
            waitFor: async () => undefined,
            click: async () => {
              hideViewedChecked = true;
            },
          }),
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
        evaluateAll: async () => [],
      };
    },
  } as never;

  const searchPage = await liepinAdapter.openSubscribeSearch(page, '优衣库');
  const result = await liepinAdapter.extractCandidateList(searchPage);

  assert.deepStrictEqual(result.candidates.map((candidate) => candidate.candidateId), ['filtered-candidate']);
});

test('liepin adapter rejects with diagnostic page text when hide-viewed is missing', async () => {
  const page = {
    goto: async () => undefined,
    url: () => 'https://h.liepin.com/search/getConditionItem?key=%E4%BC%98%E8%A1%A3%E5%BA%93',
    waitForLoadState: async () => undefined,
    waitForResponse: async () => undefined,
    waitForFunction: async () => undefined,
    evaluate: async () => ({
      found: false,
      checked: false,
      bodyText: '搜简历 搜索条件 人才搜索 快捷搜索 优衣库 订阅 目前城市 不限',
    }),
    getByText: () => ({
      first: () => ({
        waitFor: async () => undefined,
        click: async () => undefined,
      }),
    }),
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '搜简历 搜索条件 人才搜索 快捷搜索 优衣库 订阅 目前城市 不限',
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;

  await assert.rejects(
    () => liepinAdapter.openSubscribeSearch(page, '优衣库'),
    /Could not find Liepin "隐藏已查看" filter\. Page text: 搜简历 搜索条件 人才搜索 快捷搜索 优衣库 订阅 目前城市 不限/,
  );
});

test('liepin adapter rejects when quick-search click does not lead to refreshed ready state', async () => {
  let readyCalls = 0;
  const page = {
    goto: async () => undefined,
    url: () => 'https://h.liepin.com/search/getConditionItem?key=%E4%BC%98%E8%A1%A3%E5%BA%93',
    waitForLoadState: async () => undefined,
    waitForResponse: async () => undefined,
    waitForFunction: async () => {
      readyCalls += 1;
      if (readyCalls >= 2) {
        throw new Error('refreshed ready state never arrived');
      }
    },
    getByText: () => ({
      first: () => ({
        waitFor: async () => undefined,
        click: async () => undefined,
      }),
    }),
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '搜简历 搜索条件 人才搜索 快捷搜索 优衣库 订阅',
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;

  await assert.rejects(() => liepinAdapter.openSubscribeSearch(page, '优衣库'), /refreshed ready state never arrived/);
});

test('liepin adapter opens the recruiter authenticated search home instead of the public jobs page when not already on a recruiter search page', async () => {
  const gotoCalls: Array<{ url: string; waitUntil?: string }> = [];
  const clickCalls: string[] = [];
  const page = {
    goto: async (url: string, options?: { waitUntil?: string }) => {
      gotoCalls.push({ url, waitUntil: options?.waitUntil });
    },
    url: () => 'about:blank',
    waitForLoadState: async () => undefined,
    waitForResponse: async () => undefined,
    waitForFunction: async () => undefined,
    evaluate: async () => liepinHideViewedState(true),
    getByText: (text: string, options?: { exact?: boolean }) => {
      assert.equal(text, '优衣库');
      assert.equal(options?.exact, true);
      return {
        first: () => ({
          waitFor: async () => undefined,
          click: async () => {
            clickCalls.push(text);
          },
        }),
      };
    },
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => liepinSearchReadyText,
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;

  await assert.doesNotReject(() => liepinAdapter.openSubscribeSearch(page, '优衣库'));
  assert.deepStrictEqual(gotoCalls, [{ url: 'https://h.liepin.com/search/getConditionItem', waitUntil: 'domcontentloaded' }]);
  assert.deepStrictEqual(clickCalls, ['优衣库']);
});

test('liepin adapter waits for the initial-data API before treating search as ready', async () => {
  const responseUrls: string[] = [];
  const page = {
    goto: async () => undefined,
    url: () => 'https://h.liepin.com/search/getConditionItem?key=%E4%BC%98%E8%A1%A3%E5%BA%93',
    waitForLoadState: async () => undefined,
    waitForResponse: async (predicate: (response: { url(): string; status(): number }) => boolean, options?: { timeout?: number }) => {
      assert.ok(options?.timeout !== undefined && options.timeout > 0 && options.timeout <= config.playwright.searchPageTimeoutMs);
      const response = {
        url: () => 'https://api-h.liepin.com/api/com.liepin.recruitbff.clt.search.get-initial-data',
        status: () => 200,
      };
      responseUrls.push(response.url());
      assert.equal(predicate(response), true);
    },
    waitForFunction: async () => undefined,
    evaluate: async () => liepinHideViewedState(true),
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => liepinSearchReadyText,
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;

  await assert.doesNotReject(() => liepinAdapter.openSubscribeSearch(page, '优衣库'));
  assert.deepStrictEqual(responseUrls, [
    'https://api-h.liepin.com/api/com.liepin.recruitbff.clt.search.get-initial-data',
    'https://api-h.liepin.com/api/com.liepin.recruitbff.clt.search.get-initial-data',
    'https://api-h.liepin.com/api/com.liepin.recruitbff.clt.search.get-initial-data',
  ]);
});

test('liepin adapter tolerates a missing initial-data response when the recruiter shell is already ready', async () => {
  const page = {
    goto: async () => undefined,
    url: () => 'https://h.liepin.com/search/getConditionItem?key=%E4%BC%98%E8%A1%A3%E5%BA%93',
    waitForLoadState: async () => undefined,
    waitForResponse: async () => {
      throw new Error('initial-data timeout');
    },
    waitForFunction: async () => undefined,
    evaluate: async () => liepinHideViewedState(true),
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => liepinSearchReadyText,
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;

  await assert.doesNotReject(() => liepinAdapter.openSubscribeSearch(page, '优衣库'));
});

test('liepin adapter rejects login fallback before surfacing an initial-data timeout', async () => {
  let currentUrl = 'https://h.liepin.com/search/getConditionItem?key=%E4%BC%98%E8%A1%A3%E5%BA%93';
  let bodyText = '搜简历 搜索条件 人才搜索 快捷搜索 优衣库 订阅';
  const page = {
    goto: async () => undefined,
    url: () => currentUrl,
    waitForLoadState: async () => undefined,
    waitForResponse: async () => {
      currentUrl = 'https://h.liepin.com/account/login';
      bodyText = '猎聘\n立即登录/注册\n密码登录';
      throw new Error('initial-data timeout');
    },
    waitForFunction: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => bodyText,
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;

  await assert.rejects(
    () => liepinAdapter.openSubscribeSearch(page, '优衣库'),
    /Liepin authenticated page is not available because the session has fallen back to the login screen\./,
  );
});

test('liepin adapter accepts the authenticated search service page even when body text is blank', async () => {
  const page = {
    context: () => ({
      cookies: async () => [
        { name: 'UniqueKey' },
        { name: 'liepin_login_valid' },
      ],
    }),
    url: () => 'https://h.liepin.com/search/getConditionItem?key=%E4%BC%98%E8%A1%A3%E5%BA%93',
    waitForLoadState: async () => undefined,
    locator: () => ({
      waitFor: async () => undefined,
      innerText: async () => '',
    }),
  } as never;

  await assert.doesNotReject(() => liepinAdapter.assertAuthenticated(page));
});

test('liepin adapter rejects a blank authenticated search service page when authenticated cookies are absent', async () => {
  const page = {
    context: () => ({
      cookies: async () => [
        { name: 'acw_tc' },
        { name: 'XSRF-TOKEN' },
        { name: '__gc_id' },
      ],
    }),
    url: () => 'https://h.liepin.com/search/getConditionItem?key=%E4%BC%98%E8%A1%A3%E5%BA%93',
    waitForLoadState: async () => undefined,
    locator: () => ({
      waitFor: async () => undefined,
      innerText: async () => '',
    }),
  } as never;

  await assert.rejects(
    () => liepinAdapter.assertAuthenticated(page),
    /Liepin authenticated page is not available because the session has fallen back to the login screen\./,
  );
});

test('liepin adapter rejects blank authenticated-home pages until search shell readiness appears', async () => {
  const page = {
    context: () => ({
      cookies: async () => [
        { name: 'UniqueKey' },
        { name: 'liepin_login_valid' },
      ],
    }),
    goto: async () => undefined,
    url: () => 'https://h.liepin.com/search/getConditionItem',
    waitForLoadState: async () => undefined,
    waitForResponse: async () => undefined,
    waitForFunction: async () => {
      throw new Error('search shell not ready');
    },
    locator: () => ({
      waitFor: async () => undefined,
      innerText: async () => '',
    }),
  } as never;

  await assert.rejects(() => liepinAdapter.openAuthenticatedHome(page), /search shell not ready/);
});

test('liepin adapter waits for the Liepin SPA shell to hydrate before treating search as ready', async () => {
  let readyChecks = 0;
  const page = {
    goto: async () => undefined,
    url: () => 'https://h.liepin.com/search/getConditionItem?key=%E4%BC%98%E8%A1%A3%E5%BA%93',
    waitForLoadState: async () => undefined,
    waitForResponse: async () => undefined,
    waitForFunction: async (fn: () => boolean, _arg: unknown, options?: { timeout?: number; polling?: number }) => {
      assert.ok(options?.timeout !== undefined && options.timeout > 0 && options.timeout <= config.playwright.searchPageTimeoutMs);
      assert.equal(options?.polling, 250);
      while (readyChecks < 6) {
        readyChecks += 1;
        const previousDocument = globalThis.document;
        const shell = readyChecks >= 3;
        const fakeDocument = {
          body: {
            innerText: shell ? '搜索条件 人才搜索 快捷搜索 优衣库 订阅' : '',
            children: [{ id: 'main-container' }, ...(shell ? [{ id: 'hydrated' }] : [])],
            childElementCount: shell ? 2 : 1,
          },
          querySelector: (selector: string) => {
            if (selector === '.base-page-loading, [class*="loading"]') {
              return shell ? null : { className: 'base-page-loading' };
            }
            if (selector === '#main-container') {
              return { childElementCount: shell ? 1 : 0, textContent: shell ? '搜索条件 人才搜索' : '' };
            }
            if (selector === '#app, #root, [data-testid="app-root"]') {
              return null;
            }
            return null;
          },
        };
        Object.defineProperty(globalThis, 'document', {
          value: fakeDocument,
          configurable: true,
        });
        try {
          if (fn()) {
            return;
          }
        } finally {
          if (previousDocument === undefined) {
            // @ts-expect-error test cleanup for temporary global
            delete globalThis.document;
          } else {
            Object.defineProperty(globalThis, 'document', {
              value: previousDocument,
              configurable: true,
            });
          }
        }
      }
      throw new Error('waiting for function failed');
    },
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => liepinSearchReadyText,
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
    evaluate: async () => liepinHideViewedState(true),
  } as never;

  await assert.doesNotReject(() => liepinAdapter.openSubscribeSearch(page, '优衣库'));
  assert.equal(readyChecks, 5);
});

test('liepin adapter accepts the real post-login recruiter shell when main-container stays empty and loading scaffolding is hidden', async () => {
  const urls: Array<{ url: string; waitUntil: string }> = [];
  const page = {
    goto: async (url: string, options: { waitUntil?: string }) => {
      urls.push({ url, waitUntil: options.waitUntil ?? '' });
    },
    url: () => 'https://h.liepin.com/search/getConditionItem',
    waitForLoadState: async () => undefined,
    waitForResponse: async () => undefined,
    waitForFunction: async (fn: () => boolean, _arg: unknown, options?: { timeout?: number; polling?: number }) => {
      assert.ok(options?.timeout !== undefined && options.timeout > 0 && options.timeout <= config.playwright.searchPageTimeoutMs);
      assert.equal(options?.polling, 250);
      const previousDocument = globalThis.document;
      const previousWindow = globalThis.window;
      const hiddenLoading = {
        hidden: true,
        getAttribute: (name: string) => (name === 'aria-hidden' ? 'true' : null),
        getBoundingClientRect: () => ({ width: 0, height: 0 }),
      };
      const fakeDocument = {
        body: {
          innerText: '找简历 人才管理 搜简历 快捷搜索 优衣库 订阅 目前城市 不限 期望城市 不限 工作年限 不限',
          childElementCount: 8,
          textContent: '找简历 人才管理 搜简历 快捷搜索 优衣库 订阅 目前城市 不限 期望城市 不限 工作年限 不限',
        },
        querySelector: (selector: string) => {
          if (selector === '.base-page-loading, [class*="loading"]') {
            return hiddenLoading;
          }
          if (selector === '#main-container') {
            return { childElementCount: 0, textContent: '' };
          }
          if (selector === '#app' || selector === '#root' || selector === '[data-testid="app-root"]') {
            return null;
          }
          return null;
        },
        querySelectorAll: (selector: string) => {
          if (selector === '.base-page-loading, [class*="loading"]') {
            return [hiddenLoading];
          }
          return [];
        },
      };

      Object.defineProperty(globalThis, 'document', {
        value: fakeDocument,
        configurable: true,
      });
      Object.defineProperty(globalThis, 'window', {
        value: {
          getComputedStyle: () => ({
            display: 'none',
            visibility: 'hidden',
            opacity: '0',
          }),
        },
        configurable: true,
      });

      try {
        if (!fn()) {
          throw new Error('real post-login recruiter shell was not accepted');
        }
      } finally {
        if (previousDocument === undefined) {
          // @ts-expect-error test cleanup for temporary global
          delete globalThis.document;
        } else {
          Object.defineProperty(globalThis, 'document', {
            value: previousDocument,
            configurable: true,
          });
        }

        if (previousWindow === undefined) {
          // @ts-expect-error test cleanup for temporary global
          delete globalThis.window;
        } else {
          Object.defineProperty(globalThis, 'window', {
            value: previousWindow,
            configurable: true,
          });
        }
      }
    },
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '找简历\n人才管理\n搜简历\n快捷搜索：\n优衣库\n订阅\n目前城市：\n不限',
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;

  await assert.doesNotReject(() => liepinAdapter.openAuthenticatedHome(page));
  assert.deepStrictEqual(urls, [{ url: 'https://h.liepin.com/search/getConditionItem', waitUntil: 'domcontentloaded' }]);
});

test('liepin adapter rejects when the Liepin SPA shell readiness wait fails on a page that supports waitForFunction', async () => {
  const page = {
    goto: async () => undefined,
    url: () => 'https://h.liepin.com/search/getConditionItem?key=%E4%BC%98%E8%A1%A3%E5%BA%93',
    waitForLoadState: async () => undefined,
    waitForResponse: async () => undefined,
    waitForFunction: async () => {
      throw new Error('shell hydration timeout');
    },
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '搜简历 搜索条件 人才搜索 快捷搜索 优衣库 订阅',
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;

  await assert.rejects(() => liepinAdapter.openSubscribeSearch(page, '优衣库'), /shell hydration timeout/);
});

test('liepin adapter rejects when the Liepin quick-search tag interaction fails on a page that supports getByText', async () => {
  const page = {
    goto: async () => undefined,
    url: () => 'https://h.liepin.com/search/getConditionItem?key=%E4%BC%98%E8%A1%A3%E5%BA%93',
    waitForLoadState: async () => undefined,
    waitForResponse: async () => undefined,
    waitForFunction: async () => undefined,
    getByText: (text: string, options?: { exact?: boolean }) => {
      assert.equal(text, '优衣库');
      assert.equal(options?.exact, true);
      return {
        first: () => ({
          waitFor: async () => {
            throw new Error('quick-search tag not visible');
          },
          click: async () => undefined,
        }),
      };
    },
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '搜简历 搜索条件 人才搜索 快捷搜索 优衣库 订阅',
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;

  await assert.rejects(() => liepinAdapter.openSubscribeSearch(page, '优衣库'), /quick-search tag not visible/);
});

test('liepin adapter uses the Liepin login URL', () => {
  assert.equal(liepinAdapter.loginUrl, 'https://h.liepin.com/account/login');
});

test('liepin adapter tolerates aborted recruiter search navigation when the page lands on authenticated results', async () => {
  const urls: Array<{ url: string; waitUntil: string }> = [];
  let currentUrl = 'about:blank';
  const page = {
    goto: async (url: string, options: { waitUntil?: string }) => {
      urls.push({ url, waitUntil: options.waitUntil ?? '' });
      currentUrl = 'https://h.liepin.com/search/getConditionItem';
      throw new Error('page.goto: net::ERR_ABORTED');
    },
    url: () => currentUrl,
    waitForLoadState: async () => undefined,
    waitForResponse: async () => undefined,
    waitForFunction: async () => undefined,
    getByText: () => ({
      first: () => ({
        waitFor: async () => undefined,
        click: async () => undefined,
      }),
    }),
    evaluate: async () => liepinHideViewedState(true),
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => liepinSearchReadyText,
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;

  await assert.doesNotReject(() => liepinAdapter.openSubscribeSearch(page, '优衣库'));
  assert.deepStrictEqual(urls, [{ url: 'https://h.liepin.com/search/getConditionItem', waitUntil: 'domcontentloaded' }]);
});


test('liepin adapter reuses the current recruiter search URL and authenticates after the recruiter shell loads', async () => {
  const urls: Array<{ url: string; waitUntil: string }> = [];
  const page = {
    goto: async (url: string, options: { waitUntil?: string }) => {
      urls.push({ url, waitUntil: options.waitUntil ?? '' });
    },
    url: () => 'https://h.liepin.com/search/getConditionItem?key=%E4%BC%98%E8%A1%A3%E5%BA%93',
    waitForLoadState: async () => undefined,
    waitForResponse: async () => undefined,
    waitForFunction: async () => undefined,
    getByText: () => ({
      first: () => ({
        waitFor: async () => undefined,
        click: async () => undefined,
      }),
    }),
    evaluate: async () => liepinHideViewedState(true),
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => liepinSearchReadyText,
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;

  await assert.doesNotReject(() => liepinAdapter.openSubscribeSearch(page, '优衣库'));
  assert.deepStrictEqual(urls, []);
});

test('liepin adapter opens the Liepin login page', async () => {
  const urls: Array<{ url: string; waitUntil: string }> = [];
  const page = {
    goto: async (url: string, options: { waitUntil?: string }) => {
      urls.push({ url, waitUntil: options.waitUntil ?? '' });
    },
  } as never;

  await liepinAdapter.openLoginPage(page);

  assert.deepStrictEqual(urls, [{ url: 'https://h.liepin.com/account/login', waitUntil: 'domcontentloaded' }]);
});

test('liepin adapter accepts the real authenticated post-login landing page', async () => {
  const page = {
    url: () => 'https://h.liepin.com/search/getConditionItem',
    waitForLoadState: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '猎聘\n搜简历\n搜索条件\n人才搜索',
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;

  await assert.doesNotReject(() => liepinAdapter.assertAuthenticated(page));
});

test('liepin adapter accepts an authenticated recruiter resume detail page', async () => {
  const page = {
    url: () => 'https://h.liepin.com/resume/showresumedetail/?res_id_encode=e0948bd962f8G1c579f0e7b27',
    waitForLoadState: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => [
            '中文简历',
            '简历编号：e0948bd962f8G1c579f0e7b27',
            '求职意向',
            '店长/卖场管理',
            '工作经历',
            '李宁',
            '门店店长',
            '教育经历',
            '广东开放大学',
            '查看联系方式',
            '立即沟通',
          ].join('\n'),
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;

  await assert.doesNotReject(() => liepinAdapter.assertAuthenticated(page));
});

test('liepin adapter opens the real authenticated verification entry before asserting auth', async () => {
  const urls: Array<{ url: string; waitUntil: string }> = [];
  const page = {
    goto: async (url: string, options: { waitUntil?: string }) => {
      urls.push({ url, waitUntil: options.waitUntil ?? '' });
    },
    url: () => 'https://h.liepin.com/search/getConditionItem',
    waitForLoadState: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '猎聘\n搜简历\n搜索条件\n人才搜索',
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;

  await assert.doesNotReject(() => liepinAdapter.openAuthenticatedHome(page));
  assert.deepStrictEqual(urls, [{ url: 'https://h.liepin.com/search/getConditionItem', waitUntil: 'domcontentloaded' }]);
});

test('liepin adapter accepts an authenticated recruiter search page', async () => {
  const urls: Array<{ url: string; waitUntil: string }> = [];
  const page = {
    goto: async (url: string, options: { waitUntil?: string }) => {
      urls.push({ url, waitUntil: options.waitUntil ?? '' });
    },
    url: () => 'https://h.liepin.com/search/getConditionItem?key=%E9%94%80%E5%94%AE',
    waitForLoadState: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '猎聘\n搜简历\n搜索条件\n人才搜索\n快捷搜索',
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;

  await assert.doesNotReject(() => liepinAdapter.assertAuthenticated(page));
  assert.deepStrictEqual(urls, []);
});

test('liepin adapter does not directly navigate to public zhaopin resume urls when opening resume detail', async () => {
  let newPageCalls = 0;
  const clickCalls: string[] = [];
  const popupPage = {
    url: () => 'https://h.liepin.com/search/getConditionItem?resumeId=87654321#detail',
    waitForLoadState: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '猎聘\n搜简历\n搜索条件\n人才搜索\n快捷搜索\n共1位人选',
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;
  const context = {
    waitForEvent: async (event: string, options?: { timeout?: number }) => {
      assert.equal(event, 'page');
      assert.ok((options?.timeout ?? 0) > 0);
      assert.ok((options?.timeout ?? 0) <= 20000);
      return popupPage;
    },
    newPage: async () => {
      newPageCalls += 1;
      throw new Error('public zhaopin resume urls should not be opened in a fresh page');
    },
  } as never;
  const searchPage = {
    url: () => 'https://h.liepin.com/search/getConditionItem?key=%E4%BC%98%E8%A1%A3%E5%BA%93#session',
    locator: (selector: string) => {
      assert.match(selector, /87654321/);
      return {
        first: () => ({
          waitFor: async (options?: { state?: string; timeout?: number }) => {
            assert.equal(options?.state, 'visible');
            assert.ok((options?.timeout ?? 0) > 0);
            assert.ok((options?.timeout ?? 0) <= 20000);
          },
          click: async () => {
            clickCalls.push('candidate-link');
          },
        }),
      };
    },
  } as never;

  const result = await liepinAdapter.openResumeDetail(context, searchPage, {
    candidateId: '87654321',
    resumeUrl: 'https://www.liepin.com/zhaopin/?resumeId=87654321&from=search',
  });

  assert.equal(result, popupPage);
  assert.equal(newPageCalls, 0);
  assert.deepStrictEqual(clickCalls, ['candidate-link']);
});

test('liepin adapter waits for recruiter resume detail content to hydrate before treating a safe detail url as authenticated', async () => {
  let newPageCalls = 0;
  let bodyReads = 0;
  const page = {
    goto: async () => undefined,
    url: () => 'https://h.liepin.com/resume/showresumedetail/?res_id_encode=e0948bd962f8G1c579f0e7b27',
    title: async () => (bodyReads >= 2 ? 'NO.e0948bd962f8G1c579f0e7b27' : '猎头-猎头招聘服务'),
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => {
            bodyReads += 1;
            if (bodyReads === 1) {
              return '';
            }
            if (bodyReads === 2) {
              return '--\n你好，--\n我的主页\t个人中心\n安全中心\t账户资源\n用户规则\t通话管理\n安全退出';
            }
            return [
              '中文简历',
              '简历编号：e0948bd962f8G1c579f0e7b27',
              '求职意向',
              '店长/卖场管理',
              '工作经历',
              '李宁',
              '门店店长',
              '教育经历',
              '广东开放大学',
              '查看联系方式',
              '立即沟通',
            ].join('\n');
          },
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;
  const context = {
    waitForEvent: async () => null,
    newPage: async () => {
      newPageCalls += 1;
      return page;
    },
  } as never;
  const searchPage = {
    url: () => 'https://h.liepin.com/search/getConditionItem#session',
  } as never;

  const result = await liepinAdapter.openResumeDetail(context, searchPage, {
    candidateId: 'e0948bd962f8G1c579f0e7b27',
    resumeUrl: 'https://h.liepin.com/resume/showresumedetail/?res_id_encode=e0948bd962f8G1c579f0e7b27',
  });

  assert.equal(result, page);
  assert.equal(newPageCalls, 1);
  assert.equal(bodyReads >= 3, true);
});

test('liepin adapter rejects opening resume detail when only a public zhaopin route is available', async () => {
  const context = {
    waitForEvent: async () => null,
    newPage: async () => {
      throw new Error('public zhaopin resume urls should not be opened in a fresh page');
    },
  } as never;
  const searchPage = {
    url: () => 'https://h.liepin.com/search/getConditionItem?key=%E4%BC%98%E8%A1%A3%E5%BA%93#session',
    locator: (selector: string) => {
      assert.match(selector, /99887766/);
      return {
        first: () => ({
          waitFor: async () => {
            throw new Error('safe recruiter detail link not found');
          },
          click: async () => undefined,
        }),
      };
    },
  } as never;

  await assert.rejects(
    () => liepinAdapter.openResumeDetail(context, searchPage, {
      candidateId: '99887766',
      resumeUrl: 'https://www.liepin.com/zhaopin/?candidateId=99887766',
    }),
    /Could not open Liepin resume detail for candidate 99887766 without using a public zhaopin URL\./,
  );
});


test('liepin adapter rejects hash-login landing pages during authentication checks', async () => {
  const page = {
    url: () => 'https://h.liepin.com/?time=1778325808394#login',
    waitForLoadState: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '猎聘\n扫码登录\n密码登录',
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;

  await assert.rejects(
    () => liepinAdapter.assertAuthenticated(page),
    /Liepin authenticated page is not available because the session has fallen back to the login screen\./,
  );
});

test('liepin adapter rejects pages that fall back to the login screen during authentication checks', async () => {
  const page = {
    url: () => 'https://h.liepin.com/account/login',
    waitForLoadState: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '猎聘\n扫码登录\n密码登录',
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;

  await assert.rejects(() => liepinAdapter.assertAuthenticated(page), /Liepin authenticated page is not available because the session has fallen back to the login screen\./);
});

test('liepin adapter accepts recruiter result pages that only expose the 共5位人选 authenticated signal', async () => {
  const page = {
    url: () => 'https://h.liepin.com/search/getConditionItem?key=%E4%BC%98%E8%A1%A3%E5%BA%93#session',
    waitForLoadState: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '猎聘\n搜索条件\n人才搜索\n共5位人选',
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;

  await assert.doesNotReject(() => liepinAdapter.assertAuthenticated(page));
});

test('liepin adapter accepts the real recruiter shell that only exposes 找简历 and 人才管理 authenticated signals', async () => {
  const page = {
    url: () => 'https://h.liepin.com/search/getConditionItem',
    waitForLoadState: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => [
            '首页',
            '沟通',
            '找人',
            '职位',
            '猎头服务',
            '找简历',
            '人才管理',
            '包含全部关键词',
            '搜职位/公司/行业等（中文用空格隔开，英文用逗号隔开）',
            '快捷搜索：',
            '优衣库',
            '订阅',
          ].join('\n'),
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;

  await assert.doesNotReject(() => liepinAdapter.assertAuthenticated(page));
});

test('liepin adapter falls back to the search-resumes API when result cards have no extractable ids', async () => {
  const page = {
    goto: async () => undefined,
    url: () => 'https://h.liepin.com/search/getConditionItem?key=%E4%BC%98%E8%A1%A3%E5%BA%93#session',
    waitForLoadState: async () => undefined,
    waitForResponse: async (predicate: (response: { url(): string; status(): number; text(): Promise<string> }) => boolean) => {
      const response = {
        url: () => 'https://api-h.liepin.com/api/com.liepin.searchfront4r.h.search-resumes',
        status: () => 200,
        text: async () => JSON.stringify({
          data: {
            resList: [
              {
                resIdEncode: 'ed9d81d66df0J185192077e2a',
                resName: '宋**',
                highLightCompOrIndustry: '<font color="#FF7C2D">李宁</font>(中国)体育用品有限公司',
                highLightJobTitle: '门店店长',
                detailUrl: '/resume/showresumedetail/?showsearchfeedback=1&res_id_encode=ed9d81d66df0J185192077e2a&index=0',
                wantDq: '上海',
                wantJobTitle: '店长/卖场管理',
                simpleResumeForm: {
                  resIdEncode: 'ed9d81d66df0J185192077e2a',
                  resName: '宋**',
                  workYearName: '工作1年',
                  eduLevelName: '本科',
                  liveDq: '上海',
                },
              },
            ],
          },
        }),
      };
      return predicate(response) ? response : Promise.reject(new Error('unexpected response predicate'));
    },
    waitForFunction: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '猎聘\n搜简历\n搜索条件\n人才搜索\n快捷搜索\n优衣库\n订阅',
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
        evaluateAll: async () => [],
      };
    },
  } as never;

  const result = await liepinAdapter.extractCandidateList(page);

  assert.deepStrictEqual(result.candidates, [
    {
      candidateId: 'ed9d81d66df0J185192077e2a',
      name: '宋**',
      currentCompany: '李宁(中国)体育用品有限公司',
      currentTitle: '门店店长',
      resumeUrl: 'https://h.liepin.com/resume/showresumedetail/?showsearchfeedback=1&res_id_encode=ed9d81d66df0J185192077e2a&index=0',
      cardText: '宋**__AUTORECRUIT_LINE_BREAK__工作1年__AUTORECRUIT_LINE_BREAK__本科__AUTORECRUIT_LINE_BREAK__上海__AUTORECRUIT_LINE_BREAK__上海__AUTORECRUIT_LINE_BREAK__店长/卖场管理__AUTORECRUIT_LINE_BREAK__李宁(中国)体育用品有限公司__AUTORECRUIT_LINE_BREAK__门店店长',
      sourceText: JSON.stringify({
        resIdEncode: 'ed9d81d66df0J185192077e2a',
        resName: '宋**',
        highLightCompOrIndustry: '<font color="#FF7C2D">李宁</font>(中国)体育用品有限公司',
        highLightJobTitle: '门店店长',
        detailUrl: '/resume/showresumedetail/?showsearchfeedback=1&res_id_encode=ed9d81d66df0J185192077e2a&index=0',
        wantDq: '上海',
        wantJobTitle: '店长/卖场管理',
        simpleResumeForm: {
          resIdEncode: 'ed9d81d66df0J185192077e2a',
          resName: '宋**',
          workYearName: '工作1年',
          eduLevelName: '本科',
          liveDq: '上海',
        },
      }),
    },
  ]);
});

test('liepin adapter uses an already-observed search-resumes payload when the API response arrived before extraction started', async () => {
  const observedResponses: Array<{
    url(): string;
    status(): number;
    text(): Promise<string>;
  }> = [];
  const response = {
    url: () => 'https://api-h.liepin.com/api/com.liepin.searchfront4r.h.search-resumes',
    status: () => 200,
    text: async () => JSON.stringify({
      data: {
        resList: [
          {
            resIdEncode: 'ed9d81d66df0J185192077e2a',
            resName: '宋**',
            highLightCompOrIndustry: '<font color="#FF7C2D">李宁</font>(中国)体育用品有限公司',
            highLightJobTitle: '门店店长',
            detailUrl: '/resume/showresumedetail/?showsearchfeedback=1&res_id_encode=ed9d81d66df0J185192077e2a&index=0',
            wantDq: '上海',
            wantJobTitle: '店长/卖场管理',
            simpleResumeForm: {
              resIdEncode: 'ed9d81d66df0J185192077e2a',
              resName: '宋**',
              workYearName: '工作1年',
              eduLevelName: '本科',
              liveDq: '上海',
            },
          },
        ],
      },
    }),
  };
  const page = {
    url: () => 'https://h.liepin.com/search/getConditionItem#session',
    waitForLoadState: async () => undefined,
    waitForResponse: async () => {
      throw new Error('search-resumes response already happened before extraction');
    },
    waitForFunction: async () => undefined,
    on: (event: string, listener: (candidateResponse: typeof response) => void | Promise<void>) => {
      assert.equal(event, 'response');
      observedResponses.push(response);
      void listener(response);
    },
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '猎聘\n搜索条件\n人才搜索\n共7位人选\n宋**\n立即沟通',
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
        evaluateAll: async () => [],
      };
    },
  } as never;

  const result = await liepinAdapter.extractCandidateList(page);

  assert.equal(observedResponses.length, 1);
  assert.deepStrictEqual(result.candidates, [
    {
      candidateId: 'ed9d81d66df0J185192077e2a',
      name: '宋**',
      currentCompany: '李宁(中国)体育用品有限公司',
      currentTitle: '门店店长',
      resumeUrl: 'https://h.liepin.com/resume/showresumedetail/?showsearchfeedback=1&res_id_encode=ed9d81d66df0J185192077e2a&index=0',
      cardText: '宋**__AUTORECRUIT_LINE_BREAK__工作1年__AUTORECRUIT_LINE_BREAK__本科__AUTORECRUIT_LINE_BREAK__上海__AUTORECRUIT_LINE_BREAK__上海__AUTORECRUIT_LINE_BREAK__店长/卖场管理__AUTORECRUIT_LINE_BREAK__李宁(中国)体育用品有限公司__AUTORECRUIT_LINE_BREAK__门店店长',
      sourceText: JSON.stringify({
        resIdEncode: 'ed9d81d66df0J185192077e2a',
        resName: '宋**',
        highLightCompOrIndustry: '<font color="#FF7C2D">李宁</font>(中国)体育用品有限公司',
        highLightJobTitle: '门店店长',
        detailUrl: '/resume/showresumedetail/?showsearchfeedback=1&res_id_encode=ed9d81d66df0J185192077e2a&index=0',
        wantDq: '上海',
        wantJobTitle: '店长/卖场管理',
        simpleResumeForm: {
          resIdEncode: 'ed9d81d66df0J185192077e2a',
          resName: '宋**',
          workYearName: '工作1年',
          eduLevelName: '本科',
          liveDq: '上海',
        },
      }),
    },
  ]);
});

test('liepin adapter only waits for the search-resumes API during extract fallback on an already-loaded results page', async () => {
  const waitedUrls: string[] = [];
  const page = {
    url: () => 'https://h.liepin.com/search/getConditionItem?key=%E4%BC%98%E8%A1%A3%E5%BA%93#session',
    waitForLoadState: async () => undefined,
    waitForResponse: async (predicate: (response: { url(): string; status(): number; text(): Promise<string> }) => boolean) => {
      const responses = [
        {
          url: () => 'https://api-h.liepin.com/api/com.liepin.recruitbff.clt.search.get-initial-data',
          status: () => 200,
          text: async () => '{}',
        },
        {
          url: () => 'https://api-h.liepin.com/api/com.liepin.searchfront4r.h.search-resumes',
          status: () => 200,
          text: async () => JSON.stringify({ data: { resList: [] } }),
        },
      ];

      for (const response of responses) {
        if (predicate(response)) {
          waitedUrls.push(response.url());
          return response;
        }
      }

      throw new Error('unexpected response predicate');
    },
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '猎聘\n搜索条件\n人才搜索\n共5位人选',
        };
      }

      return {
        evaluateAll: async () => [],
      };
    },
  } as never;

  await assert.doesNotReject(() => liepinAdapter.extractCandidateList(page));
  assert.deepStrictEqual(waitedUrls, [
    'https://api-h.liepin.com/api/com.liepin.searchfront4r.h.search-resumes',
  ]);
});

test('liepin adapter waits for search shell hydration before treating an authenticated results page as extract-ready', async () => {
  let readyChecks = 0;
  const page = {
    url: () => 'https://h.liepin.com/search/getConditionItem?key=%E4%BC%98%E8%A1%A3%E5%BA%93#session',
    waitForLoadState: async () => undefined,
    waitForResponse: async (predicate: (response: { url(): string; status(): number; text(): Promise<string> }) => boolean) => {
      const response = {
        url: () => 'https://api-h.liepin.com/api/com.liepin.searchfront4r.h.search-resumes',
        status: () => 200,
        text: async () => JSON.stringify({ data: { resList: [] } }),
      };
      if (predicate(response)) {
        return response;
      }
      throw new Error('unexpected response predicate');
    },
    waitForFunction: async (fn: () => boolean, _arg: unknown, options?: { timeout?: number; polling?: number }) => {
      assert.ok(options?.timeout !== undefined && options.timeout > 0 && options.timeout <= config.playwright.searchPageTimeoutMs);
      assert.equal(options?.polling, 250);
      while (readyChecks < 6) {
        readyChecks += 1;
        const previousDocument = globalThis.document;
        const shell = readyChecks >= 3;
        const fakeDocument = {
          body: {
            innerText: shell ? '搜索条件 人才搜索 共5位人选' : '',
            childElementCount: shell ? 2 : 1,
            textContent: shell ? '搜索条件 人才搜索 共5位人选' : '',
          },
          querySelector: (selector: string) => {
            if (selector === '.base-page-loading, [class*="loading"]') {
              return shell ? null : { className: 'base-page-loading' };
            }
            if (selector === '#main-container') {
              return { childElementCount: shell ? 1 : 0, textContent: shell ? '搜索条件 人才搜索' : '' };
            }
            if (selector === '#app, #root, [data-testid="app-root"]') {
              return null;
            }
            return null;
          },
        };
        Object.defineProperty(globalThis, 'document', {
          value: fakeDocument,
          configurable: true,
        });
        try {
          if (fn()) {
            return;
          }
        } finally {
          if (previousDocument === undefined) {
            // @ts-expect-error test cleanup for temporary global
            delete globalThis.document;
          } else {
            Object.defineProperty(globalThis, 'document', {
              value: previousDocument,
              configurable: true,
            });
          }
        }
      }
      throw new Error('waiting for function failed');
    },
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '猎聘\n搜索条件\n人才搜索\n共5位人选',
        };
      }

      return {
        evaluateAll: async () => [],
      };
    },
  } as never;

  await assert.doesNotReject(() => liepinAdapter.extractCandidateList(page));
  assert.ok(readyChecks >= 3);
});

test('liepin adapter rejects unauthenticated public zhaopin pages that still show login/register prompts', async () => {
  const page = {
    url: () => 'https://www.liepin.com/zhaopin/?key=%E8%B4%B8%E6%98%93',
    waitForLoadState: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '猎聘\n登录/注册\n搜索结果',
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;

  await assert.rejects(() => liepinAdapter.assertAuthenticated(page), /Liepin authenticated page is not available because the session has fallen back to the login screen\./);
});


test('liepin adapter falls back to candidate card metadata when resume sections are sparse', async () => {
  const page = {
    url: () => 'https://www.liepin.com/resume/66778899',
    waitForLoadState: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => [
            '猎聘',
            '搜简历',
            '林涛',
            '大专',
            '现居住地 佛山',
            '个人优势',
            '具备多年渠道维护经验',
          ].join('\n'),
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;

  const resume = await liepinAdapter.parseResumeDetail(page, {
    candidateId: '66778899',
    resumeUrl: 'https://www.liepin.com/resume/66778899',
    name: '林涛',
    currentCompany: '佛山某家居有限公司',
    currentTitle: '销售主管',
  });

  assert.deepStrictEqual(resume, {
    candidateId: '66778899',
    resumeUrl: 'https://www.liepin.com/resume/66778899',
    name: '林涛',
    education: '大专',
    regions: ['现居住地 佛山'],
    pr: [],
    workExperiences: [
      {
        company: '佛山某家居有限公司',
        title: '销售主管',
        details: [],
      },
    ],
    projectExperiences: [],
    educationExperiences: [
      {
        degree: '大专',
        details: [],
      },
    ],
    skill: [],
    certificates: [],
  });
});

test('liepin adapter parses education background and language sections without polluting certificates', async () => {
  const page = {
    url: () => 'https://www.liepin.com/resume/55667788',
    waitForLoadState: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => [
            '猎聘',
            '搜简历',
            '周宁',
            '本科',
            '期望城市 广州',
            '工作经历',
            '2020.01-至今',
            '广州某商贸有限公司',
            '招商主管',
            '负责华南区渠道管理',
            '教育背景',
            '2015.09-2019.06',
            '华南理工大学',
            '本科 国际经济与贸易',
            '语言能力',
            '英语 CET6',
            '粤语',
            '证书',
            '教师资格证',
            '个人优势',
            '擅长客户关系维护',
          ].join('\n'),
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;

  const resume = await liepinAdapter.parseResumeDetail(page, {
    candidateId: '55667788',
    resumeUrl: 'https://www.liepin.com/resume/55667788',
  });

  assert.deepStrictEqual(resume, {
    candidateId: '55667788',
    resumeUrl: 'https://www.liepin.com/resume/55667788',
    name: '周宁',
    education: '本科',
    regions: ['期望城市 广州'],
    pr: [],
    workExperiences: [
      {
        company: '广州某商贸有限公司',
        title: '招商主管',
        details: ['2020.01-至今', '负责华南区渠道管理'],
      },
    ],
    projectExperiences: [],
    educationExperiences: [
      {
        school: '华南理工大学',
        degree: '本科',
        major: '国际经济与贸易',
        details: ['2015.09-2019.06'],
      },
    ],
    skill: [],
    certificates: ['教师资格证'],
  });
});

test('liepin adapter extracts candidate cards from nested containers and mixed id sources', async () => {
  const cards = [
    {
      href: 'https://www.liepin.com/a/resume?redirect=1',
      outerHTML: '<a href="https://www.liepin.com/a/resume?redirect=1">陈晨</a>',
      textContent: '陈晨\n广州某电子有限公司\n区域销售总监',
      closest: () => ({
        textContent: '陈晨\n广州某电子有限公司\n区域销售总监',
        getAttribute: (name: string) => (name === 'data-resume-id' ? '45678901' : name === 'outerHTML' ? '<div data-resume-id="45678901">陈晨</div>' : null),
      }),
    },
    {
      href: 'https://www.liepin.com/zhaopin/?foo=bar',
      outerHTML: '<a href="https://www.liepin.com/zhaopin/?foo=bar" data-candidate-id="56789012">孙丽</a>',
      textContent: '孙丽\n北京某咨询集团\n招商主管',
      getAttribute: (name: string) => (name === 'data-candidate-id' ? '56789012' : null),
      closest: () => ({
        textContent: '孙丽\n北京某咨询集团\n招商主管',
      }),
    },
  ];

  const page = {
    url: () => 'https://www.liepin.com/zhaopin/?foo=bar',
    waitForLoadState: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '猎聘\n搜简历\n搜索结果',
        };
      }

      return {
        evaluateAll: async (fn: (elements: unknown[]) => unknown) => fn(cards),
      };
    },
  } as never;

  const result = await liepinAdapter.extractCandidateList(page);

  assert.deepStrictEqual(result.candidates, [
    {
      candidateId: '45678901',
      resumeUrl: 'https://www.liepin.com/a/resume?redirect=1',
      name: '陈晨',
      currentCompany: '广州某电子有限公司',
      currentTitle: '区域销售总监',
      cardText: '陈晨__AUTORECRUIT_LINE_BREAK__广州某电子有限公司__AUTORECRUIT_LINE_BREAK__区域销售总监',
      sourceText: 'https://www.liepin.com/a/resume?redirect=1 <a href="https://www.liepin.com/a/resume?redirect=1">陈晨</a> 陈晨 广州某电子有限公司 区域销售总监 45678901 <div data-resume-id="45678901">陈晨</div>',
    },
    {
      candidateId: '56789012',
      resumeUrl: undefined,
      name: '孙丽',
      currentCompany: '北京某咨询集团',
      currentTitle: '招商主管',
      cardText: '孙丽__AUTORECRUIT_LINE_BREAK__北京某咨询集团__AUTORECRUIT_LINE_BREAK__招商主管',
      sourceText: 'https://www.liepin.com/zhaopin/?foo=bar <a href="https://www.liepin.com/zhaopin/?foo=bar" data-candidate-id="56789012">孙丽</a> 孙丽 北京某咨询集团 招商主管 56789012',
    },
  ]);
});

test('liepin adapter extracts candidate cards from anchor-based search results', async () => {
  const cards = [
    {
      href: 'https://www.liepin.com/resume/12345678?from=search',
      outerHTML: '<a href="https://www.liepin.com/resume/12345678?from=search">王明</a>',
      textContent: '王明\n上海某科技有限公司\n销售经理',
      closest: () => ({
        textContent: '王明\n上海某科技有限公司\n销售经理',
      }),
    },
    {
      href: 'https://www.liepin.com/resume/12345678?from=search',
      outerHTML: '<a href="https://www.liepin.com/resume/12345678?from=search">重复候选人</a>',
      textContent: '重复候选人\n上海某科技有限公司\n销售经理',
      closest: () => ({
        textContent: '重复候选人\n上海某科技有限公司\n销售经理',
      }),
    },
  ];

  const page = {
    url: () => 'https://www.liepin.com/zhaopin/?foo=bar',
    waitForLoadState: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '猎聘\n搜简历\n搜索结果',
        };
      }

      return {
        evaluateAll: async (fn: (elements: unknown[]) => unknown) => fn(cards),
      };
    },
  } as never;

  const result = await liepinAdapter.extractCandidateList(page);

  assert.deepStrictEqual(result.candidates, [
    {
      candidateId: '12345678',
      resumeUrl: 'https://www.liepin.com/resume/12345678?from=search',
      name: '王明',
      currentCompany: '上海某科技有限公司',
      currentTitle: '销售经理',
      cardText: '王明__AUTORECRUIT_LINE_BREAK__上海某科技有限公司__AUTORECRUIT_LINE_BREAK__销售经理',
      sourceText: 'https://www.liepin.com/resume/12345678?from=search <a href="https://www.liepin.com/resume/12345678?from=search">王明</a> 王明 上海某科技有限公司 销售经理',
    },
  ]);
});

test('liepin adapter extracts candidate cards from real #resultList search results', async () => {
  const cards = [
    {
      href: 'https://www.liepin.com/zhaopin/?resumeId=87654321&from=search',
      outerHTML: '<a data-tlg-elem-id="h_pc_search_res_listcard" href="https://www.liepin.com/zhaopin/?resumeId=87654321&from=search">宋**</a>',
      textContent: '宋**\n李宁(中国)体育用品有限公司\n门店店长',
      title: '宋**',
      closest: () => ({
        textContent: '宋**\n李宁(中国)体育用品有限公司\n门店店长',
        querySelector: (query: string) => {
          if (query === '[class*=name], [title]') {
            return { textContent: '宋**' };
          }
          return null;
        },
      }),
    },
  ];

  const page = {
    url: () => 'https://h.liepin.com/search/getConditionItem?key=%E4%BC%98%E8%A1%A3%E5%BA%93#session',
    waitForLoadState: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '猎聘\n搜索条件\n人才搜索\n共5位人选',
        };
      }

      return {
        evaluateAll: async (fn: (elements: unknown[]) => unknown) => fn(cards),
      };
    },
  } as never;

  const result = await liepinAdapter.extractCandidateList(page);

  assert.deepStrictEqual(result.candidates, [
    {
      candidateId: '87654321',
      resumeUrl: undefined,
      name: '门店店长',
      currentCompany: '李宁(中国)体育用品有限公司',
      currentTitle: '门店店长',
      cardText: '宋**__AUTORECRUIT_LINE_BREAK__李宁(中国)体育用品有限公司__AUTORECRUIT_LINE_BREAK__门店店长',
      sourceText: 'https://www.liepin.com/zhaopin/?resumeId=87654321&from=search <a data-tlg-elem-id="h_pc_search_res_listcard" href="https://www.liepin.com/zhaopin/?resumeId=87654321&from=search">宋**</a> 宋** 李宁(中国)体育用品有限公司 门店店长',
    },
  ]);
});

test('liepin adapter extracts candidate cards from data attributes and query id links', async () => {
  const cards = [
    {
      href: 'https://www.liepin.com/zhaopin/?resumeId=23456789&from=search',
      outerHTML: '<a data-resume-id="23456789" href="https://www.liepin.com/zhaopin/?resumeId=23456789&from=search">赵敏</a>',
      textContent: '赵敏\n杭州某信息有限公司\n招商主管',
      getAttribute: (name: string) => (name === 'data-resume-id' ? '23456789' : null),
      closest: () => ({
        textContent: '赵敏\n杭州某信息有限公司\n招商主管',
        getAttribute: (name: string) => (name === 'data-candidate-id' ? '23456789' : null),
      }),
    },
    {
      href: '',
      outerHTML: '<a data-candidate-id="34567890">周强</a>',
      textContent: '周强\n苏州某制造集团\n销售经理',
      getAttribute: (name: string) => (name === 'data-candidate-id' ? '34567890' : null),
      closest: () => ({
        textContent: '周强\n苏州某制造集团\n销售经理',
        getAttribute: (name: string) => (name === 'href' ? 'https://www.liepin.com/resume-detail/?candidateId=34567890' : null),
      }),
    },
  ];

  const page = {
    url: () => 'https://www.liepin.com/zhaopin/?foo=bar',
    waitForLoadState: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '猎聘\n搜简历\n搜索结果',
        };
      }

      return {
        evaluateAll: async (fn: (elements: unknown[]) => unknown) => fn(cards),
      };
    },
  } as never;

  const result = await liepinAdapter.extractCandidateList(page);

  assert.deepStrictEqual(JSON.parse(JSON.stringify(result.candidates)), JSON.parse(JSON.stringify([
    {
      candidateId: '23456789',
      resumeUrl: undefined,
      name: '赵敏',
      currentCompany: '杭州某信息有限公司',
      currentTitle: '招商主管',
      cardText: '赵敏__AUTORECRUIT_LINE_BREAK__杭州某信息有限公司__AUTORECRUIT_LINE_BREAK__招商主管',
      sourceText: 'https://www.liepin.com/zhaopin/?resumeId=23456789&from=search <a data-resume-id="23456789" href="https://www.liepin.com/zhaopin/?resumeId=23456789&from=search">赵敏</a> 赵敏 杭州某信息有限公司 招商主管 23456789 23456789',
    },
    {
      candidateId: '34567890',
      resumeUrl: 'https://www.liepin.com/resume-detail/?candidateId=34567890',
      name: '周强',
      currentCompany: '苏州某制造集团',
      currentTitle: '销售经理',
      cardText: '周强__AUTORECRUIT_LINE_BREAK__苏州某制造集团__AUTORECRUIT_LINE_BREAK__销售经理',
      sourceText: '<a data-candidate-id="34567890">周强</a> 周强 苏州某制造集团 销售经理 34567890 https://www.liepin.com/resume-detail/?candidateId=34567890',
    },
  ])));
});

test('liepin adapter extracts candidate cards when Playwright executes the page callback in an isolated context', async () => {
  const cards = [
    {
      href: 'https://www.liepin.com/zhaopin/?resumeId=23456789&from=search',
      outerHTML: '<a data-resume-id="23456789" href="https://www.liepin.com/zhaopin/?resumeId=23456789&from=search">赵敏</a>',
      textContent: '赵敏\n杭州某信息有限公司\n招商主管',
      getAttribute: (name: string) => (name === 'data-resume-id' ? '23456789' : null),
      closest: () => ({
        textContent: '赵敏\n杭州某信息有限公司\n招商主管',
        getAttribute: (name: string) => {
          if (name === 'data-candidate-id') {
            return '23456789';
          }
          if (name === 'href') {
            return 'https://www.liepin.com/resume-detail/?candidateId=23456789';
          }
          return null;
        },
      }),
    },
  ];

  const page = {
    url: () => 'https://www.liepin.com/zhaopin/?foo=bar',
    waitForLoadState: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '猎聘\n搜简历\n搜索结果',
        };
      }

      return {
        evaluateAll: async (fn: (elements: typeof cards) => unknown) => runInIsolatedPageContext(fn, cards),
      };
    },
  } as never;

  const result = await liepinAdapter.extractCandidateList(page);

  assert.deepStrictEqual(JSON.parse(JSON.stringify(result.candidates)), JSON.parse(JSON.stringify([
    {
      candidateId: '23456789',
      resumeUrl: undefined,
      name: '赵敏',
      currentCompany: '杭州某信息有限公司',
      currentTitle: '招商主管',
      cardText: '赵敏__AUTORECRUIT_LINE_BREAK__杭州某信息有限公司__AUTORECRUIT_LINE_BREAK__招商主管',
      sourceText: 'https://www.liepin.com/zhaopin/?resumeId=23456789&from=search <a data-resume-id="23456789" href="https://www.liepin.com/zhaopin/?resumeId=23456789&from=search">赵敏</a> 赵敏 杭州某信息有限公司 招商主管 23456789 23456789 https://www.liepin.com/resume-detail/?candidateId=23456789',
    },
  ])));
});

test('liepin adapter enriches zhaopin-backed card candidates with recruiter-safe resume urls from the search-resumes API', async () => {
  const cards = [
    {
      href: 'https://www.liepin.com/zhaopin/?resumeId=23456789&from=search',
      outerHTML: '<a data-resume-id="23456789" href="https://www.liepin.com/zhaopin/?resumeId=23456789&from=search">赵敏</a>',
      textContent: '赵敏\n杭州某信息有限公司\n招商主管',
      getAttribute: (name: string) => (name === 'data-resume-id' ? '23456789' : null),
      closest: () => ({
        textContent: '赵敏\n杭州某信息有限公司\n招商主管',
        getAttribute: (name: string) => (name === 'data-candidate-id' ? '23456789' : null),
      }),
    },
  ];

  const page = {
    url: () => 'https://h.liepin.com/search/getConditionItem?key=%E4%BC%98%E8%A1%A3%E5%BA%93#session',
    waitForLoadState: async () => undefined,
    waitForResponse: async (predicate: (response: { url(): string; status(): number; text(): Promise<string> }) => boolean) => {
      const responses = [
        {
          url: () => 'https://api-h.liepin.com/api/com.liepin.searchfront4r.h.search-resumes',
          status: () => 200,
          text: async () => JSON.stringify({
            data: {
              resList: [
                {
                  resIdEncode: '23456789',
                  resName: '赵敏',
                  highLightCompOrIndustry: '杭州某信息有限公司',
                  highLightJobTitle: '招商主管',
                  detailUrl: '/resume/showresumedetail/?showsearchfeedback=1&res_id_encode=23456789&index=0',
                },
              ],
            },
          }),
        },
      ];

      for (const response of responses) {
        if (predicate(response)) {
          return response;
        }
      }

      throw new Error('unexpected response predicate');
    },
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '猎聘\n搜索条件\n人才搜索\n共1位人选',
        };
      }

      return {
        evaluateAll: async (fn: (elements: unknown[]) => unknown) => fn(cards),
      };
    },
  } as never;

  const result = await liepinAdapter.extractCandidateList(page);

  assert.deepStrictEqual(result.candidates, [
    {
      candidateId: '23456789',
      resumeUrl: 'https://h.liepin.com/resume/showresumedetail/?showsearchfeedback=1&res_id_encode=23456789&index=0',
      name: '赵敏',
      currentCompany: '杭州某信息有限公司',
      currentTitle: '招商主管',
      cardText: '赵敏__AUTORECRUIT_LINE_BREAK__杭州某信息有限公司__AUTORECRUIT_LINE_BREAK__招商主管',
      sourceText: 'https://www.liepin.com/zhaopin/?resumeId=23456789&from=search <a data-resume-id="23456789" href="https://www.liepin.com/zhaopin/?resumeId=23456789&from=search">赵敏</a> 赵敏 杭州某信息有限公司 招商主管 23456789 23456789',
    },
  ]);
});

test('liepin adapter returns complete DOM candidates without waiting for the search-resumes API', async () => {
  let waitForResponseCalls = 0;
  const cards = [
    {
      href: 'https://www.liepin.com/resume/23456789?from=search',
      outerHTML: '<a href="https://www.liepin.com/resume/23456789?from=search">赵敏</a>',
      textContent: '赵敏\n杭州某信息有限公司\n招商主管',
      closest: () => ({
        textContent: '赵敏\n杭州某信息有限公司\n招商主管',
      }),
    },
  ];
  const page = {
    url: () => 'https://h.liepin.com/search/getConditionItem?key=%E4%BC%98%E8%A1%A3%E5%BA%93#session',
    waitForLoadState: async () => undefined,
    waitForResponse: async () => {
      waitForResponseCalls += 1;
      throw new Error('search-resumes API should not block complete DOM results');
    },
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '猎聘\n搜索条件\n人才搜索\n共1位人选',
        };
      }

      return {
        evaluateAll: async (fn: (elements: unknown[]) => unknown) => fn(cards),
      };
    },
  } as never;

  const result = await liepinAdapter.extractCandidateList(page, { deadline: Date.now() + 1000 });

  assert.deepStrictEqual(result.candidates.map((candidate) => candidate.candidateId), ['23456789']);
  assert.equal(waitForResponseCalls, 0);
});

test('liepin adapter only short-waits for API fallback when DOM candidates need safe resume urls', async () => {
  const waitTimeouts: number[] = [];
  const cards = [
    {
      href: 'https://www.liepin.com/zhaopin/?resumeId=23456789&from=search',
      outerHTML: '<a data-resume-id="23456789" href="https://www.liepin.com/zhaopin/?resumeId=23456789&from=search">赵敏</a>',
      textContent: '赵敏\n杭州某信息有限公司\n招商主管',
      getAttribute: (name: string) => (name === 'data-resume-id' ? '23456789' : null),
      closest: () => ({
        textContent: '赵敏\n杭州某信息有限公司\n招商主管',
        getAttribute: (name: string) => (name === 'data-candidate-id' ? '23456789' : null),
      }),
    },
  ];
  const page = {
    url: () => 'https://h.liepin.com/search/getConditionItem?key=%E4%BC%98%E8%A1%A3%E5%BA%93#session',
    waitForLoadState: async () => undefined,
    waitForResponse: async (_predicate: unknown, options?: { timeout?: number }) => {
      waitTimeouts.push(options?.timeout ?? 0);
      await new Promise(() => undefined);
    },
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '猎聘\n搜索条件\n人才搜索\n共1位人选',
        };
      }

      return {
        evaluateAll: async (fn: (elements: unknown[]) => unknown) => fn(cards),
      };
    },
  } as never;

  const result = await liepinAdapter.extractCandidateList(page, { deadline: Date.now() + 50 });

  assert.equal(result.candidates[0]?.candidateId, '23456789');
  assert.equal(result.candidates[0]?.resumeUrl, undefined);
  assert.equal(waitTimeouts.length, 1);
  assert.ok(waitTimeouts[0] > 0 && waitTimeouts[0] <= 50);
});
test('liepin adapter ignores login-gated teaser lines in resume details', async () => {
  const page = {
    url: () => 'https://www.liepin.com/resume/11223344',
    waitForLoadState: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => [
            '猎聘',
            '搜简历',
            '张敏',
            '本科',
            '现居住地 深圳',
            '工作经历',
            '2021.01-至今',
            '深圳某科技有限公司',
            '销售经理',
            '负责大客户拓展',
            '登录后可查看',
            '立即沟通',
            '教育经历',
            '2016.09-2020.06',
            '暨南大学',
            '本科 工商管理',
            '证书',
            'PMP',
          ].join('\n'),
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;

  const resume = await liepinAdapter.parseResumeDetail(page, {
    candidateId: '11223344',
    resumeUrl: 'https://www.liepin.com/resume/11223344',
  });

  assert.deepStrictEqual(resume.workExperiences, [
    {
      company: '深圳某科技有限公司',
      title: '销售经理',
      details: ['2021.01-至今', '负责大客户拓展'],
    },
  ]);
  assert.deepStrictEqual(resume.certificates, ['PMP']);
});

test('liepin adapter skips noisy cards without an extractable candidate id signal', async () => {
  const cards = [
    {
      href: 'https://www.liepin.com/resume/77889900',
      outerHTML: '<a href="https://www.liepin.com/resume/77889900">查看简历</a>',
      textContent: '查看简历\n立即沟通\n下载简历',
      closest: () => ({
        textContent: '查看简历\n立即沟通\n下载简历',
      }),
    },
  ];

  const page = {
    url: () => 'https://www.liepin.com/zhaopin/?key=%E9%94%80%E5%94%AE',
    waitForLoadState: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '猎聘\n搜简历\n搜索结果',
        };
      }

      return {
        evaluateAll: async (fn: (elements: unknown[]) => unknown) => fn(cards),
      };
    },
  } as never;

  const result = await liepinAdapter.extractCandidateList(page);

  assert.deepStrictEqual(result.candidates, []);
});

test('liepin adapter derives candidateId from page url when the candidate payload omits it', async () => {
  const page = {
    url: () => 'https://www.liepin.com/resume/66554433?from=search',
    waitForLoadState: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => [
            '猎聘',
            '搜简历',
            '赵磊',
            '本科',
            '现居住地 广州',
            '工作经历',
            '2020.01-至今',
            '广州某电子有限公司',
            '销售主管',
          ].join('\n'),
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;

  const resume = await liepinAdapter.parseResumeDetail(page, {
    candidateId: '',
    resumeUrl: undefined,
  });

  assert.equal(resume.candidateId, '66554433');
  assert.equal(resume.resumeUrl, 'https://www.liepin.com/resume/66554433?from=search');
});

test('liepin adapter rejects generic page text that lacks recruiter-authenticated signals', async () => {
  const page = {
    url: () => 'https://www.liepin.com/zhaopin/?key=%E8%B4%B8%E6%98%93',
    waitForLoadState: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '猎聘\n登录后可查看部分内容\n搜索结果',
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;

  await assert.rejects(() => liepinAdapter.assertAuthenticated(page), /Liepin authenticated page is not available because the session has fallen back to the login screen\./);
});

test('liepin adapter uses the highest-signal duplicate card for the same candidate id', async () => {
  const cards = [
    {
      href: 'https://www.liepin.com/zhaopin/?candidateId=99887766',
      outerHTML: '<a href="https://www.liepin.com/zhaopin/?candidateId=99887766">重复候选人</a>',
      textContent: '重复候选人\n某公司\n销售经理',
      closest: () => ({
        textContent: '重复候选人\n某公司\n销售经理',
      }),
    },
    {
      href: 'https://www.liepin.com/resume/99887766',
      outerHTML: '<a data-resume-id="99887766" href="https://www.liepin.com/resume/99887766">刘洋</a>',
      textContent: '刘洋\n杭州某制造有限公司\n区域销售总监',
      getAttribute: (name: string) => (name === 'data-resume-id' ? '99887766' : null),
      closest: () => ({
        textContent: '刘洋\n杭州某制造有限公司\n区域销售总监',
        getAttribute: (name: string) => (name === 'data-resume-id' ? '99887766' : null),
      }),
    },
  ];

  const page = {
    url: () => 'https://www.liepin.com/zhaopin/?key=%E9%94%80%E5%94%AE',
    waitForLoadState: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => '猎聘\n搜简历\n搜索结果',
        };
      }

      return {
        evaluateAll: async (fn: (elements: unknown[]) => unknown) => fn(cards),
      };
    },
  } as never;

  const result = await liepinAdapter.extractCandidateList(page);

  assert.deepStrictEqual(result.candidates, [
    {
      candidateId: '99887766',
      resumeUrl: 'https://www.liepin.com/resume/99887766',
      name: '刘洋',
      currentCompany: '杭州某制造有限公司',
      currentTitle: '区域销售总监',
      cardText: '刘洋__AUTORECRUIT_LINE_BREAK__杭州某制造有限公司__AUTORECRUIT_LINE_BREAK__区域销售总监',
      sourceText: 'https://www.liepin.com/resume/99887766 <a data-resume-id="99887766" href="https://www.liepin.com/resume/99887766">刘洋</a> 刘洋 杭州某制造有限公司 区域销售总监 99887766 99887766',
    },
  ]);
});

test('liepin adapter parses sectioned resume details from page text', async () => {
  const page = {
    url: () => 'https://www.liepin.com/resume/12345678',
    waitForLoadState: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => [
            '猎聘',
            '搜简历',
            '王明',
            '本科',
            '现居住地 上海',
            '工作经历',
            '2021.03-至今',
            '上海某科技有限公司',
            '销售经理',
            '负责华东区域渠道拓展',
            '项目经历',
            '2023.01-2023.12',
            '东南亚渠道项目',
            '完成经销商开拓',
            '教育经历',
            '复旦大学',
            '本科 市场营销',
            '证书',
            '英语六级',
          ].join('\n'),
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;

  const resume = await liepinAdapter.parseResumeDetail(page, {
    candidateId: '12345678',
    resumeUrl: 'https://www.liepin.com/resume/12345678',
  });

  assert.deepStrictEqual(resume, {
    candidateId: '12345678',
    resumeUrl: 'https://www.liepin.com/resume/12345678',
    name: '王明',
    education: '本科',
    regions: ['现居住地 上海'],
    pr: [],
    workExperiences: [
      {
        company: '上海某科技有限公司',
        title: '销售经理',
        details: ['2021.03-至今', '负责华东区域渠道拓展'],
      },
    ],
    projectExperiences: [
      {
        start: '2023.01-2023.12',
        name: '东南亚渠道项目',
        details: ['完成经销商开拓'],
      },
    ],
    educationExperiences: [
      {
        school: '复旦大学',
        degree: '本科',
        major: '市场营销',
        details: [],
      },
    ],
    skill: [],
    certificates: ['英语六级'],
  });
});

test('liepin adapter keeps sections separated across multiple experience blocks', async () => {
  const page = {
    url: () => 'https://www.liepin.com/resume/99887766',
    waitForLoadState: async () => undefined,
    locator: (selector: string) => {
      if (selector === 'body') {
        return {
          waitFor: async () => undefined,
          innerText: async () => [
            '猎聘',
            '搜简历',
            '李华',
            '硕士',
            '现居住地 深圳',
            '工作经历',
            '2022-至今',
            '深圳某制造有限公司',
            '销售总监',
            '负责全国渠道体系搭建',
            '2019.03-2022.02',
            '上海某贸易有限公司',
            '销售经理',
            '带领团队完成年度目标',
            '项目经验',
            '2023-2024',
            '东南亚市场拓展项目',
            '建立本地经销网络',
            '教育经历',
            '2016-2019',
            '中山大学',
            '硕士 国际贸易',
            '证书',
            '英语八级',
            '个人优势',
            '可接受长期出差',
          ].join('\n'),
        };
      }

      return {
        first: () => ({
          waitFor: async () => undefined,
        }),
      };
    },
  } as never;

  const resume = await liepinAdapter.parseResumeDetail(page, {
    candidateId: '99887766',
    resumeUrl: 'https://www.liepin.com/resume/99887766',
  });

  assert.deepStrictEqual(resume, {
    candidateId: '99887766',
    resumeUrl: 'https://www.liepin.com/resume/99887766',
    name: '李华',
    education: '硕士',
    regions: ['现居住地 深圳'],
    pr: [],
    workExperiences: [
      {
        company: '深圳某制造有限公司',
        title: '销售总监',
        details: ['2022-至今', '负责全国渠道体系搭建'],
      },
      {
        company: '上海某贸易有限公司',
        title: '销售经理',
        details: ['2019.03-2022.02', '带领团队完成年度目标'],
      },
    ],
    projectExperiences: [
      {
        start: '2023-2024',
        name: '东南亚市场拓展项目',
        details: ['建立本地经销网络'],
      },
    ],
    educationExperiences: [
      {
        school: '中山大学',
        degree: '硕士',
        major: '国际贸易',
        details: ['2016-2019'],
      },
    ],
    skill: [],
    certificates: ['英语八级'],
  });
});
