# Zhilian 平台说明

Zhilian 当前是正式支持的平台实现，CLI 名称为 `zhilian`。平台专项回归命令仍保留 `experimental` 前缀，以兼容已有脚本。

## 入口与登录态

- 默认 storage state：`storage-state.zhilian.json`
- 登录页：`https://passport.zhaopin.com/org/login`
- 已鉴权搜索页：`https://rd6.zhaopin.com/app/search`
- 登录刷新：`npm run login:session -- --platform zhilian [--keep-open]`
- 页面诊断：`npm run debug:zhilian -- --keyword "<关键词>"`
- live smoke：`npm run smoke:zhilian -- --keyword "<关键词>" [--parse-first]`
- 专项回归：`npm run test:experimental:zhilian`

`https://rd6.zhaopin.com/desktop` 不是搜索页，不应作为搜索流程目标页。

## 搜索与候选人提取

Zhilian 搜索进入方式与 51job、Liepin 不同：

1. 打开 `https://rd6.zhaopin.com/app/search`。
2. 点击一个已保存的快捷搜索标签。
3. 标签文本必须包含本次运行传入的原始 `--keyword`。
4. 点击后必须确认当前条件中出现 `关键词：<keyword>`，避免页面刷新或筛选切换后快捷搜索条件丢失。
5. 默认运行保留 `未看过` 筛选；`--include-viewed true` 只取消可见的 `未看过`，不改动 `未聊过`。
6. 如果取消 `未看过` 后快捷搜索条件消失，必须重新选择本次关键词的快捷搜索标签，再次取消 `未看过`，并重新确认 `关键词：<keyword>`。
7. 列表提取 DOM-first；如果 DOM 已经提取到候选人，不继续等待候选人 API。
8. 当前搜索卡片可能没有可用的详情链接或显式 ID，DOM 提取应优先读取 `.search-resume-item-wrap` Vue props 中的候选人字段，例如 `userMasterId`、`resumeNumber`、`resumeK` 和 `resumeT`。
9. DOM 无候选时，才在剩余 deadline 内等待 API fallback 或明确空结果。

## 简历详情与分享链接

点击候选人后，URL 可能变化，但简历详情仍以 `/app/search` 页内 modal 展示，不是新标签页或独立详情页。

解析要求：

- 读取 modal 子树，不能误读底层搜索列表正文。
- 解析前只做短就绪确认，不重复完整详情页等待。
- 点击 `转给同事`，选择 `链接转发`，复制生成的安全分享链接。
- 把分享链接保存为 `candidateShareUrl`，进入简历 JSON、评分产物和 Zhilian 邮件报告。

Zhilian 有新增候选人的报告邮件必须使用复制出来的同事转发分享链接，而不是内部 `candidateId`。发送前会校验当前运行的评分产物都包含唯一 `candidateShareUrl`；缺失或重复会作为邮件发送错误记录。无新增候选人的 Zhilian 通知邮件不需要分享链接。

## 推荐验证

真实账号验证顺序：

```bash
PLAYWRIGHT_HEADLESS=false npm run login:session -- --platform zhilian
PLAYWRIGHT_HEADLESS=false npm run debug:zhilian -- --keyword "优衣库"
PLAYWRIGHT_HEADLESS=false npm run smoke:zhilian -- --keyword "优衣库"
PLAYWRIGHT_HEADLESS=false npm run smoke:zhilian -- --keyword "优衣库" --parse-first
PLAYWRIGHT_HEADLESS=false npm run dev -- --platform zhilian --keyword "优衣库" --jd "招聘零售门店店长，要求具备服饰零售管理经验，有人员排班与门店运营能力。"
PLAYWRIGHT_HEADLESS=false npm run dev -- --platform zhilian --keyword "优衣库"
npm run export:results -- zhilian 优衣库
```

只验证本地命令接线和回归时：

```bash
npm run typecheck
npm run test
npm run test:experimental:zhilian
```

持续维护基线：

1. `npm run typecheck` 通过。
2. `npm run test` 通过。
3. `npm run test:experimental:zhilian` 通过。
4. 手动登录能保存 `storage-state.zhilian.json`，且 fresh-session 复验通过。
5. `smoke:zhilian` 能在至少一个真实关键词下成功进入 `https://rd6.zhaopin.com/app/search` 并完成候选人列表提取。
6. `smoke:zhilian --parse-first` 能在列表存在候选人时成功解析至少一份同页 modal 简历详情。
7. 完整 `npm run dev -- --platform zhilian` 运行能写出运行结果和 `exports/latest.md`。
