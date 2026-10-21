# Komari 插件：NetForecast (网络流量预测与限额预警)

> 面向 [Komari 监控面板](https://github.com/komari-monitor) 的全节点网络流量智能预测与多模式计费限额告警插件。

![NetForecast Dashboard Preview](https://raw.githubusercontent.com/livingfree2023/Komari-Plugin-NetForecast/main/assets/preview.svg)

> **TL;DR**：根据 7 天内流量新增量加权平均预测每个月流量是否超限，支持 Komari 内部节点配置的计费类型和限制。（因为 Komari 的数据库并不保存每日流量，所以安装插件之后才能开始统计，要准确预测需要至少安装 7 天后）。

[![Release](https://img.shields.io/github/v/release/livingfree2023/Komari-Plugin-NetForecast?color=6366f1&label=Release)](https://github.com/livingfree2023/Komari-Plugin-NetForecast/releases)
[![License](https://img.shields.io/badge/License-MIT-10b981.svg)](https://github.com/livingfree2023/Komari-Plugin-NetForecast/blob/main/LICENSE)
![Komari Compatibility](https://img.shields.io/badge/Komari%20Plugin-v1.1%2B-38bdf8.svg)

---

## 🌟 核心功能亮点

- 📊 **账单周期全景监控**：以节点每月重置日为时间基准覆盖完整计费月，单页平铺展示全节点的每日进出站增量堆叠柱状图与计费累计走势。
- ⚡ **当日流量实时呈现**：自适应计算今日 00:00 截至当前时刻的实时增量，精准反映当天最新消耗（Tooltip 标注 `今日实时`）。
- ⚖️ **5 种计费统计模式自适应**：
  - `sum`：双向求和（入站 + 出站）
  - `max`：双向取大（`MAX(入站, 出站)`）
  - `min`：双向取小（`MIN(入站, 出站)`）
  - `upload` / `up`：仅计出站（出网流量）
  - `download` / `down`：仅计入站（入网流量）
  - *图表智能视觉区分：计费流量高亮显示，非计费流量自动半透明弱化。*
- 🔄 **内核重置自适应（Counter Reset Detection）**：彻底解决 VPS/网卡重启导致 Linux `/proc/net/dev` 内核计数器清零后的流量统计异常。摒弃多层复杂回退与魔法阈值，引入标准重置检测机制（相邻采样点 `curr < prev` 时自动判定为重启并正向累加），单日多次重启亦能全额准确捕捉，不丢包、不漏计。
- 🛡️ **高并发限流保护与故障自愈 (Concurrency Limit & Retry)**：
  - **4 并发分批调度**：针对单核轻量 VPS 深度优化，拉取 30 天时序历史时引入 `mapConcurrent` 并发限制与自适应超时控制，杜绝 SQLite/核心数据库瞬间拥堵打满。
  - **故障卡片视觉警示**：针对查询超时的节点，卡片顶部自动呈现状态告警徽标与横幅说明，并保留实时网卡读数。
  - **单节点/批量一键重试**：卡片提供独立的 `[🔄 重试此节点]`，顶部提供 `[🔄 重试失败节点 (N)]`，支持按需针对失败节点以低并发长超时平滑重试，成功后自动清除警报。
  - **故障节点一键筛选**：筛选栏动态注入 `⚠️ N 个时序拉取失败` 胶囊，方便快速聚焦异常机器。
- 📥 **一键导出纯文本诊断 JSON 与静态 URL（AI Agent 友好）**：
  - **静态接口直取**：提供固定端点 `/api/plugin/net-forecast/export.json`（及别名 `/debug.json`、`/debug`），AI Agent 与外部脚本可直接通过 HTTP GET 读取，无需用户手动下载文件。
  - **操作栏一键复制**：看板底部提供「📋 复制诊断 URL」与「📥 导出诊断数据 (JSON)」双操作，轻量便捷。
  - **3 分钟内存快照与抗 DoS 保护**：静态接口默认提供 180 秒内存快照缓存与 60 秒刷新互斥锁，内存命中响应耗时 `<1ms` 且 0 次数据库 I/O 查询，完全杜绝多并发请求压垮单核 VPS 核心数据库的风险。
- 📈 **全周期平滑无折角折线**：账单周期折线引入基准底数平滑对齐算法，彻底消除网卡累计与日打点存在差额时今日折线产生的 90 度垂直突变折角，左右严格对齐重置周期。
- 🗓️ **账单周期自动对齐**：自动同步节点到期日（`expired_at`）作为每月重置日（如 8 号到期即每月 8 号重置，未配置时自动按自然月 1 号重置）。
- 🌐 **时区自由配置 (Timezone Offset)**：支持在插件设置中自定义统计基准时区（默认 UTC+8 北京时间，偏移量可配置）。日切片与重置日计算完全自适应配置时区，彻底免除修改 VPS 系统或 Docker 容器时区的繁琐操作。
- 🔮 **智能耗尽推算与阈值告警**：基于 7 天加权移动均速平滑推算重置日总消耗，提前预测流量超标并在耗尽时提供精确倒计时天数。
- 🪟 **前台自适应悬浮小组件 (Floating Widget)**：
  - **轻量微交互**：右下角常驻 48×48 方形状态图标，正常显示翠绿光边，节点告警时智能切换为红色脉冲警报光圈。
  - **跟随当前页面主题**：运行时读取宿主页面与节点卡片的计算样式，通过浮窗根节点上的 `--nf-*` 变量同步字体/字号、明暗、底色/背景图、文字/强调色、四边边框、圆角与阴影。浮窗主体接近页面背景，服务卡片接近节点卡片，标题栏和状态栏透出主体背景；不向宿主节点卡片注入内容。
  - **动态适配与隔离**：响应主题切换、系统明暗、SPA 路由、窗口变化及宿主重渲染。缓存取样元素，排除插件自身与菜单/弹层；限量发现、合并更新，避免定时全页扫描。取样不足时使用清晰可读的默认样式。
  - **自由拖拽与位置记忆**：支持原生触控与鼠标平滑拖拽停靠，松手后自动记忆位置（`localStorage` 持久化），刷新不跑偏。
  - **单节点详情自动聚焦**：访问 `https://your-komari/instance/:uuid` 实例页时，浮窗自动聚焦展示当前节点指标；同时保留全部药丸（`📌 当前`、`全部`、`预警`、`安全`、`免额`），点击任意药丸可无缝切换全局筛选。
  - **卡片一键直达详情**：点击小组件内的任意节点卡片，智能适配 Hash/Path 路由一键跳转进入对应实例的 `/instance/:uuid` 详情页。
  - **后台自动免打扰**：进入 `/admin/*` 后台管理区域时自动静默隐藏，不在管理视图中产生任何视觉干扰；支持在插件设置中一键开启/关闭。
- 💨 **SWR 本地秒开与骨架屏**：废除全屏阻断遮罩，页面刷新 0 毫秒瞬间还原图表与数据，后台无感静默同步；首次访问呈现平滑微光骨架屏，保障界面极致流畅。
- ⚙️ **直连核心数据库**：在卡片右上角点击「设置限额」，直接持久化回写至 Komari 核心数据库，无插件层私有缓存。
- 💾 **极轻量日结存储**：后台仅按天归结每日一条极简时序，内置 90 天自动滑动清理，百台节点总存储不足 1 MB。

---

## 🚀 快速安装与使用

### 方式一：通过专属插件源订阅安装（推荐 · 实时获取最新版）

在 Komari 插件市场设置中添加本仓库专属的自定义插件源订阅地址（直连 `refs/heads/main`，穿透 GitHub CDN 缓存，确保第一时间获取最新版本）：
```text
https://raw.githubusercontent.com/livingfree2023/Komari-Plugin-NetForecast/refs/heads/main/v1.json
```

### 方式二：通过 Komari 官方插件市场安装（每 6 小时同步一次）

1. 登录您的 Komari 管理后台。
2. 导航至左侧 **插件市场 (Plugin Market)**。
3. 在搜索框中输入 **`NetForecast`** 或 **`流量预测`**。
4. 找到插件后点击 **安装 (Install)**，系统将自动从官方市场目录拉取版本并一键安装。
5. 安装完成后在「插件管理」中点击 **启用**，左侧菜单即会出现 **流量预测** 仪表盘入口。

### 方式三：从 GitHub Releases 手动上传安装

1. 前往本仓库 [Releases 页面](https://github.com/livingfree2023/Komari-Plugin-NetForecast/releases) 下载最新版本的 **`net-forecast.zip`**。
2. 登录您的 Komari 管理后台，进入 **插件管理 (Plugins)**。
3. 点击右上角 **上传插件**，选择下载好的 `net-forecast.zip`。
4. 上传完成后点击启用即可。

**第一次使用需要手动开启**

![开启插件示例](https://cdn.nodeimage.com/i/Cqn5ypYEZrgTOAHKFMWJwOWmGbXdNsKo.png)

---

## 🛠️ 自行构建

实际插件入口为 `script.js`（Komari Goja 直接加载），浮窗的 CSS 和客户端脚本分别位于 `WIDGET_HEAD_HTML` / `WIDGET_BODY_HTML`。`npm run build` 编译 `src/` 到 `dist/`，不会生成或替换此浮窗入口。

安装开发依赖后运行检查：
```bash
npm install
npm test
npx playwright install chromium
npm run test:browser
npm run check
npm run build
```

浏览器测试使用独立的宿主页面与接口夹具，不连接或修改实际 Komari 实例。截图输出到忽略提交的 `test-results/`；可通过 `NF_CHROMIUM_PATH` 指定已有 Chromium，通过 `NF_TEST_OUTPUT` 指定输出目录。验证范围、已知基线构建错误及手动验收项见下方「浮窗主题验证与限制」。

如需对源码进行二次开发并手动打包（先移除旧 ZIP，避免残留条目）：
```bash
rm -f net-forecast.zip
npm run package
```

---

每次完成一批修改并交付测试包时，将当前版本号最末位递增 1，同步项目版本与插件清单；正式发布仍需明确指示。本地验收通过前不推送、不打 Tag。

## 浮窗主题验证与限制

本次本地验证日期：2026-10-20，测试包版本为 `26.1020.2`。

- `npm test`：2 项通过，覆盖主脚本及求值后的浏览器脚本语法、模板反斜杠约束、全部 CSS 选择器的浮窗作用域。
- `npm run test:browser`：5 项通过。视口为 1360×1000（桌面）、390×844（手机），另用 1200×900 和 1000×800 检查变体。覆盖浅→深→浅及系统明暗切换、蓝色网格页面、渐变和 URL 背景图、四边不同宽度/线型/颜色、零圆角/无阴影、字体/字号、透明表面兜底、样式表变化、宿主容器主题属性、SPA 路由与节点替换、延迟插入。
- 保留交互回归：展开/关闭、Esc、拖拽与位置存储、当前/全部/告警筛选、后台隐藏及返回前台。断言标题栏、KPI、筛选栏、状态栏顺序和间距，以及拖动后面板不超出视口。宿主节点选择器没有新增或修改；当前浮窗使用筛选药丸，没有内置节点下拉菜单。
- 性能与隔离回归：浮窗内部连续更新不触发主题发现；空态宿主批量插入合并为延迟发现；宿主样式不被回写。通常只重读缓存取样元素；每次发现最多遍历 600 个元素、评估 60 个候选，跳过插件及菜单/弹层；更新合并且间隔至少 1 秒，无卡片时的插入发现间隔至少 5 秒，没有定时全页扫描。
- 已实际查看桌面/手机的浅色、深色及手机拖动截图；输出为 `test-results/light-1360.png`、`dark-1360.png`、`light-390.png`、`dark-390.png`、`drag-390.png` 等。

`npm run check` 和 `npm run build` **未通过**：现有 TypeScript 基线有 12 条诊断，分别涉及 `tzOffsetHours` 未定义、参数个数、`totalUp/totalDown` 类型、配置对象推断为空对象，以及 Node 类型声明缺失。本次未修改 `src/` 或 `tsconfig.json`，已在独立临时目录用 HEAD 源码复现完全相同的诊断；结果保存在 `test-results/typescript-check.txt`。ZIP 使用直接加载的 `script.js`，不包含失败构建生成的 `dist/`。

仍需在实际 Komari 测试环境上传 ZIP 后验收：各已安装主题及其真实节点/路由、浏览器原生下拉弹层、真实 API 和 Goja 注入。自动检查使用独立夹具，不能代表所有第三方主题。取样以可见 DOM 元素的计算样式为准；伪元素、Canvas、跨域 iframe 背景及纯 CSSOM 规则修改未自动覆盖。背景图亮暗复杂时，基于底色的文字对比度保护不能代替目测；这类主题还应检查文字可读性。无法可靠发现宿主表面时会使用默认样式。

## 📄 开源许可证

本项目基于 [MIT License](https://github.com/livingfree2023/Komari-Plugin-NetForecast/blob/main/LICENSE) 协议开源。
