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
| `51job` | 是，第 1 个 | 订阅搜索或直接搜索 | 候选卡片详情、简历抓取与评分、核心 Talent Mapping |
| `liepin` | 是，第 2 个 | 订阅搜索（招聘端找人/快捷搜索）或直接搜索 | 可配置常用联系人转发、核心 Talent Mapping |
| `zhilian` | 是，第 3 个 | 订阅搜索（快捷搜索）或直接搜索 | 报告邮件可使用本轮复制的分享链接、核心 Talent Mapping |
| `boss` | 可选第 4 个；普通抓取/批量/订阅管理的 `all + --include-boss true` | `https://www.zhipin.com/web/chat/search` 人才库及 Boss 专属入口 | 订阅搜索、原生订阅管理、抓取、人才发现、聊天审核、原子操作、职位/JD 同步 |

普通 `--platform all` 串行执行前三个平台；普通抓取、批量或订阅管理明确加上 `--include-boss true` 后，顺序为 `51job → liepin → zhilian → boss`。任一平台失败会立即停止。JD/RAG 问答、筛选发现和 Talent Mapping 的 `all` 仍只覆盖前三个平台，已有任务和自动运行计划未设置该字段时也保持三平台行为。

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

编辑 `.env`。`LLM_COMPLETION_ROUTE` 控制 JD、RAG、助手等通用文本调用；`default` 使用 OpenAI 兼容服务：

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

两条路径严格互斥：`codex-session` 不会读取或调用 OpenAI 兼容服务；默认服务失败时也不会自动转入 Codex。Codex 路径会为每次调用创建隔离、短生命周期、只读的线程，禁止工具、网页搜索、MCP 和文件变更。process、initialize、thread/start 和 turn/start 握手分别受连接超时保护；turn 一旦被接受或出现处理事件便不再使用固定总时限，只等待明确完成、协议/进程失败或人工终止。可用 `npm run llm:route:doctor` 检查当前配置，或附加 `-- --verify true` 进行不含业务数据的连通性验证。

简历评分有独立路由，默认使用当前已登录 Codex/ChatGPT 账户的模型（每次仍是隔离临时线程，不复用当前对话正文）：

```dotenv
SCORING_LLM_COMPLETION_ROUTE=codex-session
```

如需改回原 OpenAI 兼容评分接口，显式切换并保留原模型配置即可；两条评分路径也不会自动互相回退：

```dotenv
SCORING_LLM_COMPLETION_ROUTE=default
SCORING_MODEL=your-scoring-model
```

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
| 订阅管理 | `--search-subscription-file` | 是 | 默认三平台；`all + --include-boss true` 扩展 Boss 原生订阅，保存/改名是平台状态变更 |
| JD/RAG 问答 | `--jd-question` / `--rag-question` | 否 | 否 |
| Boss 自动聊天 | `--boss-auto-chat true` | 是 | 仅一次性或助手确认执行；可按配置转发或回复 |
| Boss 人才发现 | `--boss-talent-source` | 是 | 默认只读；立即匹配需确认 |
| Boss 单人打招呼 | `--boss-greet-candidate-id` | 是 | 是，需精确身份和确认 |
| Boss 原子会话操作 | `--boss-chat-operation` | 是 | 读取默认安全；变更需 intent 和确认 |
| Boss 职位/JD 同步 | `--boss-job-sync true` | 是 | 只更新本地职位数据 |
| 本地控制台/API | `npm run api` | 按任务决定 | 确认后的任务统一进入队列 |

这些是互相隔离的运行模式。独立模式不能随意与普通抓取、批量、订阅管理或问答参数混用。

控制台“新建任务”和“自动运行”中的搜索选择器直接展示五种业务模式：按岗位设置抓取、订阅搜索、直接搜索、批量抓取和订阅管理；名称、分组、顺序和副作用说明来自 `GET /api/operation-modes?surface=manual|schedule`。客户端先按请求 surface 对未知响应做运行时合同解析，再消费目录；搜索与独立任务始终只有一个活动选择。Talent Mapping、Boss 职位同步和登录刷新仍在自动化页的独立入口中选择；Boss 自动沟通保留在一次性新建任务和助手确认入口。模式目录读取失败或合同不一致时，搜索/抓取创建会明确报错并提供重试，独立任务和历史查看不受影响。

### 搜索模式断言

搜索类 CLI 推荐使用安全入口 `npm run search:run`，并明确声明业务模式：

| mode ID | 用户名称 | 关键参数 | 结果 |
| --- | --- | --- | --- |
| `capture.reuse-job-settings` | 按岗位设置抓取 | 省略 `--search-source` | 普通候选抓取，复用岗位设置 |
| `capture.subscription-search` | 订阅搜索 | `--search-source saved` | 普通候选抓取，使用保存入口 |
| `capture.direct-search` | 直接搜索 | `--search-source direct` | 普通候选抓取，使用本次条件 |
| `batch.capture` | 批量抓取 | `--jobs-file ...` | 按 jobs 文件逐项执行 |
| `subscription.manage` | 订阅管理 | `--search-subscription-file ...` | 只读取/可保存订阅，不抓候选 |

例如执行 51job 的“订阅搜索”（不是订阅管理）：

```bash
npm run search:run -- \
  --mode-id capture.subscription-search \
  --platform 51job \
  --keyword "铝镁合金" \
  --search-source saved \
  --jd-file ./jd.txt
```

旧的 `npm run dev` 命令仍兼容，但省略 `--mode-id` 时只会在 stderr 提示参数推导出的模式；AI 或人工代运行不要绕过
`search:run`。模式不一致会在打开浏览器前失败，stdout JSON 保持机器可读。

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

### 普通抓取、订阅搜索、直接搜索和报告

普通抓取中，用户可见名称“订阅搜索”对应内部 `--search-source saved`，“直接搜索”对应
`--search-source direct`。订阅搜索使用平台已保存的订阅/快捷搜索入口；直接搜索必须显式指定 `direct`。如使用应用筛选输入文件，所有请求条件都必须成功应用，否则本轮停止，避免从部分筛选条件下误抓取：

对话助手把三者作为独立业务模式：`订阅搜索` 是普通候选抓取，`直接搜索` 是带本次筛选的普通候选抓取，`订阅管理` 是只应用条件并读取结果数的独立 `search-subscription` 模式。确认前会显示模式和副作用；发送新消息后旧草稿立即失效，模式冲突、未知模式或多个模式名称同时出现时不会保留确认入口或入队。Boss 普通抓取还会提示可能复用岗位已保存的转发、报告邮件和模型分流设置，并要求再次接受该风险。

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
  --keyword "工业设计师" \
  --boss-job-id boss-job-id-123
```

`--keyword` 是预期岗位名和 legacy 输入；它不再强制等于 Boss 人才页的查询词。复用保存的 direct 条件集时，
页面搜索词依次采用显式 `--boss-search-keyword`、岗位保存的 `pageKeyword`、固定 revision 的
`defaultKeyword`、岗位名。例如岗位可使用条件集中的细分品类词，而简历、seen、评分和报告仍写入带 Boss ID
的稳定 jobKey。Boss ID 与岗位名不匹配、同名岗位不唯一、固定 revision 失效或条件校验失败都会在浏览器前
失败；系统不会创建关键词或页面搜索词目录作为替代岗位。

`--boss-search-keyword "铝制行李箱"` 只覆盖 Boss 阶段的页面查询，不影响 `all + --include-boss true` 中的前三
个平台。批量任务把 `bossJobId` 和可选 `bossSearchKeyword` 写在对应 jobs-file item；它们仅在该 item 实际选择
Boss 阶段时有效。使用 Boss 订阅搜索（内部 `saved`）时，同一 item 还可以提供完整 `bossSavedSearchReference`；它会按单岗位
同样的 schema、关键词、职位范围和指纹规则校验并固化，不能只写订阅名称。服务端队列会把复用到的 Boss ID、页面搜索词和固定条件集 revision 固化到该任务，后续修改
岗位设置不会改变已经排队的任务。

Boss 的 `searchSource=saved` 只能复用完整的原生订阅引用：名称、职位范围、页面关键词、条件身份和条件指纹必须同时存在，
名称不能单独合成筛选条件。已绑定且当前 source 仍为 saved 的同一岗位，显式选择 saved 时会安全复用并重新验证岗位记录中的完整引用；direct 岗位中的残留引用不会被带入。缺少引用或指纹不匹配会在浏览器前失败，不再回退到旧的“不限职位 + 重填关键词”入口。由 Boss
订阅管理保存结果得到的引用可通过 `bossSavedSearchReference`（HTTP/队列输入）或
`--boss-saved-search-reference-json`（CLI 单岗位）传入；执行前仍会按“名称 + 关键词 + 条件身份”重新定位并核对原生卡片。
运行时的“匹配度优先”和本轮已查看覆盖不写入条件指纹；它们只属于本轮搜索策略。

Legacy 岗位需要先绑定原生订阅时，使用独立的 Boss-only 绑定模式，把订阅管理结果中的完整 JSON 引用传入；它会在一次
有界的原生卡片验证后用 JobStore CAS 写回岗位，不读取候选、不打开详情、不写 seen/评分/报告，且必须显式确认：

```bash
npm run dev -- \
  --platform boss \
  --keyword "全铝箱包设计" \
  --boss-bind-saved-search true \
  --boss-confirmed true \
  --boss-saved-search-reference-json '<订阅管理输出中的完整 savedSearch JSON>'
```

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

抓取时同时发送评分总结报告：

```bash
npm run dev -- \
  --platform liepin \
  --keyword "前端工程师" \
  --jd-file ./jd.txt \
  --email recruiter@example.com \
  --cc audit@example.com
```

如果抓取和评分已经完成，只补发最新一次运行的评分报告，使用独立入口：

```bash
npm run email:report -- boss "工业设计师-boss-job-id-123" recruiter@example.com audit@example.com primary
```

参数依次为 `platform`、`jobKey`、收件人、可选的逗号分隔抄送列表和可选 audience（`primary` 或 `secondary`）。
对开启 Boss 新交付合同的岗位，补发默认只发主受众；显式请求 `secondary` 会 fail closed，并提示查看候选人级否定
邮件 outbox，不会把多个 rejected 候选人重新合并成一封聚合副报告。历史旧合同 run 仍可按其版本事实只读补发。该命令
只读取最新 run、对应评分产物和分流事实并通过 SMTP 发送，不打开浏览器、不重新抓取、不转发候选人简历，也不修改
seen。这里的收件人仅覆盖本次补发；如需后续普通抓取持续发送报告，应在普通抓取中配置 `--email`。

若只需要检查 SMTP 的 DNS、TCP/TLS 和 `220` 欢迎语，不认证也不发信，可运行只读诊断：

```bash
npm run smtp:diagnose -- --attempts 3
```

默认只探测一次，最多允许显式指定 5 次；命中 `198.18.0.0/15` 等 synthetic/Fake-IP 地址时只告警，不自动修改
代理、VPN、DNS 或系统路由。若使用透明 TUN，优先在代理客户端为 SMTP 域名配置 DIRECT 和真实 DNS，再由运维侧确认
实际路由。

所有评分报告（包括 Boss 主/副受众）在进入 SMTP 前都会校验收件人和抄送地址；格式错误或
`example.com`、`.test`、`.invalid` 等文档/测试域名会直接 fail closed，不会尝试发送并产生退信。

默认普通抓取会排除平台页面标记为已查看的候选人；只有普通抓取可以使用 `--include-viewed true`。在 Boss 直猎邦，这一开关控制“过滤近14天查看”：默认勾选以排除平台近 14 天已查看人选，`--include-viewed true` 取消勾选。无论该开关取何值，本地 `seen-ids.json` 都仍会排除已经成功抓取过的候选人。

### 将直猎邦加入普通抓取

`--include-boss true` 只允许与普通抓取或批量任务的 `--platform all` 组合。系统会在打开第一个浏览器前，核对所有选中平台是否已有岗位 JD（或本次提供可用 JD），并在 direct 搜索时校验同一筛选输入能否被每个平台的 catalog 完整解释；任一项不满足会一次性失败，不会先运行前三个平台。

Boss 阶段复用 `data/boss/`、独立登录态和本地 `seen-ids.json`。普通抓取会将公共 `--include-viewed` 映射到直猎邦的“过滤近14天查看”：默认勾选以排除平台近 14 天已查看人选，传入 `true` 时取消勾选。这个页面筛选不等同于本地历史去重；无论页面开关取何值，`seen-ids.json` 仍会排除已经成功抓取的候选人。若 Boss 岗位已有保存的转发设置，省略本次转发参数时可能复用该设置；显式 `--boss-forward-mode` 和 `--boss-forward-recipient` 也可在 `all + --include-boss true` 中使用，并只作用于 Boss 阶段。

有头 Boss 流程在认证页面准备完成后会将当前 Boss 标签页置前一次；无头模式跳过，窗口管理器拒绝置前时只记录告警并继续流程。该行为不是持续“始终置顶”，用户之后仍可切换到其他窗口。

每次 Boss 普通抓取固定只记录并操作平台当前顺序中的前 20 份简历。上限在 seen、恢复、打开详情、评分和转发前应用；若前 20 份中已有本地 seen，不会从第 21 份以后补位。本轮 `totalCandidates`、候选人 ID、简历、评分、分流和外部操作因此都不超过这 20 份；其他平台和 Boss 独立模式不受此上限影响。

前 20 份中已经存在于当前岗位 `seen-ids.json` 的候选人，会执行一次精确卡片定位、详情打开、详情身份核验和严格关闭，让 Boss 平台有机会在下一次默认搜索中隐藏该卡片。pending-score 或可重试 outbox 的候选人由原有详情处理覆盖，避免重复打开；纯查看不解析、评分、转发、联系或发送邮件。查看同步事实会写入 RunResult 的 `bossSeenViewSync`，并与抓取尝试、失败候选人和报告候选集分开统计；关闭无法验证时停止本轮后续卡片操作。

Boss 开启评分后分流时，每位候选人的正常路径只打开一次详情：完成身份校验、解析、持久化和 pending-score/seen 后，在该详情保持打开的状态下从本地简历等待模型，等待期间不执行页面动作。模型返回后会建立新的有界页面动作预算并重新核对仍是同一候选人；qualified/review 在原详情内继续检测和转发，rejected 或评分失败直接严格关闭，不会为评分、检测或转发二次打开。只有后续运行恢复已持久化的可重试转发 outbox 时，才会按稳定候选 ID 独立打开一次详情。页面动作会在用户式节奏前为关闭预留预算，并在指针移动后再次核对候选人和控件身份。详情卡片或转发操作若意外打开“购买搜索畅聊卡”，会关闭弹窗后立即终止当前页面会话，不继续下一张卡片。转发只有在 click event 已派发且出现新的可见成功提示时才记为 `sent`；点击前失败可重试，点击已派发但无成功证据记为 `uncertain`，不会自动重发。

Boss 搜索简历详情兼容旧 iframe/canvas 和当前父页面原生 Vue 布局。新布局直接使用当前详情实例的身份与简历数据，避免复用父页面里可能属于上一位候选人的旧请求；详情自身的“搜索畅聊卡”不会被当作购买弹窗。当前转发按钮是详情顶部收藏、不合适、举报、转发一行中最右侧的“转发牛人”，程序会在移动指针后再次验证它仍唯一且最右。无关闭按钮的新转发框通过已验证的遮罩空白点清理，不使用会误关底层详情的 Escape。

只有详情身份验证通过、解析后的候选人 ID 与详情目标一致、简历文件成功落盘并回读通过，才会进入成功抓取历史和
`seen-ids.json`。详情打开、身份、解析或落盘失败只写入可重试的阶段失败事实；新运行使用 `capturedCandidateIds`，
旧运行中的 `newCandidateIds` 仅按“旧版尝试”展示，不反推为成功简历。

Boss 的简历转发和评分报告是两组独立邮件通道：`--boss-forward-recipient` 在候选人详情阶段逐份转发简历，
`--boss-forward-cc` 可为邮件转发配置逗号分隔的副本地址（仅 `--boss-forward-mode email` 有效）。Boss 详情页
没有原生抄送框：程序会先向主地址转发，再为每个去重后的副本地址重新打开转发框并独立发送；每一次留言都
写入同一候选人 ID。开启评分后分流且候选人未被否定时，邮件模式还会在当前详情读取是否存在同事沟通记录；如有，
每个地址的留言追加一行 `同事已沟通`，不会读取或保存同事姓名、时间和详情。`--email` 和
`--cc` 在本轮评分和导出完成后发送汇总报告。普通抓取显式提供的 Boss 转发目标只保存到当前岗位，不会改写 Boss
自动沟通的全局默认；只有 `--boss-auto-chat true` 自身显式提供转发参数时才更新该全局设置。

#### Boss 评分后模型要求分流

Boss 普通抓取可按岗位开启“先评分、后转发”的模型要求分流。开关关闭或岗位没有该配置时，完全保留原有流程：
按配置转发后再解析和评分。开关开启后，成功保存的每份简历先写入本地 pending-score 和 seen，在首次详情仍打开时由同一次模型请求评分并判断模型要求，然后决定转发和
报告受众：

- `qualified`：所有启用模型要求都明确满足，转发和评分报告发给主受众。
- `review`：模型请求已成功完成，但要求证据含糊或无法确定，发给主受众并在报告中标为“需复核”。
- `rejected`：至少一项模型要求被明确判断为缺失，不做任何 Boss 页面转发；向 `--boss-secondary-email` 和其
  `--boss-secondary-cc` 配置的副收件人逐候选发送一封邮件，正文包含全部否定原因和完整结构化简历。

qualified/review 仅在邮件转发模式读取当前详情的同事沟通布尔状态，有记录时在转发留言中追加 `同事已沟通`；rejected
和评分失败不执行该检测。qualified/review 在同一详情完成转发后关闭；rejected 必须先严格关闭详情并保存关闭凭证，随后
才能形成并发送候选人级否定邮件。

模型连接、进程、协议、输出解析或结构化校验失败都不属于 review，也不产生任何分流决定或候选级外部交付。失败评分产物和
pending-score 会保存 provider、kind、phase、首个输出状态和耗时等脱敏诊断；后续运行只在相同 policy 下重试。任务详情以
`bossRouting.pendingScoreCandidateIds` 的数量和 `scoreFailureStatusCounts` 显示未决阶段，不展示候选内容。

因此主报告仅在“明确符合 + 需复核”都为空时跳过；新合同不再发送 rejected 聚合副报告。主 Boss 页面转发只使用
`--boss-forward-mode`、`--boss-forward-recipient` 和 `--boss-forward-cc`；否定邮件使用
`--boss-secondary-email`、`--boss-secondary-cc`，一个候选人的 TO 与全部 CC 属于同一封 SMTP 消息。旧的
`--boss-secondary-forward-mode`、`--boss-secondary-forward-recipient`、`--boss-secondary-forward-cc` 会被明确拒绝，不能静默忽略。

运行摘要中的 `reportDeliveries.primary/secondary` 是聚合报告事实；新合同的 secondary 会以
`rejected-candidates-delivered-individually` 跳过。候选人级状态另写入 `bossRouting.rejectionEmailStatusCounts`，任务
摘要的 `rejectionEmails` 返回 eligible、pending、sending、sent、retryableFailed、retryExhausted、uncertain、superseded、失败候选 ID，
以及本轮 outbox 固化的 `deliveryTargets`；`bossRouting.rejectionEmailSmtpAttemptCount` 只统计本轮实际进入
`sendMail()` 的次数。顶层兼容字段会把主聚合报告和所有必要的否定邮件一起归约：任一本轮实际 SMTP 调用即
`emailAttempted=true`，所有必要邮件确认成功才有
`emailDelivered=true`。
任务详情会显示副收件人/CC、每份否定邮件状态以及 `sending`/`uncertain`/`retryExhausted` 人工核对提示；自动重试已用尽的邮件
不会再进入下一轮自动恢复。控制台首页健康摘要只汇总 Boss 否定邮件 outbox 的状态数量，不展示正文或 SMTP 凭据。
Boss 否定邮件正文由独立完整渲染器生成，每位候选人只出现一次，包含全部明确缺失要求、理由、核验证据和完整结构化简历；
不复用聚合报告的截断正文。完整评分仍写入本地导出；普通平台报告保持原有完整格式。

启用分流后，简历保存与写入 seen 之间会先落一条“待评分分流”工作项；若评分失败或进程在分流决定落盘前中断，后续启用
分流的运行只会按同一候选人 ID 恢复该工作，不会把 seen 误当作已经转发。只有成功评分并形成 outbox 后，`pending` 或明确的
`retryable-failed` 会按原 outbox 的不可变 TO/CC 恢复，即使候选人不再出现在当前卡片中也不依赖重新抓取。只有
`EDNS + CONN` 能证明 DNS 连接前失败并在当前运行短暂退避后重试一次；AUTH 和 MAIL 失败只保留后续运行的一次机会。
Nodemailer 可能在 DATA 后仍把 socket timeout/close 记为 `command=CONN`，因此 ETIMEDOUT、ESOCKET、ECONNECTION 及
其他 CONN 一律进入 `uncertain`，不得自动重发。RCPT、DATA、阶段未知、部分收件人 accepted/rejected/pending、遗留
`sending` 和任何结果不确定的调用同样保持 `uncertain`。同一候选人的 TO 与 CC 是一封 SMTP 消息并共享一个状态；每个
delivery 在跨进程原子锁内重新读取 outbox、递增尝试次数并调用 SMTP，最多两次，第二次仍证明未提交时写入
`retryExhausted`。

抓取详情严格关闭后才允许形成否定邮件 outbox；不可变收件人、正文、分流事实和已验证的关闭时间一次落盘，随后 SMTP 才能开始。重跑只依据这个持久化凭证恢复，不通过候选人离开前 20、历史 run 已收录或浏览器重启推断关闭成功；没有关闭凭证
的邮件不发送但会进入本轮失败摘要。已具备凭证的 `pending/retryable-failed` 即使候选人不再出现在当前卡片中也可恢复，恢复后的
`sent/uncertain/superseded` 同样进入本轮 RunResult。停留在 `sending` 的进程中断会转成 `uncertain`，必须人工核对且不自动重发。

HTTP、控制台助手、批量和 scheduler 入队时会固化 Boss settings v3/task v4 任务快照：岗位/职位 ID、页面搜索词、固定条件集
revision、交付目标、筛选策略和岗位配置 revision 都随任务保存。执行前用 revision/CAS 应用显式配置修改；岗位在排队后
被编辑时任务会失败并要求重新确认，不会恢复旧抄送或覆盖新设置。控制台中的分流开关区分“复用岗位设置 / 本次启用并保存 /
本次停用并保存”，清空否定邮件抄送也会作为明确的持久化意图记录。

模型要求文件只保存版本化业务规则，不能包含收件人、脚本或候选人数据。当前只接受版本 2 的 `modelRequirement`：

#### 三个平台的评分后结果分流

51job、猎聘和智联也支持同一套“先保存详情、再评分、再分流”的模型要求策略，但只扩展结果分流，不扩展平台原生转发：

```bash
npm run dev -- \
  --platform all \
  --keyword "工业设计师" \
  --jd-file ./jd.txt \
  --result-routing-enabled true \
  --result-routing-policy-file ./post-score-routing-policy.json \
  --email primary@example.com \
  --cc audit@example.com \
  --secondary-email review@example.com \
  --secondary-cc review-audit@example.com
```

模型明确满足的候选人和已完成评分但证据不足需复核的候选人进入主报告；模型明确判断要求缺失的候选人进入副报告。技术性评分失败保持 pending，不进入任一报告。没有主组候选人时不发主报告；副报告仍可单独发送。`--result-routing-enabled false` 可停用，省略开关会复用岗位已保存设置。51job 和猎聘报告使用稳定简历 ID，智联报告要求详情页得到唯一可直达简历链接；任一证据缺失都会在 SMTP 前失败关闭。猎聘现有站内联系人转发和 Boss 原生转发均保持原平台边界，不会被这套结果分流替换或扩展。

```json
{
  "version": 2,
  "decisionMode": "reject-on-any-missing",
  "requirements": [
    {
      "id": "aluminum-luggage-experience",
      "enabled": true,
      "kind": "modelRequirement",
      "requirement": "候选人具有铝制、铝合金或金属硬壳箱包或行李箱相关的设计、结构、工艺或量产经验",
      "criteria": [
        "材料与箱包或行李箱在同一工作、项目或产品语境中明确关联",
        "体现实际设计、结构、工艺、打样或量产工作"
      ],
      "insufficientEvidence": [
        "仅出现箱包、皮具、女包、公司名称或岗位名称",
        "仅有与箱包无关的铝材经验"
      ]
    }
  ]
}
```

模型只在一次 Boss 评分请求中返回 `satisfied | missing | unknown`。`satisfied` 必须有简历原文证据；`missing`
表示完整结构化简历中没有满足全部标准的经历，进入候选人级否定邮件；成功评估中的 `unknown` 转主受众复核，模型调用或校验失败保持 pending。版本 1 以及旧的
`scoreBelow`、`resumeFact`、`resumeMissingKeywords` 不再兼容执行，会在浏览器前失败。
升级已有岗位的本地 outbox 时先预演，再执行迁移；页面转发与候选人级否定邮件都会按 policy hash 扫描：已发送/不确定状态保留，
旧 policy 的 `pending/retryable-failed` 终止为 `superseded`，`sending` 转为 `uncertain`：

```bash
npm run migrate:boss-model-screening -- \
  --job-key "全铝箱包设计-554cbe84c293028b0nJ72NW7FlJV" \
  --dry-run
```

Boss 否定交付合同迁移默认只做脱敏 dry-run 审计；它会识别旧副转发配置和 rejected 页面转发 outbox，并只把
`queued/running` 任务、数据目录内不可变 batch 快照及 schedule 模板视为活动合同，不会让成功/失败/取消的历史任务误阻断，
也不会读取外部 jobs-file 或补发历史简历邮件：

```bash
npm run migrate:boss-rejection-email -- \
  --job-key "全铝箱包设计-554cbe84c293028b0nJ72NW7FlJV" \
  --dry-run true
```

历史一致性审计是只读操作，不会删除 seen、重评、转发或发送邮件：

```bash
npm run audit:boss-capture-history -- \
  --job-key "全铝箱包设计-554cbe84c293028b0nJ72NW7FlJV"
```

新岗位可一次配置主转发和否定邮件目标；已保存 Boss 岗位省略任意字段时复用其 canonical 配置：

```bash
npm run dev -- \
  --platform boss \
  --keyword "物业电工" \
  --jd-file ./jd.txt \
  --email primary@example.com \
  --cc primary-report-audit@example.com \
  --boss-forward-mode email \
  --boss-forward-recipient primary-forward@example.com \
  --boss-forward-cc primary-forward-audit@example.com \
  --boss-screening-enabled true \
  --boss-screening-policy-file ./boss-model-requirements.json \
  --boss-secondary-email secondary@example.com \
  --boss-secondary-cc secondary-report-audit@example.com
```

`--boss-screening-*` 和 `--boss-secondary-*` 只允许用于 `--platform boss`，或 `--platform all --include-boss true`
的 Boss 第四阶段；不能用于自动沟通、人才发现、会话操作、职位同步、订阅管理、Talent Mapping 或 JD/RAG 问答。
主转发的 `--boss-forward-cc` 还可随自动沟通自身显式提供的邮件转发目标使用，但不会从普通抓取岗位配置改写自动
沟通默认值。批量 jobs-file 可在单个条目用同名 camelCase 字段覆盖运行级默认值，包括主转发目标、否定邮件副收件人和
三组 CC；显式空数组表示清空该条目的已保存 CC，省略才表示复用。旧的 `bossSecondaryForwardMode`、
`bossSecondaryForwardRecipient`、`bossSecondaryForwardCc` 会被拒绝。`bossScreeningPolicyFile` 的相对路径按
jobs-file 所在目录解析。通过 HTTP、助手或调度入队时，系统会把每个 Boss 岗位当时解析出的策略、主转发、
主报告与否定邮件收件人/CC 固化为带 hash 的 settings v3/task v4 快照，排队后的岗位配置编辑不会改变该任务。

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

### 订阅管理与 JD 问答

订阅管理（内部模式 `search-subscription`）只应用筛选、读取结果数，并可选择保存订阅；它不会解析 JD、抓取或评分候选人，也不会改变本地 seen 状态。普通
`all` 仍只覆盖前三个平台；显式 `--include-boss true` 才追加 Boss 第四阶段：

```bash
npm run dev -- \
  --platform zhilian \
  --search-subscription-file ./search-plan.json \
  --save-search-subscription true
```

全平台扩展示例：

```bash
npm run dev -- \
  --platform all \
  --include-boss true \
  --search-subscription-file ./search-plan.json \
  --save-search-subscription true \
  --search-subscription-name "铝镁合金"
```

Boss 保存成功会返回 `savedSearch` 完整引用和 `saveOutcome`（`saved`、`already-saved` 或 `renamed`）。例如订阅名称“铝镁合金”、
职位“全铝箱包设计”和页面关键词“铝镁合金 拉杆箱”是三个独立字段；保存/改名会改变 Boss“我的订阅”状态，因此前端和助手
会单独提示这一外部变更。任务结果还显示条件应用状态、排序策略、native ID 和条件指纹，但不会显示候选资料。
全平台任务若在某个平台失败仍保持 fail-fast；失败任务会另外保留已经完成的平台结果和明确的停止平台，便于确认此前已经发生的
原生订阅保存或改名，不会自动回滚这些外部变更。

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
  --boss-forward-recipient resume@example.com \
  --boss-forward-cc resume-audit@example.com
```

未开启评分后模型要求分流时，流程按候选人打开详情、按配置转发、提取并保存简历；全部新候选人抓取后再统一评分、导出和发送报告。开启分流时，流程改为只打开一次详情，提取并保存简历、写 pending-score/seen，在原详情打开时完成评分与模型要求判定并持久化决定；qualified/review 在同一详情内检测同事沟通状态并只转发给主受众，rejected 不检测且不做 Boss 页面转发，严格关闭后才向副收件人逐份发送完整简历和否定原因，最后只生成主聚合报告。评分调用或输出校验失败保持未决并关闭详情，不进入检测、主转发、否定邮件或聚合报告。搜索结果必须出现候选卡片、站点明确空态或明确错误；未就绪的 iframe 不会被误记为零候选人。详情打开会按当前卡片的稳定 Boss 标识复核，不会仅按列表序号点击。

Boss 的 direct 搜索会先通过页面“清空筛选”回到基线，再按“职位 → 城市 → 其余条件 → 已查看策略 → 关键词”顺序应用并复核完整期望状态，避免复用页面继承人工或上轮条件。关键词在其他筛选稳定后只输入一次，防止筛选刷新先把短关键词替换成自动建议词、随后又触发重复输入。学历和经验的自定义范围在输入 catalog 中使用页面可见的语义边界（如“大专”“博士”“10年以上”），动作内部才转换为滑块索引，并同时核对隐藏值与可见范围文案；两个经验手柄允许重叠表示“10年以上”。城市会核对唯一的一级选中集合，并在复核后通过页面“确认”收起面板。所有筛选共用一个按条件数量计算、上限 120 秒的 deadline；任一项被后续动作重置、可见语义不符或面板未稳定收起，都会在候选人提取前失败。当前 application-filter 输入支持目录内的单选、年龄/薪资范围、院校要求多选、学历/经验自定义范围、城市、职位范围、公司文本、专业，以及“过滤近 14 天查看”“近 30 天未和同事交换简历”两个独立布尔条件；当前实页“更多筛选”以“专业”为最后一项，没有“资格证书”，Boss 不注册或导出虚构字段。该回放和核验均为确定性页面动作，不调用 LLM。

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
  --boss-forward-cc resume-audit@example.com \
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

计划按每日时间窗口和轮次间隔运行，并与手工任务共享一个全局队列。普通抓取或批量计划选择 `all` 时可显式保存“包含 Boss 直聘·直猎邦 Pro”；历史计划缺少该字段时按 `false` 解释。`boss-auto-chat` 不属于循环调度资格：它保留 CLI、一次性 HTTP/控制台任务和助手确认执行，但新建或更新计划会在服务端以 `scheduled-task-kind-not-allowed` 拒绝。Boss 立即匹配、单人打招呼和原子会话变更同样不能加入自动运行计划；新增 Boss 独立模式中只有职位/JD 同步可调度。

自动化页面的搜索计划与独立计划分开选择：前者使用上述五种 API 目录模式，后者只保留 Talent Mapping 和 Boss 职位同步的类型化入口。计划任务名称从服务端模式目录生成，提交时仍通过共享编译器生成兼容的 task kind 与输入字段。历史 `boss-auto-chat` 或未知 task kind 计划不会被删除或改写：scheduler recovery 会暂停它、清除下次运行时间并保存去敏阻断原因；详情仍可审计，但“启用”和“立即运行”被禁用。自动化中的订阅管理固定为只读：服务端拒绝任何 `saveSearchSubscription=true` 或订阅名称，手工/助手显式确认的订阅管理仍可保存；历史保存型计划仍可查看，但详情会提示它将在恢复或运行前被拒绝。计划创建成功会同时重置业务选择与平台表单，避免残留 Boss-only 选择。新建任务页会保留用户在模式切换前填写的条件集或旧筛选文件，但只有直接搜索、订阅管理以及显式 direct 的 batch 默认来源会把筛选字段发送到请求中。若历史文件的任务或计划元数据结构损坏，自动化详情仍保持可读，只返回逐字段白名单投影和固定去敏阻断原因；浏览器客户端仍会逐字段、逐任务验证当前版本响应，不把 `readViewVersion` 当作可信证明。此时启用/立即运行被禁用，暂停/停止仍可用，修复需提交完整受支持的计划配置。并发控制或调度扫描会按最新计划重新判断，不会用旧快照覆盖刚完成的修改，也不会把 lease、队列提交或写入冲突计入普通任务失败。

控制计划：

```bash
npm run schedule:stop -- --schedule-id <scheduleId>
npm run schedule:control -- pause --schedule-id <scheduleId>
npm run schedule:control -- start --schedule-id <scheduleId>
npm run schedule:control -- run-now --schedule-id <scheduleId>
```

计划写入发现死 owner 或损坏的 lease 时会返回 `schedule-lease-recovery-required`，普通 API/scheduler 进程不会自动删除或抢占该锁。只有确认所有 API 与 scheduler 进程均已停止后，才可对一个精确计划 ID 执行离线恢复；该命令把锁移动到同目录 quarantine 文件，不直接删除：

```bash
npm run schedule:recover-lease -- --schedule-id <scheduleId> --confirm-processes-stopped true
```

如需防止检查后 owner 已变化，可额外提供当时读取到的 `--owner-token <token>`；token 不一致时命令拒绝恢复。命令完成前不要重新启动 API 或 scheduler。

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
| `data/boss/jobs/<jobKey>/routing/` | Boss 开启评分后分流时的不可变决定事实和可恢复的转发 outbox |
| `data/<platform>/jobs/<jobKey>/rag/` | RAG 本地事实和索引源数据 |
| `data/talent-mapping/<mappingKey>/` | 当前 Mapping 配置、每运行不可变合同、平台观察、内容哈希详情证据/冲突记录、人工关联/分类审核、变化视图和 CSV/Markdown 导出 |
| `data/boss/chat-operations/runs/` | Boss 原子会话变更回执 |

只有成功抓取的简历会标记为已查看；详情打开、转发或提取失败仍可重试。评分失败会保存失败产物且不撤销已经成功抓取的状态；启用结果分流时还会保留 pending-score，并禁止在没有成功评分事实时形成外部交付。

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
| `PLAYWRIGHT_MOUSE_SPEED_MIN_PX_PER_SECOND/MAX_PX_PER_SECOND` | 全平台共享指针移动速度，默认 `700-1200 CSS px/s` |
| `PLAYWRIGHT_BOSS_TYPING_DELAY_MIN_MS/MAX_MS` | Boss 搜索关键词、直接聊天文本和备注的逐字间隔，默认 `80-180ms` |
| `LLM_COMPLETION_ROUTE` | `default`（默认）或 `codex-session`；只选择调用路径，不做失败自动切换 |
| `SCORING_LLM_COMPLETION_ROUTE` | 简历评分专属路由；默认 `codex-session`，显式 `default` 切回原 OpenAI 兼容接口 |
| `CODEX_SESSION_MODEL` | `codex-session` 的可选模型；未设置时使用当前 Codex/ChatGPT 登录的默认模型 |
| `CODEX_SESSION_CONNECT_TIMEOUT_MS` / `CODEX_SESSION_MAX_CONCURRENCY` | Codex process/initialize/thread/turn 握手的逐阶段超时和并发上限，默认 `30000` / `1`；已开始的模型 turn 没有固定总超时 |
| `TALENT_MAPPING_MODEL` | Mapping 分类建议模型；未设置时回退 `OPENAI_MODEL` |
| `QDRANT_URL` / `QDRANT_API_KEY` | Qdrant 连接配置 |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | 报告邮件配置 |

正常多平台运行建议不要设置 `STORAGE_STATE_PATH`，让程序自动选择平台登录态。51job、Liepin、Zhilian 和 Boss 的操作与候选人间隔默认均为加权 `2–4 秒`：约 80% 落在 `2–3 秒`、20% 落在 `3–4 秒`。简历详情就绪后会先停留一个动作间隔再转发或解析，处理完成后再等待一个动作间隔才关闭详情页或模态框。Boss 搜索关键词、直接聊天文本和备注会在输入框获得焦点后按 `80-180ms` 的随机间隔逐字输入，标点处额外短暂停顿；常用语仍通过页面选项直接选择。鼠标点击在同一浏览器上下文中共享上一次落点，并沿分步轨迹以默认 `700-1200 CSS px/s` 移动到下一目标；移动采用起止减速、中段加速的时间曲线，短距离移动至少持续 `160ms`，长距离不会通过压缩时长来提速。必须使用原生或 DOM 点击的兼容路径也会先完成这段移动；剩余 deadline 不足时动作失败，不会瞬移或临时加速。

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
