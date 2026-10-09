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

---

## 三、代码结构与多端同步规范

修改计算与推算逻辑时，必须**同时同步**以下文件：
1. `src/forecast.ts`：TypeScript 源码定义；
2. `script.js`：插件在 Komari Goja 运行时中直接加载的主脚本；
3. `pages/admin.html`：插件前端交互与 Canvas 可视化页面。

---

## 四、版本发布与打包流程（Release & Git Workflow - 关键守则）

### 1. 版本号命名与递增规范（Versioning Rules - 严格遵守）
- **基础格式（遵循 SemVer 三段式标准 `Major.Minor.Patch`）**：
  - 由于 Komari 核心插件管理面板采用标准语义化版本解析器，**无法识别第 4 位小版本**（如 `26.10.08.1` 会被截断或无法触发更新）。
  - 因此统一采用 **`年.月日.小版本`** 的三段式格式（Git Tag 统一带 `v` 前缀：**`v年.月日.小版本`**）：
    - 第 1 段（Major）：年份后两位，如 `26`
    - 第 2 段（Minor）：4 位月日，如 `1008`（表示 10 月 08 日）
    - 第 3 段（Patch）：当天的小版本修订号，如 `1`、`2`、`3`
  - 示例：
    - 2026年10月08日当天第 1 个版本：`26.1008.1`（Git Tag: `v26.1008.1`）
    - 当天第 2 个修复版本：`26.1008.2`（Git Tag: `v26.1008.2`）
    - 隔天（如 10月09日）发布版本：`26.1009.1`（Git Tag: `v26.1009.1`）
- **同日多版本递增规范**：
  - 同一天内发布的后续版本，**仅递增第 3 段的修订数字（Patch）**，保持第 2 段月日（Minor）与当天实际日期严格一致。
- **文件多处同步**：
  版本号必须在以下位置严格对齐：
  1. `package.json` 中的 `version` 字段（如 `"26.1008.1"`）
  2. `komari-plugin.json` 中的 `version` 字段（如 `"26.1008.1"`）
  3. Git Tag（必须带有 `v` 前缀，如 `v26.1008.1`）
  4. 根目录 `v1.json` 及提交到市场 Issue 中的 Version、下载链接

### 2. 本地打包与构建
1. 更新版本号：根据上述规则同步更新 `package.json` 和 `komari-plugin.json` 中的 `version` 字段。
2. 本地验证打包：
   ```bash
   rm -f net-forecast.zip
   zip -r net-forecast.zip komari-plugin.json script.js pages assets README.md LICENSE
   ```

### 3. Git 提交、Tag 检查与自动发布（全自动回写 v1.json）
- 提交所有代码修改：
  ```bash
  git add .
  git commit -m "feat/fix: <description>"
  ```
- **创建并推送对应的 Git Tag**（例如 `v26.10.08.1`）：
  - 必须打上 `v*` 格式的 tag 并推送到 GitHub，仓库的 `.github/workflows/release.yml` 才会触发自动发布流水线。
- **推送验证要求（重要！）**：
  - macOS 沙箱环境下，若未配置 SSH 信任文件，常规 push 可能会报错 `hostkeys_foreach failed for ~/.ssh/known_hosts: Operation not permitted` 或出现无响应静默假象。
  - 推送时必须指定安全参数：
    ```bash
    GIT_SSH_COMMAND="ssh -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no" git push origin main --tags
    ```
  - **推送后必须显式校验**：通过运行 `git ls-remote --tags origin`，确认该 tag 确实已被 GitHub 接收，绝不能在未验证的情况下宣告发布成功。
- **v1.json 自动回写流水线保障（无需人工介入）**：
  - `.github/workflows/release.yml` 已经内置了自动更新步骤。
  - GitHub Actions 创建 Release 后，会**自动计算线上包的真实 SHA256**，自动更新根目录下的 `v1.json` 并由 `github-actions[bot]` 提交推送到 `main` 分支。
  - **严禁开发者/Agent 手动计算 SHA256 并二次提交 `v1.json`**，发布完成后只需在本地执行 `git pull origin main` 同步即可。

### 4. 插件市场提交与专属订阅源规范（Komari Plugin Market）
- **本地没有、也不需要维护 `komari-plugin-market` 仓库目录**：
  官方插件市场的上架和版本更新机制是向 [komari-plugin-market](https://github.com/komari-monitor/komari-plugin-market) 提交 GitHub Issue。
- **专属插件源 `v1.json` 规范（穿透 CDN 缓存）**：
  - 本仓库根目录维护的 `v1.json` 为单插件专用市场源。
  - 引用与订阅该文件时，**必须使用带 `refs/heads/main` 的完整路径**：
    `https://raw.githubusercontent.com/livingfree2023/Komari-Plugin-NetForecast/refs/heads/main/v1.json`
    普通 `.../main/v1.json` 容易命中 GitHub Fastly CDN 的陈旧缓存，而使用 `refs/heads/main` 能确保 Komari 面板或用户拉取时 100% 拿到最新提交的版本。
- 每次发布新版本后，向用户输出清晰的 Market Issue 提交模板，包括：
  - 插件名称：`NetForecast (流量预测)`
  - 版本号（Version）：`x.y.z` 或 `x.y.z.n`
  - 仓库地址：`https://github.com/livingfree2023/Komari-Plugin-NetForecast/`
  - 专属订阅源：`https://raw.githubusercontent.com/livingfree2023/Komari-Plugin-NetForecast/refs/heads/main/v1.json`
