# Agent Guidelines for Komari-Plugin-NetForecast

本文档是针对维护和开发 `Komari-Plugin-NetForecast` 插件的 AI Agent 及开发者的核心指引与行为约束规范。任何参与本项目开发的 Agent 在修改代码、执行构建或发布版本前，**必须严格遵守**以下规则。

---

## 一、核心设计原则（Core Architecture Principles）

### 1. 严格真实数据驱动（Strict Real Data Pipeline）
- **绝不伪造任何数据**：严禁在代码中引入任何虚拟模拟种子、假随机数（如旧版的 10-35G 模拟数据）；无打点数据时严格呈现为 0 或空态。
- **物理总累计**：通过 Komari 核心内存实时上报（`GET /api/recent/:uuid`）获取，保证与 Komari 实例页显示的累计数值 100% 对齐。
- **历史增量时序**：通过 Komari 时序接口（`GET /api/records/load?load_type=network&hours=720`）按天聚合。

### 2. 每日柱状图与周期总累计彻底解耦（Decoupled Metrics）
- **柱状图（每日增量）**：
  - 永远只反映 **24 小时以内的真实物理增量**。
  - **严禁数据倒灌**：任何情况下，严禁使用 `inB = cumulativeIn - pastCycleIn` 或类似的差额补偿逻辑。缺失的历史天数流量绝不能转嫁到“今日”柱状图上。
  - **冷启动/安装首日**：若缺乏昨晚零点基准打点，以插件启动/安装时的首次采样作为基线（Baseline），只统计安装时刻起至今日的已发生增量；若有时序速率记录，使用时间积分兜底；若均无则展示为 0。
- **折线图（周期累计）**：
  - 负责周期总限额与重置日耗尽预测。
  - 在当天的最后一个点，折线图可以对齐当前周期的真实物理累计（`cumulativeBillable`），但柱状图必须保持独立的单日物理消耗。
- **日均增量（Run-Rate）推算**：
  - 优先使用**过去已完整各天**（`!r.is_today`）的 7 天移动加权平均。
  - 当缺乏过去完整天数（例如安装首日或新接入节点）时，采用 `本周期真实累计 / 本周期已过天数`（`cumulativeIn / cycle.daysElapsed`）推算均速，杜绝使用今日刚过几小时的微量流量推算整月。

### 3. 前台浮出层组件与入口规范（Frontend Floating Widget & Entrypoints）
- **首页顶部无侵入**：Komari 首页导航栏顶部不注入额外按钮，保持前台界面简洁无感。
- **浮出层单一跳转入口**：右下角浮出层小组件仅在底部 Footer 保留单一的「查看完整图表 ↗」跳转入口，顶部 Header 仅保留关闭按钮（`✕`），避免双入口冗余造成视觉混淆。
- **插件配置开关（默认开启）**：在 `komari-plugin.json` 的 `configuration.data` 中提供 `enable_floating_widget` 布尔选项，默认值为 `true`（启用），允许管理员在插件设置中自由关闭前台浮出层。

---

## 二、时区与日期计算规范（Timezone & Date Conventions）

### 1. 节点到期时间（`expired_at`）提取重置日
- **正则优先原则**：由于本地运行时时区各异（如美西 PDT `-07:00`），直接使用 `new Date("YYYY-MM-DD").getDate()` 会导致日期产生 `-1` 天漂移（例如 `2027-10-22` 变为 `21` 号）。
- **必须优先使用正则**提取字符串中的年月日：
  ```javascript
  const match = String(expiredAt).match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (match) {
    day = parseInt(match[3], 10);
  }
  ```
- 时间戳兜底时，必须结合 `getUTCDate()` 以免受西区时区干扰。

### 2. 本地日期格式化与小月末边界
- **禁止对本地 Date 对象使用 `toISOString().split("T")[0]` 来输出周期文本**：
  在东区（如东八区 `+08:00`），`2026-10-22 00:00:00` 调用 `toISOString()` 会倒退 8 小时变为 `2026-10-21T16:00:00Z`，导致界面显示错开 1 天。必须使用 `formatDateToYMD(date)`。
- **小月（30天）与二月月末判断**：
  对于配置 31 日重置的节点，小月末日（如 4 月 30 日、2 月 28 日）必须能正确进入新周期，计算周期开始的判断条件必须使用：
  ```javascript
  const actualResetDayThisMonth = Math.min(safeResetDay, maxDayThisMonth);
  if (currentDate >= actualResetDayThisMonth) { ... }
  ```

### 3. 自定义统计时区偏移规范 (Timezone Offset)
- 插件在 `komari-plugin.json` 中提供了 `timezone_offset` 配置（默认 `8` 即东八区 UTC+8，单位为小时）。
- 计算账单周期（`calculateBillingCycle`）、生成走势图序列（`buildCycleSeries`）、定时采样（`recordSample`）以及前端按日聚合（`aggregateDailyFromRecords`）均统一基于 `timezone_offset` 进行绝对时间戳对齐，彻底规避宿主机操作系统或 Docker 容器的本地时区干扰。

---

## 三、代码结构与多端同步规范

修改计算与推算逻辑时，必须**同时同步**以下文件：
1. `src/forecast.ts`：TypeScript 源码定义；
2. `script.js`：插件在 Komari Goja 运行时中直接加载的主脚本；
3. `pages/admin.html`：插件前端交互与 Canvas 可视化页面。

### 4. 服务端 HTTP 响应与连接终止规范（Goja HTTP Response Conventions）
- **必须显式调用 `res.end()`**：
  Komari 的后端插件运行在基于 Goja 的 JS 运行时中。在 `sendJSON(res, data, statusCode)` 或任何自定义路由处理中，必须显式调用 `res.end(JSON.stringify(data))` 彻底关闭 HTTP 响应流。
  若遗漏 `res.end()`，底层 HTTP 连接不会被关闭并无限挂起，导致前台悬浮小组件与看板公开页请求 `/api/plugin/net-forecast/overview` 时一直处于 Loading 卡死状态并最终超时报错。

---

## 四、版本发布与打包流程（Release & Git Workflow - 关键守则）

### 【核心红线原则】严禁未经用户明确指示自动发布新版本（No Auto Release Without User Command）
1. **日常开发严禁自动发版与打 Tag**：
   - 在后续的日常代码修改、特性开发或问题修复中，**绝对不要自动发布新版本**（严禁擅自递增版本号、严禁创建 Git Tag、严禁推送 Tag）。
   - **只有当用户明确指示“发布版本”或“发布新版本”时，才允许执行版本发布流程**。
2. **每次 Push 前必须在本地打包 ZIP 供用户测试，确认 OK 后方可 Push**：
   - 每次代码修改完成后，在执行 `git push` 前，**必须先在本地打包生成 ZIP**：
     ```bash
     rm -f net-forecast.zip
     zip -r net-forecast.zip komari-plugin.json script.js pages assets README.md LICENSE
     ```
   - 打包后，向用户汇报修改内容，并提供本地 ZIP 文件链接（格式：`[net-forecast.zip](file:///Users/leovannys/github/Komari-Plugin-NetForecast/net-forecast.zip)`），明确提醒用户进行本地/测试环境验证。
   - **严格等待用户确认**：只有在用户明确回复“测试通过”、“确认 OK”、“可以 push”等许可后，方可执行 `git push`（推送到 `main` 分支，不带 Tag）。
   - 未经用户测试与明确确认，**绝不擅自 push 代码**。
3. **正式发版时的中英文 Release 总结规范（Bilingual Release Notes）**：
   - 当用户明确下达发版指令后，每次发布新版本时，必须在 GitHub Release 页面（以及向用户的交付报告中）**同时使用中文与英文**全面、详尽地总结本次版本的变更内容（包括新增特性 Features、问题修复 Bug Fixes、优化改进 Improvements），严禁使用单语或简略含糊的说明。

---

### 1. 日常开发与修改提交流程（Dev & Test Flow）
1. **代码修改与本地校验**：
   - 修改对应文件（如 `script.js`, `pages/admin.html`, `pages/public.html`, `src/forecast.ts` 等）。
   - 运行本地语法与逻辑校验（如 `osascript -l JavaScript ...`）。
2. **本地打包与自测 ZIP 生成**：
   ```bash
   rm -f net-forecast.zip
   zip -r net-forecast.zip komari-plugin.json script.js pages assets README.md LICENSE
   ```
3. **交付用户测试验收**：
   - 汇报变更清单。
   - 提供本地 ZIP 链接：`[net-forecast.zip](file:///Users/leovannys/github/Komari-Plugin-NetForecast/net-forecast.zip)`。
   - **停下等待**用户在 Komari 实例中手动上传测试并给出反馈。
4. **用户确认后推送代码（纯代码推送，不发版本）**：
   - 收到用户明确确认后，使用 MCP `git` 工具提交并推送到 `main` 分支（注意：**绝不推送 Tag**，仅 push main 分支）：
     - `git_add`: 暂存修改的文件；
     - `git_commit`: 规范的提交信息；
     - `git_push`: 仅推送到 `main` 分支，保持工作区和远端同步，不触发 release 流水线。

---

### 2. 正式版本发布流程（Release Flow - 仅在用户明确指令时触发）
当且仅当用户明确下达发版指令（如“发布新版本”、“发版 v...”）时，按以下严格步骤执行：

1. **版本号命名与递增规范（Versioning Rules - 严格遵守）**：
   - **基础格式（遵循 SemVer 三段式标准 `Major.Minor.Patch`）**：
     - 由于 Komari 核心插件管理面板采用标准语义化版本解析器，**无法识别第 4 位小版本**（如 `26.10.08.1` 会被截断或无法触发更新）。
     - 统一采用 **`年.月日.小版本`** 的三段式格式（Git Tag 统一带 `v` 前缀：**`v年.月日.小版本`**）：
       - 第 1 段（Major）：年份后两位，如 `26`
       - 第 2 段（Minor）：4 位月日，如 `1008`（表示 10 月 08 日）
       - 第 3 段（Patch）：当天的小版本修订号，如 `1`、`2`、`3`
     - 示例：
       - 2026年10月08日当天第 1 个版本：`26.1008.1`（Git Tag: `v26.1008.1`）
       - 隔天（如 10月09日）发布版本：`26.1009.1`（Git Tag: `v26.1009.1`）
   - **同日多版本递增规范**：
     - 同一天内发布的后续版本，**仅递增第 3 段的修订数字（Patch）**，保持第 2 段月日（Minor）与当天实际日期严格一致。
   - **文件多处同步**：
     版本号必须在以下位置严格对齐：
     1. `package.json` 中的 `version` 字段（如 `"26.1009.1"`）
     2. `komari-plugin.json` 中的 `version` 字段（如 `"26.1009.1"`）
     3. Git Tag（必须带有 `v` 前缀，如 `v26.1009.1`）

2. **重新构建正式发布包**：
   ```bash
   rm -f net-forecast.zip
   zip -r net-forecast.zip komari-plugin.json script.js pages assets README.md LICENSE
   ```

3. **Git 提交并创建 Tag**：
   - 提交版本号变更：`chore(release): bump version to vX.Y.Z`；
   - 创建对应 Tag：`vX.Y.Z`。

4. **推送主分支与 Tag 触发 GitHub Actions 流水线**：
   - 使用 MCP `git_push` 推送 `main` 分支及 Tag：`refs/tags/vX.Y.Z:refs/tags/vX.Y.Z`。
   - **v1.json 自动回写流水线保障（无需人工介入）**：
     - `.github/workflows/release.yml` 内置自动更新步骤。
     - GitHub Actions 创建 Release 后，会**自动计算线上包的真实 SHA256**，自动更新根目录下的 `v1.json` 并由 `github-actions[bot]` 提交推送到 `main` 分支。
     - **严禁开发者/Agent 手动计算 SHA256 并二次提交 `v1.json`**，发布完成后只需在本地执行 `git pull origin main` 同步即可。

5. **发布中英双语 Release 总结（Bilingual Release Notes - 自动发布至 GitHub Release）**：
   - 每次发版时，必须在根目录下维护 `RELEASE_NOTES.md`，并在其中写入详尽的中英双语变更说明。
   - GitHub Actions 流水线中 `softprops/action-gh-release` 已配置 `body_path: RELEASE_NOTES.md`，Tag 推送后会自动将该文件作为 GitHub Release 的页面正文直接发布，无需人工手动复制粘贴！
   - 中英双语更新日志结构：
     ```markdown
     ## 🇨🇳 中文更新日志 (Changelog - zh_CN)
     ### 🚀 新增功能 (Features)
     - ...
     ### 🐛 问题修复 (Bug Fixes)
     - ...
     ### ⚡ 优化与改进 (Improvements)
     - ...

     ---

     ## 🇬🇧 English Changelog (en)
     ### 🚀 Features
     - ...
     ### 🐛 Bug Fixes
     - ...
     ### ⚡ Improvements
     - ...
     ```

---

## 五、前端浮出层（Floating Widget）注入与交互避坑守则（Frontend Injected JS & Interaction Guidelines）

### 1. 模板字符串零反斜杠原则（Zero-Backslash Hazard - 致命红线）
- **现象与根因**：
  `WIDGET_BODY_HTML` 采用 ES6 反引号（`` ` ``）模板字符串定义。在 Goja/Node 运行时求值该模板字符串时，所有的反斜杠转义都会被提前剥离（例如 `\/` 变成 `/`、`\?` 变成 `?`）。
  若在注入的客户端代码中写了正则表达式 `replace(/^#\/?/, "")`，求值后会变成 `replace(/^#//?, "")`，生成 `//` 行注释，将后续代码及括号完全吞噬，导致浏览器抛出 `SyntaxError` 并在页面初始化时提前崩溃，表现为**浮窗按钮消失、无法拖拽或点击事件全部失效**。
- **强制约束**：
  - `WIDGET_BODY_HTML` 内部的客户端 JS 代码**严禁使用任何带有反斜杠的正则表达式**。
  - 路径、Hash、Query 的提取与处理必须 **100% 采用纯原生字符串方法**（如 `split('/')`、`indexOf()`、`slice()`、`split('-').join('')`）。

### 2. CSS 样式表定位与拖拽冲突（CSS Specificity vs Drag Inline Styles）
- **现象与根因**：
  若在样式表规则 `#nf-floating-widget .nf-trigger-sq` 中写死 `right: 28px !important; bottom: 28px !important;`，会导致用户在拖拽按钮时，JS 计算并赋予的 `left` / `top` 行内样式被样式表里的 `right/bottom !important` 强行锁死，造成按钮无法移动。
- **强制约束**：
  - 样式表中仅声明 `position: fixed !important;`，绝不写死 `right` / `bottom` 的具体数值。
  - 初始位置完全交由 JS 的 `loadSavedPos()` 在运行时动态赋初值；拖拽中设置 `left: ... !important; top: ... !important; right: auto !important; bottom: auto !important;`。

### 3. 单节点 Instance 路由匹配鲁棒性（Robust Instance Matching）
- **现象与根因**：
  拼接路径与 Hash 时若引入多余空格（如 `pathname + " " + hash`），会导致提取的 ID 带有尾随空格（如 `"uuid "`），从而导致严格等值比对 `===` 失败；硬编码长度限制（如 `cand.length >= 8`）会导致短 ID 或别名节点无法识别。
- **强制约束**：
  - 路径与参数提取必须分别使用 `.trim()` 与 `decodeURIComponent()`。
  - 采用多级匹配策略 `findMatchingNode(nodes, targetId)`：精确匹配（`id` / `uuid` / `name`）-> 忽略连字符匹配 -> 短 UUID 前缀匹配。

### 4. 单节点与全节点筛选状态解耦（Decoupled Filtering）
- **现象与根因**：
  处于 Instance 页面时，不能在 `renderList()` 中强行锁死其他筛选按钮，否则会导致「全部」、「预警」、「安全」药丸在单节点页面失效。
- **强制约束**：
  - Instance 页面下动态呈现 `📌 当前 (1)` 专属药丸，默认激活并聚焦该单节点；
  - 同时保留全部药丸（全部、预警、正常、免额），点击任意药丸均可切换到全局状态进行过滤，互不冲突。

### 5. 拖拽与点击事件防冲突（PointerCapture & Event Protection）
- **现象与根因**：
  浮窗按钮同时支持拖动与点击展开。SVG 子元素若无保护，可能拦截 pointer 事件导致 target 错位。
- **强制约束**：
  - 图标内所有子元素强制设置 `#nf-floating-widget .nf-trigger-sq * { pointer-events: none !important; }`；
  - 采用实测验证的 `pointerdown` / `pointermove` / `pointerup` 结合位移阈值（`Math.abs(dx) > 4` 判定拖拽，未拖拽触发 `toggle()`），辅以 `click` 作为安全保底。
