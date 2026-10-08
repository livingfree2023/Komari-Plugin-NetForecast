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
- **基础格式**：
  - 发布版本号与 Git Tag 统一遵循 **`v年.月.日`** 格式（例如 2026年10月08日 即为 `v26.10.08`，在 `package.json` / `komari-plugin.json` 中写为 `26.10.08`）。
- **同日多版本递增规范（严禁修改“日”部分）**：
  - 如果同一天内发布了多个修复或迭代版本，**绝对不能通过修改“日”的数字来升级版本号**（例如禁止将 10月8日 发布的第二个版本改名为 `26.10.09` 或 `26.10.10`，这样会导致版本号脱离真实日期）。
  - **同一天发布多个版本的正确格式**：在日期后面追加修订序号 `.1`、`.2`：
    - 当天第 1 个版本：`v26.10.08`（配置文件内为 `26.10.08`）
    - 当天第 2 个版本：`v26.10.08.1`（配置文件内为 `26.10.08.1`）
    - 当天第 3 个版本：`v26.10.08.2`（配置文件内为 `26.10.08.2`）
    - 以此类推，**仅递增末尾的序号数字**，保持开头的“年.月.日”与实际发布当天日期严格一致。
- **文件多处同步**：
  版本号必须在以下位置严格对齐：
  1. `package.json` 中的 `version` 字段
  2. `komari-plugin.json` 中的 `version` 字段
  3. Git Tag（必须带有 `v` 前缀，如 `v26.10.08.1`）
  4. 提交到市场 Issue 中的 Version、下载链接及 SHA256 校验码

### 2. 本地打包与构建
1. 更新版本号：根据上述规则同步更新 `package.json` 和 `komari-plugin.json` 中的 `version` 字段。
2. 打包分发包：
   ```bash
   rm -f net-forecast.zip
   zip -r net-forecast.zip komari-plugin.json script.js pages assets README.md LICENSE
   ```
3. 计算并输出 SHA256：
   ```bash
   shasum -a 256 net-forecast.zip
   ```

### 3. Git 提交与 Tag 检查（防止发布落空）
- 提交所有修改，严禁遗漏任何核心文件。
- **必须打对应的 Git Tag**（例如 `v26.10.08.1`）：
  - 只有打上 `v*` 格式的 tag 并推送到 GitHub，仓库的 `.github/workflows/release.yml` 才会触发自动创建 GitHub Release 并附加 `net-forecast.zip`。
- **推送验证要求（重要！）**：
  - macOS 沙箱环境下，若未配置 SSH 信任文件，常规 push 可能会报错 `hostkeys_foreach failed for ~/.ssh/known_hosts: Operation not permitted` 或出现无响应静默假象。
  - 推送时若使用 SSH，必须指定安全参数：
    ```bash
    GIT_SSH_COMMAND="ssh -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no" git push origin main --tags
    ```
  - **推送后必须显式校验**：通过检查远程 ref 或运行 `git ls-remote --tags origin`，确认该 tag 确实已被 GitHub 接收，绝不能在未验证的情况下宣告发布成功。

### 4. 插件市场提交规范（Komari Plugin Market）
- **本地没有、也不需要维护 `komari-plugin-market` 仓库目录**：
  官方插件市场的上架和版本更新机制是向 [komari-plugin-market](https://github.com/komari-monitor/komari-plugin-market) 提交 GitHub Issue。
- 每次发布新版本后，应向用户输出清晰的 Market Issue 提交模板，包括：
  - 插件名称：`NetForecast (流量预测)`
  - 版本号（Version）：`x.y.z`
  - 仓库地址：`https://github.com/livingfree2023/Komari-Plugin-NetForecast/`
  - SHA256 校验和：`[生成的 64 位 hash]`
