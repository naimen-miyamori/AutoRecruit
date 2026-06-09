# RAG 运营手册

这份手册面向日常维护 RAG 的使用者。目标是让每个职位的 JD、已确认历史对话、候选人问答日志、人工审核和质量指标形成闭环。

## 1. 首次准备职位

首次运行职位时，必须提供 JD：

```bash
rtk npm run dev -- --platform <platform> --keyword "<关键词>" --jd-file ./jd.txt
```

也可以只建立 RAG 索引：

```bash
rtk npm run rag:index -- --platform <platform> --keyword "<关键词>"
```

索引成功后，本地会生成：

```text
data/<platform>/jobs/<jobKey>/rag/sources.jsonl
data/<platform>/jobs/<jobKey>/rag/chunks.jsonl
data/<platform>/jobs/<jobKey>/rag/embeddings.jsonl
data/<platform>/jobs/<jobKey>/rag/index-manifest.json
```

Qdrant 只是可重建索引，事实源以本地 `sources.jsonl` 和 `chunks.jsonl` 为准。

运行 RAG 前先确认两个本地依赖可用：

```bash
rtk launchctl list | rtk rg 'com\\.autorecruit\\.(qdrant|embedding)'
rtk curl -sSf http://127.0.0.1:6333/collections
rtk curl -sSf http://127.0.0.1:8011/health
```

当前本机 embedding 使用 `local-http` provider，默认模型是 `BAAI/bge-small-zh-v1.5`，默认地址是 `http://127.0.0.1:8011`。开发调试可以运行 `rtk npm run rag:embedding:local`；长期使用推荐让 LaunchAgent `com.autorecruit.embedding` 常驻。常驻服务的运行目录在 `~/.local/share/autorecruit/embedding/`，不是仓库目录，这是为了避开 macOS 后台服务访问 `~/Documents` 的权限限制。

本机常驻服务相关路径：

```text
~/.local/bin/autorecruit-local-embedding
~/.local/share/autorecruit/embedding/local_embedding_server.py
~/.local/share/autorecruit/embedding/requirements-rag-embedding.txt
~/.local/share/autorecruit/embedding/.venv/
~/Library/LaunchAgents/com.autorecruit.embedding.plist
~/.local/var/log/autorecruit/local-embedding.log
~/.local/var/log/autorecruit/local-embedding.err.log
```

排查 embedding 服务失败时，先看错误日志：

```bash
rtk tail -80 ~/.local/var/log/autorecruit/local-embedding.err.log
```

## 2. 导入历史对话

对话可以按 JSONL 批量导入。模板见：

```text
fixtures/rag/conversation-import.example.jsonl
```

先 dry-run 校验：

```bash
rtk npm run rag:ingest-conversations -- --file ./conversations.jsonl --dry-run true
```

确认无误后正式导入并诊断：

```bash
rtk npm run rag:ingest-conversations -- --file ./conversations.jsonl --doctor true --doctor-question "这个岗位薪资范围是多少？"
```

只有 `role=recruiter` 且 `verified=true` 的回复会进入事实检索。候选人发言和未确认回复会保存为上下文，但不会作为回答依据。

## 3. 日常问答

候选人问题可以通过 CLI 验证：

```bash
rtk npm run rag:ask -- --platform <platform> --keyword "<关键词>" --question "这个岗位需要英语吗？"
```

业务主流程也可以用：

```bash
rtk npm run dev -- --platform <platform> --keyword "<关键词>" --rag-question "这个岗位需要英语吗？"
```

已保存职位的回答会追加到：

```text
data/<platform>/jobs/<jobKey>/rag/answer-logs.jsonl
```

## 4. 单职位排障

只看本地文件统计：

```bash
rtk npm run rag:inspect -- --platform <platform> --keyword "<关键词>"
```

检查某个问题会召回什么资料：

```bash
rtk npm run rag:inspect -- --platform <platform> --keyword "<关键词>" --question "这个岗位有住宿补贴吗？"
```

完整健康诊断：

```bash
rtk npm run rag:doctor -- --platform <platform> --keyword "<关键词>" --question "这个岗位有住宿补贴吗？"
```

常见处理：

- `missing_manifest`：重新运行 `rag:index` 或 `rag:rebuild`。
- `no_active_jd_source`：确认职位目录下存在 `jd.json`，再重建索引。
- `no_chunks`：检查 JD 或对话内容是否为空，再重建索引。
- `qdrant_unreachable`：检查 `QDRANT_URL` 和 Qdrant 服务，先跑 `rtk curl -sSf http://127.0.0.1:6333/collections`。
- `embedding_config_mismatch`：确认是否切换过 `RAG_EMBEDDING_PROVIDER` 或 `RAG_EMBEDDING_MODEL`，必要时重建。
- embedding 服务不可用：检查 `RAG_EMBEDDING_LOCAL_URL`，先跑 `rtk curl -sSf http://127.0.0.1:8011/health`，再看 `~/.local/var/log/autorecruit/local-embedding.err.log`。
- 问题检索无命中：检查 JD 和已确认对话是否真的包含答案，必要时补充 verified 对话事实。

## 5. 产品化 HTTP 接口

如果外部系统要直接接入 RAG，而不是调用 CLI，可以启动本地 HTTP 服务：

```bash
rtk npm run rag:api
rtk npm run rag:api -- --host 127.0.0.1 --port 3978
RAG_API_KEY=secret rtk npm run rag:api
```

默认只监听 `127.0.0.1:3978`。需要鉴权时设置 `RAG_API_KEY` 或传 `--api-key`，请求头使用：

```text
Authorization: Bearer <RAG_API_KEY>
```

健康检查：

```bash
curl http://127.0.0.1:3978/health
```

候选人问答：

```bash
curl -X POST http://127.0.0.1:3978/v1/rag/answer \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer secret' \
  -d '{
    "platform": "51job",
    "keyword": "优衣库 店长",
    "question": "这个岗位薪资范围是多少？",
    "topK": 8,
    "autoIndex": true,
    "logAnswer": true,
    "metadata": {
      "externalConversationId": "conv-001"
    }
  }'
```

导入对话：

```bash
curl -X POST http://127.0.0.1:3978/v1/rag/conversations \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer secret' \
  -d '{
    "platform": "51job",
    "keyword": "优衣库 店长",
    "conversationId": "conv-001",
    "turns": [
      { "id": "turn-1", "role": "candidate", "content": "这个岗位有住宿补贴吗？" },
      { "id": "turn-2", "role": "recruiter", "content": "每月800元住宿补贴。", "verified": true }
    ]
  }'
```

接口和 CLI 使用同一套底层逻辑：

- `/v1/rag/answer` 等价于产品化的 `rag:ask`。
- `/v1/rag/conversations` 等价于产品化的 `rag:ingest-conversation`。
- `jobKey` 和 `keyword` 二选一；传 `keyword` 时会按 CLI 规则派生 `jobKey`。
- 只有 `role=recruiter` 且 `verified=true` 的对话会进入事实检索。
- 错误统一返回 JSON：`{ "error": { "code": "...", "message": "..." } }`。

建议生产部署时把服务放在内网或网关后面，开启 `RAG_API_KEY`，并限制请求体大小：

```bash
RAG_API_MAX_BODY_BYTES=1048576
```

上线前检查清单：

- API 只暴露在内网、VPN 或业务网关后面，不直接公开到公网。
- 已设置 `RAG_API_KEY` 或 `--api-key`，外部系统请求都带 `Authorization: Bearer <token>`。
- 已按业务入口配置网关层身份认证、权限、限流、请求追踪和访问审计。
- `QDRANT_URL`、`QDRANT_API_KEY`、`RAG_VECTOR_COLLECTION`、`RAG_EMBEDDING_PROVIDER` 和 `RAG_EMBEDDING_MODEL` 与目标环境一致。
- 默认本地 embedding 服务已启动并可访问 `RAG_EMBEDDING_LOCAL_URL`；如果显式切回 OpenAI embedding，确认已设置 `OPENAI_API_KEY`。
- 已对关键职位运行 `rag:doctor` 或 `rag:doctor:batch`，确认索引、Qdrant 和 embedding 配置没有 error。
- 已安排 `rag:ops` 定时巡检，至少覆盖 Doctor、Review 和 Metrics。
- 已备份 `data/<platform>/jobs/<jobKey>/rag/` 下的本地事实库；Qdrant 是可重建索引，真正需要长期保留的是 `sources.jsonl`、`chunks.jsonl`、`conversations/`、`embeddings.jsonl`、`index-manifest.json` 和 `answer-logs.jsonl`。
- 已确认 answer log 和人工反馈流程可用，重要政策类回答可以被追溯和复核。

## 6. 多职位巡检

职位列表模板见：

```text
fixtures/rag/rag-review-jobs.example.json
```

批量 doctor：

```bash
rtk npm run rag:doctor:batch -- --file ./rag-review-jobs.json --question "这个岗位薪资范围是多少？" --fail-on-issue true
```

建议在导入新一批对话后运行一次。`--fail-on-issue true` 适合放进定时任务或 CI。

## 7. 人工审核回答

生成单职位审核报告：

```bash
rtk npm run rag:review -- --platform <platform> --keyword "<关键词>" --output ./rag-review.md
```

生成多职位审核报告：

```bash
rtk npm run rag:review:batch -- --file ./rag-review-jobs.json --output ./rag-review.md
```

报告顶部的 `Missing error types` 表示旧日志已经标错，但没有 `feedback.errorType`。这类记录会在明细里出现 `Fill missing error type` 命令；运行前先把默认的 `--error-type other` 改成更准确的错误类型。

审核后写回反馈。正确回答：

```bash
rtk npm run rag:feedback -- --platform <platform> --keyword "<关键词>" --log-id <logId> --correct true --note "回答准确" --reviewer "reviewer-a"
```

错误回答：

```bash
rtk npm run rag:feedback -- --platform <platform> --keyword "<关键词>" --log-id <logId> --correct false --error-type wrong_fact --note "薪资说错" --reviewer "reviewer-a"
```

错误类型：

| errorType | 含义 |
| --- | --- |
| `wrong_fact` | 回答事实错误，例如薪资、地点、学历说错 |
| `unsupported_claim` | 回答包含资料里没有的承诺或推断 |
| `missing_context` | 资料里有答案，但回答漏掉关键上下文 |
| `bad_source` | 引用了不合适或不可信来源 |
| `low_relevance` | 召回片段和问题相关性低 |
| `wording_issue` | 表述不专业、不清楚或容易误解 |
| `other` | 其他问题 |

## 8. 指标和质量门禁

质量阈值模板见：

```text
fixtures/rag/rag-metrics-policy.example.json
```

导出指标：

```bash
rtk npm run rag:metrics -- --file ./rag-review-jobs.json --output ./rag-metrics.json
```

按时间窗口导出：

```bash
rtk npm run rag:metrics -- --file ./rag-review-jobs.json --since 2026-06-01 --until 2026-06-09T23:59:59.999Z
```

使用 policy 做质量门禁：

```bash
rtk npm run rag:metrics -- --file ./rag-review-jobs.json --policy ./rag-metrics-policy.json --fail-on-threshold true
```

policy 可以设置 `maxErrorTypeRates`，按人工标错样本内部占比限制高风险错误：

```json
{
  "maxErrorTypeRates": {
    "unsupported_claim": 0.2,
    "bad_source": 0.2,
    "unspecified": 0.1
  }
}
```

看到 `thresholdViolations` 或 `recommendations` 时，按指标处理：

- 审核率低：先运行 `rag:review:batch`，补齐人工反馈。
- 正确率低或错误率高：先看 `rag:metrics` 输出的整体 Error Types 和各平台/职位/日期的 Top Error Types，再结合 `feedback.note` 定位原因。
- `wrong_fact` 或 `missing_context` 集中：优先补 JD、补 verified 对话事实，或修正过期事实。
- `unsupported_claim` 集中：检查回答 prompt 和低置信拒答阈值，避免模型扩写资料里没有的承诺。
- `bad_source` 或 `low_relevance` 集中：用 `rag:inspect --question` 看 dense、keyword、hybrid 命中，调整 chunk、关键词召回或重建索引。
- `unspecified` 集中：说明旧的错误反馈缺少 `--error-type`，建议补标，后续分析才有意义。
- 拒答率高：确认资料是否缺失，或问题是否超出职位信息范围。
- 低置信率高：检查 chunk 内容、embedding 配置和 hybrid 召回结果。
- 无来源率高：优先排查回答链路和日志写入，正常 RAG 回答应带 sources。

## 9. 一键运营报告

日常巡检可以直接生成一份统一报告，内容包括：

- Doctor：职位索引、Qdrant、embedding 配置和问题检索健康状态。
- Review：待人工审核回答、旧标错日志缺失 errorType、低置信和无来源回答。
- Metrics：整体/平台/职位/日期质量指标、错误类型分布、policy 阈值违规和处理建议。

命令：

```bash
rtk npm run rag:ops -- --file ./rag-review-jobs.json --question "这个岗位薪资范围是多少？" --policy ./rag-metrics-policy.json --output ./rag-ops.md
```

需要给定时间窗口时：

```bash
rtk npm run rag:ops -- --file ./rag-review-jobs.json --since 2026-06-01 --until 2026-06-09T23:59:59.999Z --policy ./rag-metrics-policy.json --output ./rag-ops.md
```

接入定时任务或 CI 时：

```bash
rtk npm run rag:ops -- --file ./rag-review-jobs.json --policy ./rag-metrics-policy.json --fail-on-issue true
```

`rag:ops` 的整体状态含义：

| status | 含义 |
| --- | --- |
| `ok` | Doctor、Review、Metrics 都没有需要处理的问题 |
| `needs_attention` | 有 warning 或待人工审核项，但没有失败级问题 |
| `failed` | Doctor error、Review 读取失败、Metrics 读取失败或 quality policy 违规 |

建议的每日流程：

```text
rag:ops -> 按报告里的 Review 命令补人工反馈 -> 再跑 rag:ops 确认状态
```

如果 `rag:ops` 已经生成了统一报告，通常不需要再单独跑 `rag:doctor:batch`、`rag:review:batch` 和 `rag:metrics`。只有在排查某一块细节时，才单独运行对应命令。

## 10. 回归沉淀

从真实问答日志导出答案评测草稿：

```bash
rtk npm run rag:export-answer-eval -- --platform <platform> --keyword "<关键词>" --output ./tmp.answer.json
rtk npm run rag:export-answer-eval -- --platform <platform> --keyword "<关键词>" --expected-text-mode source --output ./tmp.answer.json
rtk npm run rag:export-answer-eval -- --platform <platform> --keyword "<关键词>" --expected-text-mode hybrid --include-no-answer true --output ./tmp.answer.json
```

默认只导出 `feedback.correct=true` 的日志。`--expected-text-mode answer` 是默认模式，会把完整回答放入 `expectedAnswerIncludes`；`source` 会尝试从当时引用的 JD 或 verified 历史答复中提取关键事实短语；`hybrid` 优先用 source 提取，提取不到时回退到完整回答。所有导出 case 都带 `metadata.draft=true` 和 `metadata.expectedTextNeedsReview=true`，表示仍需人工确认后再放入长期回归 suite。

推荐流程：

```text
rag:export-answer-eval --expected-text-mode source -> 人工检查 expectedAnswerIncludes -> 加入 regression suite
```

运行答案评测：

```bash
rtk npm run rag:answer-eval -- --platform <platform> --keyword "<关键词>" --eval-file ./tmp.answer.json
```

运行完整 RAG 回归：

```bash
rtk npm run rag:regression -- --suite-file ./fixtures/rag/regression.json
```

无 OpenAI 和 Qdrant 的环境可以跑离线基线：

```bash
rtk npm run test:rag:offline
```

## 11. 建议节奏

每次新增职位：

```text
保存 JD -> rag:index -> rag:doctor
```

每次批量导入对话：

```text
dry-run -> ingest --doctor true -> rag:doctor:batch
```

每天或每批候选人问答后：

```text
rag:ops -> rag:feedback -> rag:ops
```

每次修改 RAG 代码、prompt、embedding、检索参数或 chunk 规则：

```text
rag:regression -> test:rag:offline -> typecheck -> build
```
