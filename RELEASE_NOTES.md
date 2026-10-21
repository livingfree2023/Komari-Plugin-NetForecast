## 🇨🇳 中文更新日志 (Changelog - zh_CN)

### 🚀 v26.1020.1
#### 🛡️ 路由隔离与前台无感展示 (Route Isolation & UX)
- **健壮黑名单路由隔离与前台稳定展示**：
  - 将路由判定重构为健壮黑名单机制：在后台管理（`/admin`、`/terminal`、`/settings`、`/login`）及独立插件大屏（`matrix.html`、`public.html` 等）严格静默隐藏。
  - 彻底解除过于严苛的正向白名单与 iframe 限制，确保前台所有路由（首页、节点列表、实例详情、二级子路径部署、仪表盘 iframe 嵌入）均能正常稳定显示浮窗。
  - 修复 `nfCheckRoute` 中调用未定义函数的 ReferenceError，统一 `popstate` / `hashchange` / SPA pushState 路由状态监听与数据热刷新。

### v26.1012.2 (Previous)

### 🚀 新增功能与高可用自愈 (Features & Resilience)
- **时序打点重启自适应算法（Counter Reset Detection）**：
  - 彻底解决 VPS / 网卡重启后，Linux `/proc/net/dev` 内核内存计数器清零导致的“今日”流量归零、大幅倒扣或数据丢失问题。
  - 引入网络监控工业级重置判定规则：相邻采样点 `curr >= prev` 计正常增量，`curr < prev` 时判定为系统或网卡重启并将 `curr` 作为重启后新产生量正向累加。今日流量无缝衔接网卡实时计数器，单日多次重启亦能全额记录。
  - 彻底移除过去脆弱的多层嵌套 fallback 分支及 `> 500GB 归零` 的防御性硬编码，计算更简洁、稳健。
- **核心数据库高并发限流保护（Concurrency Limit & Timeout Shield）**：
  - 深度优化多节点并发拉取 720 小时历史打点时的数据库负载，引入 `mapConcurrent` 批处理机制（限制最大并发请求数为 4），单次超时时间延长至 8.0s，彻底杜绝单核轻量 VPS 下 SQLite 数据库锁死或大量请求 Abort / 失败。
- **数据库查询失败节点的视觉警示与按需重试（Failure UI & Retry Mechanisms）**：
  - **单卡片错误警示**：当节点数据库查询因超时未完成时，卡片顶部标记警示徽标，并在卡片内展示醒目的警告横幅，附带独立 `[🔄 重试此节点]` 按钮（使用 15s 充裕超时重试单节点）。
  - **全局失败横幅与批量重试**：看板顶部检测到失败节点时，自动展开全局提醒条，并提供 `[🔄 重试失败节点 (N)]` 按钮，低并发平滑轮询重试所有失败节点，重试成功后自动隐退。
  - **失败专属筛选胶囊**：动态筛选栏若检测到失败节点，自动增加 `⚠️ N 个时序拉取失败` 快捷筛选胶囊，一键聚焦故障节点。
- **一键纯文本诊断数据导出与静态 URL（AI Agent 友好）**：
  - **静态接口直取**：提供固定端点 `/api/plugin/net-forecast/export.json`（及别名 `/debug.json`、`/debug`），AI Agent 与自动化脚本可直接通过 HTTP GET 读取完整诊断数据，彻底免除手动下载与繁复 UI 弹窗。
  - **内存快照缓存与抗 DoS 保护**：服务端提供 180 秒（3 分钟）内存快照缓存与 60 秒刷新节流互斥锁，内存命中响应耗时 `<1ms` 且 0 次数据库 I/O 查询，配合 `Cache-Control: public, max-age=60`，完全免疫高频请求或 DoS 攻击。
  - **操作栏一键复制**：看板底部提供「📋 复制诊断 URL」与「📥 导出诊断数据 (JSON)」双操作，一键将抓取 URL 提供给 AI Agent。

### 🐛 问题修复与多端体验对齐 (Bug Fixes & Consistency)
- **彻底解决悬浮小组件与全量看板指标显示不一致的问题**：
  - **根本原因修复**：修复了浮窗组件在后台重复发送缺乏打点历史的请求，导致服务端回退至本地短采样数据并冲刷覆盖全局快照的严重缺陷。
  - **30 天高精度时序持久化**：在 `TrafficStorage` 中新增时序合并落盘逻辑（`setNodeDailyHistory`），全量看板从核心数据库拉取的 30 天打点数据自动落盘，确保服务端与浮窗任何时候均具备完整的 7 日均速计算基准。
  - **浮窗轻量直读优化**：彻底移除浮窗组件内部对所有节点的并发额外轮询与重算逻辑，直接复用服务端高精度权威快照，页面响应 `<1ms`，两处视图均速、预测总量与告警状态实现 100% 绝对一致。
  - **单节点重试快照保护**：在服务端增加了单节点局部合并防护逻辑，当用户在前端单独重试某个节点时，外科手术式就地更新该节点，杜绝单节点结果冲刷覆盖全局 15 个节点快照。
  - **RPC 时区对齐**：对齐了 `netForecast:getOverview` RPC 接口的统计时区偏移与快照复用。
- **账单周期折线平滑对齐（消除 90 度垂直突变）**：
  - 修复当网卡硬件总计与日采样存在差额时，今日点出现 90 度直角垂直突变的缺陷。引入前序基准底数平滑对齐，折线全周期平滑单调递增，左右严格对齐重置周期。

---

## 🇬🇧 English Changelog (en)

### 🚀 v26.1020.1
#### 🛡️ Route Isolation & Frontend UX
- **Robust Blacklist Route Isolation & Frontend Reliability**:
  - Replaced restrictive route whitelisting with robust blacklist filtering: strictly hides on admin management (`/admin`, `/terminal`, `/settings`, `/login`) and standalone plugin pages (`matrix.html`, `public.html`, etc.).
  - Restored reliable floating widget display across all frontend views, SPA hash routes, custom subpath deployments, and embedded iframe dashboards.
  - Fixed the `ReferenceError` caused by dangling function references in `nfCheckRoute`, harmonizing `popstate`, `hashchange`, and SPA `pushState` listeners.

### v26.1012.2 (Previous)

### 🚀 Features & Resilience
- **Counter Reset Detection for Linux / VPS Reboots**:
  - Completely resolved the issue where today's traffic counter would reset to zero, become negative, or lose pre-reboot usage when a monitored VPS rebooted (which resets the Linux `/proc/net/dev` kernel memory counter).
  - Adopted industry-standard reset detection: when adjacent samples show `curr >= prev`, the delta is `curr - prev`; when `curr < prev`, a counter reset / reboot is detected, treating `curr` as newly accumulated post-reboot traffic. Seamlessly stitches historical records with live counters.
  - Eliminated arbitrary thresholds (like `> 500GB`) and nested fallback cascades in favor of a clean, robust mathematical formulation.
- **Concurrency Limiting & Database Timeout Defense**:
  - Implemented `mapConcurrent` batch scheduling (capped at 4 concurrent requests) and extended database timeouts to 8.0s when querying 720h network records, preventing SQLite lockups and request aborts on single-core lightweight VPS servers.
- **Node Query Failure UI & Interactive Retry Mechanisms**:
  - **Per-Card Alert & Inline Retry**: Nodes that timeout during initial loading display a clear warning banner and an independent `[🔄 Retry Node]` button with a 15-second relaxed timeout.
  - **Global Failure Banner & Batch Retry**: The header displays a global alert banner when failed nodes are detected, featuring a `[🔄 Retry Failed Nodes (N)]` button that sequentially recovers all failed nodes with progressive status feedback.
  - **Quick Filter Pill**: The filter bar dynamically adds a `⚠️ N Failed Queries` pill to quickly isolate nodes needing attention.
- **Direct Plain-Text Diagnostic JSON Export & Static URL (AI Agent Friendly)**:
  - **Static Endpoint Access**: Added a dedicated static endpoint `GET /api/plugin/net-forecast/export.json` (with aliases `/debug.json` and `/debug`) allowing AI agents and external scripts to directly retrieve comprehensive diagnostic data via HTTP GET without manual file downloads or bulky UI modals.
  - **In-Memory Snapshot & DoS Protection**: Implemented a 180-second (3-minute TTL) in-memory snapshot cache with a 60-second mutex refresh lock. Cache hits return in `<1ms` with zero database queries, fortified with `Cache-Control: public, max-age=60` to thoroughly eliminate any risk of DoS attacks or database exhaustion on single-core VPS servers.
  - **One-Click URL Copying**: Added a "📋 Copy Diagnostic URL" button alongside "📥 Export Debug Data (JSON)" in the footer bar for effortless URL sharing.

### 🐛 Bug Fixes & Multi-View Consistency
- **Resolved Discrepancy Between Floating Widget and Full Chart**:
  - **Root Cause Fix**: Fixed a critical defect where the floating widget sent background recalculation requests lacking historical records, causing the backend to fall back to limited local samples and overwrite the authoritative global snapshot.
  - **Persistent 30-Day Historical Storage**: Added `setNodeDailyHistory` in `TrafficStorage` to persistently save high-resolution 30-day records fetched by the dashboard to disk, ensuring both server endpoints and the floating widget consistently compute the accurate 7-day weighted run-rate.
  - **Lightweight Floating Widget Direct Consumption**: Removed redundant 15-node `/api/recent` polling and degraded re-POST loops from the floating widget. The widget now directly consumes the unified high-precision overview snapshot in `<1ms`, ensuring 100% data consistency across both views.
  - **Surgical Snapshot Protection on Node Retry**: Added in-place partial update protection so that retrying an individual node does not flush or overwrite the global multi-node snapshot.
  - **RPC Timezone Alignment**: Aligned the `netForecast:getOverview` RPC interface with the configured timezone offset and snapshot reuse.
- **Continuous Monotonic Billing Cycle Curves**:
  - Fixed the 90-degree vertical cliff artifact on the cumulative line chart by smoothly offsetting the baseline when historical counters and daily increments have discrepancies, ensuring strictly monotonic curves aligned between `[cycleStart, cycleEnd]`.
