# Auto Recruit

Auto Recruit 是一个基于 TypeScript、Playwright 和 OpenAI 兼容模型的招聘自动化 CLI，同时提供一个本地运营控制台。它可以在招聘平台上按职位搜索候选人、抓取简历、解析和评分、导出结果，并通过 SMTP 发送报告。

平台差异：

| 平台 | `--platform all` | 浏览器 | 搜索与默认已查看筛选 | 特殊行为 |
| --- | --- | --- | --- | --- |
| `51job` | 是，第 1 个 | 默认有头、可复用 | 保存的订阅或直接搜索；默认勾选 `我已看` | 详情使用候选卡片入口 |
| `liepin` | 是，第 2 个 | 强制有头、可复用 | 招聘端找人或直接搜索；默认勾选 `隐藏已查看` | 可配置常用联系人转发 |
| `zhilian` | 是，第 3 个 | 默认有头、可复用 | `/app/search` 快捷搜索或直接搜索；默认勾选 `未看过` | 报告邮件使用当前运行复制的分享链接 |
| `boss` | 否，仅单平台 | 默认有头、可复用 | 复用当前人才搜索页 | 普通抓取和未读聊天支持配置式简历转发 |

`--platform all` 严格按 `51job`、`liepin`、`zhilian` 的顺序串行运行，任一平台失败会立即停止，不包含 Boss。

## 环境要求

- Node.js 24 LTS（支持 `>=24 <27`）
- 一个 OpenAI 或兼容 OpenAI API 的模型服务
- 对应招聘平台的登录态
- 使用 RAG 时需要 Qdrant；默认还需要本地 embedding 服务

## 安装

```bash
npm install
cp .env.example .env
```

编辑 `.env`，至少设置：

```dotenv
OPENAI_API_KEY=your-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=your-model-name
```

项目默认使用 CloakBrowser。需要使用 Playwright 自带 Chromium 时设置：

```dotenv
BROWSER_ENGINE=playwright
```

不要提交 `.env`、登录态文件、候选人数据或 `data/`。这些内容包含凭据和个人信息。

## 登录平台

首次运行前，为每个平台保存独立登录态：

```bash
npm run login:session -- --platform 51job
npm run login:session -- --platform liepin
npm run login:session -- --platform zhilian
npm run login:session -- --platform boss
```

登录流程需要有头浏览器，因此不要将 `PLAYWRIGHT_HEADLESS` 设置为 `true`。登录态默认保存为：

```text
storage-state.json
storage-state.liepin.json
storage-state.zhilian.json
storage-state.boss.json
```

## 简历抓取

首次运行新职位时必须提供 JD，可以直接传文本或使用文件：

```bash
npm run dev -- \
  --platform 51job \
  --keyword "店长" \
  --jd-file ./jd.txt

npm run dev -- \
  --platform liepin \
  --keyword "前端工程师" \
  --jd "岗位职责：..."
```

职位记录会保存到 `data/<platform>/jobs/<jobKey>/`。后续使用相同关键词重跑时会复用已保存的 JD：

```bash
npm run dev -- --platform 51job --keyword "店长"
```

常用选项：

```bash
# 包含已经看过的候选人
npm run dev -- --platform 51job --keyword "店长" --include-viewed true

# 首次使用直接搜索；已有岗位可省略 --jd-file
npm run dev -- \
  --platform zhilian \
  --keyword "前端工程师" \
  --jd-file ./jd.txt \
  --search-source direct \
  --application-filter-input-file ./filter-input.json

# 首次抓取并在导出后发送报告；已有岗位可省略 --jd-file
npm run dev -- \
  --platform liepin \
  --keyword "前端工程师" \
  --jd-file ./jd.txt \
  --email recruiter@example.com \
  --cc audit@example.com
```

`--search-source saved` 是默认模式；`--application-filter-input-file` 只能和显式的 `--search-source direct` 一起使用。抓取、评分和导出结果会写入职位目录，最新运行摘要保存在 `results/` 下。

主要输出位置：

| 内容 | 路径 |
| --- | --- |
| 岗位配置和复用输入 | `data/<platform>/jobs/<jobKey>/jd.json` |
| 已成功抓取的候选人 ID | `data/<platform>/jobs/<jobKey>/seen-ids.json` |
| 结构化简历 | `data/<platform>/jobs/<jobKey>/resumes/<candidateId>.json` |
| 评分结果 | `data/<platform>/jobs/<jobKey>/scores/<candidateId>.json` |
| 运行摘要 | `data/<platform>/jobs/<jobKey>/results/<timestamp>.json` |
| 最新 Markdown 报告 | `data/<platform>/jobs/<jobKey>/exports/latest.md` |
| RAG 本地事实和索引数据 | `data/<platform>/jobs/<jobKey>/rag/` |

### 浏览器操作间隔

- Liepin 的站内操作和候选人间隔默认随机等待 `2–3 秒`。成功提取并保存简历后，流程还会等待 `2–3 秒`再关闭详情页；提取或转发失败时保留详情页供检查。
- Boss 的网页操作和候选人间隔默认随机等待 `2–4 秒`，其中约 80% 落在 `2–3 秒`、约 20% 落在 `3–4 秒`。导航、点击、输入、按键和简历转发都使用该节奏，普通搜索和自动聊天均生效。
- 页面状态读取、简历解析、模型评分、文件写入和 SMTP 邮件不属于网页交互，不额外加入上述固定等待。

可通过 `PLAYWRIGHT_<PLATFORM>_ACTION_DELAY_MIN_MS`、`PLAYWRIGHT_<PLATFORM>_ACTION_DELAY_MAX_MS`、`PLAYWRIGHT_<PLATFORM>_CANDIDATE_DELAY_MIN_MS` 和 `PLAYWRIGHT_<PLATFORM>_CANDIDATE_DELAY_MAX_MS` 覆盖平台配置，其中 `<PLATFORM>` 可为 `51JOB`、`LIEPIN`、`ZHILIAN` 或 `BOSS`。

### 多平台和批量运行

```bash
# 依次运行 51job、Liepin、Zhilian
npm run dev -- --platform all --keyword "店长" --jd-file ./jd.txt

# jobs.json 必须是 JSON 数组，每项至少包含 keyword
npm run dev -- --platform all --jobs-file ./jobs.json
```

批量模式的职位定义示例：

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

`--jobs-file` 不能和单职位的 `--keyword`、`--jd` 或 `--jd-file` 同时使用。批量文件中的相对筛选文件路径相对于 jobs 文件所在目录解析。

## 搜索订阅和 JD 问答

搜索订阅是独立模式，只应用筛选、读取结果数，并可选择保存订阅，不会抓取或评分候选人：

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

`--rag-question` 是同一个功能的别名。问答模式不会打开浏览器、抓取候选人、评分、导出或发送邮件。临时 JD 可以使用 `--jd` 或 `--jd-file`，不会创建持久职位记录。

## Boss 功能

Boss 不参与 `all` 运行。普通抓取时使用：

```bash
npm run dev -- \
  --platform boss \
  --keyword "物业电工" \
  --jd-file ./jd.txt \
  --boss-forward-mode email \
  --boss-forward-recipient resume@example.com
```

Boss 普通抓取的顺序是：打开详情、如已配置则完成简历转发、提取并保存简历；全部新候选人抓取完成后再统一评分、导出和发送报告。普通抓取的转发发生在评分之前，因此不是只转发评分合适的候选人。

Boss 未读聊天审核是独立模式：

```bash
PLAYWRIGHT_HEADLESS=false npm run dev -- \
  --platform boss \
  --boss-auto-chat true \
  --boss-forward-mode email \
  --boss-forward-recipient resume@example.com \
  --boss-chat-summary-email recruiter@example.com
```

自动聊天会先读取和判断首次沟通候选人的简历，只有匹配候选人才转发。物业电工需要严格检查全部硬性要求时增加 `--boss-chat-require-all true`。自动聊天不能与普通抓取、批量、搜索订阅或 JD/RAG 问答参数混用。回复未匹配候选人默认关闭，只有显式设置 `--boss-chat-reply-unqualified true` 才会发送拒绝短语。

Boss 推荐牛人和原生深度搜索是独立、默认只读的模式：

```bash
# 推荐牛人，只读取候选人卡片
npm run dev -- --platform boss --boss-talent-source recommend

# 读取/同步深度搜索条件，但不消耗“立即匹配”次数
npm run dev -- \
  --platform boss \
  --boss-talent-source deep-search \
  --boss-job-id job-123 \
  --boss-expected-job-name "物业电工" \
  --boss-core-requirements-json '["持高低压电工证","2年以上物业经验"]' \
  --boss-bonus-requirements-json '["上海本地经验"]'
```

只有同时设置 `--boss-trigger-match true --boss-confirmed true` 才会点击“立即匹配”。单人打招呼必须提供精确候选人 ID、预期姓名和职位，并显式确认：

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

Boss 职位/JD 同步会读取职位管理中的开放、审核中和已关闭职位，并按 Boss 职位 ID 创建独立岗位记录：

```bash
npm run dev -- --platform boss --boss-job-sync true --boss-include-closed-jobs true
```

JD 原文哈希未变化时不会再次调用模型解析或重写 `jd.json`。自动聊天可增加 `--boss-sync-jobs-before-review true`，在读取未读会话前先同步职位；会话优先按 Boss 职位 ID 找 JD，缺少 ID 时只允许使用唯一同名岗位。

控制台/API 提交的原子会话操作统一通过任务队列执行；CLI 也提供对应独立模式。只读示例：

```bash
npm run dev -- --platform boss --boss-chat-operation list-conversations --boss-unread-only true
```

`send-text`、`remark`、`mark-not-fit`、索要/接收附件简历、交换电话或微信属于变更操作，必须提供会话 ID、唯一 `intentId` 和 `--boss-confirmed true`。执行回执保存在 `data/boss/chat-operations/runs/`，重试同一 `intentId` 不会重复执行。

## RAG

推荐使用本地 embedding 服务：

```bash
python -m venv .venv
.venv/bin/pip install -r requirements-rag-embedding.txt
npm run rag:embedding:local
```

确保 `.env` 至少包含：

```dotenv
QDRANT_URL=http://127.0.0.1:6333
RAG_EMBEDDING_PROVIDER=local-http
RAG_EMBEDDING_LOCAL_URL=http://127.0.0.1:8011
RAG_EMBEDDING_MODEL=BAAI/bge-small-zh-v1.5
RAG_RETRIEVAL_MODE=hybrid
```

常用 RAG 命令：

```bash
npm run rag:index -- --platform 51job --keyword "店长"
npm run rag:ask -- --platform 51job --keyword "店长" --question "是否要求英语？"
npm run rag:doctor -- --platform 51job --keyword "店长"
npm run test:rag:offline
```

RAG 的本地 JSONL 数据位于 `data/<platform>/jobs/<jobKey>/rag/`，是事实来源；Qdrant 只作为可重建索引。只有已验证的招聘方信息可以成为候选人问答事实，无法可靠回答时系统会返回明确的无答案结果。

## 本地控制台

构建前端并启动本地 API：

```bash
npm run web:build
npm run api
```

默认地址：`http://127.0.0.1:4180`。

开发前端时可分开运行：

```bash
npm run web:dev
```

Vite 默认地址为 `http://127.0.0.1:5173`，并将 `/api` 代理到本地 API。控制台支持任务队列、职位和候选人查看、搜索订阅、Boss 人才发现/单人打招呼/原子会话操作/职位同步、Boss 自动聊天、RAG 运维和结构化助手草稿确认。

### 循环自动运行

控制台“自动运行”页可以创建由多个搜索、Boss 职位同步或 Boss 自动聊天任务组成的串行计划。职位同步可排在自动聊天之前；计划按每日时间窗口启动新一轮，并从上一轮全部任务完成后开始计算下一轮间隔；间隔为 `0` 时立即尝试重跑。所有轮次与手工任务共享一个全局队列，不会并发控制浏览器。

停止计划时使用“当前任务结束后停止”：正在运行的单个任务完成后，系统取消本轮余下任务并停止后续循环。`--platform all`、batch 和一次 Boss 自动聊天各自都视为一个单个任务，不会在内部被强制中断。

本机控制命令：

```bash
npm run schedule:stop -- --schedule-id <scheduleId>
npm run schedule:control -- pause --schedule-id <scheduleId>
npm run schedule:control -- start --schedule-id <scheduleId>
npm run schedule:control -- run-now --schedule-id <scheduleId>
```

## 配置参考

完整配置模板见 [.env.example](./.env.example)。常用配置包括：

- `DATA_DIR`：数据目录，默认 `./data`
- `PLAYWRIGHT_HEADLESS`：是否无头运行
- `PLAYWRIGHT_SEARCH_PAGE_TIMEOUT_MS`：搜索页面总超时，默认 `20000`
- `PLAYWRIGHT_RESUME_DETAIL_TIMEOUT_MS`：简历详情总超时，默认 `20000`
- `PLAYWRIGHT_<PLATFORM>_REUSE_BROWSER`：平台级浏览器复用开关
- `PLAYWRIGHT_<PLATFORM>_ACTION_DELAY_MIN_MS` / `PLAYWRIGHT_<PLATFORM>_ACTION_DELAY_MAX_MS`：平台网页动作间隔
- `PLAYWRIGHT_<PLATFORM>_CANDIDATE_DELAY_MIN_MS` / `PLAYWRIGHT_<PLATFORM>_CANDIDATE_DELAY_MAX_MS`：平台候选人间隔
- `QDRANT_URL`、`QDRANT_API_KEY`：Qdrant 配置
- `SMTP_HOST`、`SMTP_PORT`、`SMTP_USER`、`SMTP_PASS`、`SMTP_FROM`：邮件配置

Liepin 默认动作、成功详情关闭和候选人间隔为 `2–3 秒`；Boss 默认为加权 `2–4 秒`。完整节奏说明见[浏览器操作间隔](#浏览器操作间隔)。正常多平台运行时建议不要设置 `STORAGE_STATE_PATH`，让程序自动选择平台对应的登录态文件。

## 开发和验证

```bash
npm run typecheck
npm run test
npm run build
npm run web:build
```

项目也提供筛选目录发现、筛选输入校验、简历重新解析、结果导出和平台 smoke test 脚本，完整列表见 `package.json` 的 `scripts` 字段。

## 数据和安全

- `data/` 保存职位、简历、评分、运行结果、筛选目录和 RAG 本地事实库。
- 登录态文件和 `.env` 可能包含高敏感凭据，已被 Git 忽略。
- 候选人简历属于个人信息，生产环境应限制 `data/` 访问并做好备份和删除策略。
- RAG API 和控制台 API 只适合作为内部服务；`RAG_API_KEY` 或 `AUTORECRUIT_CONSOLE_API_KEY` 是轻量保护，不替代上游网关的认证、权限、限流和审计。

## 进一步阅读

完整的平台流程、筛选能力、持久化结构、RAG、控制台和运维说明见[项目说明文档](./项目说明文档.md)。面向代码代理的约束按目录拆分在根目录及 `src/*/AGENTS.md`。
