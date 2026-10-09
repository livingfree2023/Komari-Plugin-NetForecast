## 🇨🇳 中文更新日志 (Changelog - zh_CN)

### 🚀 新增功能与体验革新 (Features & Performance)
- **主看板 SWR 本地秒开与渐进式骨架屏 (SWR Caching & Skeleton Screen)**：
  - **彻底废除全屏阻塞遮罩**：告别原有的全屏 Loading 弹窗，进入页面和刷新时不再阻断用户视窗。
  - **0 毫秒首屏秒开**：基于 SWR（Stale-While-Revalidate）架构与 `localStorage` 本地缓存，日常刷新或二次进入页面时，0 毫秒瞬间还原所有节点卡片、KPI 指标与 30 天 Canvas 图表，等待时间彻底降为 0 秒。
  - **非阻塞后台静默同步**：页面秒开的同时，在顶部展现极细渐变非阻塞进度条与状态角标，后台自动对齐最新时序与预测，完成后平滑热更新图表与数值。
  - **首次访问流动微光骨架屏**：在无缓存场景下，0 毫秒呈现带平滑流动微光（Shimmer）动画的深色骨架占位卡片，避免空白等待，数据就绪后平滑淡入。
- **悬浮小组件节点卡片直达跳转 (Clickable Instance Navigation)**：
  - 前台右下角浮出层小组件内的各个节点卡片全面支持点击直达；
  - 智能识别并适配 Komari 的 Hash 路由（`#/instance/:uuid`）与 Path 路由（`/instance/:uuid`），点击一键跳转至对应主机详情页；
  - 配备悬浮微动效（边框呼吸蓝光、轻微浮起、悬浮提示）以及名称右侧优雅的 `↗` 跳转指示标；
  - 智能防重复机制：已在目标详情页点击时自动保持当前视图，避免无谓重载。

---

## 🇬🇧 English Changelog (en)

### 🚀 Features & Performance Improvements
- **Dashboard SWR Instant Load & Progressive Skeleton Screen (SWR & Skeleton UI)**:
  - **Eliminated Blocking Full-Screen Overlay**: Removed the intrusive full-screen loading modal, unblocking the viewport during page loads and refreshes.
  - **0ms Instant Cache Restoration**: Powered by Stale-While-Revalidate (SWR) caching with `localStorage`, page reloads and subsequent visits instantly restore all node cards, KPI metrics, and 30-day Canvas charts in 0ms, reducing perceived wait time to zero.
  - **Non-blocking Background Sync**: While cached data is displayed instantly, a slender top gradient progress bar and lightweight sync badge indicate silent background reconciliation, seamlessly updating charts and metrics once fresh data arrives.
  - **Progressive Shimmer Skeleton Screen**: Cold visits without cache immediately display dark skeleton placeholder cards with gentle shimmer animations, gracefully fading into live cards once computed.
- **Clickable Floating Widget Cards with Smart Navigation**:
  - Node cards inside the frontend floating widget are now fully interactive and clickable.
  - Automatically detects Komari routing (supporting both `#/instance/:uuid` and `/instance/:uuid`) to navigate directly to the specific node detail page.
  - Features smooth hover micro-interactions (indigo border glow, subtle card lift, and an elegant `↗` navigation icon next to the node name).
  - Built-in redundant navigation protection: avoids reloading if already on the selected instance page.
