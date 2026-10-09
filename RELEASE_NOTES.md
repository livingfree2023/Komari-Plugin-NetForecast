## 🇨🇳 中文更新日志 (Changelog - zh_CN)

### 🚀 新增功能 (Features)
- **前台自适应悬浮小组件 (Floating Widget)**：
  - 前台右下角常驻 48×48px 可拖拽方形指示图标，支持全平台触控与鼠标原生平滑拖拽停靠，松手自动将坐标持久化至 `localStorage`。
  - 状态边框自适应响应：节点处于安全状态时呈现翠绿边框，存在超限或临界预警时自动切换为红色呼吸警报光圈与状态点。
  - 单节点详情页自动聚焦：访问 `https://your-komari/instance/:uuid` 时，浮窗自动激活 `📌 当前 (1)` 专属视角，直观呈现当前主机的即时消耗与重置日预测。
  - 多维分类筛选自由切换：浮窗内保留「全部」、「🚨 预警」、「✅ 安全」、「⚪ 免额」分类筛选药丸，在单节点页也可随时一键联动查看全局概况。
  - 管理后台免打扰：访问 `/admin/*` 路径时自动静默隐藏；支持在插件设置中通过 `enable_floating_widget` 开关自由控制启闭。
- **全新 16:9 海报式 3D 透视预览图**：
  - 更新 `assets/preview.svg`，采用左侧 30% 极简海报标题区配合右侧 70% 双层 3D 透视倾斜叠放窗口（完整后台看板 + 前景悬浮小组件），展现多场景预测与前台交互。

### 🐛 问题修复 (Bug Fixes)
- **消除模板字符串转义陷阱**：彻底移除注入代码中可能在 ES6 模板字符串中展开为 `//` 注释的正则表达式，全量改用纯原生字符串解析，杜绝浏览器端 `SyntaxError` 导致的脚本崩溃。
- **修复样式表定位与拖拽冲突**：样式表中仅声明 `position: fixed !important`，移除死锁的 `right/bottom` 样式，交由 JS 动态赋初值，恢复流畅拖拽。
- **修复单节点页面筛选按钮失效问题**：将单节点过滤与全局筛选类别彻底解耦，解决在 instance 路由下点击筛选按钮无响应的缺陷。

### ⚡ 优化与改进 (Improvements)
- **鲁棒的实例路由匹配**：增强 `getCurrentInstanceUuid()` 与 `findMatchingNode()`，支持全字匹配、忽略连字符 UUID 匹配以及短 UUID 前缀匹配，全面兼容各种 URL 格式。
- **开发与发布规范升级**：在 `agent.md` 中确立版本发布红线规范与前端注入 5 大避坑守则。

---

## 🇬🇧 English Changelog (en)

### 🚀 Features
- **Adaptive Frontend Floating Widget**:
  - Persistent 48×48px draggable square status button pinned to the bottom-right corner, supporting native touch and mouse dragging with `localStorage` position persistence.
  - Dynamic status indicator: emerald green glowing border under safe budget; pulses with a neon red halo and indicator dot when exhaustion risk is detected.
  - Smart Instance Page Auto-Focus: Navigating to `https://your-komari/instance/:uuid` automatically highlights and activates the `📌 Current (1)` filter view, focusing on the active node's live quota and reset forecast.
  - Interactive Filter Pills: Preserves `All`, `🚨 Alert`, `✅ Safe`, and `⚪ Uncapped` filter pills even on instance pages, allowing effortless toggling between single-node and fleet-wide overviews.
  - Admin Area Auto-Hide: Automatically hides on `/admin/*` routes to avoid clutter; configurable via `enable_floating_widget` in plugin settings.
- **New 16:9 Poster-Style 3D Perspective Banner**:
  - Redesigned `assets/preview.svg` with a clean 30% left column for typography and 70% right area showcasing dual 3D perspective-tilted windows (full dashboard and foreground floating widget overlay).

### 🐛 Bug Fixes
- **Eliminated Template Literal Slash Unescaping**: Replaced regular expressions inside ES6 template literals with pure native string operations, preventing unexpected `//` line comment syntax errors in Goja injection.
- **Fixed CSS Specificity vs. Drag Conflict**: Removed hardcoded `right/bottom: !important` from the CSS stylesheet, allowing dynamic inline styles to manage dragging smoothly without coordinate locking.
- **Fixed Filter Button Inoperability on Instance Pages**: Decoupled single-node routing from category filtering, ensuring all pills respond accurately across all views.

### ⚡ Improvements
- **Robust Node Matching**: Upgraded `getCurrentInstanceUuid()` and `findMatchingNode()` to support exact UUID/name matching, non-hyphenated UUIDs, and prefix matching across pathname, hash, and search parameters.
- **Enhanced Agent & Release Guidelines**: Formalized release approval gates and the 5 frontend widget safety rules in `agent.md`.
