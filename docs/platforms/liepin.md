# Liepin 平台说明

Liepin 当前是正式支持的平台实现，CLI 名称为 `liepin`。平台专项回归命令仍保留 `experimental` 前缀，以兼容已有脚本。

## 入口与登录态

- 默认 storage state：`storage-state.liepin.json`
- 登录刷新：`npm run login:session -- --platform liepin [--keep-open]`
- live smoke：`npm run smoke:liepin -- --keyword "<关键词>" [--parse-first]`
- 专项回归：`npm run test:experimental:liepin`

手动登录轮询有一个重要约束：在检测到已鉴权 recruiter cookies 之前，不应在同一上下文里额外探测其他登录页、`about:blank` 或任意无关页面，避免刚打开登录窗口就被脚本误关。只有 cookies 已就绪后，才允许探测非登录 recruiter 页和专用 probe page 来确认搜索壳页可用。

## 搜索与候选人提取

Liepin 搜索页打开、搜索壳页、快捷搜索标签、DOM 候选和 `search-resumes` API fallback 都应使用同一个搜索 deadline，避免多个固定长等待串联。

关键流程：

1. 点击本次关键词对应的快捷搜索标签。
2. 确认结果页上的 `隐藏已查看` 已勾选。
3. 如果筛选项尚未渲染，但存在可见的结果页“搜索”按钮，先点击搜索按钮让筛选项出现。
4. 勾选 `隐藏已查看` 后，清空旧的 `search-resumes` 缓存并设置请求开始时间屏障。
5. 进入候选人提取。DOM 完整时优先使用 DOM；DOM 无候选或 DOM 候选缺安全详情 URL 时，才短等 API fallback。

勾选 `隐藏已查看` 前捕获到的 `search-resumes` 响应不能复用。旧响应延迟返回时也不能污染后续候选人 ID 列表。本地 `seen-ids.json` 仍然是最终去重兜底，平台侧“隐藏已查看”不能替代本地去重。

## 推荐验证

真实账号验证顺序：

```bash
PLAYWRIGHT_HEADLESS=false npm run login:session -- --platform liepin
PLAYWRIGHT_HEADLESS=false npm run smoke:liepin -- --keyword "优衣库"
PLAYWRIGHT_HEADLESS=false npm run smoke:liepin -- --keyword "优衣库" --parse-first
PLAYWRIGHT_HEADLESS=false npm run dev -- --platform liepin --keyword "优衣库" --jd "<JD 文本>"
```

只验证本地命令接线和回归时：

```bash
npm run typecheck
npm run test
npm run test:experimental:liepin
```

持续维护基线：

1. `npm run typecheck`、`npm run test`、`npm run test:experimental:liepin` 通过。
2. `npm run login:session -- --platform liepin` 能保存并验证 fresh-session 可复用的 `storage-state.liepin.json`。
3. `npm run smoke:liepin -- --keyword "优衣库" --parse-first` 能在真实账号下成功运行，并至少完成一个候选人的详情页解析。
4. 完整 `npm run dev -- --platform liepin --keyword "优衣库" --jd "<JD 文本>"` 能写出 `jd.json`、`results/*.json`、`exports/latest.md`，并在有候选人时写出简历、快照和评分产物。
5. live 验证至少在两个不同关键词或两个不同日期重复成功，且中间不依赖新的选择器修补。

## 验证记录

- 2026-05-15：Liepin 正式支持状态已确认。`npm run typecheck`、`npm run test`、`npm run test:experimental:liepin` 全部通过；`npm run smoke:liepin -- --keyword "优衣库"`、`npm run smoke:liepin -- --keyword "优衣库" --parse-first`、`npm run smoke:liepin -- --keyword "阀门"`、`npm run smoke:liepin -- --keyword "阀门" --parse-first` 已在真实账号下跑通。完整 `npm run dev -- --platform liepin --keyword "优衣库" --jd "<JD 文本>"` 与 `npm run dev -- --platform liepin --keyword "阀门" --jd "<JD 文本>"` 也已在隔离 `DATA_DIR` 下验证成功，并写出 `jd.json`、`seen-ids.json`、`results/*.json`、`exports/latest.md`、`resumes/*.json`、`snapshots/*.txt`、`scores/*.json`。
- 2026-05-25：Liepin `隐藏已查看` 筛选已接入正式搜索入口。`npm run typecheck`、`npm run test:experimental:liepin` 已通过；`PLAYWRIGHT_HEADLESS=true npm run smoke:liepin -- --keyword "优衣库"` 在真实登录态下通过，并在勾选 `隐藏已查看` 后返回 0 候选人。完整 `PLAYWRIGHT_HEADLESS=true npm run dev -- --platform liepin --keyword "优衣库" --email "wd-cmgmt@hotmail.com"` 已成功写出结果、导出最新报告并发送“本次无新增候选人”邮件。
