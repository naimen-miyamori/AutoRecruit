---
name: autorecruit-ops-console
tokens:
  colors:
    background: "#f5f7f8"
    surface: "#ffffff"
    text: "#1c2430"
    muted: "#65727d"
    primary: "#0f766e"
    success: "#138a44"
    danger: "#b42318"
    warning: "#9a5b00"
    focus: "#4056a1"
  typography:
    family: "Inter, PingFang SC, Microsoft YaHei, Arial, sans-serif"
    baseSize: 14
    headingSize: 22
    sectionHeadingSize: 15
  spacing:
    unit: 4
    panelPadding: 14
    gridGap: 12
  radius:
    panel: 8
    control: 6
    tile: 8
components:
  tables: dense
  cards: repeated-items-only
  icons: lucide-react
---

# Autorecruit Ops Console

## Product Shape

内部招聘运营台，面向需要反复提交招聘自动化任务、检查运行结果、核对候选人评分、排查 RAG 质量的运营和工程人员。首屏必须是工作台，不做 marketing hero。

## Layout

- 左侧固定导航：Dashboard、Tasks、Jobs、Run Job、RAG、Ops。
- 主区域按信息密度组织：状态 tile、表格、详情面板、只读 JSON/snapshot。
- 移动端导航收缩为图标，主要内容单列。

## Visual Rules

- 表格优先，列表和详情面板使用 8px 或更小圆角。
- 状态颜色必须区分 running、success、failed、warning。
- 中文长文本、错误原因、RAG sources 和 snapshot 必须可换行，不溢出父容器。
- 不使用大面积单一色系渐变，不使用装饰性 orb/blob。
- 控制按钮优先使用 lucide 图标加短标签；纯图标按钮必须有 title/aria-label。

## Screen Inventory

- Dashboard: 最近任务、平台状态、成功/失败/零候选统计。
- Run Job: resume-capture、batch、search-subscription 三种提交模式。
- Tasks: 任务列表、详情、输入摘要、输出摘要、运行日志、错误。
- Jobs: 平台筛选、关键词搜索、历史 job 表格。
- Job Detail: JD、normalized job、最近 run、候选人列表、导出路径。
- Candidate Detail: 简历结构、评分 artifact、失败原因、Zhilian share link、snapshot 预览。
- RAG: platform/jobKey/keyword/question 表单，answer/confidence/sources/no-answer reason。
- Ops: filter catalog、RAG doctor/review/metrics 入口。

## Stitch Note

已通过 `@google/stitch-sdk` 验证 Stitch 连接，创建专用项目和项目级设计系统，并生成 Dashboard 基础方案及 2 个 layout variants。下载的 HTML/截图参考文件位于 `docs/design/stitch-artifacts/`。本文件和生成 artifact 不包含任何真实密钥。
