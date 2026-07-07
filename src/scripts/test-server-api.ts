import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { handleApiRequest } from '../server/routes.js';
import { TaskQueue } from '../server/task-queue.js';
import { JobReadModel } from '../server/job-read-model.js';
import type { TaskDetail } from '../server/types.js';
import type { MainRunSummary } from '../index.js';
import type { ApplicationFilterOptions } from '../search/filter-application-options.js';
import type { CandidateResume, CandidateScoreArtifact, JobRecord, RunResult } from '../types/job.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'autorecruit-server-api-'));
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function waitForTask(queue: TaskQueue, taskId: string): Promise<TaskDetail> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2000) {
    const task = await queue.getTask(taskId);
    if (task && task.status !== 'queued' && task.status !== 'running') {
      return task;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Timed out waiting for task ${taskId}`);
}

function buildRunSummary(overrides: Partial<MainRunSummary> = {}): MainRunSummary {
  return {
    jobKey: '优衣库-店长',
    totalCandidates: 0,
    newCandidates: 0,
    scoredCandidates: 0,
    failedCandidates: 0,
    resultPath: '/tmp/result.json',
    emailAttempted: false,
    emailDelivered: false,
    sampleCandidateIds: [],
    ...overrides,
  };
}

describe('console API routes', () => {
  it('returns health status', async () => {
    const response = await handleApiRequest({
      method: 'GET',
      pathname: '/api/health',
    });

    assert.equal(response.statusCode, 200);
    assert.deepStrictEqual(response.body, {
      status: 'ok',
      service: 'autorecruit-console-api',
    });
  });

  it('queues resume-capture tasks and builds CLI-compatible argv', async () => {
    const taskDir = await makeTempDir();
    const calls: string[][] = [];
    const queue = new TaskQueue({
      taskDir,
      runner: async (argv) => {
        calls.push([...argv]);
        return buildRunSummary();
      },
    });
    const response = await handleApiRequest({
      method: 'POST',
      pathname: '/api/tasks/resume-capture',
      taskQueue: queue,
      body: {
        platform: 'all',
        keyword: '优衣库 店长',
        jd: '负责门店运营',
        includeViewed: true,
        searchSource: 'direct',
        applicationFilterInputFile: './filters.json',
        email: 'ops@example.com',
        cc: ['a@example.com', 'b@example.com'],
      },
    });

    assert.equal(response.statusCode, 202);
    const queued = response.body as TaskDetail;
    const completed = await waitForTask(queue, queued.taskId);

    assert.equal(completed.status, 'succeeded');
    assert.deepStrictEqual(calls[0], [
      '--platform',
      'all',
      '--keyword',
      '优衣库 店长',
      '--jd',
      '负责门店运营',
      '--include-viewed',
      'true',
      '--search-source',
      'direct',
      '--application-filter-input-file',
      './filters.json',
      '--email',
      'ops@example.com',
      '--cc',
      'a@example.com,b@example.com',
    ]);
    assert.equal(completed.outputSummary?.jobKey, '优衣库-店长');
  });

  it('treats blank optional strings as absent when queueing resume-capture tasks', async () => {
    const taskDir = await makeTempDir();
    const calls: string[][] = [];
    const queue = new TaskQueue({
      taskDir,
      runner: async (argv) => {
        calls.push([...argv]);
        return buildRunSummary();
      },
    });

    const response = await handleApiRequest({
      method: 'POST',
      pathname: '/api/tasks/resume-capture',
      taskQueue: queue,
      body: {
        platform: 'liepin',
        keyword: 'Java 后端',
        jd: '',
        jdFile: './fixtures/jd.txt',
        email: '',
        cc: '',
        liepinForwardContact: '',
      },
    });

    assert.equal(response.statusCode, 202);
    const queued = response.body as TaskDetail;
    const completed = await waitForTask(queue, queued.taskId);

    assert.equal(completed.status, 'succeeded');
    assert.deepStrictEqual(calls[0], [
      '--platform',
      'liepin',
      '--keyword',
      'Java 后端',
      '--jd-file',
      './fixtures/jd.txt',
    ]);
  });

  it('keeps task persistence stable when captured logs write concurrently', async () => {
    const taskDir = await makeTempDir();
    const queue = new TaskQueue({
      taskDir,
      runner: async () => {
        console.log('first captured log');
        console.log('second captured log');
        console.log('third captured log');
        return buildRunSummary();
      },
    });

    const response = await handleApiRequest({
      method: 'POST',
      pathname: '/api/tasks/resume-capture',
      taskQueue: queue,
      body: {
        platform: '51job',
        keyword: '泰国',
        jd: '负责门店运营',
      },
    });

    assert.equal(response.statusCode, 202);
    const queued = response.body as TaskDetail;
    const completed = await waitForTask(queue, queued.taskId);
    const persisted = JSON.parse(await fs.readFile(path.join(taskDir, `${queued.taskId}.json`), 'utf8')) as TaskDetail;

    assert.equal(completed.status, 'succeeded');
    assert.equal(persisted.status, 'succeeded');
    assert.equal(persisted.error, undefined);
    assert.ok(persisted.logs.some((log) => log.message === 'first captured log'));
    assert.ok(persisted.logs.some((log) => log.message === 'Task succeeded'));
  });

  it('queues login-refresh tasks through the session refresh runner', async () => {
    const taskDir = await makeTempDir();
    const cliCalls: string[][] = [];
    const refreshCalls: string[] = [];
    const queue = new TaskQueue({
      taskDir,
      runner: async (argv) => {
        cliCalls.push([...argv]);
        return buildRunSummary();
      },
      loginRefreshRunner: async (input) => {
        refreshCalls.push(input.platform);
        return {
          platform: input.platform,
          storageStatePath: `/tmp/storage-state.${input.platform}.json`,
          refreshedAt: '2026-06-10T12:00:00.000Z',
        };
      },
    });

    const response = await handleApiRequest({
      method: 'POST',
      pathname: '/api/tasks/login-refresh',
      taskQueue: queue,
      body: {
        platform: 'boss',
      },
    });

    assert.equal(response.statusCode, 202);
    const queued = response.body as TaskDetail;
    const completed = await waitForTask(queue, queued.taskId);

    assert.equal(completed.status, 'succeeded');
    assert.deepStrictEqual(cliCalls, []);
    assert.deepStrictEqual(refreshCalls, ['boss']);
    assert.equal(completed.inputSummary.platform, 'boss');
    assert.equal(completed.inputSummary.action, 'manual-login-refresh');
    assert.equal(completed.outputSummary?.platform, 'boss');
    assert.equal(completed.outputSummary?.storageStatePath, '/tmp/storage-state.boss.json');
  });

  it('queues RAG operations through the task queue', async () => {
    const taskDir = await makeTempDir();
    const cliCalls: string[][] = [];
    const ragOpsCalls: unknown[] = [];
    const queue = new TaskQueue({
      taskDir,
      runner: async (argv) => {
        cliCalls.push([...argv]);
        return buildRunSummary();
      },
      ragOpsRunner: async (input) => {
        ragOpsCalls.push(input);
        return {
          action: input.action,
          status: 'ok',
          platform: input.platform,
          jobKey: input.keyword,
          summary: {
            issueCount: 0,
          },
        };
      },
    });

    const response = await handleApiRequest({
      method: 'POST',
      pathname: '/api/tasks/rag-ops',
      taskQueue: queue,
      body: {
        action: 'doctor',
        platform: '51job',
        keyword: '优衣库 店长',
        question: '薪资是多少',
      },
    });

    assert.equal(response.statusCode, 202);
    const queued = response.body as TaskDetail;
    const completed = await waitForTask(queue, queued.taskId);

    assert.equal(completed.status, 'succeeded');
    assert.equal(completed.kind, 'rag-ops');
    assert.deepStrictEqual(cliCalls, []);
    assert.equal(ragOpsCalls.length, 1);
    assert.equal(completed.inputSummary.action, 'doctor');
    assert.equal(completed.inputSummary.platform, '51job');
    assert.equal(completed.inputSummary.keyword, '优衣库 店长');
    assert.equal(completed.outputSummary?.action, 'doctor');
    assert.equal(completed.outputSummary?.status, 'ok');
    assert.equal(completed.outputSummary?.issueCount, 0);
  });

  it('generates assistant Boss resume-capture drafts from Chinese requests', async () => {
    const completionRequests: unknown[] = [];
    const response = await handleApiRequest({
      method: 'POST',
      pathname: '/api/assistant/chat',
      body: {
        messages: [{
          role: 'user',
          content: '帮我在 Boss 搜索物业电工，筛选本科以上，3-5 年经验，JD 是负责物业电气维修。',
        }],
        modelConfig: {
          baseUrl: 'https://proxy.example.com/v1',
          model: 'assistant-test-model',
          apiKey: 'sk-test-assistant',
        },
      },
      assistantCompleteJsonText: async (request) => {
        completionRequests.push(request);
        return JSON.stringify({
          reply: '已生成 Boss 简历抓取草稿。',
          draft: {
            kind: 'resume-capture',
            input: {
              platform: 'boss',
              keyword: '物业电工',
              jd: '负责物业电气维修。',
              searchSource: 'direct',
              applicationFilterInputFile: './filters/boss.json',
            },
            missingFields: [],
            warnings: [],
          },
          clarificationQuestions: [],
        });
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(completionRequests.length, 1);
    assert.deepStrictEqual((completionRequests[0] as { settings?: unknown }).settings, {
      baseUrl: 'https://proxy.example.com/v1',
      model: 'assistant-test-model',
      apiKey: 'sk-test-assistant',
    });
    assert.match((completionRequests[0] as { instructions?: string }).instructions ?? '', /boss/);
    assert.match((completionRequests[0] as { instructions?: string }).instructions ?? '', /all 只代表 51job、liepin、zhilian/);
    assert.doesNotMatch((completionRequests[0] as { input?: string }).input ?? '', /sk-test-assistant/);
    const body = response.body as { draft?: { kind?: string; missingFields?: string[]; argvPreview?: string[]; input?: Record<string, unknown> } };
    assert.equal(body.draft?.kind, 'resume-capture');
    assert.doesNotMatch(JSON.stringify(body), /sk-test-assistant/);
    assert.deepStrictEqual(body.draft?.missingFields, []);
    assert.deepStrictEqual(body.draft?.argvPreview, [
      '--platform',
      'boss',
      '--keyword',
      '物业电工',
      '--jd',
      '负责物业电气维修。',
      '--search-source',
      'direct',
      '--application-filter-input-file',
      './filters/boss.json',
    ]);
    assert.equal(body.draft?.input?.platform, 'boss');
  });

  it('returns assistant clarification questions when JD is missing', async () => {
    const response = await handleApiRequest({
      method: 'POST',
      pathname: '/api/assistant/chat',
      body: {
        messages: [{
          role: 'user',
          content: '用这个岗位执行全部平台搜索',
        }],
      },
      assistantCompleteJsonText: async () => JSON.stringify({
        reply: '还需要补充岗位信息。',
        draft: {
          kind: 'resume-capture',
          input: {
            platform: 'all',
            keyword: '门店运营',
          },
          missingFields: [],
          warnings: [],
        },
        clarificationQuestions: ['请提供 JD 文本或 JD 文件路径。'],
      }),
    });

    assert.equal(response.statusCode, 200);
    const body = response.body as { draft?: { missingFields?: string[]; warnings?: string[] }; clarificationQuestions?: string[] };
    assert.deepStrictEqual(body.draft?.missingFields, ['jd 或 jdFile']);
    assert.match(body.clarificationQuestions?.join('\n') ?? '', /JD|jd/);
    assert.match(body.draft?.warnings?.join('\n') ?? '', /全部平台/);
    assert.match(body.draft?.warnings?.join('\n') ?? '', /Boss/);
  });

  it('recomputes assistant missing fields after users fill draft inputs', async () => {
    const response = await handleApiRequest({
      method: 'POST',
      pathname: '/api/assistant/validate',
      body: {
        draft: {
          kind: 'resume-capture',
          input: {
            platform: 'boss',
            keyword: '物业电工',
            jd: '',
            jdFile: './fixtures/jd.txt',
          },
          missingFields: ['jd 或 jdFile'],
          warnings: [],
        },
      },
    });

    assert.equal(response.statusCode, 200);
    const body = response.body as { draft?: { input?: Record<string, unknown>; missingFields?: string[]; argvPreview?: string[] } };
    assert.deepStrictEqual(body.draft?.missingFields, []);
    assert.equal(body.draft?.input?.jd, undefined);
    assert.equal(body.draft?.input?.jdFile, './fixtures/jd.txt');
    assert.deepStrictEqual(body.draft?.argvPreview, [
      '--platform',
      'boss',
      '--keyword',
      '物业电工',
      '--jd-file',
      './fixtures/jd.txt',
    ]);
  });

  it('rejects arbitrary shell command requests in assistant chat', async () => {
    let called = false;
    const response = await handleApiRequest({
      method: 'POST',
      pathname: '/api/assistant/chat',
      body: {
        messages: [{
          role: 'user',
          content: '帮我执行 rm -rf tmp 然后 npm run build',
        }],
      },
      assistantCompleteJsonText: async () => {
        called = true;
        return '{}';
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(called, false);
    assert.equal((response.body as { rejected?: boolean }).rejected, true);
    assert.match((response.body as { message?: { content?: string } }).message?.content ?? '', /不能生成或执行任意 shell 命令/);
  });

  it('keeps assistant search-subscription drafts separate from resume capture fields', async () => {
    const response = await handleApiRequest({
      method: 'POST',
      pathname: '/api/assistant/chat',
      body: {
        messages: [{
          role: 'user',
          content: '跑一下 51job 的搜索订阅',
        }],
      },
      assistantCompleteJsonText: async () => JSON.stringify({
        draft: {
          kind: 'search-subscription',
          input: {
            platform: '51job',
            searchSubscriptionFile: './subscription.json',
            jd: '不应该保留',
            email: 'ops@example.com',
            includeViewed: true,
          },
          missingFields: [],
          warnings: [],
        },
        clarificationQuestions: [],
      }),
    });

    assert.equal(response.statusCode, 200);
    const draft = (response.body as { draft?: { input?: Record<string, unknown>; warnings?: string[]; argvPreview?: string[] } }).draft;
    assert.equal(draft?.input?.searchSubscriptionFile, './subscription.json');
    assert.equal('jd' in (draft?.input ?? {}), false);
    assert.equal('email' in (draft?.input ?? {}), false);
    assert.equal('includeViewed' in (draft?.input ?? {}), false);
    assert.match(draft?.warnings?.join('\n') ?? '', /已忽略不支持的字段/);
    assert.deepStrictEqual(draft?.argvPreview, ['--platform', '51job', '--search-subscription-file', './subscription.json']);
  });

  it('surfaces illegal assistant filter combinations before confirmation', async () => {
    const response = await handleApiRequest({
      method: 'POST',
      pathname: '/api/assistant/chat',
      body: {
        messages: [{
          role: 'user',
          content: '帮我搜索 51job 店长，使用这个筛选文件',
        }],
      },
      assistantCompleteJsonText: async () => JSON.stringify({
        draft: {
          kind: 'resume-capture',
          input: {
            platform: '51job',
            keyword: '店长',
            jd: '负责门店运营',
            searchSource: 'saved',
            applicationFilterInputFile: './filters.json',
          },
          missingFields: [],
          warnings: [],
        },
        clarificationQuestions: [],
      }),
    });

    assert.equal(response.statusCode, 200);
    assert.match((response.body as { draft?: { warnings?: string[] } }).draft?.warnings?.join('\n') ?? '', /applicationFilterInputFile/);
  });

  it('confirms assistant drafts through the task queue normalizer', async () => {
    const taskDir = await makeTempDir();
    const calls: string[][] = [];
    const queue = new TaskQueue({
      taskDir,
      runner: async (argv) => {
        calls.push([...argv]);
        return buildRunSummary();
      },
    });
    const response = await handleApiRequest({
      method: 'POST',
      pathname: '/api/assistant/confirm',
      taskQueue: queue,
      body: {
        riskAccepted: true,
        draft: {
          kind: 'resume-capture',
          input: {
            platform: 'all',
            keyword: '优衣库 店长',
            jd: '负责门店运营',
            includeViewed: true,
          },
          missingFields: [],
          warnings: [],
          argvPreview: [],
        },
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { kind?: string }).kind, 'resume-capture');
    const task = (response.body as { task: TaskDetail }).task;
    const completed = await waitForTask(queue, task.taskId);
    assert.equal(completed.status, 'succeeded');
    assert.deepStrictEqual(calls[0], [
      '--platform',
      'all',
      '--keyword',
      '优衣库 店长',
      '--jd',
      '负责门店运营',
      '--include-viewed',
      'true',
    ]);
  });

  it('confirms assistant drafts with jdFile after users leave JD text blank', async () => {
    const taskDir = await makeTempDir();
    const calls: string[][] = [];
    const queue = new TaskQueue({
      taskDir,
      runner: async (argv) => {
        calls.push([...argv]);
        return buildRunSummary();
      },
    });

    const response = await handleApiRequest({
      method: 'POST',
      pathname: '/api/assistant/confirm',
      taskQueue: queue,
      body: {
        draft: {
          kind: 'resume-capture',
          input: {
            platform: 'boss',
            keyword: '物业电工',
            jd: '',
            jdFile: './fixtures/jd.txt',
          },
          missingFields: ['jd 或 jdFile'],
          warnings: [],
          argvPreview: [],
        },
      },
    });

    assert.equal(response.statusCode, 200);
    const task = (response.body as { task: TaskDetail }).task;
    const completed = await waitForTask(queue, task.taskId);
    assert.equal(completed.status, 'succeeded');
    assert.deepStrictEqual(calls[0], [
      '--platform',
      'boss',
      '--keyword',
      '物业电工',
      '--jd-file',
      './fixtures/jd.txt',
    ]);
  });

  it('answers assistant rag-answer drafts without creating tasks or browser work', async () => {
    const taskDir = await makeTempDir();
    const queue = new TaskQueue({
      taskDir,
      runner: async () => {
        throw new Error('runner should not be called');
      },
    });
    const persistedCalls: unknown[] = [];
    const response = await handleApiRequest({
      method: 'POST',
      pathname: '/api/assistant/confirm',
      taskQueue: queue,
      body: {
        draft: {
          kind: 'rag-answer',
          input: {
            platform: '51job',
            keyword: '优衣库 店长',
            question: '是否接受远程办公？',
            logAnswer: false,
          },
          missingFields: [],
          warnings: [],
        },
      },
      answerQuestion: async (options) => {
        persistedCalls.push(options);
        return {
          answer: '未找到可信答案。',
          answered: false,
          confidence: 0,
          noAnswerReason: 'no_trusted_context',
          sources: [],
        };
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { kind?: string }).kind, 'rag-answer');
    assert.equal((response.body as { answer?: { answered?: boolean } }).answer?.answered, false);
    assert.equal(persistedCalls.length, 1);
    assert.deepStrictEqual(await queue.listTasks(), []);
  });

  it('rejects invalid task parameter combinations', async () => {
    const taskDir = await makeTempDir();
    const queue = new TaskQueue({
      taskDir,
      runner: async () => buildRunSummary(),
    });

    const filterWithoutDirect = await handleApiRequest({
      method: 'POST',
      pathname: '/api/tasks/resume-capture',
      taskQueue: queue,
      body: {
        platform: '51job',
        keyword: '店长',
        applicationFilterInputFile: './filters.json',
      },
    });
    const batchWithKeyword = await handleApiRequest({
      method: 'POST',
      pathname: '/api/tasks/batch',
      taskQueue: queue,
      body: {
        platform: '51job',
        jobsFile: './jobs.json',
        keyword: '店长',
      },
    });
    const subscriptionWithIncludeViewed = await handleApiRequest({
      method: 'POST',
      pathname: '/api/tasks/search-subscription',
      taskQueue: queue,
      body: {
        platform: 'zhilian',
        searchSubscriptionFile: './subscription.json',
        includeViewed: true,
      },
    });

    assert.equal(filterWithoutDirect.statusCode, 400);
    assert.match((filterWithoutDirect.body as { error?: { message?: string } }).error?.message ?? '', /searchSource direct/);
    assert.equal(batchWithKeyword.statusCode, 400);
    assert.match((batchWithKeyword.body as { error?: { message?: string } }).error?.message ?? '', /cannot include keyword/);
    assert.equal(subscriptionWithIncludeViewed.statusCode, 400);
    assert.match((subscriptionWithIncludeViewed.body as { error?: { message?: string } }).error?.message ?? '', /cannot include includeViewed/);
  });

  it('reads application filter options and saves validated filter input files', async () => {
    const dataDir = await makeTempDir();
    const filterOptions: ApplicationFilterOptions = {
      platform: '51job',
      capturedAt: '2026-06-10T10:00:00.000Z',
      keyword: '门店',
      fieldCount: 3,
      fieldIds: ['education', 'living_location', 'age'],
      fieldIdByLabel: {
        学历: 'education',
        现居住地: 'living_location',
        年龄: 'age',
      },
      groups: {
        singleSelect: ['education'],
        textInput: ['living_location'],
        salaryRange: [],
        numberRange: ['age'],
      },
      fieldsById: {
        education: {
          fieldId: 'education',
          filterKey: '学历',
          label: '学历',
          kind: 'singleSelect',
          restrictInput: true,
          valueShape: 'string',
          acceptedInputShapes: ['string'],
          allowedValues: ['大专', '本科'],
          options: [
            { label: '大专', value: '大专', disabled: false, selected: false },
            { label: '本科', value: '本科', disabled: false, selected: false },
          ],
        },
        living_location: {
          fieldId: 'living_location',
          filterKey: '现居住地',
          label: '现居住地',
          kind: 'textInput',
          semanticKind: 'location',
          scope: 'applicationFilter',
          restrictInput: true,
          valueShape: 'string|string[]',
          acceptedInputShapes: [
            'string',
            'string[]',
            '{ value: string; pathLabels: string[] }',
            '{ value: string; pathLabels: string[] }[]',
          ],
          allowedValues: ['上海', '深圳'],
          rootValues: ['上海', '广东'],
          valuesByDepth: [],
          tree: [],
        },
        age: {
          fieldId: 'age',
          filterKey: '年龄',
          label: '年龄',
          kind: 'numberRange',
          restrictInput: true,
          valueShape: 'object',
          acceptedInputShapes: ['{ min?: number|string; max?: number|string }'],
          minKey: 'min',
          maxKey: 'max',
          minLabel: '年龄下限',
          maxLabel: '年龄上限',
          unit: '岁',
          min: 18,
          max: 65,
          orderedValues: ['18', '25', '35', '65'],
          minOptions: ['18', '25', '35'],
          maxOptions: ['25', '35', '65'],
          rule: {
            kind: 'orderedRange',
            comparison: 'maxNumberValue >= minNumberValue',
            message: '年龄上限不能低于年龄下限。',
          },
        },
      },
    };
    await writeJson(
      path.join(dataDir, '51job', 'filter-catalog', 'application-filter-options.latest.json'),
      filterOptions,
    );

    const optionsResponse = await handleApiRequest({
      method: 'GET',
      pathname: '/api/ops/application-filter-options',
      searchParams: new URLSearchParams({ platform: '51job' }),
      dataDir,
    });
    const validInput = {
      education: '本科',
      living_location: '上海',
      age: { min: 25, max: 35 },
    };
    const saveResponse = await handleApiRequest({
      method: 'POST',
      pathname: '/api/ops/filter-inputs',
      dataDir,
      body: {
        platform: '51job',
        label: '门店筛选',
        applicationFilterInput: validInput,
      },
    });
    const invalidResponse = await handleApiRequest({
      method: 'POST',
      pathname: '/api/ops/filter-inputs',
      dataDir,
      body: {
        platform: '51job',
        applicationFilterInput: {
          education: '高中',
        },
      },
    });

    assert.equal(optionsResponse.statusCode, 200);
    assert.equal((optionsResponse.body as ApplicationFilterOptions).fieldCount, 3);
    assert.equal(saveResponse.statusCode, 201);
    assert.equal((saveResponse.body as { fieldCount?: number }).fieldCount, 3);
    assert.equal((saveResponse.body as { validation?: { ok?: boolean } }).validation?.ok, true);
    const savedPath = (saveResponse.body as { absolutePath: string }).absolutePath;
    assert.equal(path.dirname(savedPath), path.join(dataDir, 'runtime', 'filter-inputs'));
    assert.deepStrictEqual(JSON.parse(await fs.readFile(savedPath, 'utf8')), validInput);
    assert.equal(invalidResponse.statusCode, 400);
    assert.match((invalidResponse.body as { error?: { message?: string } }).error?.message ?? '', /education:invalid_option/);
  });

  it('wraps search-subscription files with generated filter input files', async () => {
    const dataDir = await makeTempDir();
    const taskDir = await makeTempDir();
    const calls: string[][] = [];
    const queue = new TaskQueue({
      taskDir,
      runner: async (argv) => {
        calls.push([...argv]);
        return {
          platform: 'liepin',
          keyword: '店长',
          resultTotal: 3,
          resultTotalSource: 'page',
          saveRequested: false,
          saved: false,
          allConditionsApplied: true,
          conditionStatusCounts: { applied: 1, skipped: 0, failed: 0 },
          conditionResults: [],
        };
      },
    });
    const subscriptionPath = path.join(dataDir, 'subscription.json');
    const filterInputPath = path.join(dataDir, 'filter-input.json');
    await writeJson(subscriptionPath, {
      keyword: '店长',
      conditions: [],
    });
    await writeJson(filterInputPath, {
      education: '本科',
    });

    const response = await handleApiRequest({
      method: 'POST',
      pathname: '/api/tasks/search-subscription',
      dataDir,
      taskQueue: queue,
      body: {
        platform: 'liepin',
        searchSubscriptionFile: subscriptionPath,
        applicationFilterInputFile: filterInputPath,
      },
    });

    assert.equal(response.statusCode, 202);
    const task = response.body as TaskDetail;
    await waitForTask(queue, task.taskId);
    const argv = calls[0] ?? [];
    const wrappedPath = argv[argv.indexOf('--search-subscription-file') + 1];
    assert.ok(wrappedPath);
    assert.equal(argv.includes('--application-filter-input-file'), false);
    const wrappedAbsolutePath = path.resolve(wrappedPath);
    assert.equal(path.dirname(wrappedAbsolutePath), path.join(dataDir, 'runtime', 'search-subscriptions'));
    assert.match(path.basename(wrappedAbsolutePath), /^search-subscription-.+\.json$/);
    const wrapped = JSON.parse(await fs.readFile(wrappedAbsolutePath, 'utf8')) as { applicationFilterInputFile?: string };
    assert.ok(wrapped.applicationFilterInputFile);
    assert.equal(path.resolve(path.dirname(wrappedAbsolutePath), wrapped.applicationFilterInputFile), filterInputPath);
  });

  it('reads jobs, runs, candidates, scores, and snapshot previews', async () => {
    const dataDir = await makeTempDir();
    const jobKey = '优衣库-店长';
    const jobDir = path.join(dataDir, '51job', 'jobs', jobKey);
    const jobRecord: JobRecord = {
      platform: '51job',
      jobKey,
      searchKeyword: '优衣库 店长',
      rawText: '岗位 JD',
      normalizedJob: {
        title: '店长',
        location: '上海',
        majors: [],
        languageRequirements: [],
        responsibilities: ['门店运营'],
        hardRequirements: ['零售经验'],
        preferredRequirements: [],
        regionPreferences: ['上海'],
        industryTags: ['零售'],
      },
      createdAt: '2026-06-10T10:00:00.000Z',
    };
    const runResult: RunResult = {
      platform: '51job',
      jobKey,
      fetchedAt: '2026-06-10T11:00:00.000Z',
      totalCandidates: 1,
      newCandidateIds: ['c1'],
      scoredCandidates: ['c1'],
      failedCandidates: [],
    };
    const resume: CandidateResume = {
      candidateId: 'c1',
      name: '张三',
      age: 30,
      education: '本科',
      regions: ['上海'],
      pr: [],
      workExperiences: [{
        company: '零售公司',
        title: '店长',
        industry: '零售',
        details: ['门店运营'],
      }],
      projectExperiences: [],
      educationExperiences: [],
      skill: [],
      certificates: [],
    };
    const scoreArtifact: CandidateScoreArtifact = {
      candidateId: 'c1',
      model: 'test-model',
      scoredAt: '2026-06-10T11:01:00.000Z',
      status: 'success',
      score: {
        totalScore: 88,
        summary: '匹配度较高',
        risks: [],
        dimensionScores: {
          education: { score: 8, reason: '本科' },
          language: { score: 7, reason: '未说明' },
          experience: { score: 9, reason: '店长经验' },
          industryMatch: { score: 9, reason: '零售' },
          regionMatch: { score: 9, reason: '上海' },
          responsibilityMatch: { score: 9, reason: '运营' },
        },
      },
    };

    await writeJson(path.join(jobDir, 'jd.json'), jobRecord);
    await writeJson(path.join(jobDir, 'results', '2026-06-10T11-00-00-000Z.json'), runResult);
    await writeJson(path.join(jobDir, 'resumes', 'c1.json'), resume);
    await writeJson(path.join(jobDir, 'scores', 'c1.json'), scoreArtifact);
    await fs.mkdir(path.join(jobDir, 'snapshots'), { recursive: true });
    await fs.writeFile(path.join(jobDir, 'snapshots', 'c1.txt'), '简历原文\n工作经历', 'utf8');
    await writeJson(path.join(dataDir, 'boss', 'jobs', '物业电工', 'jd.json'), {
      ...jobRecord,
      platform: 'boss',
      jobKey: '物业电工',
      searchKeyword: '物业电工',
      normalizedJob: {
        ...jobRecord.normalizedJob,
        title: '物业电工',
      },
    });

    const model = new JobReadModel({ dataDir });
    const allJobs = await handleApiRequest({
      method: 'GET',
      pathname: '/api/jobs',
      jobReadModel: model,
    });
    const jobs = await handleApiRequest({
      method: 'GET',
      pathname: '/api/jobs',
      searchParams: new URLSearchParams({ platform: '51job' }),
      jobReadModel: model,
    });
    const detail = await handleApiRequest({
      method: 'GET',
      pathname: `/api/jobs/51job/${encodeURIComponent(jobKey)}`,
      jobReadModel: model,
    });
    const candidates = await handleApiRequest({
      method: 'GET',
      pathname: `/api/jobs/51job/${encodeURIComponent(jobKey)}/candidates`,
      jobReadModel: model,
    });
    const candidate = await handleApiRequest({
      method: 'GET',
      pathname: `/api/jobs/51job/${encodeURIComponent(jobKey)}/candidates/c1`,
      jobReadModel: model,
    });

    assert.equal(jobs.statusCode, 200);
    assert.equal(allJobs.statusCode, 200);
    assert.equal((allJobs.body as { jobs: Array<{ platform: string; jobKey: string }> }).jobs.some((job) => job.platform === 'boss' && job.jobKey === '物业电工'), true);
    assert.equal((jobs.body as { jobs: Array<{ jobKey: string }> }).jobs[0]?.jobKey, jobKey);
    assert.equal(detail.statusCode, 200);
    assert.equal((detail.body as { title?: string }).title, '店长');
    assert.equal(candidates.statusCode, 200);
    assert.equal((candidates.body as { candidates: Array<{ score?: { totalScore?: number } }> }).candidates[0]?.score?.totalScore, 88);
    assert.equal(candidate.statusCode, 200);
    assert.match((candidate.body as { snapshotPreview?: string }).snapshotPreview ?? '', /简历原文/);
  });

  it('summarizes dashboard health anomalies and funnels', async () => {
    const dataDir = await makeTempDir();
    const taskDir = await makeTempDir();
    const queue = new TaskQueue({
      taskDir,
      runner: async () => buildRunSummary(),
      loginRefreshRunner: async () => {
        throw new Error('login expired');
      },
    });
    const jobKey = '优衣库-店长';
    const jobDir = path.join(dataDir, 'liepin', 'jobs', jobKey);
    const orphanDir = path.join(dataDir, 'liepin', 'jobs', 'job-platform-export-1');
    const jobRecord: JobRecord = {
      platform: 'liepin',
      jobKey,
      searchKeyword: '优衣库 店长',
      rawText: '岗位 JD',
      normalizedJob: {
        title: '店长',
        majors: [],
        languageRequirements: [],
        responsibilities: [],
        hardRequirements: [],
        preferredRequirements: [],
        regionPreferences: [],
        industryTags: [],
      },
      createdAt: '2026-06-10T10:00:00.000Z',
    };
    const longLiepinFailure = [
      'Could not select Liepin frequent forward contact "顾春晖".',
      'Dialog text:',
      '每日任务 郭成昱 你好，郭成昱 我的主页 招聘服务 应聘管理 候选人详情',
      '工作经历 门店运营 区域管理 业绩: 协助门店完成月度销售目标210万，平均目标',
    ].join(' ');
    const successRun: RunResult = {
      platform: 'liepin',
      jobKey,
      fetchedAt: '2026-06-10T11:00:00.000Z',
      totalCandidates: 2,
      newCandidateIds: ['c1', 'c2'],
      scoredCandidates: ['c1'],
      failedCandidates: [{ candidateId: 'c2', error: longLiepinFailure }],
    };
    const zeroRun: RunResult = {
      platform: 'liepin',
      jobKey,
      fetchedAt: '2026-06-10T12:00:00.000Z',
      totalCandidates: 0,
      newCandidateIds: [],
      scoredCandidates: [],
      failedCandidates: [],
    };
    const resume: CandidateResume = {
      candidateId: 'c1',
      name: '张三',
      regions: [],
      pr: [],
      workExperiences: [],
      projectExperiences: [],
      educationExperiences: [],
      skill: [],
      certificates: [],
    };
    const scoreArtifact: CandidateScoreArtifact = {
      candidateId: 'c1',
      model: 'test-model',
      scoredAt: '2026-06-10T11:01:00.000Z',
      status: 'success',
      score: {
        totalScore: 90,
        summary: 'ok',
        risks: [],
        dimensionScores: {
          education: { score: 9, reason: 'ok' },
          language: { score: 9, reason: 'ok' },
          experience: { score: 9, reason: 'ok' },
          industryMatch: { score: 9, reason: 'ok' },
          regionMatch: { score: 9, reason: 'ok' },
          responsibilityMatch: { score: 9, reason: 'ok' },
        },
      },
    };

    await writeJson(path.join(jobDir, 'jd.json'), jobRecord);
    await writeJson(path.join(jobDir, 'results', '2026-06-10T11-00-00-000Z.json'), successRun);
    await writeJson(path.join(jobDir, 'results', '2026-06-10T12-00-00-000Z.json'), zeroRun);
    await writeJson(path.join(jobDir, 'resumes', 'c1.json'), resume);
    await writeJson(path.join(jobDir, 'scores', 'c1.json'), scoreArtifact);
    await fs.mkdir(path.join(orphanDir, 'exports'), { recursive: true });
    await fs.writeFile(path.join(orphanDir, 'exports', 'latest.md'), '# orphan\n', 'utf8');
    await writeJson(path.join(dataDir, 'liepin', 'filter-catalog', 'latest.json'), {
      platform: 'liepin',
      keyword: '优衣库',
      capturedAt: '2026-06-10T10:00:00.000Z',
      pageUrl: 'https://example.test',
      filters: [],
      failures: [],
      stats: {
        discoveredControls: 25,
        inspectedControls: 25,
        optionsExtracted: 100,
        failedControls: 1,
        unknownControls: 2,
      },
    });

    const queued = await handleApiRequest({
      method: 'POST',
      pathname: '/api/tasks/login-refresh',
      taskQueue: queue,
      body: { platform: 'liepin' },
    });
    assert.equal(queued.statusCode, 202);
    await waitForTask(queue, (queued.body as TaskDetail).taskId);

    const response = await handleApiRequest({
      method: 'GET',
      pathname: '/api/dashboard/health',
      searchParams: new URLSearchParams({ platform: 'liepin' }),
      dataDir,
      taskQueue: queue,
      jobReadModel: new JobReadModel({ dataDir }),
    });

    assert.equal(response.statusCode, 200);
    const health = response.body as {
      dataAnomalies: Array<{ missingJd: number; exportOnlyDirectories: number; sampleOrphanDirectories: string[] }>;
      platformRuns: Array<{ runCount: number; zeroCandidateRuns: number; latestFailureMessage?: string; latestFailureDetail?: string }>;
      candidateFunnels: Array<{ totalCandidates: number; newCandidates: number; capturedResumes: number; scoredCandidates: number; failedCandidates: number }>;
      filters: Array<{ fieldCount: number; failedControls: number; unknownControls: number }>;
      sessions: Array<{ recentLoginRefreshStatus?: string; recentLoginRefreshError?: string }>;
      tasks: { failed: number; latestFailureMessage?: string };
    };
    assert.equal(health.dataAnomalies[0]?.missingJd, 1);
    assert.equal(health.dataAnomalies[0]?.exportOnlyDirectories, 1);
    assert.deepStrictEqual(health.dataAnomalies[0]?.sampleOrphanDirectories, ['job-platform-export-1']);
    assert.equal(health.platformRuns[0]?.runCount, 2);
    assert.equal(health.platformRuns[0]?.zeroCandidateRuns, 1);
    assert.equal(health.platformRuns[0]?.latestFailureMessage?.endsWith('...'), true);
    assert.equal(health.platformRuns[0]?.latestFailureMessage?.includes('Dialog text:'), true);
    assert.equal(health.platformRuns[0]?.latestFailureMessage?.length, 140);
    assert.equal(health.platformRuns[0]?.latestFailureDetail, longLiepinFailure);
    assert.equal(health.candidateFunnels[0]?.totalCandidates, 2);
    assert.equal(health.candidateFunnels[0]?.newCandidates, 2);
    assert.equal(health.candidateFunnels[0]?.capturedResumes, 1);
    assert.equal(health.candidateFunnels[0]?.scoredCandidates, 1);
    assert.equal(health.candidateFunnels[0]?.failedCandidates, 1);
    assert.equal(health.filters[0]?.fieldCount, 25);
    assert.equal(health.filters[0]?.failedControls, 1);
    assert.equal(health.filters[0]?.unknownControls, 2);
    assert.equal(health.sessions[0]?.recentLoginRefreshStatus, 'failed');
    assert.equal(health.sessions[0]?.recentLoginRefreshError, 'login expired');
    assert.equal(health.tasks.failed, 1);
    assert.equal(health.tasks.latestFailureMessage, 'login expired');
  });

  it('passes through RAG no-answer results without rewriting them', async () => {
    const response = await handleApiRequest({
      method: 'POST',
      pathname: '/api/rag/answer',
      body: {
        platform: '51job',
        keyword: '优衣库 店长',
        question: '是否提供住宿？',
        logAnswer: false,
      },
      answerQuestion: async (options) => ({
        answer: '目前 JD 和已确认历史答复中未说明这一信息，建议与招聘方进一步确认。',
        answered: false,
        confidence: 0,
        noAnswerReason: 'no_trusted_context',
        sources: [],
      }),
    });

    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { jobKey?: string }).jobKey, '优衣库-店长');
    assert.equal((response.body as { answered?: boolean }).answered, false);
    assert.equal((response.body as { noAnswerReason?: string }).noAnswerReason, 'no_trusted_context');
  });

  it('passes console model config to stored RAG answers without leaking API keys', async () => {
    const persistedCalls: unknown[] = [];
    const response = await handleApiRequest({
      method: 'POST',
      pathname: '/api/rag/answer',
      body: {
        platform: '51job',
        keyword: '优衣库 店长',
        question: '薪资范围是多少？',
        logAnswer: false,
        modelConfig: {
          baseUrl: 'https://proxy.example.com/v1',
          model: 'rag-test-model',
          apiKey: 'sk-test-rag',
        },
      },
      answerQuestion: async (options) => {
        persistedCalls.push(options);
        return {
          answer: '薪资范围以 JD 为准。',
          answered: true,
          confidence: 0.9,
          sources: [],
        };
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(persistedCalls.length, 1);
    assert.deepStrictEqual((persistedCalls[0] as { llmSettings?: unknown }).llmSettings, {
      baseUrl: 'https://proxy.example.com/v1',
      model: 'rag-test-model',
      apiKey: 'sk-test-rag',
    });
    assert.doesNotMatch(JSON.stringify(response.body), /sk-test-rag/);
  });

  it('answers temporary JD questions without routing through persisted RAG', async () => {
    const persistedCalls: unknown[] = [];
    const temporaryCalls: unknown[] = [];
    const response = await handleApiRequest({
      method: 'POST',
      pathname: '/api/rag/answer',
      body: {
        platform: '51job',
        keyword: '临时 JD',
        jd: '工作地点：上海。',
        question: '工作地点在哪里？',
      },
      answerQuestion: async (options) => {
        persistedCalls.push(options);
        return {
          answer: 'should not be used',
          answered: true,
          sources: [],
        };
      },
      answerTemporaryJdQuestion: async (input) => {
        temporaryCalls.push(input);
        return {
          answer: '工作地点是上海。',
          answered: true,
          confidence: 1,
          sources: [{
            id: 'jd-1',
            label: 'JD 原文片段 1',
            text: input.rawJdText,
            score: 1,
          }],
        };
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(persistedCalls.length, 0);
    assert.equal(temporaryCalls.length, 1);
    assert.equal((response.body as { temporary?: boolean }).temporary, true);
    assert.equal((response.body as { jobKey?: string }).jobKey, '临时-jd');
    assert.equal((response.body as { answer?: string }).answer, '工作地点是上海。');
  });

  it('passes console model config to temporary JD answers without leaking API keys', async () => {
    const persistedCalls: unknown[] = [];
    const temporaryCalls: unknown[] = [];
    const response = await handleApiRequest({
      method: 'POST',
      pathname: '/api/rag/answer',
      body: {
        platform: 'zhilian',
        keyword: '临时配置',
        jd: '工作地点：杭州。',
        question: '工作地点在哪里？',
        modelConfig: {
          baseUrl: 'https://proxy.example.com/v1',
          model: 'temporary-rag-test-model',
          apiKey: 'sk-test-temporary-rag',
        },
      },
      answerQuestion: async (options) => {
        persistedCalls.push(options);
        return {
          answer: 'should not be used',
          answered: true,
          sources: [],
        };
      },
      answerTemporaryJdQuestion: async (input) => {
        temporaryCalls.push(input);
        return {
          answer: '工作地点是杭州。',
          answered: true,
          confidence: 1,
          sources: [{
            id: 'jd-1',
            label: 'JD 原文片段 1',
            text: input.rawJdText,
            score: 1,
          }],
        };
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(persistedCalls.length, 0);
    assert.equal(temporaryCalls.length, 1);
    assert.deepStrictEqual((temporaryCalls[0] as { llmSettings?: unknown }).llmSettings, {
      baseUrl: 'https://proxy.example.com/v1',
      model: 'temporary-rag-test-model',
      apiKey: 'sk-test-temporary-rag',
    });
    assert.doesNotMatch(JSON.stringify(response.body), /sk-test-temporary-rag/);
  });

  it('answers temporary JD file questions without creating persisted RAG calls', async () => {
    const dataDir = await makeTempDir();
    const jdFile = path.join(dataDir, 'jd.txt');
    await fs.writeFile(jdFile, '薪资范围：20k-30k。', 'utf8');

    const persistedCalls: unknown[] = [];
    const temporaryCalls: unknown[] = [];
    const response = await handleApiRequest({
      method: 'POST',
      pathname: '/api/rag/answer',
      body: {
        platform: 'liepin',
        jobKey: '临时薪资',
        jdFile,
        question: '薪资范围是多少？',
      },
      answerQuestion: async (options) => {
        persistedCalls.push(options);
        return {
          answer: 'should not be used',
          answered: true,
          sources: [],
        };
      },
      answerTemporaryJdQuestion: async (input) => {
        temporaryCalls.push(input);
        return {
          answer: '薪资范围是 20k-30k。',
          answered: true,
          confidence: 1,
          sources: [{
            id: 'jd-1',
            label: 'JD 原文片段 1',
            text: input.rawJdText,
            score: 1,
          }],
        };
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(persistedCalls.length, 0);
    assert.equal(temporaryCalls.length, 1);
    assert.deepStrictEqual(temporaryCalls[0], {
      rawJdText: '薪资范围：20k-30k。',
      question: '薪资范围是多少？',
    });
    assert.equal((response.body as { temporary?: boolean }).temporary, true);
    assert.equal((response.body as { jobKey?: string }).jobKey, '临时薪资');
  });

  it('answers temporary JD file questions when blank JD text is present', async () => {
    const dataDir = await makeTempDir();
    const jdFile = path.join(dataDir, 'jd.txt');
    await fs.writeFile(jdFile, '工作地点：深圳。', 'utf8');

    const persistedCalls: unknown[] = [];
    const temporaryCalls: unknown[] = [];
    const response = await handleApiRequest({
      method: 'POST',
      pathname: '/api/rag/answer',
      body: {
        platform: 'zhilian',
        jobKey: '临时地点',
        jd: '',
        jdFile,
        question: '工作地点在哪里？',
      },
      answerQuestion: async (options) => {
        persistedCalls.push(options);
        return {
          answer: 'should not be used',
          answered: true,
          sources: [],
        };
      },
      answerTemporaryJdQuestion: async (input) => {
        temporaryCalls.push(input);
        return {
          answer: '工作地点是深圳。',
          answered: true,
          confidence: 1,
          sources: [{
            id: 'jd-1',
            label: 'JD 原文片段 1',
            text: input.rawJdText,
            score: 1,
          }],
        };
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(persistedCalls.length, 0);
    assert.equal(temporaryCalls.length, 1);
    assert.deepStrictEqual(temporaryCalls[0], {
      rawJdText: '工作地点：深圳。',
      question: '工作地点在哪里？',
    });
  });
});
