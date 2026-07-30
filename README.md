# Auto Recruit — 多平台招聘自动化 CLI + 本地运营控制台

**Auto Recruit** 是一个基于 TypeScript、浏览器自动化和 OpenAI 兼容模型的本地招聘工作流工具。它把 **候选人搜索、简历抓取、JD 解析、匹配评分、人才地图、报告导出、邮件投递、RAG 问答和定时任务** 串成可复用流程，并为 Boss 提供人才发现、自动聊天、原子会话操作及职位/JD 同步能力。

生产普通抓取默认覆盖 `51job`、`liepin` 和 `zhilian`；Boss 直聘·直猎邦 Pro 可作为显式选择的单平台，或通过 `--platform all --include-boss true` 加入普通抓取和批量任务的第 4 阶段。职位、简历、评分、运行记录和 RAG 事实保存在本地 `data/`，Qdrant 仅作为可重建索引。

```bash
npm install
cp .env.example .env
npm run login:session -- --platform 51job
npm run dev -- --platform 51job --keyword "店长" --jd-file ./jd.txt
```

> 本项目面向本地、受控的招聘运营环境。浏览器登录需要人工完成；匹配、联系候选人和修改聊天状态等外部动作不会仅凭读取命令自动执行。

---

## 为什么使用 Auto Recruit？

| 场景 | 能力或入口 |
| --- | --- |
| 多平台候选人处理 | 按固定顺序运行 `51job → liepin → zhilian`，统一抓取、评分和报告 |
| 职位批量运行 | `--jobs-file` 定义多个职位，复用各自 JD、搜索条件和投递设置 |
| Talent Mapping | 多搜索切片扫描 51job、猎聘和智联，按公司/岗位族/职级/地域聚合，并对确定性样本补全详情 |
| Boss 人才发现 | 推荐牛人、原生深度搜索条件、显式确认的立即匹配和单人打招呼 |
| Boss 未读会话审核 | 读取简历、按 JD 判断、转发匹配简历并生成审核摘要 |
| Boss 职位管理 | 从职位管理页同步职位和 JD，按稳定职位 ID 建立本地映射 |
| 招聘知识问答 | 基于职位本地事实库回答 JD 和已验证招聘信息问题 |
| 本地运营控制台 | 任务队列、人才地图、自动运行计划、职位/候选人查看、RAG 运维和结构化助手草稿 |
| 数据可追溯 | JSON/JSONL 为事实来源，保留简历、评分、回执、运行摘要和导出结果 |

## 平台支持

| 平台 | 是否属于 `--platform all` | 搜索入口 | 平台能力 |
| --- | --- | --- | --- |
| `51job` | 是，第 1 个 | 保存的订阅或直接搜索 | 候选卡片详情、简历抓取与评分、核心 Talent Mapping |
| `liepin` | 是，第 2 个 | 招聘端找人或直接搜索 | 可配置常用联系人转发、核心 Talent Mapping |
| `zhilian` | 是，第 3 个 | 快捷搜索或直接搜索 | 报告邮件可使用本轮复制的分享链接、核心 Talent Mapping |
| `boss` | 可选第 4 个；仅普通抓取/批量的 `all + --include-boss true` | `https://www.zhipin.com/web/chat/search` 人才库及 Boss 专属入口 | 抓取、人才发现、聊天审核、原子操作、职位/JD 同步 |

普通 `--platform all` 串行执行前三个平台；普通抓取或批量明确加上 `--include-boss true` 后，顺序为 `51job → liepin → zhilian → boss`。任一平台失败会立即停止。搜索订阅、JD/RAG 问答、筛选发现和 Talent Mapping 的 `all` 仍只覆盖前三个平台，已有任务和自动运行计划未设置该字段时也保持三平台行为。

---

## 安装

要求：

- Node.js 24 LTS；项目支持 `>=24 <27`
- 对应招聘平台的有效账号和登录态
- 用于 JD 解析和候选人评分的 OpenAI 兼容 API，或本机已登录的 Codex/ChatGPT 会话
- 使用持久化 RAG 时可访问 Qdrant；默认还需要本地 embedding 服务

安装依赖并创建配置：

```bash
npm install
cp .env.example .env
```

编辑 `.env`，选择一种模型调用路径。默认路径使用 OpenAI 兼容服务：

```dotenv
OPENAI_API_KEY=your-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=your-model-name
```

也可以显式使用当前本机 Codex 的 ChatGPT 登录。先完成 `codex login`，再设置：

```dotenv
LLM_COMPLETION_ROUTE=codex-session
# 可选；留空使用该登录账户的默认模型
# CODEX_SESSION_MODEL=
```

两条路径严格互斥：`codex-session` 不会读取或调用 OpenAI 兼容服务；默认服务失败时也不会自动转入 Codex。Codex 路径会为每次调用创建隔离、短生命周期、只读的线程，禁止工具、网页搜索、MCP 和文件变更。可用 `npm run llm:route:doctor` 检查当前配置，或附加 `-- --verify true` 进行不含业务数据的连通性验证。

项目默认使用 CloakBrowser。如需改用 Playwright 自带 Chromium：

```dotenv
BROWSER_ENGINE=playwright
```

完整模板见 [.env.example](./.env.example)。不要提交 `.env`、浏览器登录态、候选人数据、生成报告或 `data/`。

## 登录平台

每个平台使用独立登录态。首次运行前分别登录：

```bash
npm run login:session -- --platform 51job
npm run login:session -- --platform liepin
npm run login:session -- --platform zhilian
npm run login:session -- --platform boss
```

登录必须使用有头浏览器，因此不要在登录时设置 `PLAYWRIGHT_HEADLESS=true`。默认登录态文件为：

```text
storage-state.json
storage-state.liepin.json
storage-state.zhilian.json
storage-state.boss.json
```

有头运行遇到过期会话时可以人工重新登录；无头运行会停止并提示如何刷新登录态。

---

## 模式一览

| 模式 | 入口 | 是否打开浏览器 | 是否可能产生外部动作 |
| --- | --- | --- | --- |
| 普通抓取 | `--platform <平台> --keyword ...` | 是 | 抓取；按配置转发或发送报告 |
| 多平台/批量 | `--platform all [--include-boss true]` / `--jobs-file` | 是 | 同普通抓取 |
| Talent Mapping | `--talent-mapping-file` | 是 | 卡片扫描较低风险；详情补全可能改变“已查看”状态并需本轮确认 |
| 搜索订阅 | `--search-subscription-file` | 是 | 仅显式配置时保存订阅 |
| JD/RAG 问答 | `--jd-question` / `--rag-question` | 否 | 否 |
| Boss 自动聊天 | `--boss-auto-chat true` | 是 | 可按配置转发或回复 |
| Boss 人才发现 | `--boss-talent-source` | 是 | 默认只读；立即匹配需确认 |
| Boss 单人打招呼 | `--boss-greet-candidate-id` | 是 | 是，需精确身份和确认 |
| Boss 原子会话操作 | `--boss-chat-operation` | 是 | 读取默认安全；变更需 intent 和确认 |
| Boss 职位/JD 同步 | `--boss-job-sync true` | 是 | 只更新本地职位数据 |
| 本地控制台/API | `npm run api` | 按任务决定 | 确认后的任务统一进入队列 |

这些是互相隔离的运行模式。独立模式不能随意与普通抓取、批量、搜索订阅或问答参数混用。

---

## 快速上手

### 1. 抓取并评分一个职位

新职位第一次运行必须提供 JD：

```bash
npm run dev -- \
  --platform 51job \
  --keyword "店长" \
  --jd-file ./jd.txt
```

也可以直接传入 JD 文本：

```bash
npm run dev -- \
  --platform liepin \
  --keyword "前端工程师" \
  --jd "岗位职责：..."
```

职位记录保存到 `data/<platform>/jobs/<jobKey>/`。相同平台、相同职位再次运行会复用已保存的 JD，不需要重复传入：

```bash
npm run dev -- --platform 51job --keyword "店长"
```

### 2. 运行全部生产平台

```bash
npm run dev -- \
  --platform all \
  --keyword "店长" \
  --jd-file ./jd.txt
```

该命令默认只运行 `51job`、`liepin` 和 `zhilian`。如要把直猎邦作为第 4 个普通抓取阶段，显式开启：

```bash
npm run dev -- \
  --platform all \
  --include-boss true \
  --keyword "店长" \
  --jd-file ./jd.txt
```

这不会触发 Boss 的推荐牛人、深度搜索、立即匹配、打招呼、聊天或职位同步等专属模式。

### 3. 启动本地控制台

生产模式先构建前端，再由 API 服务同时提供接口和静态页面：

```bash
npm run web:build
npm run api
```

打开 `http://127.0.0.1:4180`。`npm run build` 已同时包含服务端编译和前端 production bundle 构建。

开发模式需要 API 和 Vite 同时运行：

```bash
# 终端 1
npm run api

# 终端 2
npm run web:dev
```

开发客户端默认地址为 `http://127.0.0.1:5173`，`/api` 请求会代理到 `http://127.0.0.1:4180`。

---

## 常用工作流

### 普通抓取、直接搜索和报告

默认 `--search-source saved` 使用平台已保存的搜索入口。直接搜索必须显式指定 `direct`；如使用应用筛选输入文件，所有请求条件都必须成功应用，否则本轮停止，避免从部分筛选条件下误抓取：

```bash
npm run dev -- \
  --platform zhilian \
  --keyword "前端工程师" \
  --jd-file ./jd.txt \
  --search-source direct \
  --application-filter-input-file ./filter-input.json
```

控制台的“搜索条件集”可把已校验的直接筛选保存成独立、命名且版本固定的本地实体。条件集按平台保存于
`data/<platform>/search-condition-sets/`，不属于 JD；岗位、任务和调度只引用固定 revision 并保存本次解析快照，
因此之后编辑条件集不会改变历史运行。CLI 可在 direct 抓取中引用它：

```bash
npm run dev -- \
  --platform boss \
  --keyword "铝" \
  --jd-file ./jd.txt \
  --search-source direct \
  --search-condition-set scs-<id>@1
```

`--application-filter-input-file` 与 `--search-condition-set` 互斥。`--platform all` 使用逗号分隔的平台映射，
例如 `51job=scs-<id>@1,liepin=scs-<id>@2,boss=scs-<id>@1`；Boss 引用仍要求 `--include-boss true`。条件集在任务
入队、调度创建、每次调度轮次和浏览器启动前都重新校验当前筛选目录，字段/选项失效或语义变化会失败，绝不
静默跳过。

#### Boss 复用岗位保存设置

已通过职位同步归档的 Boss 岗位以稳定 Boss Job ID 作为本地身份。普通抓取可只提供岗位名和该 ID，复用保存的
JD、direct/saved 搜索来源、固定条件集 revision、页面搜索词、转发和报告设置，不需要再次传 JD：

```bash
npm run dev -- \
  --platform boss \
  --keyword "全铝箱包设计" \
  --boss-job-id 554cbe84c293028b0nJ72NW7FlJV
```

`--keyword` 是预期岗位名和 legacy 输入；它不再强制等于 Boss 人才页的查询词。复用保存的 direct 条件集时，
页面搜索词依次采用显式 `--boss-search-keyword`、岗位保存的 `pageKeyword`、固定 revision 的
`defaultKeyword`、岗位名。例如该岗位会使用条件集默认的“铝”，而简历、seen、评分和报告仍写入带 Boss ID
的稳定 jobKey。Boss ID 与岗位名不匹配、同名岗位不唯一、固定 revision 失效或条件校验失败都会在浏览器前
失败；系统不会创建关键词或页面搜索词目录作为替代岗位。

`--boss-search-keyword "铝制行李箱"` 只覆盖 Boss 阶段的页面查询，不影响 `all + --include-boss true` 中的前三
个平台。批量任务把 `bossJobId` 和可选 `bossSearchKeyword` 写在对应 jobs-file item；它们仅在该 item 实际选择
Boss 阶段时有效。服务端队列会把复用到的 Boss ID、页面搜索词和固定条件集 revision 固化到该任务，后续修改
岗位设置不会改变已经排队的任务。

如只需把固定 Boss 条件集应用到当前人才搜索页并取得最终验证结果，不要使用临时浏览器脚本或普通抓取。
使用以下 Boss-only 命令；它不会读取候选详情、写 seen、评分或发送报告：

```bash
npm run boss:apply-search-condition-set -- \
  --condition-set scs-<id>@1 \
  --keyword "铝" \
  --recent-viewed-policy exclude
```

`--recent-viewed-policy` 取 `exclude`（默认，勾选“过滤近14天查看”）、`include`（取消勾选）或
`condition-set`（只服从条件集内显式 toggle）。命令只在全部筛选完成业务语义复核并读取稳定结果数后输出
一条成功 JSON；取消、超时或筛选失败会以非零状态退出，绝不把中途页面状态报告为成功。

重放条件集时会先读取当前筛选状态：已满足的字段不会重复操作，输出的 `changedFields` 和
`alreadySatisfiedFields` 可用于审计本次实际变更。Boss 城市条件仅选择一级省份；例如“广东”代表该省
二级城市默认全部，不会点击肇庆等二级选项。最终复核只读取关闭状态下的页面证据，不会为了复核再次展开
或确认城市面板；只有存在无法安全增量清除的残留筛选时才会执行一次基线 reset，并在输出中给出 `resetReason`。

抓取完成后发送报告：

```bash
npm run dev -- \
  --platform liepin \
  --keyword "前端工程师" \
  --jd-file ./jd.txt \
  --email recruiter@example.com \
  --cc audit@example.com
```

默认普通抓取会排除平台页面标记为已查看的候选人；只有普通抓取可以使用 `--include-viewed true`。在 Boss 直猎邦，这一开关控制“过滤近14天查看”：默认勾选以排除平台近 14 天已查看人选，`--include-viewed true` 取消勾选。无论该开关取何值，本地 `seen-ids.json` 都仍会排除已经成功抓取过的候选人。

### 将直猎邦加入普通抓取

`--include-boss true` 只允许与普通抓取或批量任务的 `--platform all` 组合。系统会在打开第一个浏览器前，核对所有选中平台是否已有岗位 JD（或本次提供可用 JD），并在 direct 搜索时校验同一筛选输入能否被每个平台的 catalog 完整解释；任一项不满足会一次性失败，不会先运行前三个平台。

Boss 阶段复用 `data/boss/`、独立登录态和本地 `seen-ids.json`。普通抓取会将公共 `--include-viewed` 映射到直猎邦的“过滤近14天查看”：默认勾选以排除平台近 14 天已查看人选，传入 `true` 时取消勾选。这个页面筛选不等同于本地历史去重；无论页面开关取何值，`seen-ids.json` 仍会排除已经成功抓取的候选人。若 Boss 岗位已有保存的转发设置，省略本次转发参数时可能复用该设置；显式 `--boss-forward-mode` 和 `--boss-forward-recipient` 也可在 `all + --include-boss true` 中使用，并只作用于 Boss 阶段。

### 批量职位

```bash
npm run dev -- --platform all --jobs-file ./jobs.json
```

需要在每个职位末尾加入直猎邦时：

```bash
npm run dev -- --platform all --include-boss true --jobs-file ./jobs.json
```

`jobs.json` 是 JSON 数组，职位顺序是外层循环，平台顺序是内层循环。默认内层为 `51job → liepin → zhilian`；开启直猎邦后为 `51job → liepin → zhilian → boss`：

```json
[
  {
    "keyword": "店长",
    "jdFile": "./jd.txt",
    "searchSource": "direct",
    "applicationFilterInputFile": "./filters/store-manager.json",
    "bossJobId": "boss-job-id-for-this-item",
    "bossSearchKeyword": "门店零售"
  }
]
```

`--jobs-file` 是批量模式唯一的职位定义来源，不能和单职位的 `--keyword`、`--jd` 或 `--jd-file` 同时使用。相对筛选文件路径按 jobs 文件所在目录解析。
`bossJobId` 和 `bossSearchKeyword` 只在 `--platform boss` 或 `--platform all --include-boss true` 的该条目中生效；
不写时按保存岗位设置的唯一名称解析，多个同名 Boss 岗位会要求补充 ID。

批量条目也可使用 `searchConditionSets` 按平台覆盖运行级条件集；每个引用必须有明确 revision：

```json
{
  "searchConditionSets": {
    "boss": { "conditionSetId": "scs-<id>", "platform": "boss", "revision": 1 }
  }
}
```

### Talent Mapping

Talent Mapping 是独立研究模式，不复用普通职位抓取链路。它不会创建岗位 `jd.json`、读写 `seen-ids.json`、评分、转发、联系候选人、发送邮件或写入 RAG。平台范围固定为 `51job`、`liepin`、`zhilian` 和三者组成的 `all`；Boss 明确不属于 Talent Mapping 产品范围。

仓库提供脱敏计划示例 [`fixtures/talent-mapping/retail-operations.example.json`](./fixtures/talent-mapping/retail-operations.example.json)，以及仅卡片扫描/安全调度示例 [`fixtures/talent-mapping/retail-operations.card-only.example.json`](./fixtures/talent-mapping/retail-operations.card-only.example.json)。计划必须显式声明搜索切片、平台 search plan、批次/候选上限和详情策略；相对 `searchPlanFile` 从 Mapping 文件目录解析。先运行卡片扫描：

```bash
npm run dev -- \
  --platform all \
  --talent-mapping-file ./fixtures/talent-mapping/retail-operations.example.json \
  --mapping-stage scan
```

正式详情补全建议使用 `targeted-detail` 计划，并引用一次成功扫描。每轮必须重新提供确认；打开详情可能改变平台的“已查看”状态：

```bash
npm run dev -- \
  --platform all \
  --talent-mapping-file ./fixtures/talent-mapping/retail-operations.example.json \
  --mapping-stage enrich \
  --mapping-run-id <scan-run-id> \
  --mapping-confirm-detail-open true
```

也可以用 `--mapping-stage all --mapping-confirm-detail-open true` 在一轮中串行扫描并补全。每次 scan/all 会保存不可变的已校验计划快照、`planHash`、`scanContractHash` 和范围指纹；`enrich` 只能使用合同相同的扫描，搜索切片、taxonomy、归一化或覆盖范围改变后必须重新扫描。缺少合同的历史运行可浏览，但不能作为严格详情补全来源。`card-only` 输出只标识为“市场扫描 / Mapping 初筛”；`full-detail` 只有结果集不超过显式硬上限时才执行，超限会在打开任何详情前拒绝。Direct 条件必须全部应用成功才读取候选卡片，只有页面/API 的明确空结果或分页终点才能完成扫描；受批次、候选或 deadline 上限停止的运行会明确标记 `completed-with-gaps`。

本地事实和导出位于 `data/talent-mapping/<mappingKey>/`。主要交付物是平台隔离的人才清单、公司岗位矩阵、切片/详情覆盖和历次变化，以及 `candidates.csv`、`company-role-matrix.csv`、`coverage.csv`、`changes.csv`、`changes.md` 和 `summary.md`。唯一人数默认按 `platform:candidateId` 统计；系统只生成非权威的跨平台可能关联线索，人工填写审核人和证据并确认后才显示“人工关联后实体数”，撤销也保留审计记录。关联不会合并原始平台档案或改变详情执行目标。

控制台“人才地图”还提供历次运行对比和分类审核。变化报告默认比较最近两次成功的 `scan`/`all`；只有扫描合同、平台/切片/覆盖范围一致且两次完整结束时才为 `ready` 并显示“本轮未再次观察”。`partial`、`incomparable` 和 `insufficient` 仍会说明可观察差异及原因，但不会把缺失观察列为人员变化；“未再次观察”绝不解释为离职、跳槽或不再求职。模型分类任务通过共享 `TaskQueue` 执行，使用 `TALENT_MAPPING_MODEL`（未设置时回退 `OPENAI_MODEL`）；输入只含截断的当前公司、当前职位和由确定性规则确认的标准化地域，不含姓名、平台候选 ID、卡片全文、简历或联系方式。模型输出只能引用计划 taxonomy，且只有人工接受后才能填补仍为空的分类字段；接受记录可按审核人和原因撤销或以新的建议替代，冲突提交返回 `409`。所有 CSV 单元格都会中和公式前缀，详情原文快照按内容哈希不可变保存。

### 搜索订阅与 JD 问答

搜索订阅模式只应用筛选、读取结果数，并可选择保存订阅；它不会解析 JD、抓取或评分候选人，也不会改变已查看状态。该模式不接受 `--include-boss`，其 `all` 仍只覆盖前三个平台：

```bash
npm run dev -- \
  --platform zhilian \
  --search-subscription-file ./search-plan.json \
  --save-search-subscription true
```

对已保存职位提问：

```bash
npm run dev -- \
  --platform 51job \
  --keyword "店长" \
  --jd-question "这个岗位的薪资范围是多少？"
```

`--rag-question` 是别名。问答模式不打开浏览器、不抓取、不评分、不导出，也不发送邮件。临时 `--jd` 或 `--jd-file` 问答不会创建职位记录或生产 RAG 日志。

---

## Boss 工作流

Boss 专属模式只通过 `--platform boss` 运行；普通搜索/简历抓取另可通过 `--platform all --include-boss true` 作为第 4 阶段执行。网页导航、点击、输入、按键、简历转发和候选人切换都使用共享的随机操作节奏，默认约为 `2–4 秒`。

### 普通搜索与简历抓取

```bash
npm run dev -- \
  --platform boss \
  --keyword "物业电工" \
  --jd-file ./jd.txt \
  --boss-forward-mode email \
  --boss-forward-recipient resume@example.com
```

流程按候选人打开详情、按配置转发、提取并保存简历；全部新候选人抓取后再统一评分、导出和发送报告。因此普通抓取中的转发发生在评分之前，并非只转发评分合适的候选人。搜索结果必须出现候选卡片、站点明确空态或明确错误；未就绪的 iframe 不会被误记为零候选人。详情打开会按当前卡片的稳定 Boss 标识复核，不会仅按列表序号点击。

Boss 的 direct 搜索会先通过页面“清空筛选”回到基线，再按“职位 → 关键词 → 城市 → 其余条件”顺序应用并复核完整期望状态，避免复用页面继承人工或上轮条件。学历和经验的自定义范围在输入 catalog 中使用页面可见的语义边界（如“大专”“博士”“10年以上”），动作内部才转换为滑块索引，并同时核对隐藏值与可见范围文案；两个经验手柄允许重叠表示“10年以上”。城市会核对唯一的一级选中集合，并在复核后通过页面“确认”收起面板。所有筛选共用一个按条件数量计算、上限 120 秒的 deadline；任一项被后续动作重置、可见语义不符或面板未稳定收起，都会在候选人提取前失败。当前 application-filter 输入支持目录内的单选、年龄/薪资范围、院校要求多选、学历/经验自定义范围、城市、职位范围、公司文本、专业，以及“过滤近 14 天查看”“近 30 天未和同事交换简历”两个独立布尔条件；当前实页“更多筛选”以“专业”为最后一项，没有“资格证书”，Boss 不注册或导出虚构字段。该回放和核验均为确定性页面动作，不调用 LLM。

可用 `npm run verify:boss-filter-options -- --field school_nature,filter_recent_viewed` 从本地 catalog 生成逐项 dry-run 计划及明确缺口；它不打开浏览器。经单独授权后，`--run true` 可按字段或 `offset`/`limit` 分批在当前 Boss 搜索页运行：每项均按生产节奏重置、应用、回读筛选状态和读取结果就绪，再恢复进入前状态；结果仅写入被忽略目录中的无候选内容 JSONL。自定义滑块会生成离散边界 case；未发现有限建议值的动态文本输入仍会明确标为缺口。

### 推荐牛人与原生深度搜索

读取推荐候选人卡片：

```bash
npm run dev -- --platform boss --boss-talent-source recommend
```

读取或同步原生深度搜索的核心要求和加分项：

```bash
npm run dev -- \
  --platform boss \
  --boss-talent-source deep-search \
  --boss-job-id job-123 \
  --boss-expected-job-name "物业电工" \
  --boss-core-requirements-json '["持高低压电工证","2年以上物业经验"]' \
  --boss-bonus-requirements-json '["上海本地经验"]'
```

该模式默认不会点击“立即匹配”。只有同时提供以下两个参数才允许消耗匹配次数：

```bash
--boss-trigger-match true --boss-confirmed true
```

执行前还会检查职位身份、核心要求、按钮状态和剩余次数。返回结果最多保留最新 20 位候选人。

### 单人打招呼

打招呼必须提供精确候选人 ID、页面预期姓名、预期职位和显式确认：

```bash
npm run dev -- \
  --platform boss \
  --boss-greet-source deep-search \
  --boss-greet-candidate-id candidate-123 \
  --boss-expected-candidate-name "候选人甲" \
  --boss-expected-job-name "物业电工" \
  --boss-job-id job-123 \
  --boss-confirmed true
```

候选人已显示“继续沟通”时会返回已联系结果，不重复触发打招呼。姓名和列表序号只用于复核，不作为外部动作的主标识。

### 职位/JD 同步

职位同步从 Boss 职位管理读取职位和 JD，并按稳定 Boss 职位 ID 建立本地岗位记录：

```bash
npm run dev -- \
  --platform boss \
  --boss-job-sync true \
  --boss-include-closed-jobs true
```

也可以通过 `--boss-job-ids job-123,job-456` 只同步指定职位。同步解决了自动聊天必须先由人工创建并保存 JD 的问题：会话优先使用 Boss 职位 ID 定位已同步 JD，缺少 ID 时只允许使用唯一同名职位。

同名但职位 ID 不同的岗位不会合并。Boss 同步直接使用职位页的已验证字段，并只按 JD 中明确的章节、列表和数值原句做保守规则解析，不调用模型；无证据字段保持为空。JD 原文哈希和规则版本均未变化时不重写职位记录；读取或解析失败不会覆盖上一份有效 JD。

### 未读聊天审核

```bash
PLAYWRIGHT_HEADLESS=false npm run dev -- \
  --platform boss \
  --boss-auto-chat true \
  --boss-sync-jobs-before-review true \
  --boss-forward-mode email \
  --boss-forward-recipient resume@example.com \
  --boss-chat-summary-email recruiter@example.com
```

自动聊天读取首次沟通候选人的简历并按对应 JD 判断，只转发匹配候选人。`--boss-sync-jobs-before-review true` 会在审核前同步职位/JD，任一同步项失败时本轮停止。

物业电工等需要全部硬性条件同时满足的职位可增加 `--boss-chat-require-all true`。未匹配回复默认关闭，只有显式设置 `--boss-chat-reply-unqualified true` 才会发送拒绝短语。

### 原子会话操作

只读操作包括列出/打开会话、读取消息和历史、预览在线简历：

```bash
npm run dev -- \
  --platform boss \
  --boss-chat-operation list-conversations \
  --boss-unread-only true
```

发送文本示例：

```bash
npm run dev -- \
  --platform boss \
  --boss-chat-operation send-text \
  --boss-conversation-id conversation-123 \
  --boss-expected-candidate-name "候选人甲" \
  --boss-expected-job-name "物业电工" \
  --boss-chat-text "方便沟通一下吗？" \
  --boss-intent-id contact-conversation-123-v1 \
  --boss-confirmed true
```

除 `list-conversations` 外，操作需要精确会话 ID。`send-text`、`remark`、`mark-not-fit`、索要/接收附件简历、交换电话或微信均属于变更操作，必须提供唯一 intent ID 和确认。成功回执保存在 `data/boss/chat-operations/runs/`；重试相同 intent 不会重复执行，聊天框已有草稿时也不会覆盖用户文本。

---

## RAG 与职位问答

默认使用本地 embedding HTTP 服务：

```bash
python -m venv .venv
.venv/bin/pip install -r requirements-rag-embedding.txt
npm run rag:embedding:local
```

推荐配置：

```dotenv
QDRANT_URL=http://127.0.0.1:6333
RAG_EMBEDDING_PROVIDER=local-http
RAG_EMBEDDING_LOCAL_URL=http://127.0.0.1:8011
RAG_EMBEDDING_MODEL=BAAI/bge-small-zh-v1.5
RAG_RETRIEVAL_MODE=hybrid
```

常用命令：

```bash
npm run rag:index -- --platform 51job --keyword "店长"
npm run rag:ask -- --platform 51job --keyword "店长" --question "是否要求英语？"
npm run rag:doctor -- --platform 51job --keyword "店长"
npm run test:rag:offline
```

`data/<platform>/jobs/<jobKey>/rag/` 下的 JSONL 是事实来源，Qdrant 只是可重建索引。只有已验证的招聘方信息可以成为回答事实；没有可信来源或置信度不足时会返回明确的无答案结果。

---

## 控制台、API 与自动运行

本地控制台的一级工作区包括控制台、任务中心、岗位与人才、人才地图、Boss 工作台、自动化、知识与运营、智能助手和设置。人才地图页面读取本地项目、公司矩阵、人才清单、覆盖和运行记录；详情补全按钮显示本轮确定性选择的精确人数，并要求当轮安全确认。Boss 工作台集中提供职位/JD 同步、人才发现、会话中心、自动沟通审核和幂等操作回执；立即匹配、打招呼和会话变更仍需精确身份、`confirmed` 和实际 `intentId`。HTTP 或助手确认的浏览器任务统一通过 `TaskQueue` 串行执行，预览命令不是执行来源。

设置了 `AUTORECRUIT_CONSOLE_API_KEY` 时，可在客户端设置页输入控制台 Bearer token。API 地址可以写入 `localStorage`，控制台 token 只写入当前标签页会话的 `sessionStorage`；模型 API key 与控制台 token 分离，也只写入 `sessionStorage`。生产客户端在 API 故障时显示真实错误，不回退到 mock 业务数据。

Boss 持久化读模型通过以下 GET 接口提供职位、同步记录、自动沟通审核和操作回执：

```text
/api/boss/positions
/api/boss/job-sync/runs[/<runId>]
/api/boss/chat-reviews[/<runId>]
/api/boss/chat-receipts[/<intentId>]
```

这些读取不会打开浏览器或消耗 Boss 配额。下载报告、快照和回执使用 `GET /api/artifacts/:artifactId`；`artifactId` 必须来自服务端返回的白名单引用，接口不接受任意本地路径或目录遍历输入。

Talent Mapping 浏览器任务使用 `POST /api/tasks/talent-mapping`，分类建议使用 `POST /api/tasks/talent-mapping-classification` 或项目下的 `/classification-suggestions/generate`。项目、运行、人才、公司矩阵、覆盖和变化由 `/api/talent-mappings` 及其 `/:mappingKey`、`/runs`、`/candidates`、`/companies`、`/coverage`、`/changes` 子资源提供；`/entity-links` 和 `/classification-suggestions` 分别承载人工实体关联及分类建议审核，已接受建议可通过 `/classification-suggestions/:suggestionId/revoke` 以原因撤销。冲突的人工写入返回 `409`，GET 接口只读取本地事实和派生视图，不打开浏览器。

自动运行只接受 `mappingStage: "scan"` 且计划 `enrichment.mode` 为 `card-only` 的 Talent Mapping 任务；`enrich`、`all`、`targeted-detail` 和 `full-detail` 会在创建/更新计划时被服务端拒绝，调度不能静默获得详情打开权限。

“自动运行”计划可以组合：

- 普通搜索任务
- Talent Mapping `card-only` 市场扫描
- Boss 职位/JD 同步
- Boss 自动聊天

计划按每日时间窗口和轮次间隔运行，并与手工任务共享一个全局队列。普通抓取或批量计划选择 `all` 时可显式保存“包含 Boss 直聘·直猎邦 Pro”；历史计划缺少该字段时按 `false` 解释。Boss 立即匹配、单人打招呼和原子会话变更不能加入自动运行计划；新增 Boss 独立模式中只有职位/JD 同步可调度。

控制计划：

```bash
npm run schedule:stop -- --schedule-id <scheduleId>
npm run schedule:control -- pause --schedule-id <scheduleId>
npm run schedule:control -- start --schedule-id <scheduleId>
npm run schedule:control -- run-now --schedule-id <scheduleId>
```

`rag:api` 和控制台 API 是内部接口，不是完整认证网关。若需要跨机器访问，应在上游增加认证、授权、TLS、限流和审计。

---

## 数据目录

| 路径 | 内容 |
| --- | --- |
| `data/<platform>/jobs/<jobKey>/jd.json` | JD、投递设置、搜索来源和可复用条件 |
| `data/<platform>/jobs/<jobKey>/seen-ids.json` | 已成功抓取的候选人 ID |
| `data/<platform>/jobs/<jobKey>/resumes/` | 结构化简历 |
| `data/<platform>/jobs/<jobKey>/scores/` | 候选人评分及失败记录 |
| `data/<platform>/jobs/<jobKey>/results/` | 轻量运行摘要 |
| `data/<platform>/jobs/<jobKey>/exports/` | Markdown 等导出结果 |
| `data/<platform>/jobs/<jobKey>/rag/` | RAG 本地事实和索引源数据 |
| `data/talent-mapping/<mappingKey>/` | 当前 Mapping 配置、每运行不可变合同、平台观察、内容哈希详情证据/冲突记录、人工关联/分类审核、变化视图和 CSV/Markdown 导出 |
| `data/boss/chat-operations/runs/` | Boss 原子会话变更回执 |

只有成功抓取的简历会标记为已查看；详情打开、转发或提取失败仍可重试。评分失败会保存失败产物，但不会撤销已经成功抓取的状态。

---

## 配置参考

常用环境变量：

| 变量 | 用途 |
| --- | --- |
| `DATA_DIR` | 数据目录，默认 `./data` |
| `BROWSER_ENGINE` | `cloakbrowser`（默认）或 `playwright` |
| `PLAYWRIGHT_HEADLESS` | 是否使用无头浏览器 |
| `PLAYWRIGHT_SEARCH_PAGE_TIMEOUT_MS` | 搜索流程总超时 |
| `PLAYWRIGHT_RESUME_DETAIL_TIMEOUT_MS` | 候选人详情总超时 |
| `PLAYWRIGHT_<PLATFORM>_REUSE_BROWSER` | 平台级浏览器复用开关 |
| `PLAYWRIGHT_<PLATFORM>_ACTION_DELAY_MIN_MS/MAX_MS` | 平台网页动作间隔 |
| `PLAYWRIGHT_<PLATFORM>_CANDIDATE_DELAY_MIN_MS/MAX_MS` | 平台候选人切换间隔 |
| `PLAYWRIGHT_BOSS_TYPING_DELAY_MIN_MS/MAX_MS` | Boss 搜索关键词、直接聊天文本和备注的逐字间隔，默认 `80-180ms` |
| `LLM_COMPLETION_ROUTE` | `default`（默认）或 `codex-session`；只选择调用路径，不做失败自动切换 |
| `CODEX_SESSION_MODEL` | `codex-session` 的可选模型；未设置时使用当前 Codex/ChatGPT 登录的默认模型 |
| `CODEX_SESSION_TIMEOUT_MS` / `CODEX_SESSION_MAX_CONCURRENCY` | Codex 隔离线程的总超时和并发上限，默认 `120000` / `1` |
| `TALENT_MAPPING_MODEL` | Mapping 分类建议模型；未设置时回退 `OPENAI_MODEL` |
| `QDRANT_URL` / `QDRANT_API_KEY` | Qdrant 连接配置 |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | 报告邮件配置 |

正常多平台运行建议不要设置 `STORAGE_STATE_PATH`，让程序自动选择平台登录态。51job、Liepin、Zhilian 和 Boss 的操作与候选人间隔默认均为加权 `2–4 秒`：约 80% 落在 `2–3 秒`、20% 落在 `3–4 秒`。简历详情就绪后会先停留一个动作间隔再转发或解析，处理完成后再等待一个动作间隔才关闭详情页或模态框。Boss 搜索关键词、直接聊天文本和备注会在输入框获得焦点后按 `80-180ms` 的随机间隔逐字输入，标点处额外短暂停顿；常用语仍通过页面选项直接选择。鼠标点击在同一浏览器上下文中共享上一次落点，并沿分步轨迹连续移动到下一目标；必须使用原生或 DOM 点击的兼容路径也会先完成这段移动。

---

## 常见问题

### `--platform all` 会运行 Boss 吗？

默认不会。`--platform all` 按 `51job → liepin → zhilian` 顺序串行运行；普通抓取或批量加上 `--include-boss true` 后才在末尾运行 Boss 直聘·直猎邦 Pro。Boss 的人才发现、聊天和职位同步等专属模式仍必须显式使用 `--platform boss`。

### 为什么新职位必须提供 JD？

JD 是解析、评分、问答和 Boss 会话判断的职位依据。首次保存后，相同平台和职位会复用 `jd.json`；Boss 也可以通过职位/JD 同步自动建立这份映射。

### Boss 深度搜索会自动消耗“立即匹配”次数吗？

不会。条件读取和同步默认只读；只有 `--boss-trigger-match true` 与 `--boss-confirmed true` 同时存在时才可能点击立即匹配。

### 数据是否全部留在本机？

持久化业务数据以本地 JSON/JSONL 为事实来源，但配置的模型服务会接收 JD、简历或问答所需内容，SMTP 服务会接收待投递报告。请根据组织的数据合规要求选择服务、限制访问并制定备份和删除策略。

### 可以把控制台直接暴露到公网吗？

不建议。内置 API 密钥只是轻量保护，不能替代正式网关的身份认证、权限、传输加密、限流和审计。

---

## 开发与验证

```bash
npm run typecheck
npm run test
npm run build
npm run web:typecheck
npm run test:web
npm run test:talent-mapping
npm run web:build
```

聚合命令已覆盖前端：`typecheck` 包含 `web:typecheck`，`test` 包含 `test:web`，`build` 包含 `web:build`。项目还提供筛选目录发现、筛选输入校验、简历重新解析、结果导出、RAG 质量评估和平台专项测试，具体脚本见 `package.json`。

### 本地计划文档

实现、设计和治理计划统一存放于本地 `docs/plan/`，默认受 `.gitignore` 保护而不提交。首次使用或恢复工作区执行：

```bash
npm run plan:init
npm run plan:new -- --topic talent-pipeline --title "人才管道计划"
npm run plan:check
```

新计划必须使用 `YYYY-MM-DD-<topic>-plan.md`，并在顶部说明状态、最近更新和提交策略。`plan:new` 会创建模板化文档并更新本地索引；`plan:check` 会拒绝根目录、`src/` 或其他位置的计划文档。功能完成后的稳定行为仍以本 README 和 [`项目说明文档.md`](./项目说明文档.md) 为准。

## 进一步阅读

- [项目说明文档](./项目说明文档.md)：完整流程、架构、持久化、失败语义和运维说明
- [AGENTS.md](./AGENTS.md)：面向代码代理的仓库级约束；目录内还有更具体的 scoped instructions
