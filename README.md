# Auto Recruit — 多平台招聘自动化 CLI + 本地运营控制台

**Auto Recruit** 是一个基于 TypeScript、浏览器自动化和 OpenAI 兼容模型的本地招聘工作流工具。它把 **候选人搜索、简历抓取、JD 解析、匹配评分、报告导出、邮件投递、RAG 问答和定时任务** 串成可复用流程，并为 Boss 提供人才发现、自动聊天、原子会话操作及职位/JD 同步能力。

生产搜索平台包括 `51job`、`liepin` 和 `zhilian`；Boss 是必须显式选择的单平台扩展。职位、简历、评分、运行记录和 RAG 事实保存在本地 `data/`，Qdrant 仅作为可重建索引。

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
| Boss 人才发现 | 推荐牛人、原生深度搜索条件、显式确认的立即匹配和单人打招呼 |
| Boss 未读会话审核 | 读取简历、按 JD 判断、转发匹配简历并生成审核摘要 |
| Boss 职位管理 | 从职位管理页同步职位和 JD，按稳定职位 ID 建立本地映射 |
| 招聘知识问答 | 基于职位本地事实库回答 JD 和已验证招聘信息问题 |
| 本地运营控制台 | 任务队列、自动运行计划、职位/候选人查看、RAG 运维和结构化助手草稿 |
| 数据可追溯 | JSON/JSONL 为事实来源，保留简历、评分、回执、运行摘要和导出结果 |

## 平台支持

| 平台 | 是否属于 `--platform all` | 搜索入口 | 平台能力 |
| --- | --- | --- | --- |
| `51job` | 是，第 1 个 | 保存的订阅或直接搜索 | 候选卡片详情、简历抓取与评分 |
| `liepin` | 是，第 2 个 | 招聘端找人或直接搜索 | 可配置常用联系人转发 |
| `zhilian` | 是，第 3 个 | 快捷搜索或直接搜索 | 报告邮件可使用本轮复制的分享链接 |
| `boss` | 否，仅 `--platform boss` | 当前人才搜索页及 Boss 专属入口 | 抓取、人才发现、聊天审核、原子操作、职位/JD 同步 |

`--platform all` 始终串行执行前三个平台，任一平台失败会立即停止。Boss 不会隐式加入全平台或批量平台循环。

---

## 安装

要求：

- Node.js 24 LTS；项目支持 `>=24 <27`
- 对应招聘平台的有效账号和登录态
- 用于 JD 解析和候选人评分的 OpenAI 或兼容 API
- 使用持久化 RAG 时可访问 Qdrant；默认还需要本地 embedding 服务

安装依赖并创建配置：

```bash
npm install
cp .env.example .env
```

编辑 `.env`，至少设置模型服务：

```dotenv
OPENAI_API_KEY=your-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=your-model-name
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
| 多平台/批量 | `--platform all` / `--jobs-file` | 是 | 同普通抓取 |
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

该命令只运行 `51job`、`liepin` 和 `zhilian`，不包含 Boss。

### 3. 启动本地控制台

```bash
npm run web:build
npm run api
```

打开 `http://127.0.0.1:4180`。前端开发可另行运行 `npm run web:dev`，默认地址为 `http://127.0.0.1:5173`。

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

抓取完成后发送报告：

```bash
npm run dev -- \
  --platform liepin \
  --keyword "前端工程师" \
  --jd-file ./jd.txt \
  --email recruiter@example.com \
  --cc audit@example.com
```

默认跳过已查看候选人；只有普通抓取可以使用 `--include-viewed true`。

### 批量职位

```bash
npm run dev -- --platform all --jobs-file ./jobs.json
```

`jobs.json` 是 JSON 数组，职位顺序是外层循环，平台顺序是内层循环：

```json
[
  {
    "keyword": "店长",
    "jdFile": "./jd.txt",
    "searchSource": "direct",
    "applicationFilterInputFile": "./filters/store-manager.json"
  }
]
```

`--jobs-file` 是批量模式唯一的职位定义来源，不能和单职位的 `--keyword`、`--jd` 或 `--jd-file` 同时使用。相对筛选文件路径按 jobs 文件所在目录解析。

### 搜索订阅与 JD 问答

搜索订阅模式只应用筛选、读取结果数，并可选择保存订阅；它不会解析 JD、抓取或评分候选人，也不会改变已查看状态：

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

Boss 只通过 `--platform boss` 运行。网页导航、点击、输入、按键、简历转发和候选人切换都使用共享的随机操作节奏，默认约为 `2–4 秒`。

### 普通搜索与简历抓取

```bash
npm run dev -- \
  --platform boss \
  --keyword "物业电工" \
  --jd-file ./jd.txt \
  --boss-forward-mode email \
  --boss-forward-recipient resume@example.com
```

流程按候选人打开详情、按配置转发、提取并保存简历；全部新候选人抓取后再统一评分、导出和发送报告。因此普通抓取中的转发发生在评分之前，并非只转发评分合适的候选人。

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

同名但职位 ID 不同的岗位不会合并。JD 原文哈希未变化时不会再次调用模型解析或重写职位记录；读取或解析失败不会覆盖上一份有效 JD。

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

本地控制台支持任务队列、职位和候选人查看、搜索订阅、Boss 工作流、RAG 运维和结构化助手草稿确认。HTTP 或助手确认的浏览器任务统一通过 `TaskQueue` 串行执行，预览命令不是执行来源。

“自动运行”计划可以组合：

- 普通搜索任务
- Boss 职位/JD 同步
- Boss 自动聊天

计划按每日时间窗口和轮次间隔运行，并与手工任务共享一个全局队列。Boss 立即匹配、单人打招呼和原子会话变更不能加入自动运行计划；新增 Boss 独立模式中只有职位/JD 同步可调度。

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
| `QDRANT_URL` / `QDRANT_API_KEY` | Qdrant 连接配置 |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | 报告邮件配置 |

正常多平台运行建议不要设置 `STORAGE_STATE_PATH`，让程序自动选择平台登录态。Liepin 默认操作和候选人间隔为 `2–3 秒`；Boss 默认为加权 `2–4 秒`。

---

## 常见问题

### `--platform all` 会运行 Boss 吗？

不会。它只按 `51job → liepin → zhilian` 顺序串行运行。Boss 必须显式使用 `--platform boss`。

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
npm run web:build
```

项目还提供筛选目录发现、筛选输入校验、简历重新解析、结果导出、RAG 质量评估和平台专项测试，具体脚本见 `package.json`。

## 进一步阅读

- [项目说明文档](./项目说明文档.md)：完整流程、架构、持久化、失败语义和运维说明
- [AGENTS.md](./AGENTS.md)：面向代码代理的仓库级约束；目录内还有更具体的 scoped instructions

