# 前端运营客户端重构计划

## 文档状态

- 状态：第一版已完成；未阻塞首版交付的增强项已单列为后续迭代
- 日期：2026-07-25
- 范围：`frontend/`、控制台 API 的只读模型与契约、前端构建和验证链路
- 不在范围：平台选择器、浏览器自动化节奏、CLI 参数语义、RAG 检索/事实规则的重新设计

### 实施记录（2026-07-25）

- 已完成应用壳、BrowserRouter、TanStack Query、共享 API 类型、Bearer token 会话存储和新的视觉 token。
- 已完成控制台、任务中心、岗位/候选人、自动化、RAG、设置、智能助手和 Boss 工作台页面；生产入口已移除旧 mock fallback。
- 已完成 Boss 持久化 read model、职位/JD 同步历史、自动沟通审核、幂等回执和白名单 artifact 下载 API。
- 已完成服务端 API 回归 fixture，覆盖 Boss read model、artifact 下载、404、400 和路径遍历拒绝。
- 已完成前后端聚合 `typecheck` 与 `build` 脚本；旧集中式前端入口、mock 数据和旧样式已删除。
- 已完成 `rtk npm run typecheck`、`rtk npm run build`、`rtk npm test` 和 `rtk git diff --check`；完整回归共 453 项，服务端 API 回归 35 项。
- 已使用 Playwright fixture 检查 9 个一级路由以及 `390x844`、`1024x768`、`1440x900` 三个视口，无横向溢出、控制台错误或关键内容遮挡。

### 后续增强项

以下事项不阻塞第一版交付，转入后续迭代独立排期：

1. 为 API client、安全确认、任务输出和复杂表单补充更细粒度的组件单元测试。
2. 根据真实书签使用情况决定是否增加旧 hash 路由兼容窗口；当前正式入口统一使用 BrowserRouter 路径。
3. 使用脱敏的真实本地历史数据继续做人工验收，重点检查长文本、极端表格和历史可选字段。
4. 在实际发布环境增加静态资源版本一致性检查，并持续扩充无障碍与视觉回归覆盖。

## 1. 背景与结论

AutoRecruit 仍是 CLI-first、本地优先的招聘自动化工具；Web 前端应是高质量的本地运营客户端，而不是营销页、通用 ATS 或远程 SaaS 后台。

制定本计划时，旧前端已经覆盖普通抓取、批量、搜索订阅、Boss 自动沟通、岗位/候选人浏览、RAG、运营诊断和调度，但与产品能力存在以下结构性缺口：

1. Boss 人才发现、单人打招呼、原子会话操作、职位/JD 同步只可经智能助手的通用字段编辑器提交，不能形成日常工作流。
2. 任务页只显示输入/输出摘要，无法把 Boss 候选人、会话、同步明细、回执和自动聊天审核以可核验的形式呈现。
3. API 开启 `AUTORECRUIT_CONSOLE_API_KEY` 后前端未发送 Bearer token；网络或服务端故障时会回退到 mock 数据，可能造成运营误判。
4. 前端状态、类型、路由和页面集中在单个 `App.tsx`，无法以领域模块持续演进；前端没有独立的单元和端到端验证矩阵。
5. 岗位详情只显示最新运行，虽然服务端已能读取完整运行历史；工件仅暴露本地路径，不能安全地在浏览器中打开或下载。

本次重构的目标不是给现有页面换皮，而是在不改变任务执行和安全边界的前提下，建立一个视觉成熟、信息密集、可审计的招聘运营客户端。

## 2. 目标、非目标与成功标准

### 2.1 目标

1. 建立可复用的视觉语言、页面骨架、路由、数据访问层和无障碍交互基线。
2. 让所有已公开的控制台任务类型有明确入口；其中 Boss 四类新工作流必须具备专用界面。
3. 将任务、调度、岗位、候选人、Boss 运行工件和 RAG 运维结果呈现为结构化、可追溯的工作流。
4. 将读操作、配额消耗操作、候选人联系操作明确区分，并让变更前的身份校验、确认和回执可见。
5. 清除生产模式下的 mock 回退，补齐可选控制台 API token 支持，并对长任务提供可预期的实时状态更新。
6. 让 `npm run web:build`、前端单元测试和浏览器端到端测试进入发布验证链路。

### 2.2 非目标

本次不实现：

- 多租户、RBAC、云端账户体系、远程控制平面、服务端集中审计或外部监控告警。
- 直接从前端调用 Boss、51job、Liepin、Zhilian 浏览器模块，或绕过 `TaskQueue`、normalizer、CLI 模式隔离。
- 在浏览器内编辑、上传或任意读取本地文件；前端只能调用受控 API 和登记过的工件下载地址。
- 改变 `--platform all` 仅串行运行 `51job -> liepin -> zhilian` 的公共契约，或让 Boss 进入该循环。
- 把读数据的聊天快照误当成持久化 CRM 历史；未持久化的数据在服务重启后不得伪装成可恢复历史。
- 在本阶段引入 Tauri/Electron。先以现有本地 HTTP 服务承载 Web 客户端；仅当安装包、托盘和后台常驻成为明确需求时另立原生壳计划。

### 2.3 成功标准

重构完成时，以下条件必须全部满足：

- 用户可以不借助智能助手，完成 Boss 职位同步、人才发现、只读会话查看、受控会话变更和单人打招呼。
- 每个 Boss 变更操作在提交前展示候选人/职位/会话/意图 ID/风险，并在完成后展示可重试的回执或失败原因。
- 运行中任务、调度轮次和平台会话健康自动更新；网络故障显示错误和最后成功时间，不显示伪造业务数据。
- 开启 `AUTORECRUIT_CONSOLE_API_KEY` 后，用户可在当前浏览器会话配置控制台令牌并访问 API；该令牌不得与模型 API key 混用或持久化到 localStorage。
- 岗位页能看到全部运行历史，候选人详情能看到评分证据；登记过的报告和快照可通过受控下载接口访问。
- 所有关键流程在桌面和移动断点下无文字遮挡、无横向布局破坏，并通过截图/端到端测试。
- 现有 CLI、队列、调度、RAG、Boss 幂等回执及浏览器节奏测试仍然通过。

## 3. 基本原则与约束

### 3.1 客户端职责

客户端负责：

- 展示本地持久化的岗位、候选人、运行和 Boss 工件。
- 对 API 请求做格式校验、状态展示、轮询和确认交互。
- 通过 API 创建结构化任务草稿或已确认任务。
- 将可解释的预览与真实执行来源分开。

客户端不负责：

- 执行 CLI argv、浏览器自动化、模型命令或文件系统写入。
- 根据任务预览自行推导执行参数。
- 在客户端记录生产 RAG 答案日志、Boss 回执或平台账号信息。

### 3.2 必须保持的执行路径

```text
页面表单 / 助手草稿 / 调度模板
  -> API request schema
  -> task-normalizers.ts
  -> TaskQueue
  -> 现有 index.ts / 平台模块
  -> 本地 JSON/JSONL 工件
  -> read model / API
  -> 客户端展示
```

以下规则不可因视觉重构弱化：

- 所有 HTTP、助手确认和调度任务共用 `TaskQueue`。
- Boss 即时匹配、打招呼和会话变更仍需 mode-specific `confirmed: true`、精确身份和意图 ID；风险接受不是替代条件。
- Boss 读操作与配额/联系变更保持分离；只有职位/JD 同步可以调度。
- RAG 无可信来源必须展示明确的“无答案”与原因，不能补充猜测性文案。
- 请求级模型设置只影响助手草稿和控制台 RAG 回答；不能进入任务、日志、持久化配置或模型输入以外的地方。
- 平台浏览器会话、共享指针轨迹、逐字输入、动作节奏和 deadline 行为均留在现有浏览器/平台层。

### 3.3 数据真实性原则

1. 生产客户端默认不加载 mock 数据。`VITE_DEMO_MODE=true` 才能启用隔离的演示 fixture。
2. 本地 JSON/JSONL 是产品记录的权威来源；外部索引或任务内存状态不能成为唯一数据源。
3. 后端返回的文件系统绝对路径只用于诊断显示，不能当成前端可访问 URL。
4. 可下载工件必须先由服务端白名单解析为 artifact ID，再流式响应；不允许“传一个任意 path 下载”。
5. 候选人照片只在已确认来自该候选人详情页头像的证据存在时展示；证据不足时使用姓名缩写，不使用默认头像、学校图或相似候选人图。

## 4. 产品与视觉方向

### 4.1 设计定位

整体风格为“本地招聘运营工作台”：安静、专业、可扫描，类似精密的桌面工具，而不是卡片化营销站。

- 默认桌面优先，适配窄屏用于监控、复核和轻量确认。
- 首屏直接进入运营状态与待办，不设置品牌 Hero 或功能说明页。
- 页面采用全宽工作区和有限的局部工具面板；卡片仅用于独立重复项目、弹窗、确认面板和真正需要边界的工具。
- 信息层级通过排版、留白、细边框、列布局和状态色建立，不依赖大面积渐变或装饰图形。

### 4.2 视觉 token

建立 `frontend/src/styles/tokens.css`，仅在该文件定义颜色、阴影、圆角、层级、间距和动效时长。建议初始 token：

| 类别 | 建议 | 用途 |
| --- | --- | --- |
| 背景 | `#F6F8F9` / `#FFFFFF` | 页面与内容面 |
| 文字 | `#1F2933` / `#5F6B76` | 主信息与辅助信息 |
| 导航 | `#202A2E` | 深石墨侧栏，不使用深蓝主导 |
| 主操作 | `#007C73` | 提交、确认、当前导航 |
| 信息 | `#315FC9` | 运行、排队、检索 |
| 警告 | `#B86A00` | 配额、需要注意、待复核 |
| 失败 | `#C6382C` | 失败、阻断操作 |
| 成功 | `#248A4A` | 已完成、已验证 |

规则：

- 圆角上限 `8px`；状态标签可以使用胶囊形但不应成为主要布局元素。
- 字号使用稳定档位，例如 `12/13/15/20/28px`，不随视口宽度缩放；`letter-spacing: 0`。
- 操作按钮优先使用图标，文本按钮只用于明确命令。所有图标按钮都应有可见 tooltip 或 `aria-label`。
- 平台标记使用官方许可范围内的位图或文字徽标；不使用无关装饰插图。

### 4.3 动效与反馈

动效必须解释状态，不得干扰读表：

- 列表切换、抽屉展开、筛选变化：`120-180ms` 的 opacity/transform 过渡。
- 任务运行：低频状态指示与阶段时间线，不使用大面积闪烁。
- 数据加载：骨架屏保持固定布局，避免表格和工具栏跳动。
- 变更确认：从右侧抽屉或居中对话框展开，显示目标摘要、风险、确认条件和提交结果。
- 支持 `prefers-reduced-motion`，降低非必要动画。

## 5. 信息架构与路由

### 5.1 一级导航

| 新入口 | 路由 | 主要内容 | 现有入口迁移 |
| --- | --- | --- | --- |
| 控制台 | `/` | 队列、告警、平台健康、今日漏斗、待处理项 | `dashboard` |
| 任务中心 | `/tasks` | 任务、日志、结构化结果、失败复盘 | `tasks` |
| 岗位与人才 | `/jobs` | 岗位、运行历史、候选人和评分证据 | `jobs` |
| Boss 工作台 | `/boss` | 职位同步、人才发现、会话、自动沟通审核、回执 | 分散在助手/任务中 |
| 自动化 | `/automation` | 调度计划、轮次、停止/恢复、登录刷新 | `schedules` + 部分 `ops` |
| 知识与运营 | `/knowledge` | RAG 问答、来源、review、doctor、metrics | `rag` + `ops` |
| 设置 | `/settings` | 控制台连接、模型临时配置、前端偏好 | `settings` |

“执行搜索”不再作为孤立主入口，而是在控制台的快捷动作和岗位与人才页的“新建任务”抽屉中打开。保留深链接 `/run` 到新建任务抽屉，避免破坏已有书签。

### 5.2 二级路由

```text
/tasks/:taskId
/jobs/:platform/:jobKey
/jobs/:platform/:jobKey/candidates/:candidateId
/boss/positions
/boss/talent
/boss/conversations
/boss/reviews
/boss/receipts
/automation/schedules/:scheduleId
/knowledge/rag
/knowledge/operations
```

React Router 负责路由、参数解析、懒加载和 404 页面。旧 `#/...` 路由在一个发布周期内通过兼容重定向映射到新路径，再移除手写 hash router。

## 6. 页面规格

### 6.1 控制台

控制台首屏按“先处理、后分析”排列：

1. 顶部状态带：API 连接、最后刷新时间、队列执行状态、平台会话异常数量。
2. 待处理区域：失败任务、登录过期、连续失败调度、RAG 待复核、Boss 待审聊天。
3. 运行轨道：当前任务、队列中任务、最近完成任务，显示阶段、持续时间和跳转。
4. 平台健康矩阵：每个平台一行，展示最近成功、失败、零候选比例、会话和筛选目录健康。
5. 今日漏斗：搜索候选、新增、成功解析、已评分、失败；先用条形/比例组件，避免为少量数据引入重型图表。

异常项必须可直接跳转到任务、岗位或 Boss 对象，不在总览内堆叠长 JSON。

### 6.2 任务中心

采用“列表 + 详情检查器”布局：

- 列表支持状态、类型、平台、时间和来源筛选；运行中任务自动刷新。
- 详情顶部显示任务状态、队列/调度归属、开始/结束时间、可复制 ID 和失败概要。
- 中部按任务类型渲染 output：
  - 普通抓取/批量：平台计数、新候选、评分失败、报告工件。
  - Boss 人才发现：候选人卡片、稳定 candidate ID、来源、联系状态和后续安全动作。
  - Boss 会话操作：会话、候选人、职位、消息、变更结果与 receipt。
  - Boss 职位同步：职位清单、stable ID、hash、created/updated/unchanged/failed。
  - RAG：答案、置信度、来源、无答案原因或运维摘要。
- 日志按级别和时间渲染，支持复制，不以原始 JSON 取代结构化结果。

任务输出只在数据实际存在时展示。运行中的临时结果应标明“本次任务状态”；跨重启历史应来自已持久化的 run、receipt 或 review 工件。

### 6.3 岗位与人才

岗位列表使用紧凑可扫描的行：平台、岗位名、地点、最近运行、候选/评分数量、健康状态。详情页包含：

- 岗位原文 JD 与结构化 JD 的并列查看；Boss 岗位额外展示 stable Boss job ID、职位状态、最后同步和 JD hash。
- 完整运行历史（使用既有 `/api/jobs/:platform/:jobKey/runs`），按运行展开新增候选、失败和导出结果。
- 候选人表格支持按评分、状态、当前公司、城市筛选和排序。
- 候选人详情展示结构化信息、评分维度/证据、原始快照和受控工件链接。照片证据不充分时不渲染图片。

不将候选人的敏感原始简历文本预加载到大列表中；只在详情按需读取。

### 6.4 Boss 工作台

Boss 是单独的领域工作台，不加入“全部平台”选择器。页面顶部始终展示“Boss 单平台”提示和会话/API 状态。

#### 职位同步

- 列表来自 latest position snapshot，列为职位名、Boss job ID、状态、本地 jobKey、最后同步、JD hash 和最近 outcome。
- 可查看同步运行历史与逐职位结果；失败项显示原因和“重新同步”动作。
- “同步全部”与“同步选中职位”创建 `boss-job-sync` 任务。关闭职位默认包含，保持现有会话关联语义。
- 不在 UI 中通过同名职位合并或猜测职位 ID。

#### 人才发现

- 首次进入默认只读：推荐/深度搜索条件、匹配余额、匹配按钮可用性和候选人结果。
- 深度搜索的核心要求与加分项分别显示，并在提交前与后端读取结果逐项核对。
- “立即匹配”只在核心要求非空、剩余额度大于零、平台控制可用时显示；点击后进入高风险确认抽屉。
- “打招呼”只能从带 stable candidate ID 的候选人详情打开；确认抽屉显示 candidate ID、候选人姓名、职位名、Boss job ID、intent ID 和“已联系”处理结果。

#### 会话中心

三栏布局：会话列表、会话/简历详情、操作面板。

- 会话列表可筛选未读，仅以 exact conversation ID 作为操作目标。
- 只读操作（列表、打开、读取历史、预览简历）正常进入任务队列，结果在详情显示。
- 发送文本、备注、不合适、请求/接收附件、电话、微信等变更在操作面板中以独立命令呈现；禁止通过自由文本生成任意浏览器行为。
- 通用文本发送始终标明“不会覆盖已有草稿”；提交结果必须显示 `changed`、`intentId`、`receiptPath` 对应的 artifact 和完成时间。

#### 自动沟通审核

- 展示已持久化 review run：会话、职位、候选人、首次/跟进分支、评估结论、已转发/已联系状态、失败原因和邮件结果。
- 不在页面提供任意话术编辑器；继续复用平台固定常用语路径和服务器端的严格判断逻辑。
- “再次运行”创建新的 `boss-auto-chat` 任务，不重放或伪造已有回执。

#### 回执

- 仅展示成功持久化的 mutation receipt。
- 按 intent ID、操作、会话、候选人、职位和时间检索。
- 清楚说明重试同一 intent ID 会返回已有结果，不会重复外部动作。

### 6.5 自动化

调度页保留当前时间窗口、完成后延迟、失败策略、暂停阈值和轮次历史，但改用结构化任务编辑器：

- 任务类型切换后显示该类型的受限表单，不以 JSON 文本作为默认编辑方式。
- 高级 JSON 仅为诊断模式；保存前必须走同一 normalizer 验证。
- 可调度任务只显示 `resume-capture`、`batch`、`search-subscription`、`boss-auto-chat`、`boss-job-sync`。
- 人才匹配、打招呼、会话变更不显示为可调度选项。
- 停止操作显式标注“当前任务结束后停止”，不承诺强制中止浏览器动作。

### 6.6 知识与运营

- 问答页将答案、置信度、来源片段和无答案原因并列显示。
- 已存岗位和临时 JD 必须是两个清晰的模式；临时 JD 明确标记“不创建岗位、不写持久索引、不写生产 answer log”。
- 运营页聚合 RAG doctor、review、metrics、ops、rebuild，但每个操作仍生成独立队列任务和结果链接。
- 页面不提供“把候选人回答直接设为事实”的快捷动作；只有已验证 recruiter 事实可进入可信来源。

### 6.7 设置

设置分成三个隔离区域：

1. 控制台连接：API base URL、控制台 Bearer token、连接测试。token 仅在 sessionStorage 保存，页面关闭后可重新输入。
2. 模型临时配置：base URL、model、模型 API key。模型 API key 只用于助手和控制台 RAG 请求，并遵守现有“不持久化、不写日志”规则。
3. 客户端偏好：轮询频率、紧凑密度、减少动画、默认平台筛选。不得把执行参数或平台会话写入此区。

## 7. API、持久化与契约计划

### 7.1 既有 API 的前端接入

前端应完整接入并按领域封装以下既有能力：

| API | 客户端用途 | 当前缺口 |
| --- | --- | --- |
| `GET /api/dashboard/health` | 控制台健康矩阵 | 缺少自动刷新和异常跳转 |
| `GET /api/tasks`、`GET /api/tasks/:id` | 任务中心 | 缺少 typed output renderer |
| `GET/POST /api/schedules...` | 自动化 | 表单过度依赖 JSON |
| `GET /api/jobs...` | 岗位/候选人 | 未接入完整 runs |
| `GET /api/jobs/:p/:job/runs` | 岗位运行历史 | 服务端已有，客户端未使用 |
| `POST /api/rag/answer` | RAG 问答 | 保留无答案语义 |
| `POST /api/assistant/*` | 辅助任务草稿 | 作为辅助入口，不承担主工作台职责 |
| `GET/POST /api/ops/*` | 筛选目录和输入 | 保留可视化筛选构建器 |

### 7.2 新增只读 read model

新增 `BossReadModel` 或扩展 `JobReadModel`，只读取已经持久化的本地工件。建议路由：

```text
GET /api/boss/positions
GET /api/boss/job-sync/runs
GET /api/boss/job-sync/runs/:runId
GET /api/boss/chat-reviews
GET /api/boss/chat-reviews/:runId
GET /api/boss/chat-receipts
GET /api/boss/chat-receipts/:intentId
```

规则：

- 这些 GET 路由不得直接打开浏览器、读取在线 Boss 页面或消耗额度。
- 职位数据读取 `data/boss/job-sync/positions.latest.json` 和 timestamped sync runs。
- 自动沟通读取 `data/boss/chat-review/runs/`；对候选人敏感信息做最小必要字段展示。
- 回执读取 `data/boss/chat-operations/` 中已持久化、可验证的 receipt；回执 ID 不能被前端自由拼接成文件路径。
- 人才发现与只读会话的临时任务输出仅通过任务详情查看。若产品需要跨重启的历史浏览，必须先在后端定义新持久化工件和保留策略，不能由前端缓存冒充历史。

### 7.3 安全工件下载

新增一个只读、受控的 artifact 路由：

```text
GET /api/artifacts/:artifactId
```

`artifactId` 从任务、岗位、候选人或 Boss read model 输出中获得，由服务端映射至允许的文件类型：Markdown 导出、文本快照、DOM 快照和已登记回执。服务端必须：

- 校验 artifact 所属平台、jobKey、candidateId 或 intent ID。
- 拒绝路径分隔符、任意文件路径和 `..`。
- 设置正确的 content type 与 `Content-Disposition`。
- 不提供 `.env`、storage state、任意 `data/` 文件、浏览器 profile 或未经登记的附件。

### 7.4 任务 API 与实时状态

第一期使用客户端轮询，不增加 WebSocket：

- 含 queued/running 任务的页面每 3 秒刷新任务与详情。
- 没有运行中任务时，控制台每 30 秒刷新；后台标签页降低到 60 秒。
- 调度运行中时每 5 秒刷新对应 schedule/runs。
- 请求使用 `AbortController`，路由切换和新请求应取消旧请求。
- 最近一次成功时间与连接错误同时显示；错误期间不清空最后真实数据，但必须标明数据已过期。

后续只有在任务量和实时性确实需要时，才单独设计 SSE；不得将 SSE 作为绕开队列或直接驱动浏览器的通道。

### 7.5 API 鉴权和错误契约

统一 API 客户端：

- 读取 sessionStorage 中的 `autorecruit.consoleToken`，存在时添加 `Authorization: Bearer <token>`。
- 模型 `apiKey` 继续只作为 `modelConfig` 请求字段，绝不放入 Authorization。
- 401 显示“控制台令牌缺失或无效”并跳转设置，不自动回退 mock。
- 400 显示 normalizer 返回的明确字段错误；409/重复 intent 显示幂等语义；5xx 显示可重试错误和 request context。
- 生产模式的 `withFallback` 删除。演示数据只能由 build-time `VITE_DEMO_MODE=true` 和专用 demo API 层启用。

### 7.6 共享契约

创建一个不引入 Node runtime 依赖的共享模块，例如：

```text
src/server/api-contracts.ts
frontend/src/api/contracts.ts  // 仅 re-export 或生成类型
```

Zod 已是仓库依赖。新 API 要先定义 request/response schema，再由服务端解析和前端推导类型。前端不得继续复制服务端 union 后手工维护。

## 8. 前端工程结构

目标目录：

```text
frontend/src/
  app/
    AppShell.tsx
    router.tsx
    providers.tsx
  api/
    client.ts
    contracts.ts
    query-keys.ts
  components/
    layout/
    data-display/
    feedback/
    forms/
    safety/
  features/
    dashboard/
    tasks/
    jobs/
    boss/
    automation/
    knowledge/
    settings/
  hooks/
  styles/
    tokens.css
    reset.css
    globals.css
  test/
```

技术选择：

| 领域 | 方案 | 原因 |
| --- | --- | --- |
| 路由 | `react-router-dom` | 嵌套路由、深链接、懒加载与 404 |
| 服务端状态 | `@tanstack/react-query` | 轮询、缓存、取消、失效与 mutation 状态 |
| 表单 | `react-hook-form` + Zod | 复杂任务、确认和调度表单的一致校验 |
| 无障碍弹层 | Radix Dialog/Popover 等必要 primitive | 保留自定义视觉，同时处理 focus trap/键盘 |
| 图标 | 继续使用 `lucide-react` | 保持现有图标体系 |
| 图表 | 先用 CSS/SVG 轻量数据可视化；确有多维趋势需求时再选单一图表库 | 避免无用途的依赖和视觉噪音 |

迁移后的 `frontend/src/app/App.tsx` 只挂载 provider 与 router；业务页面按领域保存在 `features/`，不再集中到单文件。

## 9. 高风险操作交互规范

### 9.1 风险分级

| 级别 | 示例 | UI 行为 |
| --- | --- | --- |
| 只读 | 读取职位、人才卡片、会话、简历预览、RAG 问答 | 普通提交，展示“只读任务” |
| 配额消耗 | Boss 立即匹配 | 橙色确认抽屉，显示余额、核心条件、职位 ID，要求 `confirmed` |
| 外部联系 | 打招呼、发送文本、索要简历、换电话、换微信 | 红色确认抽屉，显示完整身份和 intent ID，要求 `confirmed` 与风险确认 |
| 不可逆标记 | 不合适、备注、接收附件 | 红色确认抽屉，显示会话/候选人/职位和执行内容 |

### 9.2 统一确认抽屉

确认组件必须从服务端返回或经 shared normalizer 校验的字段渲染：

```text
操作类型
目标：候选人姓名 + stable ID / 会话 ID / Boss job ID
预期职位与身份核对信息
要发送的固定文本或备注预览
intent ID
风险说明
确认 checkbox
提交按钮
```

前端可为新动作生成 UUID 作为 `intentId`，但服务器仍是幂等与身份校验的唯一裁决者。重试同一 intent ID 时，客户端应优先请求现有回执，而不是暗示会再次发送。

## 10. 分阶段实施计划（首版执行记录）

阶段 0 至阶段 4 的首版核心范围已经完成。阶段 5 已完成自动化、知识与运营页面、统一构建测试链路和旧集中式代码清理；旧 hash 兼容、组件级测试扩充及发布环境版本检查按“后续增强项”继续推进。以下保留原始阶段工作项，作为需求和验收追溯记录。

### 阶段 0：契约冻结与设计基线

**目标**：确认范围，避免视觉改造中改变业务语义。

工作项：

1. 建立当前 API inventory、现有任务输入/输出映射和新 Boss read model schema。
2. 为任务、Boss 同步、聊天 receipt、chat review、artifact 定义 Zod contract 和 fixture。
3. 输出低保真信息架构和高保真关键页面设计：控制台、任务详情、岗位详情、Boss 三栏工作台、确认抽屉。
4. 定义颜色、排版、间距、状态、断点、tooltip、加载和错误 token。
5. 确认下列产品决策：默认轮询频率、Boss review 记录保留期、artifact 可下载类型、是否保留旧 hash 路由的时间窗口。

验收：设计稿覆盖所有状态（loading、empty、error、unauthorized、running、succeeded、failed、stale），且不要求平台模块变更。

### 阶段 1：应用壳与数据访问层

**目标**：先解决前端可靠性与可持续开发结构。

工作项：

1. 引入 React Router、TanStack Query、表单校验 primitive，建立 `AppShell`、新导航和路由迁移层。
2. 将 `api.ts` 拆为 API client、合同、query keys；实现 Bearer token session 存储和 401 引导。
3. 删除生产 mock fallback，新增明确的 demo build flag 与隔离 fixture。
4. 建立统一页面状态组件：骨架、空态、连接错误、数据过期、错误边界、toast、confirm drawer。
5. 将 CSS 拆成 token、基础样式和 feature 样式，完成暗侧栏/亮工作区的新视觉基线。
6. 接入可见焦点、键盘导航、`prefers-reduced-motion` 和移动断点。

验收：

- 现有控制台 API 页面在新壳内工作；配置控制台 Bearer token 时客户端能正常访问。
- API 断开时显示真实错误和上次真实数据，不出现 mock 候选人。
- 桌面 `1440x900`、平板 `1024x768`、手机 `390x844` 截图无溢出或文本遮挡。

### 阶段 2：核心运营页面

**目标**：完成高频的控制台、任务、岗位和候选人体验。

工作项：

1. 实现控制台的队列轨道、待处理列表、平台健康矩阵和漏斗。
2. 实现任务中心的轮询、日志检查器和基于 task kind 的 output renderer。
3. 将既有 jobs runs API 接入岗位详情，增加运行历史、失败展开和 artifact 列表。
4. 改造候选人列表/详情为结构化评分证据和快照查看器。
5. 实现新建任务抽屉，覆盖普通抓取、批量、搜索订阅、Boss 自动沟通和登录刷新；保留现有 direct filter builder。
6. 创建受控 artifact API，并替换前端绝对路径链接。

验收：

- 用户可从失败警报跳转到任务，再跳转到岗位/候选人或登记工件。
- 已有岗位的完整运行历史可见，且来源于 API 而非前端推测。
- 任务运行期间页面不需要手动刷新即可得到终态。

### 阶段 3：Boss 持久化读取与工作台

**目标**：让新 Boss 能力可复盘、可浏览、可定位。

工作项：

1. 实现 `BossReadModel`、只读路由、schema 和服务端测试。
2. 实现 Boss 职位同步页和同步历史页，呈现 stable job ID、hash、状态和逐项 outcome。
3. 实现 Boss 自动沟通审核列表和详情页，按持久化 run 展示判断、转发、联系、失败和邮件结果。
4. 实现 chat receipt 检查器，按 intent ID 查询并解释幂等重试结果。
5. 在任务中心加入 Boss 结果专用 renderer，并链接到对应 Boss 对象页。

验收：

- 服务重启后，已持久化的同步、审核和回执仍可被前端读取。
- 同名不同 Boss job ID 的职位在 UI 中始终作为独立记录。
- 前端 GET 页面不会启动浏览器、不消耗匹配额度、不触发聊天动作。

### 阶段 4：Boss 受控操作界面

**目标**：将 Boss 新任务从助手辅助能力升级为完整、安全的操作界面。

工作项：

1. 实现人才发现页：推荐/深度搜索、核心/加分条件、只读卡片、匹配状态和结果。
2. 实现会话中心：会话列表、消息详情、简历预览任务结果和只读操作状态。
3. 为立即匹配、打招呼和每种会话变更接入统一确认抽屉、intent ID、身份复核和回执跳转。
4. 将 Boss 职位同步作为自动化任务可选项；明确隐藏所有不可调度 mutation。
5. 将智能助手保留为自然语言快捷入口；其草稿确认后跳转到相同的结构化确认 UI，而不是绕过它。

验收：

- 可从职位 -> 人才卡片 -> 打招呼确认完成完整路径，且 stable candidate ID/职位身份可见。
- 会话 mutation 无法在缺少 `conversationId`、identity expectation、`confirmed` 或 intent ID 时提交。
- 用户可以明确区分只读结果、已排队动作、已完成变更和通过 receipt 去重的重试。

### 阶段 5：自动化、RAG、收尾与切换

**目标**：完成所有剩余入口，并建立长期维护基线。

工作项：

1. 将调度 JSON 编辑器替换为类型化表单，保留诊断 JSON 查看模式。
2. 重构 RAG 和运营页，强化来源、置信度、无答案与临时 JD 的隔离提示。
3. 为所有旧 hash 路由添加迁移和 404 行为，完成旧页面移除。
4. 将 web build 纳入统一构建脚本或 CI；确保服务端静态目录使用最新 `frontend/dist`。
5. 完成 visual regression、端到端、无障碍和性能回归；清理旧 mock/runtime-only 代码路径。

验收：

- 每个公开任务类型均有专用入口或清晰归属，助手只是补充入口。
- `npm run build` 的发布流程同时验证 TypeScript 和前端 production bundle。
- 无关键 UI 依赖 mock、临时 JSON 编辑或浏览器本地文件路径。

## 11. 文件与模块实施清单

| 区域 | 实施结果 |
| --- | --- |
| 旧根级前端入口、API、类型、mock 和样式文件 | 已删除，由领域目录和共享契约替代 |
| `frontend/src/app/` | 新增 provider、BrowserRouter、应用壳和导航 |
| `frontend/src/api/` | 新增带认证和错误契约的 API client、共享类型与模型设置存储 |
| `frontend/src/components/` | 新增安全确认、工件下载、结构化任务输出和通用界面组件 |
| `frontend/src/features/*` | 新增控制台、任务、岗位、Boss、自动化、知识、助手、设置和新建任务模块 |
| `frontend/src/styles/` | 新增视觉 token、全局与响应式样式 |
| `src/server/job-read-model.ts` | 增加运行历史和安全 artifact 描述 |
| `src/server/boss-read-model.ts` | 新增 Boss 持久化工件读取与兼容解析 |
| `src/server/artifact-read-model.ts` | 新增白名单 artifact ID 映射和安全读取 |
| `src/server/api-contracts.ts` | 新增前后端共享 Zod 契约 |
| `src/server/routes.ts` | 新增只读 Boss/artifact routes；任务提交继续复用 normalizer 与 queue |
| `src/scripts/test-server-api.ts` | 扩展 API contract、artifact 和 Boss read model 回归 |
| `src/scripts/test-frontend-client.ts` | 新增客户端路由、契约和生产边界检查 |
| `package.json` | 新增 `web:typecheck`、`test:web` 和聚合构建脚本 |

预计不修改 `src/platforms/*`、`src/browser/*`、`src/index.ts` 的业务行为。若发现缺少持久化工件，应先增加最小、可审计的存储 API，再做 UI；不得以页面状态替代持久化。

## 12. 测试与验证矩阵

### 12.1 前端单元测试

- API client：token、401、400、5xx、demo mode、abort 和错误映射。
- 表单：普通抓取/批量/订阅的模式隔离；Boss mutation 的必填身份与确认条件；不可调度任务隐藏。
- 组件：风险抽屉、状态标签、artifact 链接、无答案、数据过期、空态。
- 路由：旧 hash 映射、深链接、非法平台/jobKey/candidateId。

### 12.2 服务端集成测试

- Boss read model 不启动浏览器，只读取测试 data fixture。
- artifact route 拒绝目录遍历、storage state、`.env` 和任意路径输入。
- 401 保护所有 `/api/*`；token 不出现在 task record、assistant draft 或日志。
- 现有 task normalizer、TaskQueue、schedule、Boss receipt 和 RAG isolation 测试继续通过。

### 12.3 Playwright 端到端测试

使用 fixture API/data，禁止测试直接操作真实招聘平台：

1. 未授权 -> 设置 token -> 正常加载控制台。
2. 运行中任务自动刷新为成功/失败，并显示对应结果。
3. 岗位详情显示多次 run 与安全 artifact 下载。
4. Boss 职位同步明细按不同 Boss job ID 分开渲染。
5. Boss 人才发现默认只读；立即匹配在确认前不发请求。
6. Boss 会话变更必须完成 identity、intent ID、confirmed、risk acceptance 才能提交。
7. 无可信 RAG 来源时显示 no-answer，不显示臆测回答。
8. 三个目标视口的截图比较和关键交互检查。

### 12.4 手工验收

- 使用已有本地数据启动 API 和生产 bundle，验证任务、岗位、调度和 Boss read pages。
- 在测试 Boss 会话中验证相同 intent ID 的重试只返回 receipt，不重复外部动作。
- 断网或停止 API 后，确认页面只显示真实的 stale 数据和连接错误。
- 键盘完成导航、确认抽屉、关闭弹层和表格操作；检查屏幕阅读器标签。

## 13. 发布、迁移与回滚

1. 先发布服务端只读 API 和 schema，保持现有前端可用。
2. 新前端通过 feature flag 或独立静态目录进行内部验证；与旧控制台共享同一 API，不共享 mock 数据。
3. 将旧 hash 入口重定向到新路由，观察一整个发布周期后移除兼容层。
4. 前端发布前必须先运行 `web:build`；服务端静态托管前校验 `frontend/dist` 存在且版本匹配。
5. 回滚只回滚静态 bundle；服务端新增的只读 API 与持久化读取不破坏旧客户端。
6. 不迁移或重写现有职位、简历、RAG、Boss receipt、chat review、调度数据；read model 必须向后兼容历史文件的可选字段。

## 14. 风险与缓解措施

| 风险 | 影响 | 缓解措施 |
| --- | --- | --- |
| 视觉重构误改任务语义 | 外部浏览器动作错误或重复 | 所有执行仍经 normalizer + TaskQueue；先锁定 contract 和回归测试 |
| 把 runtime task output 当历史 | 重启后审计缺失 | 仅持久化工件进入 Boss 历史页面；临时结果明确标记 |
| mock 回退掩盖 API 故障 | 运营误判 | 生产删除 fallback，demo 显式开关 |
| 控制台 token 与模型 key 混用 | 凭据泄露或接口失败 | 独立字段、独立存储、token 仅 sessionStorage、模型 key 不进 Authorization |
| Boss UI 降低确认门槛 | 配额消耗/联系误触发 | 风险抽屉 + server-side confirmed/identity/intent 检查 + receipt |
| 前端读取任意路径 | 本地敏感数据泄露 | artifact ID 白名单、服务端路径解析与测试 |
| 重构过大导致长时间不可交付 | 核心页面迟迟无法使用 | 分阶段发布，阶段 1/2 可独立上线，Boss 工作台分读与写两步 |
| 客户端依赖膨胀 | 首屏和维护成本增加 | 只引入路由、查询、表单和必要无障碍 primitive；图表按需求后置 |

## 15. 实施前检查清单

- [x] 确认新前端路由以 BrowserRouter 还是 HashRouter 过渡；已采用 BrowserRouter，静态服务器保留 SPA fallback。
- [x] 确认控制台 token 的用户输入方式和 session 生命周期；仅写入 sessionStorage。
- [x] 确认 Boss chat review、sync run、receipt 的历史文件样例与字段兼容范围。
- [x] 确认 artifact 白名单与候选人敏感数据的下载权限范围。
- [x] 为新的 API schema 准备无真实候选人数据的测试 fixture。
- [x] 执行 `rtk npm run typecheck`、`rtk npm run test`、`rtk npm run build` 作为发布验证。
- [x] 在涉及 server 和 Boss 边界的实施阶段读取对应 `AGENTS.md`。

## 16. 完成定义

本计划完成不以“页面更漂亮”为标准，而以以下产品闭环为标准：

```text
发现异常
  -> 定位任务/岗位/Boss 对象
  -> 查看真实结构化证据
  -> 只读检查或创建受控任务
  -> 高风险操作完成身份与风险确认
  -> 通过队列执行
  -> 在实时状态、持久化工件和回执中复盘
```

达到该闭环后，客户端才算与当前 AutoRecruit 的平台、调度、RAG 和 Boss 能力对齐。

第一版已在实现、API fixture、完整回归和三个目标视口的浏览器验证中达到该闭环；真实平台变更操作仍遵循原有人工确认与运行边界，不由前端验证替代。
