**目标**

把 Boss 直聘接入现有招聘自动化 CLI，逐步补齐到其他生产平台的核心能力：登录态保存、搜索页准备、候选人列表提取、简历详情打开、简历解析、评分、导出和后续筛选回放。

当前阶段只把 Boss 作为单平台能力扩展，不加入 `--platform all`。`--platform all` 仍必须保持现有公开顺序：

1. `51job`
2. `liepin`
3. `zhilian`

Boss 完整抓取链路稳定前，不改变三平台生产路径。

**当前基线**

已完成并提交：

- `16a5568 Add Boss login and search page preparation`
- `cfd81d2 Add OpenAI chat completions fallback`

Boss 相关现有入口：

- Adapter: `src/platforms/boss-adapter.ts`
- Smoke: `src/scripts/smoke-boss-search-flow.ts`
- 平台注册：`src/platforms/types.ts`、`src/platforms/registry.ts`
- Storage state: `storage-state.boss.json`，已被 `.gitignore` 忽略，不提交

**浏览器复用约束**

后续所有 Boss 现场调试和功能扩展，优先使用当前已经打开的 Boss 搜索页和 Boss reusable browser profile，不要反复新开登录页或重复执行登录流程，避免触发 Boss 风控。

具体要求：

- 优先复用当前 `data/boss/browser-profile` 对应的 Boss 浏览器窗口。
- 如果当前窗口已经在 `https://www.zhipin.com/web/chat/search`，直接复用该页面和其中的 `searchFrame`。
- 只有在没有可用 Boss 页面、页面已关闭、或登录态明确失效时，才执行登录刷新。
- 不要在调试中频繁调用 `openLoginPage` 或反复访问 `https://www.zhipin.com/web/user/?ka=header-login`。
- 新增 smoke/debug 脚本应默认走 `ensureAuthenticatedBrowserSession('boss')` 的 reusable browser 路径，并尽量保持页面打开。
- 做候选人列表、详情、解析、筛选调试时，从当前搜索页继续操作；不要为了每个步骤重新打开登录页。

可运行命令：

```bash
PLAYWRIGHT_HEADLESS=false rtk npm run login:session -- --platform boss
PLAYWRIGHT_HEADLESS=false rtk node --import ./scripts/node-ts-hooks.mjs src/scripts/smoke-boss-search-flow.ts
```

Smoke 预期输出：

```json
{
  "platform": "boss",
  "url": "https://www.zhipin.com/web/chat/search",
  "selectedJob": "不限职位",
  "browserKeptOpen": true
}
```

**已确认网页结构**

登录后默认页：

- URL: `https://www.zhipin.com/web/chat/index`
- 左侧栏“搜索”入口：
  - `a[ka="menu-geek-search"]`
  - `.menu-geeksearch a`
  - `.menu-geeksearch`

搜索页：

- URL: `https://www.zhipin.com/web/chat/search`
- 主页面只显示外层壳和标题“人才库”
- 真正搜索内容在 iframe 内：
  - frame name: `searchFrame`
  - frame URL pattern: `/web/frame/search/`
  - observed URL: `https://www.zhipin.com/web/frame/search/?jobId=&keywords=&t=&source=&city=`

搜索栏职位选择控件：

- 容器：`.search-job-list-C`
- 当前职位标签：
  - `.search-job-list-C .ui-dropmenu-label`
  - `.search-job-list-C .search-current-job`
- 下拉列表：`.search-job-list-C .ui-dropmenu-list`
- “不限职位”选项文本：`不限职位`

注意：当前职位标签文本不能写死为“物业电工”。它只是当前页面状态的一种显示，后续可能是任意职位名。自动化逻辑应点击职位选择控件本身，再选择“不限职位”。

候选人列表初步结构：

- 候选人卡片：`.geek-info-card`
- 简历打开入口：`a[ka="search_click_open_resume"]`
- 已观察到的候选人属性：
  - `data-jid`
  - `data-expect`
  - `data-lid`
  - `data-contact`
  - `data-elitegeek`
  - `data-itemid`
- 联系按钮：`button.btn-getcontact`
- 卡片文本内包含姓名脱敏、活跃度、年龄、经验、学历、求职状态、薪资、期望城市/职位、工作/院校摘要等。

**阶段计划**

**阶段 1：搜索页准备稳定化**

目标：把现有 Boss 搜索页准备能力固化为可诊断、可复用的 helper。

范围：

- 保留 `openSubscribeSearch` 当前行为：进入搜索页 iframe，点击职位选择控件，选择“不限职位”
- 抽出 Boss frame helper，例如：
  - `waitForBossSearchFrame`
  - `readBossSelectedJob`
  - `selectBossUnrestrictedJob`
- 增加失败诊断：
  - 当前 outer URL
  - frame URL 列表
  - body preview
  - 关键控件是否存在
- 所有 helper 优先复用当前已打开的 Boss 搜索页；只有不在搜索页时才点击左侧栏“搜索”，不重新打开登录页

验收：

```bash
rtk npm run typecheck
PLAYWRIGHT_HEADLESS=false rtk node --import ./scripts/node-ts-hooks.mjs src/scripts/smoke-boss-search-flow.ts
```

**阶段 2：候选人列表提取**

目标：实现 `bossAdapter.extractCandidateList`，只提取搜索结果卡片，不打开详情。

候选人 ID 策略：

- 优先使用 `data-expect`
- 再组合 `data-jid` + `data-lid`
- 最后用卡片文本 hash 作为保底，但要避免不稳定分页文本造成重复

初步字段：

- `candidateId`
- `name`，脱敏名也要保留
- `title` 或当前/期望职位摘要
- `company` 或最近工作摘要，如果卡片能稳定读到
- `resumeUrl` 暂时可为空，详情打开用 DOM 点击
- `rawText`
- `sourceUrl`
- Boss 专属 metadata，先放入可扩展字段或内部结构，避免污染共享类型

空结果判断：

- 需要现场确认 Boss 空结果文案
- 空结果应返回成功的零候选人，不应抛 extraction failure

验收：

- 新增 `src/scripts/smoke-boss-flow.ts` 或扩展 smoke 支持 `--list-only`
- 输出前 5 个候选人的 ID 和摘要
- 不打开详情、不保存 seen

**阶段 3：简历详情打开**

目标：实现 `bossAdapter.openResumeDetail`。

待确认：

- 点击 `a[ka="search_click_open_resume"]` 后，详情是 iframe 内弹层、右侧面板、新路由，还是新窗口
- 详情是否需要 hover/click 特定区域
- 详情是否有反爬校验或权限弹窗

实现原则：

- 用同一个总 deadline，避免多个固定等待串联
- 详情打开失败时候选人必须保持 retryable
- 不点击“联系Ta”，不触发沟通或权益消耗
- 只打开/读取简历详情

验收：

- smoke 打开第一个候选人详情，并输出：
  - detail readiness selector
  - detail URL/frame URL
  - detail body preview
- 失败时输出诊断，不标记 seen

**阶段 4：简历解析**

目标：实现 `bossAdapter.parseResumeDetail`，映射到共享 `CandidateResume`。

优先解析字段：

- 基础信息：姓名/脱敏名、年龄、经验、学历、求职状态、期望薪资
- 求职意向：城市、职位、行业或职能
- 工作经历：公司、职位、时间、描述
- 项目经历，如页面存在
- 教育经历：学校、专业、学历、时间
- 技能、证书、自我评价

解析策略：

- DOM 优先，文本 fallback
- 保存 raw snapshot 和结构化 resume
- 不把 Boss 特定文案硬编码进共享 parser，平台逻辑放在 `src/platforms/boss-adapter.ts`

验收：

- smoke 支持 `--parse-first`
- 能保存 `resumes/<candidateId>.json` 和 `snapshots/<candidateId>.txt`
- 至少覆盖一个真实详情样本的单测或 fixture 测试

**阶段 5：接入正常抓取主流程**

目标：让 Boss 单平台正常跑通现有主流程。

命令形态：

```bash
rtk npm run dev -- --platform boss --keyword "物业电工" --jd-file ./fixtures/jd.txt
```

行为：

- 新 job 仍要求 `--jd` 或 `--jd-file`
- 复跑复用 `data/boss/jobs/<jobKey>/jd.json`
- 成功捕获后再标记 seen
- 评分失败要保存 failed score artifact，不撤销 seen
- 导出报告保留平台来源标签 `Boss`

暂不支持：

- `--platform all` 包含 Boss
- Boss search-subscription
- Boss direct application-filter replay
- Boss 联系/沟通动作

验收：

- 单平台 Boss 能完成：搜索、列表、详情、解析、保存、评分、导出
- `data/boss/jobs/<jobKey>/` 结构与其他平台一致
- 现有三平台回归测试不变

**阶段 6：筛选发现与回放**

目标：在 Boss 搜索 iframe 内发现和应用筛选条件。

已观察到筛选区文本：

- 学历要求
- 院校要求
- 经验要求
- 年龄要求
- 其他筛选
- 性别
- 薪资区间
- 牛人活跃度
- 跳槽频率
- 求职状态
- 牛人职位要求
- 专业

实现顺序：

1. 只读发现，导出 catalog
2. 单选筛选回放
3. 区间筛选回放
4. 组合筛选回放
5. 搜索结果数量读取

验收：

- `discover:filters --platform boss` 可输出 catalog
- `--application-filter-input-file` 只在 Boss 支持字段上生效
- 任何筛选应用失败必须成为 run error，不从部分筛选状态继续抓人

**阶段 7：产品化与边界**

目标：把 Boss 平台行为与 CLI/API/前端控制台一致暴露。

需要补齐：

- HTTP task normalizer 支持 `platform: "boss"`
- 前端平台下拉支持 Boss，但标注能力状态
- Assistant draft 支持 Boss 单平台普通抓取
- RAG 路径天然支持 `data/boss/jobs/<jobKey>/rag/`，但必须等 Boss 简历/JD 数据稳定后再开放

边界：

- Boss 不做“搜索订阅”除非确认站点有等价可保存搜索
- Boss 不自动点击联系、打招呼、交换微信、交换电话
- Boss 不消耗权益类动作
- Boss 只作为单平台入口暴露；`--platform all` 和批量 all 的执行顺序仍只包含 `51job -> liepin -> zhilian`
- 控制台的岗位、总览健康、筛选目录等只读聚合可以展示 Boss 数据，但这不改变 CLI 的 all-platform 执行含义

**测试建议**

单元/离线：

- `src/scripts/test-platform-registry.ts`
- Boss adapter 纯函数测试：ID 提取、文本分段、简历解析
- Fixture-based DOM parser 测试

集成/现场：

```bash
PLAYWRIGHT_HEADLESS=false rtk node --import ./scripts/node-ts-hooks.mjs src/scripts/smoke-boss-search-flow.ts
PLAYWRIGHT_HEADLESS=false rtk npm run dev -- --platform boss --keyword "物业电工" --jd-file ./fixtures/jd.txt
```

回归：

```bash
rtk npm run typecheck
rtk node --import ./scripts/node-ts-hooks.mjs --test src/scripts/test-platform-registry.ts
rtk node --import ./scripts/node-ts-hooks.mjs --test src/scripts/test-scoring-run-semantics.ts
```

**风险与注意事项**

- Boss 后续开发必须尽量复用当前已打开的搜索页，避免重复登录、重复打开登录页或频繁创建新浏览器上下文，以降低风控风险。
- Boss 搜索主体在 iframe 内，所有搜索页 DOM 操作必须 frame-aware。
- 当前职位选择控件文本可能是任意职位名，不能写死为“物业电工”。
- 候选人卡片里的姓名可能脱敏，候选人 ID 必须优先来自 data 属性。
- 点击简历详情和点击“联系Ta”必须严格区分，避免触发沟通或权益消耗。
- 搜索结果可能包含热搜、推荐、广告或权益提示，需要先确认哪些是真实搜索结果卡片。
- Reusable browser 默认使用 `data/boss/browser-profile` 和 CDP port `19331`。
- `storage-state.boss.json`、`data/` 和 `tmp-*.png` 已忽略，不应提交。

**下一步建议**

阶段 2 已执行：

- `bossAdapter.extractCandidateList` 已实现只读列表提取。
- 候选人 ID 顺序为 `data-expect`、`data-jid` + `data-lid`、`data-jid`、`data-lid`、卡片文本 hash。
- Smoke 已输出 `totalCandidates` 和前 5 条 `sampleCandidates`。
- 早期验证时搜索 iframe 曾返回 0 候选人；后续在当前 `物业电工` 搜索页已确认 `.geek-info-card` 可稳定提取 15 条候选人。0 候选人仍应作为页面状态处理，不触发详情、不标记 seen。

阶段 3 已执行：

- `bossAdapter.openResumeDetail` 已实现。
- 详情入口是搜索 iframe 内的 `a[ka="search_click_open_resume"]`。
- 点击候选人卡片信息区域后，不会打开新页；详情出现在外层 `https://www.zhipin.com/web/chat/search` 页面里的 `.dialog-wrap.active[data-type="boss-dialog"]`。
- 详情主体嵌入 iframe：`https://www.zhipin.com/web/frame/c-resume/?source=search`。
- iframe 内简历正文不是普通 DOM 文本，而是 `canvas#resume` 渲染；已验证 canvas 可见尺寸约 `777x580`。
- 右侧操作区存在 `联系Ta`，当前实现不会点击该按钮。
- Smoke 支持 `--open-first`，会关闭已有详情弹层、按候选人 ID 重新打开第一条候选人详情，并输出 `detailFrameUrl`、`detailCanvas`、`dialogPreview`。

当前验证命令：

```bash
PLAYWRIGHT_HEADLESS=false rtk node --import ./scripts/node-ts-hooks.mjs src/scripts/smoke-boss-search-flow.ts --open-first
```

验证结果：

- `selectedJob`: `不限职位`
- `totalCandidates`: `15`
- `openedDetail.detailFrameUrl`: `https://www.zhipin.com/web/frame/c-resume/?source=search`
- `openedDetail.detailCanvas`: `{ "width": 777, "height": 580 }`

阶段 4 已执行：

- `bossAdapter.parseResumeDetail` 已实现。
- Boss 详情正文虽然是 canvas 渲染，但详情 iframe 会请求稳定 JSON 接口：
  - `https://www.zhipin.com/wapi/zpitem/web/boss/search/geek/info?...`
- Parser 读取详情 iframe performance entries 中的 `geek/info` URL，并在同源 iframe 内 `fetch` 该接口，不依赖 OCR。
- 已映射字段：
  - `geekBaseInfo.name`
  - `geekBaseInfo.ageDesc`
  - `geekBaseInfo.degreeCategory`
  - `geekBaseInfo.userDescription` / `userDesc`
  - `showExpectPosition` / `geekExpectList` 地区
  - `geekWorkExpList` 工作经历
  - `geekProjExpList` 项目经历
  - `geekEduExpList` / `highestEduExp` 教育经历
  - `geekCertificationList` / `certList` / `professionalSkill` 证书或技能文本
- Smoke 支持 `--parse-first`，会打开第一条候选人详情并输出解析摘要。

当前验证命令：

```bash
PLAYWRIGHT_HEADLESS=false rtk node --import ./scripts/node-ts-hooks.mjs src/scripts/smoke-boss-search-flow.ts --parse-first
```

验证结果：

- `totalCandidates`: `15`
- 第一条解析结果：
  - `name`: `朱**`
  - `age`: `37`
  - `education`: `大专`
  - `regions`: `["南京"]`
  - `workExperienceCount`: `2`
  - `educationExperienceCount`: `2`
- 仍未点击 `联系Ta`，未标记 seen，未消耗权益。

阶段 5 已执行：

- Boss 单平台正常抓取主流程已跑通。
- 主流程复用当前 `https://www.zhipin.com/web/chat/search` 搜索页和 `searchFrame`，没有反复打开 Boss 登录页。
- 列表提取、详情打开、API 简历解析、保存、评分、导出均完成。
- Boss 运行数据写入 `data/boss/jobs/物业电工/`，该目录属于运行数据，不提交。
- 导出报告包含平台来源标签 `boss`。
- Boss 仍未加入 `--platform all`，`all` 顺序继续保持 `51job -> liepin -> zhilian`。

验证命令：

```bash
PLAYWRIGHT_HEADLESS=false rtk npm run dev -- --platform boss --keyword "物业电工" --jd "招聘岗位：物业电工。任职要求：持低压或高压电工证，熟悉物业楼宇强弱电设备巡检、维修和保养；有住宅、商业或写字楼物业工程维修经验，能处理配电、照明、水泵、消防联动等日常故障；责任心强，服务意识好，能接受排班。工作内容：负责物业项目设备房巡检、公共区域电气维修、报修处理、维保记录和突发故障响应。"
```

验证结果：

- `jobKey`: `物业电工`
- `totalCandidates`: `15`
- `newCandidates`: `15`
- `scoredCandidates`: `15`
- `failedCandidates`: `0`
- result: `data/boss/jobs/物业电工/results/2026-07-06T10-14-14-951Z.json`
- export: `data/boss/jobs/物业电工/exports/latest.md`

阶段 6 第一步已执行：

- `bossAdapter.prepareSearchConditionPage` 已接入，复用当前 Boss 搜索页准备筛选发现页面。
- `bossAdapter.discoverSearchFilters` 已接入只读静态发现，不点击联系类按钮，不应用筛选条件。
- 当前静态 catalog 直接读取 Boss 搜索 iframe 中已展开的筛选区。
- 已导出 11 个 Boss 筛选字段，其中 4 个字段包含可直接使用的静态选项：
  - `学历要求` -> `education`
  - `院校要求` -> `school_nature`
  - `经验要求` -> `work_years`
  - `年龄要求` -> `age`
- 更多筛选区的 `性别`、`薪资区间`、`牛人活跃度`、`跳槽频率`、`求职状态`、`牛人职位要求`、`专业` 已记录为字段外壳，后续再做下拉/弹层选项展开。

验证命令：

```bash
PLAYWRIGHT_HEADLESS=false rtk npm run discover:filters -- --platform boss --keyword "物业电工" --max-depth 2 --max-options-per-level 50
rtk node --import ./scripts/node-ts-hooks.mjs src/scripts/export-application-filter-options.ts boss
```

验证结果：

- `filters`: `11`
- `failures`: `0`
- `optionsExtracted`: `28`
- latest catalog: `data/boss/filter-catalog/latest.json`
- application options: `data/boss/filter-catalog/application-filter-options.latest.json`
- `fieldIds`: `education`, `school_nature`, `work_years`, `age`

阶段 6 第二步已执行：

- Boss 更多筛选区的安全下拉/弹层选项发现已接入。
- 发现逻辑只点击筛选控件打开下拉，读取 `.dropdown-menu` / `.options` 里的选项后按 Escape 关闭，不选择任何具体选项，不应用筛选条件。
- 已读取以下更多筛选选项：
  - `性别`: `不限`、`男`、`女`
  - `薪资区间`: `不限`、`1K` 到 `50K`、`60K`、`70K`、`80K`、`90K`、`100K`、`150K`、`200K`
  - `牛人活跃度`: `不限`、`刚刚活跃`、`今日活跃`、`3日内活跃`、`近一周活跃`、`近一个月活跃`
  - `跳槽频率`: `不限`、`5年少于3份`、`时间≥1年`
  - `求职状态`: `不限`、`离职-随时到岗`、`在职-暂不考虑`、`在职-考虑机会`、`在职-月内到岗`
  - `牛人职位要求`: `不限`、`仅从事过此职位`、`最近从事此职位`、`牛人期望此职位`
- `专业` 当前只记录字段外壳，尚未展开输入/建议池。
- application options 已扩展为 10 个字段：
  - `education`
  - `school_nature`
  - `work_years`
  - `gender`
  - `recent_activity_time`
  - `job_hopping_count`
  - `job_status`
  - `candidate_position_requirement`
  - `age`
  - `expected_salary`
- 通用 application options 已支持 Boss `薪资区间` 的 `K` 单位薪资值。

验证命令：

```bash
rtk npm run typecheck
rtk node --import ./scripts/node-ts-hooks.mjs --test src/scripts/test-export-application-filter-options.ts
PLAYWRIGHT_HEADLESS=false rtk npm run discover:filters -- --platform boss --keyword "物业电工" --max-depth 2 --max-options-per-level 80
rtk node --import ./scripts/node-ts-hooks.mjs src/scripts/export-application-filter-options.ts boss
```

验证结果：

- latest catalog: `data/boss/filter-catalog/latest.json`
- `filters`: `11`
- `failures`: `0`
- `optionsExtracted`: `107`
- application options: `data/boss/filter-catalog/application-filter-options.latest.json`
- `fieldCount`: `10`

阶段 6 第三步已执行：

- `bossAdapter.applySearchCondition` 已接入 Boss `applicationFilter` 回放。
- 当前只支持已确认稳定的单选/下拉字段：
  - `education`
  - `school_nature`
  - `work_years`
  - `gender`
  - `recent_activity_time`
  - `job_hopping_count`
  - `job_status`
  - `candidate_position_requirement`
- `age`、`expected_salary`、`major` 等区间/输入字段暂不回放；传入时会返回 `failed`，避免从部分筛选状态继续抓人。
- `bossAdapter.readSearchConditionResultTotal` 已接入，当前返回搜索 iframe 内可见候选卡数量，来源标记为 `page`。
- 现场验证继续复用当前 Boss 搜索页和 reusable browser，没有打开登录页。

现场验证命令：

```bash
PLAYWRIGHT_HEADLESS=false rtk node --import ./scripts/node-ts-hooks.mjs --input-type=module <<'EOF'
import { ensureAuthenticatedBrowserSession, closeBrowserSessionRef } from './src/browser/session.ts';
import { getPlatformAdapter } from './src/platforms/registry.ts';

const session = await ensureAuthenticatedBrowserSession('boss');
const adapter = getPlatformAdapter('boss');
try {
  const page = await adapter.prepareSearchConditionPage(session.page, '物业电工', { deadline: Date.now() + 45000 });
  const fields = [
    ['education', '学历要求'],
    ['school_nature', '院校要求'],
    ['work_years', '经验要求'],
    ['gender', '性别'],
    ['recent_activity_time', '牛人活跃度'],
    ['job_hopping_count', '跳槽频率'],
    ['job_status', '求职状态'],
    ['candidate_position_requirement', '牛人职位要求'],
  ];
  for (const [fieldId, label] of fields) {
    console.log(await adapter.applySearchCondition(page, {
      kind: 'applicationFilter',
      fieldId,
      label,
      fieldKind: 'singleSelect',
      value: '不限',
      values: [{ value: '不限' }],
    }));
  }
  console.log(await adapter.readSearchConditionResultTotal(page));
} finally {
  await closeBrowserSessionRef.fn(session);
}
EOF
```

验证结果：

- 8 个字段均返回 `status: "applied"`。
- 当前页 `resultTotal`: `15`。

阶段 6 第四步已执行：

- Boss 区间字段回放已接入：
  - `expected_salary`
  - `age`
- `expected_salary` 读取 Boss `薪资区间` 的双列下拉，分别选择薪资下限和上限。
- `expected_salary` 支持 `K`、`千`、`万` 和纯数字输入归一到 Boss 页面使用的 `K` 选项，例如 `5`、`5K`、`5千` 均归一为 `5K`，`1万` 归一为 `10K`。
- `age` 优先命中页面预设：
  - `不限`
  - `20-25`
  - `25-30`
  - `30-35`
  - `35-40`
  - `40-50`
  - `50以上`
- 无法命中预设的合法年龄范围走 `自定义` 双下拉，只选择页面明确存在的年龄边界，不做近似扩大。
- Boss 更多筛选里的 `薪资区间` 已支持已选值状态定位；当控件显示 `5K-10K`、`5K-不限` 等已选值时，仍通过 `.salary-container` 识别为 `薪资区间`。
- 筛选应用后如果页面偶发 `数据加载异常`，会用当前搜索框重新触发同关键词搜索来恢复结果页。
- 现场验证继续复用当前 Boss reusable 浏览器和 `https://www.zhipin.com/web/chat/search`，没有重新打开登录页。

现场验证命令：

```bash
PLAYWRIGHT_HEADLESS=false rtk node --import ./scripts/node-ts-hooks.mjs --input-type=module <<'EOF'
import { ensureAuthenticatedBrowserSession, closeBrowserSessionRef } from './src/browser/session.ts';
import { getPlatformAdapter } from './src/platforms/registry.ts';

const session = await ensureAuthenticatedBrowserSession('boss');
const adapter = getPlatformAdapter('boss');
try {
  const page = await adapter.prepareSearchConditionPage(session.page, '物业电工', { deadline: Date.now() + 45000 });
  const salary = await adapter.applySearchCondition(page, {
    kind: 'applicationFilter',
    fieldId: 'expected_salary',
    label: '薪资区间',
    fieldKind: 'salaryRange',
    value: { min: '5K', max: '10K' },
    values: [{ value: '5K' }, { value: '10K' }],
  });
  const age = await adapter.applySearchCondition(page, {
    kind: 'applicationFilter',
    fieldId: 'age',
    label: '年龄要求',
    fieldKind: 'numberRange',
    value: { min: 25, max: 30 },
    values: [{ value: '25' }, { value: '30' }],
  });
  console.log({ salary, age, total: await adapter.readSearchConditionResultTotal(page) });
} finally {
  await closeBrowserSessionRef.fn(session);
}
EOF
```

验证结果：

- `expected_salary` 返回 `status: "applied"`。
- `age` 返回 `status: "applied"`。
- 应用后更多筛选显示 `5K-10K`。
- 应用后前 5 张候选卡年龄为 `29`、`29`、`28`、`28`、`29`，符合 `25-30` 范围。
- 重置后已恢复当前 Boss 搜索页，`物业电工` 搜索结果为 15 条，页面继续保持打开。
- 补充回归只切换 `expected_salary: 5K-10K` 再重置为 `不限-不限`，重置后 `resultTotal` 和候选卡数量均为 15。

本步回归验证：

```bash
rtk npm run typecheck
rtk node --import ./scripts/node-ts-hooks.mjs --test src/scripts/test-platform-registry.ts
rtk node --import ./scripts/node-ts-hooks.mjs --test src/scripts/test-export-application-filter-options.ts
rtk git diff --check
```

验证结果：

- typecheck 通过。
- `test-platform-registry.ts` 20 个测试通过。
- `test-export-application-filter-options.ts` 7 个测试通过。
- `git diff --check` 通过。

阶段 6 第五步已执行：

- `bossAdapter.openDirectSearch` 已接入。
- Boss direct 模式沿用现有平台约定：
  - 复用当前 Boss 搜索页。
  - 准备 `searchFrame` 和关键词。
  - 按顺序应用 `applicationFilter` 条件。
  - 任一条件返回 `failed` 或 `skipped` 时立即抛错，中断后续候选人提取。
- Boss 更多筛选已支持已选值状态下的稳定定位：
  - `薪资区间` 使用 `.salary-container` 和固定更多筛选顺序识别。
  - `牛人活跃度`、`跳槽频率` 等下拉字段即使显示当前选中值，也可通过字段顺序和 hidden placeholder 重开。
  - `求职状态`、`牛人职位要求` 等 multi-select 字段即使显示选中项，也可通过固定顺序重开。
  - 目标值为 `不限` 且控件已处于默认态时，直接视为已应用，避免默认态重置误报失败。
- 已确认 Boss 页面约束：
  - 当 `经验要求=在校/应届` 时，`求职状态` 控件会被置为 disabled。
  - 这种组合如果继续要求 `job_status` 非默认值，会在 direct 模式中作为条件失败中断。
- 现场验证继续复用当前 Boss 搜索页，没有重新打开登录页。

search-subscription CLI 验证命令：

```bash
PLAYWRIGHT_HEADLESS=false rtk npm run dev -- --platform boss --search-subscription-file data/boss/tmp-search-subscription-zero.json
```

验证结果：

- `conditionStatusCounts`: `{ "applied": 10, "skipped": 0, "failed": 0 }`
- `allConditionsApplied`: `true`
- `resultTotal`: `0`
- 未保存订阅，未抓取候选人，未打开详情。

direct normal capture CLI 成功验证命令：

```bash
PLAYWRIGHT_HEADLESS=false rtk npm run dev -- --platform boss --keyword "物业电工" --search-source direct --application-filter-input-file data/boss/tmp-direct-filter-zero.json
```

验证结果：

- `totalCandidates`: `0`
- `newCandidates`: `0`
- `scoredCandidates`: `0`
- `failedCandidates`: `0`
- 复用已有 `data/boss/jobs/物业电工/jd.json`，未重新解析 JD。
- 0 结果条件下未打开简历详情、未评分、未触发联系动作。

direct failure 中断验证命令：

```bash
PLAYWRIGHT_HEADLESS=false rtk npm run dev -- --platform boss --keyword "物业电工" --search-source direct --application-filter-input-file data/boss/tmp-direct-filter-incompatible.json
```

验证结果：

- 命令以退出码 `1` 结束。
- 错误信息：

```text
Boss direct search condition applicationFilter job_status failed: frame.waitForFunction: Timeout 5000ms exceeded.
```

- 没有输出正常抓取 summary，说明未继续进入候选人提取/简历详情/评分路径。
- 验证结束后已重置 Boss 搜索页，当前 `物业电工` 默认搜索结果恢复为 15 条。

本步回归验证：

```bash
rtk npm run typecheck
rtk node --import ./scripts/node-ts-hooks.mjs --test src/scripts/test-platform-registry.ts
rtk node --import ./scripts/node-ts-hooks.mjs --test src/scripts/test-export-application-filter-options.ts
rtk node --import ./scripts/node-ts-hooks.mjs --test src/scripts/test-search-subscription.ts
rtk git diff --check
```

验证结果：

- typecheck 通过。
- `test-platform-registry.ts` 20 个测试通过。
- `test-export-application-filter-options.ts` 7 个测试通过。
- `test-search-subscription.ts` 8 个测试通过。
- `git diff --check` 通过。

阶段 7 已执行：

- HTTP task normalizer 通过 `parsePlatformArg` 已支持 `platform: "boss"`，本阶段补了 server API 测试覆盖 Boss 登录刷新、Assistant Boss 草稿和确认、以及 `/api/jobs` 聚合读取 Boss 岗位。
- 前端 `Platform` 类型已加入 `boss`，控制台总览、岗位筛选、执行搜索、问答、运营登录刷新、问答运维和智能助手字段均已暴露 Boss 单平台选项。
- 前端执行任务页增加提示：全部平台仅包含 51job、猎聘、智联，不包含 Boss。
- 控制台只读模型默认遍历 `SUPPORTED_PLATFORMS`，因此岗位、筛选目录、健康聚合能展示 Boss 数据；CLI `all` 仍通过 `listSupportedPlatforms()` 保持三平台顺序。
- Assistant system prompt 已允许 `boss`，并明确 `all` 只代表 `51job`、`liepin`、`zhilian`；`all` 风险提示也会提示 Boss 需单独选择。
- Boss 徽标和可视化筛选构建器已补独立样式。

本步回归验证：

```bash
rtk npm run typecheck
rtk npm run web:build
rtk node --import ./scripts/node-ts-hooks.mjs --test src/scripts/test-platform-registry.ts
rtk node --import ./scripts/node-ts-hooks.mjs --test src/scripts/test-server-api.ts
```

验证结果：

- typecheck 通过。
- frontend build 通过。
- `test-platform-registry.ts` 20 个测试通过。
- `test-server-api.ts` 26 个测试通过。

补充控制台 smoke 已执行：

- 本地启动 `api` 和 `web:dev` 后访问 `http://127.0.0.1:5173`。
- 总览页已渲染 `Boss直聘`。
- 执行搜索页平台下拉包含 `Boss直聘`，并显示“全部平台仅包含 51job、猎聘、智联，不包含 Boss。”
- 问答页平台下拉包含 `Boss直聘`。
- 运营页平台筛选包含 `Boss直聘`，登录刷新按钮包含 `Boss直聘`。
- 现场 smoke 只访问本地控制台，没有打开 Boss 远程登录页，也没有触发 Boss 联系/沟通动作。

本地临时截图：`/tmp/autorecruit-boss-console-smoke.png`。

**阶段 8：Boss 简历转发**

目标：Boss 打开候选人简历后，可按任务配置选择转发给站内同事或指定邮箱，留言固定使用当前候选人 ID。

参数：

```bash
--boss-forward-mode colleague --boss-forward-recipient "同事姓名"
--boss-forward-mode email --boss-forward-recipient "recipient@example.com"
```

约束：

- 两个参数必须同时提供。
- `bossForwardMode` 只允许 `colleague` 或 `email`。
- 只允许 `--platform boss` 的普通抓取或批量任务；Boss 仍不进入 `--platform all`。
- 站内同事模式会填写姓名，并要求下拉结果唯一匹配后再选择。
- 邮件模式填写“请输入收件人邮箱”。
- 两种模式的“请输入留言”都固定填写 `candidate.candidateId`。
- 只有配置转发参数时才点击右上角 `.btn-coop-forward` 和最终 `a[ka="geek_coop_forward"]`。
- 转发失败时不解析、不标记 seen，候选人保持可重试。
- 转发弹窗会替换简历 iframe，因此执行转发前先读取并缓存详情 API payload；转发成功后从缓存继续解析。
- 不点击“联系Ta”、打招呼、交换微信或交换电话。

现场结构：

- 简历浮窗右上转发入口：`.btn-coop-forward`
- 转发弹窗：`.dialog-wrap.active .c-share-box`
- 站内同事 tab：`.nav-list .item` 文本 `站内同事`
- 站内同事输入：`input[placeholder="姓名、职位、邮箱"]`
- 邮件 tab：`.nav-list .item` 文本 `邮件转发`
- 邮件输入：`input[placeholder="请输入收件人邮箱"]`
- 留言：`textarea[placeholder="请输入留言"]`
- 最终转发：`a[ka="geek_coop_forward"]`

受控现场验证：

- 复用当前 Boss reusable browser 和搜索页，没有打开登录页。
- 使用 `prepare-only` 内部测试模式填写测试邮箱 `autorecruit-smoke@example.com` 和候选人 ID `1583748930`。
- 已确认活动模式为“邮件转发”、收件人和留言值正确、最终转发按钮唯一存在。
- 没有点击最终转发按钮，没有向站内同事或邮箱发送简历。
- 关闭转发弹窗后，已确认可从预读缓存解析候选人 `1583748930`，搜索页保持打开。

回归验证：

```bash
rtk npm run typecheck
rtk node --import ./scripts/node-ts-hooks.mjs --test src/scripts/test-server-api.ts
rtk node --import ./scripts/node-ts-hooks.mjs --test src/scripts/test-scoring-run-semantics.ts
```

验证结果：

- `rtk npm run typecheck` 通过。
- `rtk npm run web:build` 通过。
- `test-platform-registry.ts` 20 个测试通过。
- `test-server-api.ts` 27 个测试通过。
- `test-scoring-run-semantics.ts` 所在定向测试 123 个测试通过。
- 完整 `rtk npm run test` 通过：scoring 282、export 55、maintenance 44，全部 0 失败。
- 本地控制台 smoke 确认 Boss 转发方式包含“不转发 / 站内同事 / 邮件转发”，收件人字段随模式切换，Boss 平台下不会显示猎聘转发字段。
- 本地 UI 临时截图：`/tmp/autorecruit-boss-forward-ui.png`。
