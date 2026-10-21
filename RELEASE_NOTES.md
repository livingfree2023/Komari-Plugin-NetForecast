# v26.1021.6 — 宿主水合稳定期淡入、手势防重开与多插件对齐 / Host Settling Window, Gesture Disambiguation & Multi-Widget Alignment

## 🇨🇳 中文更新日志 (Changelog - zh_CN)

### 🚀 新增功能 (Features)
- **120ms 宿主水合稳定期与平滑无缝淡入机制 (Host Settling Window & Smooth Delayed Reveal)**：
  - 引入 120ms 宿主稳定期架构规范。根容器初始保持 `opacity: 0` 隐身，静默等待宿主 SPA 完成 DOM 水合、动态主题类注入与背景图片渲染；
  - 稳定期结束后，探针读取 100% 真实的宿主背景与边框风格，并结合同屏邻近按钮完成槽位防碰撞避让，随后通过 `0.22s ease` 极其自然地淡入视野；
  - 彻底消除了页面刷新时按钮瞬间由深灰色闪跳为主题色（Flash of Unstyled Theme）的肉眼撕裂感。
- **多插件共存防碰撞与槽位智能避让 (Multi-Widget Collision Avoidance)**：
  - 遵循统一的 `[data-km-fab="true"]` 去中心化契约与 `resolveFabPosition` 算法，在宿主水合与拖拽停靠时自动与同屏其他插件悬浮按钮（如 `unlock-test`）智能错开槽位，杜绝按钮互相重叠遮挡。
- **全局卡片互斥展示协议 (Mutually Exclusive Cards)**：
  - 监听并广播 `km:floating-card-open`，同一时刻只展开一个卡片，点击打开当前浮窗时自动收起其他插件已展开的弹窗。

### 🐛 问题修复 (Bug Fixes)
- **点击小按钮收起时刚关又开冲突修复 (Click Double-Toggle Disambiguation)**：
  - 彻底修复当浮窗已展开时再次点击小按钮收起浮窗、浮窗在关闭后立刻被重新打开的交互冲突；
  - 展开/折叠状态机统一收敛由 `pointerup` 的 `toggle()` 唯一驱动，`click` 仅拦截阻止冒泡与默认行为，杜绝多重事件触发导致的再次展开；
  - 增加 `onpointercancel` 安全保底，与 `unlock-test` 保持 100% 行为一致。
- **实例详情页浮窗展示与主题容错**：
  - 修复在 `/instance/:id` 详情页下主题探测器对单节点卡片样式抓取的容错性，保证在节点详情页依然能稳定呈现悬浮按钮与浮层。

### ⚡ 优化与改进 (Improvements)
- **视觉质感全面对齐与克制美学 (Refined Aesthetics)**：
  - 采用极致 1px 发丝边框（贴合宿主主题 `var(--nf-border)`），消除内嵌高光避免边框视觉变粗；
  - 移除粗红绿外框与预警呼吸脉冲动画，状态通过右上角静止角标优雅传达；
  - 采用右下立体深邃投影（X:4px, Y:6px），使按钮与展开浮窗在各种背景下均具备优雅的立体悬浮空间感。
- **Z-Index 严格层级隔离规范**：
  - 展开浮窗卡片层级提升至 `100000`，彻底跨越悬浮按钮层级区间（`99990`），彻底消除被其他插件小按钮部分遮挡角标的层级错乱。
- **零反斜杠模版安全校验**：
  - `WIDGET_BODY_HTML` 纯原生字符串处理，严格规避 Goja 模板求值时的反斜杠剥离漏洞。

---

## 🇬🇧 English Changelog (en)

### 🚀 Features
- **Host Settling Window & Smooth Delayed Reveal (120ms)**:
  - Introduced a 120ms host settling window architecture. The root container starts in stealth mode (`opacity: 0`), silently allowing the host SPA to complete DOM hydration, dynamic theme classes injection, and background rendering.
  - After 120ms, computed styles are sampled from the settled host page, collision coordinates are aligned with neighbor widgets, and the button smoothly fades in with `0.22s ease`.
  - Completely eliminates the instant color flicker from dark gray to host theme on page refresh.
- **Multi-Widget Collision Avoidance & Smart Stacking**:
  - Implements the decentralized `[data-km-fab="true"]` contract and `resolveFabPosition` algorithm to automatically offset slots from other plugin buttons (e.g. `unlock-test`), preventing overlap and stacking.
- **Mutually Exclusive Card Display**:
  - Dispatches and listens to `km:floating-card-open`, ensuring only one floating card remains expanded at any time.

### 🐛 Bug Fixes
- **Click Double-Toggle Disambiguation on Widget Close**:
  - Fixed an issue where clicking the floating button while the card is open caused it to close and immediately re-open.
  - Unifies card expansion and collapse strictly through `pointerup`'s `toggle()`. The native `click` listener only intercepts bubbling and default behaviors, eliminating re-triggering.
  - Added `onpointercancel` safety handler, fully aligning behavior with `unlock-test`.
- **Instance Detail Page Robustness**:
  - Improved theme discovery fallback on `/instance/:id` pages, ensuring reliable floating widget display across all routes.

### ⚡ Improvements
- **Refined Aesthetics & Restrained Design**:
  - Applied 1px hairline borders matching host theme styles without deceptive inset highlights.
  - Removed garish colored borders and distracting pulse animations in favor of static badge dots.
  - Added directional bottom-right elevation shadows (X:4px, Y:6px) for solid depth separation against diverse backgrounds.
- **Strict Z-Index Hierarchy**:
  - Set floating cards to `z-index: 100000`, strictly separating them from trigger buttons (`99990`) to prevent any clipping from neighbor widgets.
- **Zero-Backslash Template Safety**:
  - Enforced 100% native string operations inside `WIDGET_BODY_HTML`, avoiding Goja template backslash-stripping hazards.
