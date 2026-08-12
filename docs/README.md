# AutoRecruit 文档中心

这里是共享专题文档的统一入口。新使用者先读根目录 `README.md`，维护者再读 `项目说明文档.md`；开发约束以根目录及对应作用域的 `AGENTS.md` 为准。

## 信息权威顺序

发生冲突时按以下顺序核对：

1. 可执行代码、schema 和自动化测试。
2. 根目录及作用域 `AGENTS.md`。
3. `项目说明文档.md`。
4. `README.md` 和当前专题资料。
5. 表达材料、设计快照、本地计划和 Git 历史。

低层级材料不能覆盖高层级事实。发现漂移时应先确认预期合同，再同步实现、测试和文档。

## 阅读入口

| 文档 | 主要受众 | 定位 |
| --- | --- | --- |
| [README](../README.md) | 使用者 | 安装、登录、模式概览和常用工作流 |
| [项目说明文档](../项目说明文档.md) | 维护者 | 当前产品能力、架构、数据语义、设计原因和失败边界 |
| [AGENTS.md](../AGENTS.md) | 开发者与代码代理 | 仓库级实现合同、作用域路由和验证矩阵 |
| [RAG 功能说明](./rag功能说明.md) | 产品、研发和使用者 | 当前 RAG 能力、概念、数据链路和质量闭环 |
| [RAG 运营手册](./rag运营手册.md) | 运维与研发 | RAG 初始化、日常操作、诊断和恢复步骤 |
| [项目面试问答](./项目面试问答.md) | 项目讲述者 | 表达参考；不是当前行为的权威来源 |
| [控制台设计基线](./design/DESIGN.md) | 前端与设计 | 2026-06-10 的历史设计基线；实际界面以前端代码为准 |
| [功能架构全景](./architecture/autorecruit-functional-architecture.html) | 产品与维护者 | 可视化架构参考；代码和项目说明仍是当前事实来源 |

## 设计资料

以下资料用于理解控制台设计过程，其中带日期的评审属于历史快照：

- [2026-06-10 设计评审](./design/review-2026-06-10.md)
- [Stitch 生成简报](./design/stitch-brief.md)
- [控制台脱敏 Mock 数据说明](./design/mock-data.md)
- [Run Job 改版](./design/run-job-redesign.png)
- [Run Job 直接筛选改版](./design/run-job-direct-filter-redesign.png)
- [筛选构建器](./design/runjob-filter-builder.png)
- [平台风格筛选构建器](./design/runjob-filter-builder-platform-style.png)
- [Dashboard 健康指标](./design/dashboard-health-metrics.png)

## 版本控制边界

- `docs/` 下的专题说明、设计源资料和架构参考是共享文档，应进入版本控制。
- `docs/plan/` 是本地实施计划档案，默认忽略；稳定结论必须归并到 README、项目说明或对应专题文档。
- `docs/generated/` 和 `docs/design/stitch-artifacts/` 是可再生成产物，默认忽略；需要保留的设计意图写入受版本控制的源文档。
- 不在文档中保存密钥、登录态、候选人数据、真实聊天、运行日志或一次性调试产物。

## 维护与校验

文档变更后运行：

```bash
rtk npm run docs:check
rtk npm run agents:check
rtk npm run plan:check
```

`docs:check` 校验文档入口、主要索引、本地 Markdown 链接、引用的 npm scripts、Node 版本锚点及忽略策略。新增实施计划仍使用：

```bash
rtk npm run plan:new -- --topic <kebab-case-topic> --title "<标题>"
```
