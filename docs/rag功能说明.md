# RAG 功能说明

这份文档面向不熟悉 RAG 的使用者，说明当前项目里的 RAG 是什么、能解决什么问题、资料如何进入系统、候选人提问时系统如何回答，以及日常怎么维护。

## 一句话说明

RAG 可以理解为“先查资料，再回答问题”。

在本项目中，系统会把每个职位的 JD 和经过确认的历史对话保存起来。当候选人提问时，系统先从这些资料里找出最相关的内容，再让模型基于这些内容生成回答。

它的目标不是让模型自由发挥，而是让模型尽量只根据当前职位的可信资料回答。

## 适用场景

适合回答候选人围绕职位本身提出的问题，例如：

- 这个岗位薪资范围是多少？
- 是否接受大专？
- 英语是不是必须？
- 工作地点在哪里？
- 是否需要东南亚经验？
- 是否有住宿或补贴？
- 之前招聘方确认过的政策是什么？

不适合回答资料里没有的信息，例如：

- 公司未来战略。
- 面试官个人偏好。
- 未确认的福利细节。
- 其他职位的信息。

如果资料中没有答案，系统应该明确说明“当前 JD 或已确认历史答复中未说明”，并建议候选人与招聘方确认。

## 当前实现状态

当前项目已经实现的是：

- Qdrant 向量数据库。
- 本地 FastEmbed embedding 服务，把文本变成可检索的向量。
- 本地持久化事实库，保存在职位目录下。
- 元数据过滤，确保只查当前平台、当前职位、当前有效资料。
- 对话式 RAG，支持一个职位后续不断追加新对话。
- 混合检索，向量检索加关键词检索一起用。
- 重新排序，把更可能回答问题的资料排到前面。
- 可重建索引，Qdrant 数据可以从本地事实库重新生成。
- 回答日志、人工反馈、审核报告、质量指标、Doctor 巡检和一键运营报告。
- 回归评测、离线 CI 基线和产品化 HTTP API。

一句话概括：

```text
候选人问题
-> 查当前职位的 JD 和已确认历史答复
-> 用向量检索和关键词检索一起找资料
-> 融合排序并重新排序
-> 基于找到的资料生成回答
```

按当前代码状态，RAG 的核心闭环已经完整：职位 JD 可以进入事实库，历史对话可以持续追加，候选人问题可以通过 CLI 或 HTTP API 得到基于资料的回答，回答结果可以被记录、审核、反馈，并沉淀为回归用例。

它还不是完整的企业级 SaaS 能力。当前没有内置多租户、RBAC、限流、集中监控告警、可视化管理后台，也没有自动接入企业微信、网页 IM 或 CRM webhook。生产接入时，应把 `rag:api` 放在内网或网关后，由外层系统处理用户身份、权限、限流和审计。

## 关键概念

### JD

JD 就是职位描述。它是 RAG 最基础、最权威的资料来源。

系统会保存 JD 原文，也会保存解析后的结构化 JD，例如职位名称、薪资、地点、学历、经验、职责、硬性要求、优先条件等。

### 历史对话

历史对话是候选人与招聘方围绕该职位产生的问答记录。

系统会保存完整对话，但不是所有内容都会成为回答依据。

只有满足以下条件的内容才会进入事实检索：

```text
role = recruiter
verified = true
```

也就是说，只有“已确认的招聘方答复”才会作为事实。

候选人说的话、未确认的招聘方答复，都会被保存，但不会被当作事实回答其他候选人。

### Chunk

Chunk 是资料片段。

一整份 JD 或一整段对话太长，不适合直接检索，所以系统会把它切成较小的片段。候选人提问时，系统会找出最相关的几个片段。

### Embedding

Embedding 是把文字转换成数字向量。

可以把它理解成“让系统知道两段话在语义上有多接近”。例如：

```text
候选人问：薪资多少？
JD 里写：薪资范围 15-25K
```

即使两句话不完全一样，向量检索也应该能找到相关内容。

### Qdrant

Qdrant 是向量数据库。

它负责保存向量，并根据候选人的问题快速找出语义最接近的资料片段。

### 关键词检索

关键词检索负责补足向量检索不稳定的地方。

招聘问答里经常有精确词和数字，例如：

- 15-25K
- 大专
- 本科
- 英语
- 上海
- 东南亚
- 5年以上

这些内容只靠语义相似度有时不够稳定，所以系统还会用关键词方式再查一遍。

### 元数据过滤

元数据过滤是安全边界。

每个资料片段都会带上平台、职位、来源类型、是否有效、是否确认等信息。检索时系统会先过滤范围，例如：

```text
platform = 51job
jobKey = 当前职位
active = true
只允许 JD 或 verified=true 的历史答复
```

这样可以避免把其他职位、其他平台、未确认对话拿来回答。

## 资料如何进入系统

### 1. JD 进入系统

正常职位运行时，JD 会保存到：

```text
data/<platform>/jobs/<jobKey>/jd.json
```

之后可以显式建立 RAG 索引：

```bash
rtk npm run rag:index -- --platform <platform> --keyword "<关键词>"
```

如果用户直接用 `--jd-question` 问问题，而该职位还没有 RAG 索引，系统会自动索引当前已保存 JD。

### 2. 历史对话进入系统

对话文件可以是 JSON 数组，也可以是 JSONL。

示例：

```json
[
  {
    "id": "turn-1",
    "role": "candidate",
    "content": "这个岗位提供住宿吗？"
  },
  {
    "id": "turn-2",
    "role": "recruiter",
    "content": "可以提供住宿补贴。",
    "verified": true
  }
]
```

导入命令：

```bash
rtk npm run rag:ingest-conversation -- --platform <platform> --keyword "<关键词>" --conversation-id conv-001 --conversation-file ./conversation.json
```

真实聊天系统或人工确认表批量导入时，使用：

```bash
rtk npm run rag:ingest-conversations -- --file ./conversations.jsonl
rtk npm run rag:ingest-conversations -- --file ./conversations.jsonl --dry-run true
rtk npm run rag:ingest-conversations -- --file ./conversations.jsonl --fail-on-error false
rtk npm run rag:ingest-conversations -- --file ./conversations.jsonl --doctor true
```

批量文件支持 JSON 数组、`{ "items": [...] }` 包装对象，或 JSONL。每个 item 可以是一整段 conversation：

```json
{
  "platform": "51job",
  "keyword": "优衣库 店长",
  "conversationId": "conv-001",
  "turns": [
    { "id": "turn-1", "role": "candidate", "content": "这个岗位提供住宿吗？" },
    { "id": "turn-2", "role": "recruiter", "content": "可以提供住宿补贴。", "verified": true }
  ]
}
```

也可以是一行一个 turn，适合聊天系统导出的 JSONL：

```json
{"platform":"51job","jobKey":"优衣库","conversationId":"conv-001","id":"turn-1","role":"candidate","content":"这个岗位提供住宿吗？","createdAt":"2026-06-02T09:00:00.000Z"}
{"platform":"51job","jobKey":"优衣库","conversationId":"conv-001","id":"turn-2","role":"recruiter","content":"可以提供住宿补贴。","verified":true,"createdAt":"2026-06-02T09:01:00.000Z"}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `platform` | 必填，`51job`、`liepin` 或 `zhilian` |
| `jobKey` / `keyword` | 二选一；有 `jobKey` 时直接使用，否则从 `keyword` 派生 |
| `conversationId` | 必填，同一段候选人对话使用同一个 ID |
| `turns` | 可选；整段 conversation 导入时使用 |
| `id` | 单个 turn 的稳定 ID；用于幂等和覆盖修正 |
| `role` | `candidate`、`recruiter` 或 `system` |
| `content` | 对话文本 |
| `verified` | 只有 `role=recruiter` 且 `verified=true` 才会进入事实检索 |
| `createdAt` | 可选，对话时间 |
| `metadata` | 可选对象，保存外部系统字段 |

`--dry-run true` 只校验和汇总，不写本地文件、不调用 embedding、不写 Qdrant。默认遇到首个失败 item 会停止；如果希望单行失败不影响其他行，使用 `--fail-on-error false`，最后看输出里的 `failedCount` 和失败明细。

如果希望导入后立刻检查本次受影响职位的 RAG 状态，可以加：

```bash
rtk npm run rag:ingest-conversations -- --file ./conversations.jsonl --doctor true
rtk npm run rag:ingest-conversations -- --file ./conversations.jsonl --doctor true --doctor-question "这个岗位有住宿补贴吗？"
rtk npm run rag:ingest-conversations -- --file ./conversations.jsonl --doctor true --fail-on-doctor-issue true
```

`--doctor true` 会在导入结束后，把本次成功导入的 `platform + jobKey` 去重，然后逐个运行 `rag:doctor`。诊断结果会放在同一个输出 JSON 的 `doctorSummary` 里。导入失败的 item 不会进入 doctor；同一职位有多段对话也只诊断一次。`--doctor-question` 是诊断用的问题，会触发 dense、keyword、hybrid 三路检索检查。`--fail-on-doctor-issue true` 适合自动任务：只要 `doctorSummary.status` 不是 `ok`，命令退出码就是失败。`--dry-run true --doctor true` 只返回空的 doctor 汇总，不会诊断未写入的数据。

导入后：

- 完整对话会保存到本地。
- 重复导入同一个 turn id 会覆盖旧 turn，不会重复写入。
- 新增 turn 会和已保存 turn 合并，然后重建当前 conversationId 的事实向量。
- 已确认招聘方答复会进入 Qdrant 向量索引。
- 候选人发言不会作为事实进入检索。
- 未确认招聘方答复不会作为事实进入检索。

建议业务系统给每轮对话传稳定的 `id`。如果没有传 `id`，系统会用 `role`、`createdAt` 和 `content` 生成稳定 id；同一条内容、同一时间重复导入时仍然可以去重。

## 候选人提问时发生了什么

候选人提问时，系统会按下面流程处理：

```text
1. 接收问题
2. 把问题转换成向量
3. 在 Qdrant 里查语义相近的资料片段
4. 在本地 chunks.jsonl 里做关键词检索
5. 两路结果合并去重
6. 根据相关性重新排序
7. 把最相关片段交给模型
8. 模型基于这些片段生成中文回答
9. 把本次问答追加到 answer-logs.jsonl
```

当前回答不会打开浏览器，不会抓候选人，不会评分，不会导出报告，也不会发邮件。

## 怎么提问

对已保存职位提问：

```bash
rtk npm run dev -- --platform <platform> --keyword "<关键词>" --jd-question "这个岗位薪资范围是多少？"
```

`--rag-question` 是同一功能的别名：

```bash
rtk npm run dev -- --platform <platform> --keyword "<关键词>" --rag-question "这个岗位需要英语吗？"
```

直接使用 RAG 问答脚本：

```bash
rtk npm run rag:ask -- --platform <platform> --keyword "<关键词>" --question "这个岗位需要出差吗？"
```

如果只是临时拿一份 JD 问答，不想创建职位记录：

```bash
rtk npm run dev -- --platform <platform> --keyword "<关键词>" --jd-file ./fixtures/jd.txt --jd-question "这个岗位接受大专吗？"
```

注意：临时 JD 问答不会写入职位 RAG 索引。

## 回答日志和反馈闭环

已保存职位每次通过 `rag:ask`、`--jd-question` 或 `--rag-question` 完成 RAG 回答后，系统会追加一条审计日志：

```text
data/<platform>/jobs/<jobKey>/rag/answer-logs.jsonl
```

日志是一行一个 JSON，主要字段如下：

```json
{
  "platform": "51job",
  "jobKey": "优衣库",
  "logId": "answer-log-xxxx",
  "question": "这个岗位有住宿补贴吗？",
  "answer": "可以提供住宿补贴。",
  "answered": true,
  "confidence": 0.42,
  "noAnswerReason": null,
  "sources": [
    {
      "chunkId": "conversation-conv-001-turn-2",
      "sourceType": "conversation",
      "verified": true,
      "score": 0.42
    }
  ],
  "createdAt": "2026-06-09T00:00:00.000Z"
}
```

如果系统拒答，也会记录同样的日志，`answered=false`，并在 `noAnswerReason` 中标出原因，例如 `no_trusted_context` 或 `low_confidence`。这样可以回看候选人问过什么、系统答了什么、引用了哪些 JD 或已确认历史对话，以及为什么没有回答。

每条新日志都会带一个稳定的 `logId`。老日志没有 `logId` 时，系统读取或重写日志时会按 `platform + jobKey + createdAt + question` 自动补齐。

人工审核前，可以先生成 Review 报告：

```bash
rtk npm run rag:review -- --platform 51job --keyword "东南亚 销售"
rtk npm run rag:review -- --platform 51job --keyword "东南亚 销售" --output ./rag-review.md
rtk npm run rag:review -- --platform 51job --keyword "东南亚 销售" --format json --output ./rag-review.json
```

`rag:review` 默认输出 Markdown，列出需要人工处理的问题：未审核回答、拒答、低置信回答、没有引用来源的回答，以及已经标记为错误的回答。已经标记 `feedback.correct=true` 的日志默认不展示；需要完整列表时加 `--include-reviewed true`。报告里每条记录会展示 `logId`、问题、回答、confidence、拒答原因、引用来源摘要，并给出可复制的 `rag:feedback` 命令。如果旧日志已经 `feedback.correct=false` 但缺少 `feedback.errorType`，报告会把它计入 `Missing error types`，并在该条记录下给出补标命令。

多职位审核时，用批量 Review：

```bash
rtk npm run rag:review:batch -- --file ./rag-review-jobs.json --output ./rag-review.md
rtk npm run rag:review:batch -- --file ./rag-review-jobs.json --format json --output ./rag-review.json
rtk npm run rag:review:batch -- --file ./rag-review-jobs.json --fail-on-issue true
```

批量文件支持 JSON 数组、`{ "items": [...] }` 包装对象，或 JSONL。每个 item 只需要：

```json
{
  "platform": "51job",
  "keyword": "东南亚 销售"
}
```

也可以直接传 `jobKey`：

```json
{
  "platform": "liepin",
  "jobKey": "东南亚-销售"
}
```

`rag:review:batch` 会对每个职位复用单职位 `rag:review`，再生成全局汇总：职位数、需要审核的职位数、总问答数、未审核数、已标错数、缺失错误类型数、拒答数、低置信数和无来源数。`--fail-on-issue true` 适合定时任务或 CI：只要存在需要审核的记录或某个职位读取失败，命令返回失败码。

如果要看一段时间内整体 RAG 质量，可以导出 Metrics：

```bash
rtk npm run rag:metrics -- --file ./rag-review-jobs.json --output ./rag-metrics.json
rtk npm run rag:metrics -- --file ./rag-review-jobs.json --format markdown --output ./rag-metrics.md
rtk npm run rag:metrics -- --file ./rag-review-jobs.json --since 2026-06-01 --until 2026-06-09T23:59:59.999Z
rtk npm run rag:metrics -- --file ./rag-review-jobs.json --policy ./rag-metrics-policy.json --fail-on-threshold true
```

`rag:metrics` 复用同一份职位列表，只读 `answer-logs.jsonl`，输出整体、按平台、按职位、按日期的质量指标，包括总问答数、已审核数、未审核数、人工正确率、错误率、拒答率、低置信率、无来源率、平均 confidence 和错误类型分布。人工正确率只在已审核样本上计算；拒答率、低置信率和无来源率按总问答数计算；错误类型分布只统计 `feedback.correct=false` 的日志。

JSON 输出中，每个 overall/platform/job/day bucket 都会包含 `errorTypes`：

```json
[
  {
    "errorType": "wrong_fact",
    "count": 2,
    "incorrectRate": 0.6667
  },
  {
    "errorType": "unspecified",
    "count": 1,
    "incorrectRate": 0.3333
  }
]
```

旧日志如果已经标错但没有 `errorType`，会归入 `unspecified`。Markdown 输出会单独展示整体 Error Types，并在平台、职位、日期表格中展示 Top Error Types。

质量阈值可以写成 policy 文件，便于版本化和接入 CI：

```json
{
  "minReviewRate": 0.8,
  "minCorrectRate": 0.9,
  "maxIncorrectRate": 0.1,
  "maxNoAnswerRate": 0.3,
  "maxLowConfidenceRate": 0.2,
  "maxMissingSourcesRate": 0.05,
  "maxErrorTypeRates": {
    "unsupported_claim": 0.2,
    "bad_source": 0.2,
    "unspecified": 0.1
  }
}
```

`maxErrorTypeRates` 按“某类错误在所有人工标错日志中的占比”判断。例如 `unsupported_claim: 0.2` 表示：在 `feedback.correct=false` 的日志里，资料外承诺类错误不能超过 20%。

`rag:metrics` 输出中会包含 `thresholds`、`thresholdViolations` 和 `recommendations`。命令行阈值会覆盖 policy 中的同名字段，例如 `--min-correct-rate 0.85` 会覆盖 `minCorrectRate`。试运行阶段可以先放宽，例如 `minReviewRate=0.3`、`minCorrectRate=0.7`；生产阶段再提高到更严格的审核率和正确率。`--fail-on-threshold true` 会在普通质量阈值或错误类型阈值违规时返回失败码。

日常运营可以用一条命令把 Doctor、Review 和 Metrics 合在一份报告里：

```bash
rtk npm run rag:ops -- --file ./rag-review-jobs.json --question "这个岗位薪资范围是多少？" --policy ./rag-metrics-policy.json --output ./rag-ops.md
rtk npm run rag:ops -- --file ./rag-review-jobs.json --policy ./rag-metrics-policy.json --fail-on-issue true
```

`rag:ops` 会先批量检查每个职位的 RAG 健康状态，再生成待人工审核清单，最后汇总质量指标和 policy 阈值违规。它的 `status` 有三种：`ok` 表示没有待处理问题，`needs_attention` 表示有 warning 或待审核记录，`failed` 表示存在 Doctor error、读取失败或质量阈值违规。Markdown 报告里会包含统一建议、Doctor 摘要、Review 明细和 Metrics 明细。

如果要给业务系统接入产品化接口，可以启动 RAG HTTP 服务：

```bash
rtk npm run rag:api
RAG_API_KEY=secret rtk npm run rag:api -- --host 127.0.0.1 --port 3978
```

默认只监听本机 `127.0.0.1:3978`。设置 `RAG_API_KEY` 后，请求需要带：

```text
Authorization: Bearer secret
```

当前接口：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查 |
| `POST` | `/v1/rag/answer` | 根据当前职位 JD 和 verified 历史答复回答候选人问题 |
| `POST` | `/v1/rag/conversations` | 导入某个职位的一段历史对话，并把 verified 招聘方答复写入索引 |

问答请求示例：

```json
{
  "platform": "51job",
  "keyword": "优衣库 店长",
  "question": "这个岗位薪资范围是多少？",
  "topK": 8,
  "autoIndex": true,
  "logAnswer": true,
  "metadata": {
    "externalConversationId": "conv-001"
  }
}
```

对话导入请求示例：

```json
{
  "platform": "51job",
  "keyword": "优衣库 店长",
  "conversationId": "conv-001",
  "turns": [
    { "id": "turn-1", "role": "candidate", "content": "这个岗位有住宿补贴吗？" },
    { "id": "turn-2", "role": "recruiter", "content": "每月800元住宿补贴。", "verified": true }
  ]
}
```

接口和 CLI 共用同一套底层逻辑，所以数据隔离、元数据过滤、verified 规则、自动索引和 answer log 行为保持一致。生产部署建议放在内网或网关后面，开启 `RAG_API_KEY`，并通过网关或上游业务系统补齐身份认证、权限、限流、请求追踪和监控告警。

人工审核后，可以用 `rag:feedback` 把反馈写回对应日志：

```bash
rtk npm run rag:feedback -- --platform 51job --keyword "东南亚 销售" --log-id answer-log-xxxx --correct true --note "回答准确" --reviewer "recruiter-a"
rtk npm run rag:feedback -- --platform 51job --keyword "东南亚 销售" --created-at "2026-06-09T00:00:00.000Z" --correct false --error-type wrong_fact --note "薪资说错"
rtk npm run rag:feedback -- --platform 51job --keyword "东南亚 销售" --question "这个岗位有住宿补贴吗？" --correct true
```

推荐优先用 `--log-id`。`--created-at` 适合旧日志或临时定位；`--question` 只有在该问题唯一出现时才适合使用，如果同一个问题出现多次，命令会拒绝写入，要求改用 `--log-id` 或 `--created-at`。

`--error-type` 只用于 `--correct false`，方便后续统计错误原因。当前支持：

| errorType | 说明 |
| --- | --- |
| `wrong_fact` | 回答事实错误，例如薪资、地点、学历说错 |
| `unsupported_claim` | 回答包含资料里没有的承诺或推断 |
| `missing_context` | 资料里有答案，但回答漏掉关键上下文 |
| `bad_source` | 引用了不合适或不可信来源 |
| `low_relevance` | 召回片段和问题相关性低 |
| `wording_issue` | 表述不专业、不清楚或容易误解 |
| `other` | 其他问题 |

写入后的人工反馈字段是 `feedback`：

```json
{
  "feedback": {
    "correct": false,
    "errorType": "wrong_fact",
    "note": "薪资说错",
    "reviewedAt": "2026-06-09T01:00:00.000Z",
    "reviewer": "recruiter-a"
  }
}
```

系统默认只追加原始问答日志；只有显式运行 `rag:feedback` 时才会重写 `answer-logs.jsonl` 中的匹配日志。可以基于这些日志生成 `rag:answer-eval` 用例，把真实候选人问题沉淀成回归集：

```bash
rtk npm run rag:export-answer-eval -- --platform 51job --keyword "东南亚 销售" --output ./fixtures/rag/my-job.answer.json
rtk npm run rag:export-answer-eval -- --platform 51job --keyword "东南亚 销售" --output ./tmp.answer.json --only-feedback false
rtk npm run rag:export-answer-eval -- --platform 51job --keyword "东南亚 销售" --output ./tmp.answer.json --include-no-answer true
rtk npm run rag:export-answer-eval -- --platform 51job --keyword "东南亚 销售" --output ./tmp.answer.json --expected-text-mode source
rtk npm run rag:export-answer-eval -- --platform 51job --keyword "东南亚 销售" --output ./tmp.answer.json --expected-text-mode hybrid --include-no-answer true
```

默认 `--only-feedback true`，只导出 `feedback.correct=true` 的日志，避免未审核回答进入回归。需要先导出草稿时，可以传 `--only-feedback false`。默认不导出拒答日志；需要把 `answered=false` 的日志也变成 `expectNoAnswer` 用例时，传 `--include-no-answer true`。

`--expected-text-mode` 控制 `expectedAnswerIncludes` 如何生成：

| 模式 | 作用 |
| --- | --- |
| `answer` | 默认模式，把完整回答作为期望文本，兼容旧行为 |
| `source` | 从当时引用的 JD 或 verified 历史答复里提取与回答匹配的关键事实短语 |
| `hybrid` | 优先使用 `source` 提取；提取不到时回退到完整回答 |

`source` 和 `hybrid` 更适合作为长期回归草稿，因为它们通常会生成类似 `15-25K，13薪`、`每月800元住宿补贴` 这样的稳定事实短语，而不是整段自然语言回答。导出的 case 会带 `metadata.draft=true` 和 `metadata.expectedTextNeedsReview=true`，提醒仍需要人工确认。

导出的文件是 `{ "cases": [...] }`，可直接交给 `rag:answer-eval`。系统会自动填入：

- `question`
- `expectedAnswerIncludes`：默认使用当时的完整回答文本
- `expectedSourceTypes`
- `expectedChunkIds`
- `expectedConversationIds`
- `metadata.logId`：对应原始问答日志 ID
- `metadata.expectedTextMode`：本次导出使用的期望文本模式
- `metadata.expectedTextReviewNote`：为什么需要人工检查

自动导出的 `expectedAnswerIncludes` 更适合作为草稿。建议人工把完整回答改成关键事实短语，例如把“这个岗位薪资范围是15-25K，13薪。”改成 `["15-25K", "13薪"]`，这样回归不会因为措辞变化而过于脆弱。

离线评测命令 `rag:answer-eval` 和 `rag:regression` 默认不会写入 `answer-logs.jsonl`，避免评测数据污染真实候选人问答日志。临时 `--jd-file` / `--jd` 问答也不会写日志，因为它没有创建职位记录。

日常运营可直接参考 `docs/rag运营手册.md`。可复制的批量职位列表、Metrics policy 和对话导入模板在 `fixtures/rag/` 下：

- `rag-review-jobs.example.json`
- `rag-metrics-policy.example.json`
- `conversation-import.example.jsonl`

## 数据保存在哪里

每个职位的 RAG 数据保存在：

```text
data/<platform>/jobs/<jobKey>/rag/
```

里面主要有：

```text
sources.jsonl
chunks.jsonl
embeddings.jsonl
conversations/<conversationId>.jsonl
index-manifest.json
answer-logs.jsonl
```

含义如下：

| 文件 | 作用 |
| --- | --- |
| `sources.jsonl` | 记录资料来源，例如某版 JD、某段对话 |
| `chunks.jsonl` | 保存实际参与检索的资料片段 |
| `embeddings.jsonl` | 保存 embedding 缓存，避免相同内容重复调用 embedding 服务 |
| `conversations/*.jsonl` | 保存导入的完整历史对话 |
| `index-manifest.json` | 记录最近一次索引构建摘要 |
| `answer-logs.jsonl` | 保存真实 RAG 问答日志，后续可用于人工复盘和生成评测集 |

本地 JSONL 是事实源。Qdrant 是可重建索引。

这意味着即使 Qdrant 数据丢失，也可以从本地文件重建：

```bash
rtk npm run rag:rebuild -- --platform <platform> --keyword "<关键词>"
```

## JD 更新后会怎样

如果同一个职位后续更新了 JD，重新索引时：

- 新 JD 会成为 active 资料。
- 旧 JD 不会删除，会标记为 inactive。
- 回答问题时只检索 active 资料。
- 历史版本仍保存在本地，方便追踪。

这样可以避免旧 JD 继续影响候选人问答。

## 历史对话持续增加时会怎样

一个职位可以不断导入新的对话。

每次导入时：

- 系统先读取当前 conversationId 已保存的 turn。
- 新传入的 turn 会按 `id` 合并；同 id 新内容覆盖旧内容。
- 当前 conversationId 的 sources、chunks 和 Qdrant 向量会基于合并后的完整 turn 重建。
- 只有 verified=true 的招聘方答复进入事实检索。
- 其他对话内容只作为记录保存，不会参与回答。

## 当前安全边界

系统会尽量做到：

- 不跨平台回答。
- 不跨职位回答。
- 不使用 inactive 旧 JD。
- 不使用未确认招聘方答复。
- 不使用候选人发言作为事实。
- 回答资料中没有的信息时说明未提及。

但它仍然依赖模型生成自然语言回答，所以重要问题仍建议人工复核，例如：

- 薪资承诺。
- 福利政策。
- 录用条件。
- 法律合规相关表述。

## 配置项

基础配置：

```bash
OPENAI_API_KEY=...
OPENAI_MODEL=...
QDRANT_URL=http://localhost:6333
```

可选配置：

```bash
QDRANT_API_KEY=...
RAG_MODEL=...
RAG_EMBEDDING_PROVIDER=local-http
RAG_EMBEDDING_LOCAL_URL=http://127.0.0.1:8011
RAG_EMBEDDING_MODEL=BAAI/bge-small-zh-v1.5
RAG_VECTOR_COLLECTION=autorecruit_rag_chunks
```

检索相关配置：

```bash
RAG_TOP_K=8
RAG_RETRIEVAL_MODE=hybrid
RAG_DENSE_TOP_K=32
RAG_KEYWORD_TOP_K=32
RAG_RERANK_CANDIDATE_K=24
RAG_MIN_CONFIDENCE_SCORE=0.08
```

说明：

| 配置 | 默认值 | 作用 |
| --- | --- | --- |
| `RAG_EMBEDDING_PROVIDER` | `local-http` | embedding 服务来源；默认使用本机 HTTP embedding 服务，也可显式设为 `openai` |
| `RAG_EMBEDDING_MODEL` | `BAAI/bge-small-zh-v1.5` | embedding 模型名 |
| `RAG_EMBEDDING_LOCAL_URL` | `http://127.0.0.1:8011` | `local-http` provider 的服务地址 |
| `RAG_EMBEDDING_LOCAL_API_KEY` | 无 | `local-http` provider 的可选 bearer token |
| `RAG_TOP_K` | `8` | 最终给模型的资料片段数量 |
| `RAG_RETRIEVAL_MODE` | `hybrid` | `hybrid` 表示向量加关键词；`dense` 表示只用 Qdrant 向量 |
| `RAG_DENSE_TOP_K` | `RAG_TOP_K * 4` | Qdrant 向量召回候选数 |
| `RAG_KEYWORD_TOP_K` | `RAG_TOP_K * 4` | 关键词召回候选数 |
| `RAG_RERANK_CANDIDATE_K` | `RAG_TOP_K * 3` | 融合后进入重新排序的候选数 |
| `RAG_MIN_CONFIDENCE_SCORE` | `0.08` | 最低可信召回分；低于该值时直接回答未说明。hybrid 模式下这是排序分，不是概率 |

一般不需要调整这些参数。只有当回答经常漏掉精确数字或关键词时，才考虑增大召回数量。

当前项目推荐使用本地 embedding 服务。开发调试时，可以直接从仓库启动：

```bash
rtk .venv/bin/pip install -r requirements-rag-embedding.txt
rtk npm run rag:embedding:local
```

默认监听 `127.0.0.1:8011`，使用 `BAAI/bge-small-zh-v1.5`。首次启动会下载模型；如果下载需要代理，可以在启动前设置：

```bash
HTTP_PROXY=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897 rtk npm run rag:embedding:local
```

本机长期使用时，推荐把 embedding 服务作为 LaunchAgent 常驻运行，而不是依赖终端窗口。当前可用的本机常驻路径是：

```text
~/.local/bin/autorecruit-local-embedding
~/.local/share/autorecruit/embedding/local_embedding_server.py
~/.local/share/autorecruit/embedding/requirements-rag-embedding.txt
~/.local/share/autorecruit/embedding/.venv/
~/Library/LaunchAgents/com.autorecruit.embedding.plist
~/.local/var/log/autorecruit/local-embedding.log
~/.local/var/log/autorecruit/local-embedding.err.log
```

之所以把 LaunchAgent 运行目录放在 `~/.local/share/autorecruit/embedding/`，是因为 macOS 的后台服务对 `~/Documents` 目录可能受到隐私权限限制；用独立运行目录更稳定。仓库里的 `scripts/local_embedding_server.py` 和 `requirements-rag-embedding.txt` 仍然是源文件，常驻目录只是运行时副本。

检查常驻服务：

```bash
rtk launchctl list | rtk rg 'com\\.autorecruit\\.(qdrant|embedding)'
rtk curl -sSf http://127.0.0.1:8011/health
rtk tail -80 ~/.local/var/log/autorecruit/local-embedding.err.log
```

健康检查返回示例：

```bash
RAG_EMBEDDING_PROVIDER=local-http
RAG_EMBEDDING_LOCAL_URL=http://127.0.0.1:8011
RAG_EMBEDDING_MODEL=BAAI/bge-small-zh-v1.5
rtk curl http://127.0.0.1:8011/health
```

本地服务需要提供：

```text
POST /embeddings
```

请求体：

```json
{
  "model": "BAAI/bge-small-zh-v1.5",
  "input": ["第一段文本", "第二段文本"]
}
```

返回体支持 OpenAI 风格：

```json
{
  "data": [
    { "embedding": [0.1, 0.2, 0.3] },
    { "embedding": [0.4, 0.5, 0.6] }
  ]
}
```

也支持简单格式：

```json
{
  "embeddings": [
    [0.1, 0.2, 0.3],
    [0.4, 0.5, 0.6]
  ]
}
```

embedding 缓存按 `provider + model + 内容 hash` 命中。相同职位资料重复建索引时，会优先复用 `rag/embeddings.jsonl` 中的缓存，不再重复请求 embedding 服务。

## 常见操作

### 为职位建立 RAG 索引

```bash
rtk npm run rag:index -- --platform 51job --keyword "东南亚 销售"
```

### 问一个职位问题

```bash
rtk npm run rag:ask -- --platform 51job --keyword "东南亚 销售" --question "薪资范围是多少？"
```

输出是 JSON，核心字段包括：

| 字段 | 含义 |
| --- | --- |
| `answer` | 给候选人的中文回答 |
| `answered` | `true` 表示使用可信资料生成了回答；`false` 表示触发兜底 |
| `confidence` | 当前最高可信片段的召回排序分，用于排查，不是概率 |
| `noAnswerReason` | 兜底原因，例如 `no_trusted_context` 或 `low_confidence` |
| `sources` | 本次回答引用的资料片段，包含 JD/历史对话来源、chunkId、conversationId、verified 和 score |

如果没有命中 JD 或已确认招聘方答复，或者最高可信片段低于 `RAG_MIN_CONFIDENCE_SCORE`，系统不会调用回答模型自由发挥，而是直接返回“目前 JD 和已确认历史答复中未说明这一信息，建议与招聘方进一步确认。”

### 检查一个职位的 RAG 状态

只看本地 RAG 文件统计，不调用模型，也不连接 Qdrant：

```bash
rtk npm run rag:inspect -- --platform 51job --keyword "东南亚 销售"
```

输出里重点看：

| 字段 | 含义 |
| --- | --- |
| `manifest` | 最近一次索引构建摘要，例如 embedding 模型、向量库、索引片段数 |
| `sourceCounts` | 资料来源数量，例如 JD 来源、历史对话来源、active/inactive 数量 |
| `chunkCounts` | 实际资料片段数量，以及哪些片段可以作为事实参与回答 |
| `embeddingCacheCount` | 本地 embedding 缓存数量 |
| `activeJdSources` | 当前有效 JD 版本 |
| `inactiveJdSources` | 历史旧 JD 版本 |
| `conversations` | 已导入的对话 ID、已确认事实片段数、未确认片段数 |

如果想排查某个问题为什么命中或没命中哪些资料，可以加 `--question`：

```bash
rtk npm run rag:inspect -- --platform 51job --keyword "东南亚 销售" --question "薪资范围是多少？"
```

带问题的诊断会额外输出：

| 字段 | 含义 |
| --- | --- |
| `denseResults` | Qdrant 向量检索命中的片段 |
| `keywordResults` | 本地关键词检索命中的片段 |
| `hybridResults` | 向量和关键词融合、重新排序后的最终候选片段 |

`rag:inspect` 不会生成候选人回答。它只用来排查当前职位 RAG 资料是否完整、索引是否正常、某个问题会召回哪些上下文。

### 诊断一个职位的 RAG 问题

`rag:doctor` 是只读排障命令。它会调用 `rag:inspect` 的统计和可选检索诊断，再给出状态、风险和建议动作：

```bash
rtk npm run rag:doctor -- --platform 51job --keyword "东南亚 销售"
rtk npm run rag:doctor -- --platform 51job --keyword "东南亚 销售" --question "这个岗位有住宿补贴吗？"
rtk npm run rag:doctor:batch -- --file ./rag-doctor-jobs.json
```

输出里的 `status` 可能是：

| 状态 | 含义 |
| --- | --- |
| `ok` | 未发现明显问题 |
| `warning` | RAG 可用但存在风险，例如对话没有 verified 招聘方事实、manifest 计数不一致、问题检索无命中 |
| `error` | RAG 不完整或外部依赖不可用，例如缺少 manifest、没有 chunks、Qdrant 不可连接 |

常见诊断项包括：

| code | 含义 |
| --- | --- |
| `missing_manifest` | 缺少 `rag/index-manifest.json` |
| `no_sources` / `no_chunks` | 本地事实源或 chunk 为空 |
| `conversation_without_verified_facts` | 已导入对话，但没有 verified 招聘方事实 |
| `embedding_model_mismatch` / `embedding_provider_mismatch` | 当前 embedding 配置和 manifest 不一致 |
| `missing_qdrant_url` / `qdrant_unreachable` | Qdrant 配置缺失或不可连接 |
| `dense_no_results` / `keyword_no_results` / `hybrid_no_results` | 带问题诊断时，对应检索路径没有命中 |

### 批量诊断多个职位

后期一个职位会持续加入新的对话，多个职位也会同时运行。`rag:doctor:batch` 用来一次检查多个职位的 RAG 健康状态：

```bash
rtk npm run rag:doctor:batch -- --file ./rag-doctor-jobs.json
rtk npm run rag:doctor:batch -- --file ./rag-doctor-jobs.json --question "这个岗位有住宿补贴吗？"
rtk npm run rag:doctor:batch -- --file ./rag-doctor-jobs.json --fail-on-issue true
```

批量文件支持 JSON 数组、`{ "items": [...] }` 包装对象，或 JSONL。每个 item 至少提供 `platform` 和 `jobKey`，也可以用 `keyword` 代替 `jobKey`：

```json
[
  {
    "platform": "51job",
    "jobKey": "优衣库",
    "question": "这个岗位有住宿补贴吗？"
  },
  {
    "platform": "liepin",
    "keyword": "销售经理",
    "question": "这个岗位需要出差吗？"
  }
]
```

`--question` 是全局默认诊断问题；如果 item 自己有 `question`，优先使用 item 里的问题。输出会包含：

| 字段 | 含义 |
| --- | --- |
| `status` | 全批次状态；任一职位 error 或执行失败就是 `error`，否则有 warning 就是 `warning` |
| `okCount` / `warningCount` / `errorCount` / `failedCount` | 各状态职位数量 |
| `issueCounts` | 按 code 聚合的高频问题，方便看是否是系统性故障 |
| `recommendations` | 去重后的处理建议 |
| `results` | 每个职位的完整 doctor 结果或执行错误 |

批量诊断不会因为单个职位失败就停止，它会尽量把后续职位也诊断完。`--fail-on-issue true` 只影响命令退出码，适合 CI、定时任务或上线前检查：只要有 warning、error 或执行失败，命令就返回失败码。

### 批量评测 RAG 召回质量

`rag:eval` 用来批量检查一组候选人问题是否能召回预期资料。它复用 `rag:inspect` 的 dense、keyword、hybrid 诊断结果，不生成候选人回答。

```bash
rtk npm run rag:eval -- --platform 51job --keyword "东南亚 销售" --eval-file ./rag-eval.json
```

评测文件可以是 JSON 数组：

```json
[
  {
    "id": "salary",
    "question": "薪资范围是多少？",
    "expectedTextIncludes": ["15-25K"],
    "expectedSourceTypes": ["jd"]
  },
  {
    "id": "housing",
    "question": "提供住宿吗？",
    "expectedTextIncludes": ["住宿补贴"],
    "expectedSourceTypes": ["conversation"],
    "expectedConversationIds": ["conv-001"]
  },
  {
    "id": "stock",
    "question": "公司是否提供股票期权？",
    "expectNoAnswer": true,
    "unexpectedTextIncludes": ["股票期权"]
  }
]
```

也可以写成：

```json
{
  "cases": [
    {
      "question": "这个岗位需要英语吗？",
      "expectedTextIncludes": ["英语"],
      "expectedSourceTypes": ["jd"]
    }
  ]
}
```

常用期望字段：

| 字段 | 含义 |
| --- | --- |
| `expectedTextIncludes` | hybrid 最终候选片段里应该包含的文字 |
| `expectedSourceTypes` | 期望来源类型，例如 `jd` 或 `conversation` |
| `expectedChunkIds` | 期望命中的具体 chunkId |
| `expectedConversationIds` | 期望命中的历史对话 ID |
| `expectNoAnswer` | 该问题应该没有明确资料可答 |
| `unexpectedTextIncludes` | 无答案或负例中不应出现的文字 |
| `maxHybridResults` | 可选，限制最终候选片段数量；设为 `0` 表示必须完全无召回 |

输出里会包含：

- `hitRate`：全部 case 的通过率。
- `recallAtK`：有明确期望资料的 case 中，最终 topK 是否命中。
- `sourceTypeAccuracy`：来源类型是否符合期望。
- `noAnswerAccuracy`：无答案 case 是否没有命中禁止内容。
- 每个 case 的 dense、keyword、hybrid 命中 chunk。

注意：`rag:eval` 只评测召回，不评估最终模型生成文本。如果要检查最终回答是否说清楚、是否越界，使用下面的 `rag:answer-eval`。

### 批量评测最终回答

`rag:answer-eval` 用来检查候选人最终看到的回答文本。它会真实走 `rag:ask` 的问答链路，检查回答是否包含预期事实、是否出现禁止内容、引用来源是否符合预期。

```bash
rtk npm run rag:answer-eval -- --platform 51job --keyword "东南亚 销售" --eval-file ./rag-answer-eval.json
```

示例评测文件：

```json
[
  {
    "id": "salary-answer",
    "question": "薪资范围是多少？",
    "expectedAnswerIncludes": ["15-25K"],
    "forbiddenAnswerIncludes": ["30K", "面议"],
    "expectedSourceTypes": ["jd"]
  },
  {
    "id": "stock-answer",
    "question": "公司是否提供股票期权？",
    "expectNoAnswer": true,
    "expectedNoAnswerIncludes": ["未说明"],
    "forbiddenAnswerIncludes": ["提供股票期权", "有期权"]
  }
]
```

常用字段：

| 字段 | 含义 |
| --- | --- |
| `expectedAnswerIncludes` | 最终回答中应该出现的文字 |
| `forbiddenAnswerIncludes` | 最终回答中不允许出现的文字 |
| `expectedSourceTypes` | 回答引用来源应包含的类型，例如 `jd` 或 `conversation` |
| `expectedChunkIds` | 回答引用来源应包含的 chunkId |
| `expectedConversationIds` | 回答引用来源应包含的历史对话 ID |
| `expectNoAnswer` | 该问题应该回答“资料未说明” |
| `expectedNoAnswerIncludes` | 无答案回答里应该出现的提示文字；不填时默认检查 `未说明` |

`rag:answer-eval` 默认有失败 case 时退出码为 `1`。它适合放进回归检查，用来防止模型回答越界、编造或引用错误来源。

也可以从真实问答日志生成初始评测文件：

```bash
rtk npm run rag:review -- --platform 51job --keyword "东南亚 销售" --output ./rag-review.md
rtk npm run rag:feedback -- --platform 51job --keyword "东南亚 销售" --log-id answer-log-xxxx --correct true --note "已人工确认"
rtk npm run rag:export-answer-eval -- --platform 51job --keyword "东南亚 销售" --output ./rag-answer-eval.json
rtk npm run rag:export-answer-eval -- --platform 51job --keyword "东南亚 销售" --expected-text-mode source --output ./rag-answer-eval.json
```

默认只导出 `feedback.correct=true` 的日志。默认 `--expected-text-mode answer` 会导出完整回答；推荐用 `--expected-text-mode source` 或 `hybrid` 先从引用来源里生成关键事实草稿，再人工检查 `expectedAnswerIncludes` 后放入回归套件。

### 运行 RAG 回归套件

`rag:regression` 用来一次性运行多个职位的召回评测和答案评测。它读取一个 suite 文件，按顺序执行每个职位的 `rag:eval` 和 `rag:answer-eval`，最后输出总汇总。

```bash
rtk npm run rag:regression -- --suite-file ./fixtures/rag/regression.json
```

suite 文件可以是 JSON 数组：

```json
[
  {
    "id": "51job-sea-sales",
    "platform": "51job",
    "keyword": "东南亚 销售",
    "retrievalEvalFile": "./51job-sea-sales.retrieval.json",
    "answerEvalFile": "./51job-sea-sales.answer.json"
  }
]
```

也可以写成：

```json
{
  "items": [
    {
      "platform": "liepin",
      "jobKey": "senior-sales",
      "retrievalEvalFile": "./liepin-senior-sales.retrieval.json"
    }
  ]
}
```

字段说明：

| 字段 | 含义 |
| --- | --- |
| `id` | 可选，方便识别套件项 |
| `platform` | 平台，例如 `51job`、`liepin`、`zhilian` |
| `keyword` | 职位关键词；未提供 `jobKey` 时用它生成 jobKey |
| `jobKey` | 已保存职位 key；和 `keyword` 二选一 |
| `retrievalEvalFile` | 可选，召回评测文件 |
| `answerEvalFile` | 可选，答案评测文件 |

评测文件路径相对 suite 文件所在目录解析。每个套件项至少要提供一个 `retrievalEvalFile` 或 `answerEvalFile`。

输出里会汇总：

- 总职位数、通过职位数、失败职位数。
- 召回评测 case 总数和失败数。
- 答案评测 case 总数和失败数。
- 每个职位的完整 `rag:eval` / `rag:answer-eval` 结果。

默认有任何失败时退出码为 `1`，适合在改 embedding、chunk、rerank、prompt 后跑一次，防止质量退化。

仓库内已经提供第一批轻量基线：

```bash
rtk npm run rag:baseline
rtk npm run test:rag:offline
```

这套基线使用 `fixtures/rag/regression.json`，覆盖薪资、工作地点、学历、经验、语言要求、岗位职责、排班要求、已确认历史对话里的住宿补贴、未确认历史对话不能作为事实的负例，以及一个 JD 未说明的负例问题。`rag:baseline` 会先把 `fixtures/rag/jobs/51job/优衣库/jd.json` 写入本机 `data/51job/jobs/优衣库/jd.json`，并读取 `fixtures/rag/conversations/<platform>/<jobKey>/<conversationId>.json` 下的对话 fixture；随后调用 embedding 和 Qdrant 构建索引，最后运行回归 suite。默认配置下需要 `QDRANT_URL`，且本地 embedding 服务 `RAG_EMBEDDING_LOCAL_URL` 必须可访问；命令也会在写入数据前检查 Qdrant `/collections` 是否可访问。如果显式把 `RAG_EMBEDDING_PROVIDER` 切回 `openai`，才需要 `OPENAI_API_KEY` 参与 embedding。答案评测会调用回答模型，因此仍需要配置可用的 `OPENAI_API_KEY` 和 `OPENAI_MODEL`。默认不覆盖已有职位，除非显式传入 `--overwrite true`。

`test:rag:offline` 是给 CI 和快速冒烟用的确定性版本，底层运行 `rag:baseline:offline -- --summary-only true`。它默认使用临时数据目录、内存向量库和固定算法生成的假 embedding，不需要 OpenAI、本地 embedding 服务或 Qdrant；它只验证 fixture 能否 seed、chunk、索引和完成召回评测，不生成最终回答，也不运行答案评测。CI 默认只打印紧凑摘要；需要完整 JSON 时，可以运行 `rag:baseline:offline -- --output-file tmp/rag-baseline-offline.json`，需要保留本次离线运行产物时再加 `--data-dir /path/to/debug-data`。

底层命令也可以单独运行：

```bash
rtk npm run rag:seed-fixtures
rtk npm run rag:seed-fixtures -- --index true
rtk npm run rag:ingest-conversations -- --file ./conversations.jsonl --dry-run true
rtk npm run rag:doctor -- --platform 51job --keyword "东南亚 销售" --question "这个岗位有住宿补贴吗？"
rtk npm run rag:doctor:batch -- --file ./rag-doctor-jobs.json --fail-on-issue true
rtk npm run rag:regression -- --suite-file ./fixtures/rag/regression.json
```

新增回归用例时，建议按这个顺序做：

1. 把脱敏后的职位 `jd.json` 放到 `fixtures/rag/jobs/<platform>/<jobKey>/jd.json`。
2. 如需覆盖历史对话，把脱敏对话放到 `fixtures/rag/conversations/<platform>/<jobKey>/<conversationId>.json`，并只给已确认的招聘方事实标记 `verified: true`。
3. 把新职位加入 `fixtures/rag/regression.json`。
4. 新增一个 `*.retrieval.json`，每个问题只写能从 JD 或已确认历史对话中找到的事实。
5. 新增一个 `*.answer.json`，检查最终回答必须包含的关键事实和禁止编造的内容。
6. 运行 `rtk npm run rag:baseline`，保证本地职位记录、chunks、Qdrant 索引和回归结果都可复现。
7. 失败时先用 `rag:inspect --question` 看召回，再看答案 prompt 或事实源。

### 导入一段历史对话

```bash
rtk npm run rag:ingest-conversation -- --platform 51job --keyword "东南亚 销售" --conversation-id conv-001 --conversation-file ./conversation.json
```

### 重建 Qdrant 索引

```bash
rtk npm run rag:rebuild -- --platform 51job --keyword "东南亚 销售"
```

### 临时关闭混合检索

```bash
RAG_RETRIEVAL_MODE=dense rtk npm run rag:ask -- --platform 51job --keyword "东南亚 销售" --question "薪资范围是多少？"
```

## 常见问题

### 为什么有 JD 还需要索引？

因为模型不能每次都读完整 JD 和全部历史对话。索引可以让系统快速找到最相关的片段。

### 为什么不直接把所有历史对话都喂给模型？

历史对话会越来越多，全部塞给模型成本高、速度慢，也容易混入未确认内容。RAG 会先筛出最相关、最可信的片段。

### 为什么候选人说的话不作为事实？

候选人说的话可能是问题、猜测或个人描述，不代表招聘方承诺。只有已确认招聘方答复才作为事实。

### 为什么已经导入对话，回答还是说未说明？

常见原因：

- 招聘方答复没有设置 `verified: true`。
- `role` 不是 `recruiter`。
- 导入到了另一个 platform 或 jobKey。
- Qdrant 没有配置或索引没有重建。
- 问题确实没有被 JD 或已确认答复覆盖。

可以先用下面命令确认本地资料和召回结果：

```bash
rtk npm run rag:inspect -- --platform <platform> --keyword "<关键词>" --question "<问题>"
```

### Qdrant 里的数据丢了怎么办？

本地 JSONL 仍然是事实源，可以重建：

```bash
rtk npm run rag:rebuild -- --platform <platform> --keyword "<关键词>"
```

### 回答能否完全替代人工？

不能。它适合自动回答常见、低风险、资料中明确的问题。涉及薪资承诺、福利政策、录用条件、法律合规等内容时，仍建议人工确认。

## 当前限制

- 当前重新排序是轻量规则排序，不是专门的 cross-encoder reranker。
- 临时 `--jd` / `--jd-file` 问答不会创建职位记录，不会进入持久化 RAG 索引，也不会写入 `answer-logs.jsonl`。
- 已确认历史对话需要调用导入命令写入，当前不会自动从聊天系统实时同步。
- 产品化 HTTP API 目前是内部服务接口，不内置多租户、RBAC、限流、集中监控告警或前端管理后台。
- 回答质量依赖 JD 和历史确认答复的完整性。
- 对资料中没有的信息，系统只能说明未提及，不能凭空补充。

## 推荐使用流程

新职位推荐流程：

```text
1. 首次运行职位，保存 JD
2. 执行 rag:index 建立索引
3. 候选人提问时用 rag:ask 或 --jd-question 回答
4. 有新的招聘方确认答复后，用 rag:ingest-conversation 导入
5. 如果 Qdrant 数据异常，用 rag:rebuild 重建
```

日常维护重点：

- 确认 JD 是最新版本。
- 只把经过确认的招聘方答复标记为 `verified: true`。
- 定期抽查回答是否引用了正确职位资料。
- 重要政策类回答保留人工审核。
