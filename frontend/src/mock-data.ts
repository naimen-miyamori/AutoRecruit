import type { ApplicationFilterOptions, CandidateDetail, CandidateSummary, DashboardHealth, FilterCatalog, JobDetail, JobSummary, TaskDetail, TaskSummary } from './types';

export const mockTasks: TaskSummary[] = [
  {
    taskId: 'mock-running-001',
    kind: 'resume-capture',
    status: 'running',
    createdAt: '2026-06-10T09:10:00.000Z',
    updatedAt: '2026-06-10T09:12:00.000Z',
    startedAt: '2026-06-10T09:10:01.000Z',
    inputSummary: {
      platform: 'all',
      keyword: '优衣库 店长',
      includeViewed: false,
      searchSource: 'saved',
    },
  },
  {
    taskId: 'mock-succeeded-002',
    kind: 'resume-capture',
    status: 'succeeded',
    createdAt: '2026-06-09T14:05:00.000Z',
    updatedAt: '2026-06-09T14:30:00.000Z',
    finishedAt: '2026-06-09T14:30:00.000Z',
    inputSummary: {
      platform: 'zhilian',
      keyword: '海外零售运营',
      searchSource: 'direct',
    },
    outputSummary: {
      jobKey: '海外零售运营',
      totalCandidates: 18,
      newCandidates: 4,
      scoredCandidates: 4,
      failedCandidates: 0,
    },
  },
];

export const mockTaskDetail: TaskDetail = {
  ...mockTasks[0],
  input: {
    platform: 'all',
    keyword: '优衣库 店长',
  },
  logs: [
    { at: '2026-06-10T09:10:01.000Z', level: 'info', message: 'Task started' },
    { at: '2026-06-10T09:11:12.000Z', level: 'info', message: '51job search page ready' },
  ],
};

export const mockJobs: JobSummary[] = [
  {
    platform: '51job',
    jobKey: '优衣库-店长',
    searchKeyword: '优衣库 店长',
    title: '门店店长',
    location: '上海',
    createdAt: '2026-06-01T08:00:00.000Z',
    runCount: 6,
    candidateCount: 22,
    scoreCount: 20,
    latestRunAt: '2026-06-10T09:00:00.000Z',
    latestRun: {
      platform: '51job',
      jobKey: '优衣库-店长',
      fetchedAt: '2026-06-10T09:00:00.000Z',
      totalCandidates: 12,
      newCandidateIds: ['c-001', 'c-002'],
      scoredCandidates: ['c-001'],
      failedCandidates: [],
    },
  },
  {
    platform: 'liepin',
    jobKey: '东南亚-运营经理',
    searchKeyword: '东南亚 运营经理',
    title: '区域运营经理',
    location: '深圳',
    createdAt: '2026-06-04T08:00:00.000Z',
    runCount: 3,
    candidateCount: 9,
    scoreCount: 9,
    latestRunAt: '2026-06-09T12:00:00.000Z',
  },
];

export const mockJobDetail: JobDetail = {
  ...mockJobs[0],
  rawText: '负责门店运营、人员管理、销售目标达成。',
  normalizedJob: {
    title: '门店店长',
    location: '上海',
    responsibilities: ['门店运营', '团队管理', '销售目标'],
    hardRequirements: ['零售经验', '管理经验'],
  },
  recipientEmail: 'ops@example.com',
  exportPath: 'data/51job/jobs/优衣库-店长/exports/latest.md',
};

export const mockCandidates: CandidateSummary[] = [
  {
    platform: '51job',
    jobKey: '优衣库-店长',
    candidateId: 'c-001',
    name: '张三',
    age: 31,
    education: '本科',
    regions: ['上海'],
    currentCompany: '某零售集团',
    currentTitle: '店长',
    score: {
      status: 'success',
      totalScore: 88,
      summary: '零售管理经验扎实，区域匹配。',
    },
  },
  {
    platform: '51job',
    jobKey: '优衣库-店长',
    candidateId: 'c-002',
    name: '李四',
    age: 28,
    education: '大专',
    regions: ['苏州', '上海'],
    currentCompany: '服饰品牌',
    currentTitle: '副店长',
    score: {
      status: 'failed',
      error: '模型返回格式校验失败',
    },
  },
];

export const mockCandidateDetail: CandidateDetail = {
  ...mockCandidates[0],
  resume: {
    workExperiences: [
      {
        company: '某零售集团',
        title: '店长',
        duration: '2021-至今',
        details: ['管理 20 人团队', '负责销售目标和陈列执行'],
      },
    ],
    educationExperiences: [
      {
        school: '上海商学院',
        degree: '本科',
        major: '市场营销',
      },
    ],
  },
  snapshotPath: 'data/51job/jobs/优衣库-店长/snapshots/c-001.txt',
  snapshotPreview: '张三\n31岁 本科 上海\n某零售集团 店长\n管理 20 人团队，负责销售目标和门店运营。',
};

export const mockCatalogs: FilterCatalog[] = [
  {
    platform: 'zhilian',
    keyword: '海外零售运营',
    capturedAt: '2026-06-08T10:00:00.000Z',
    pageUrl: 'https://rd6.zhaopin.com/app/search',
    filters: [
      { key: 'education', label: '学历', controlType: 'singleSelect', valueShape: 'string', status: 'optionsExtracted', options: ['本科'] },
      { key: 'expected_salary', label: '期望月薪', controlType: 'rangeInput', valueShape: 'range', status: 'optionsExtracted', options: [] },
    ],
    failures: [],
    stats: {
      discoveredControls: 19,
      inspectedControls: 19,
      optionsExtracted: 112,
      failedControls: 0,
      unknownControls: 0,
    },
  },
];

export const mockDashboardHealth: DashboardHealth = {
  generatedAt: '2026-06-10T10:00:00.000Z',
  dataAnomalies: [
    {
      platform: '51job',
      jobDirectories: 1,
      validJobRecords: 1,
      missingJd: 0,
      emptyDirectories: 0,
      exportOnlyDirectories: 0,
      sampleOrphanDirectories: [],
    },
    {
      platform: 'liepin',
      jobDirectories: 1,
      validJobRecords: 1,
      missingJd: 0,
      emptyDirectories: 0,
      exportOnlyDirectories: 0,
      sampleOrphanDirectories: [],
    },
    {
      platform: 'zhilian',
      jobDirectories: 0,
      validJobRecords: 0,
      missingJd: 0,
      emptyDirectories: 0,
      exportOnlyDirectories: 0,
      sampleOrphanDirectories: [],
    },
  ],
  platformRuns: [
    {
      platform: '51job',
      jobCount: 1,
      runCount: 6,
      latestSuccessAt: '2026-06-10T09:00:00.000Z',
      consecutiveFailures: 0,
      zeroCandidateRuns: 1,
      zeroCandidateRate: 0.17,
    },
    {
      platform: 'liepin',
      jobCount: 1,
      runCount: 3,
      latestSuccessAt: '2026-06-09T12:00:00.000Z',
      consecutiveFailures: 0,
      zeroCandidateRuns: 0,
      zeroCandidateRate: 0,
    },
    {
      platform: 'zhilian',
      jobCount: 0,
      runCount: 0,
      consecutiveFailures: 0,
      zeroCandidateRuns: 0,
      zeroCandidateRate: 0,
    },
  ],
  candidateFunnels: [
    { platform: '51job', totalCandidates: 42, newCandidates: 8, capturedResumes: 22, scoredCandidates: 20, failedCandidates: 2, scoreArtifacts: 20 },
    { platform: 'liepin', totalCandidates: 12, newCandidates: 4, capturedResumes: 9, scoredCandidates: 9, failedCandidates: 0, scoreArtifacts: 9 },
    { platform: 'zhilian', totalCandidates: 0, newCandidates: 0, capturedResumes: 0, scoredCandidates: 0, failedCandidates: 0, scoreArtifacts: 0 },
  ],
  sessions: [
    { platform: '51job', storageStatePath: './storage-state.json', exists: true, updatedAt: '2026-06-10T08:00:00.000Z' },
    { platform: 'liepin', storageStatePath: './storage-state.liepin.json', exists: true, updatedAt: '2026-06-10T08:00:00.000Z' },
    { platform: 'zhilian', storageStatePath: './storage-state.zhilian.json', exists: false },
  ],
  filters: [
    { platform: '51job', exists: true, capturedAt: '2026-06-08T10:00:00.000Z', ageHours: 48, fieldCount: 18, failedControls: 0, unknownControls: 0, optionsExtracted: 90 },
    { platform: 'liepin', exists: true, capturedAt: '2026-06-08T10:00:00.000Z', ageHours: 48, fieldCount: 25, failedControls: 0, unknownControls: 0, optionsExtracted: 130 },
    { platform: 'zhilian', exists: true, capturedAt: '2026-06-08T10:00:00.000Z', ageHours: 48, fieldCount: 19, failedControls: 0, unknownControls: 0, optionsExtracted: 112 },
  ],
  tasks: {
    queued: 0,
    running: 1,
    succeeded: 1,
    failed: 0,
  },
};

export const mockApplicationFilterOptions: ApplicationFilterOptions = {
  platform: 'zhilian',
  capturedAt: '2026-06-08T10:00:00.000Z',
  keyword: '海外零售运营',
  fieldCount: 4,
  fieldIds: ['education', 'living_location', 'expected_salary', 'age'],
  fieldsById: {
    education: {
      fieldId: 'education',
      label: '学历要求',
      kind: 'singleSelect',
      allowedValues: ['不限', '大专及以上', '本科及以上'],
      options: [
        { label: '不限', value: '不限', disabled: false, selected: false },
        { label: '大专及以上', value: '大专及以上', disabled: false, selected: false },
        { label: '本科及以上', value: '本科及以上', disabled: false, selected: false },
      ],
    },
    living_location: {
      fieldId: 'living_location',
      label: '现居住地',
      kind: 'textInput',
      semanticKind: 'location',
      restrictInput: true,
      allowedValues: ['上海', '深圳', '广州'],
      rootValues: ['上海', '广东'],
      tree: [],
    },
    expected_salary: {
      fieldId: 'expected_salary',
      label: '期望月薪',
      kind: 'salaryRange',
      minLabel: '薪资下限',
      maxLabel: '薪资上限',
      minOptions: ['3千', '5千', '1万'],
      maxOptions: ['5千', '1万', '2万'],
    },
    age: {
      fieldId: 'age',
      label: '年龄要求',
      kind: 'numberRange',
      minLabel: '年龄下限',
      maxLabel: '年龄上限',
      unit: '岁',
      min: 16,
      max: 65,
      minOptions: ['20', '25', '30'],
      maxOptions: ['30', '35', '40'],
    },
  },
};
