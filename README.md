# Auto Recruit

Auto Recruit 是一个基于 TypeScript、Playwright 和 OpenAI 兼容模型的招聘自动化 CLI，同时提供一个本地运营控制台。它可以在招聘平台上按职位搜索候选人、抓取简历、解析和评分、导出结果，并通过 SMTP 发送报告。

支持的平台：

- `51job`
- `liepin`
- `zhilian`
- `boss`（仅支持单平台运行）

`--platform all` 只按 `51job`、`liepin`、`zhilian` 的顺序运行，不包含 Boss。

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

# 使用直接搜索和筛选输入文件
npm run dev -- \
  --platform zhilian \
  --keyword "前端工程师" \
  --search-source direct \
  --application-filter-input-file ./filter-input.json

# 导出后发送报告
npm run dev -- \
  --platform liepin \
  --keyword "前端工程师" \
  --email recruiter@example.com \
  --cc audit@example.com
```

`--search-source saved` 是默认模式；`--application-filter-input-file` 只能和显式的 `--search-source direct` 一起使用。抓取、评分和导出结果会写入职位目录，最新运行摘要保存在 `runs/` 下。

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

Boss 未读聊天审核是独立模式：

```bash
PLAYWRIGHT_HEADLESS=false npm run dev -- \
  --platform boss \
  --boss-auto-chat true \
  --boss-forward-mode email \
  --boss-forward-recipient resume@example.com \
  --boss-chat-summary-email recruiter@example.com
```

自动聊天不能与普通抓取、批量、搜索订阅或 JD/RAG 问答参数混用。回复未匹配候选人默认关闭，只有显式设置 `--boss-chat-reply-unqualified true` 才会发送拒绝短语。

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

Vite 默认地址为 `http://127.0.0.1:5173`，并将 `/api` 代理到本地 API。控制台支持任务队列、职位和候选人查看、搜索订阅、Boss 自动聊天、RAG 运维和结构化助手草稿确认。

### 循环自动运行

控制台“自动运行”页可以创建由多个搜索或 Boss 自动聊天任务组成的串行计划。计划按每日时间窗口启动新一轮，并从上一轮全部任务完成后开始计算下一轮间隔；间隔为 `0` 时立即尝试重跑。所有轮次与手工任务共享一个全局队列，不会并发控制浏览器。

停止计划时使用“当前任务结束后停止”：正在运行的单个任务完成后，系统取消本轮余下任务并停止后续循环。`--platform all`、batch 和一次 Boss 自动聊天各自都视为一个单个任务，不会在内部被强制中断。

本机控制命令：

```bash
rtk npm run schedule:stop -- --schedule-id <scheduleId>
rtk npm run schedule:control -- pause --schedule-id <scheduleId>
rtk npm run schedule:control -- start --schedule-id <scheduleId>
rtk npm run schedule:control -- run-now --schedule-id <scheduleId>
```

## 配置参考

完整配置模板见 [.env.example](./.env.example)。常用配置包括：

- `DATA_DIR`：数据目录，默认 `./data`
- `PLAYWRIGHT_HEADLESS`：是否无头运行
- `PLAYWRIGHT_SEARCH_PAGE_TIMEOUT_MS`：搜索页面总超时，默认 `20000`
- `PLAYWRIGHT_RESUME_DETAIL_TIMEOUT_MS`：简历详情总超时，默认 `20000`
- `PLAYWRIGHT_<PLATFORM>_REUSE_BROWSER`：平台级浏览器复用开关
- `QDRANT_URL`、`QDRANT_API_KEY`：Qdrant 配置
- `SMTP_HOST`、`SMTP_PORT`、`SMTP_USER`、`SMTP_PASS`、`SMTP_FROM`：邮件配置

正常多平台运行时建议不要设置 `STORAGE_STATE_PATH`，让程序自动选择平台对应的登录态文件。

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
