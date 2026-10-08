# Komari 插件：NetForecast (网络流量预测与限额预警)

面向 Komari 监控面板的网络流量预测插件。

## 🌟 功能特性

1. **多周期进出站增量图表 (1 / 7 / 30 天)**：
   - 使用 Canvas 绘制高性能堆叠柱状图（Stacked Bar Chart）。
   - 区分入站流量（Inbound / 蓝紫色）与出站流量（Outbound / 青绿色），直观展示各节点每日新增流量体量。
2. **当月账单周期累计折线图 (Cumulative Line)**：
   - 在柱状图上方叠加橙金色累计流量折线，实时呈现当月从重置日起累积消耗的走势。
3. **重置日流量耗尽预测 (Forecasting Engine)**：
   - 自动识别或自定义每个节点的账单重置日期（1~31日）。
   - 基于近 7 天加权移动平均速率（Weighted Run-rate），精准推算到达重置日时可能的入站、出站及总消耗数值。
   - 图表右侧在当前日期之后自动延伸橙色虚线，直观展示到达重置日的预测走势。
4. **配额超限预警体系 (Exhaustion Alerts)**：
   - 支持为每个节点设置流量配额（Quota，如 1000 GB）。
   - 若预测在重置日前耗尽配额，自动显示红色高危告警横幅（包含预计耗尽天数、预计耗尽日期以及超标量）。
   - 若预测将达到 90% 阈值，显示黄色预警提示。
5. **灵活的节点限额与重置日配置**：
   - 可在插件界面中随时点击“⚙️ 限额配置”对各节点的配额（GB）和重置日期进行调整，即时生效并持久化存储于 `__storageDir__`。

---

## 📁 项目目录结构

```text
Komari-Plugin-NetForecast/
├── komari-plugin.json      # 插件清单 (声明权限、配置项与管理页面)
├── script.js               # Goja 运行时入口核心逻辑
├── pages/
│   └── admin.html          # 管理后台内置可视化仪表盘 (Canvas 复合图表)
├── assets/
│   └── icon.svg            # 插件图标
├── src/
│   ├── plugin.ts           # TypeScript 源码入口
│   ├── forecast.ts         # 账单周期与流量预测算法模块
│   ├── storage.ts          # 本地数据持久化与历史聚合管理器
│   └── types.ts            # 类型定义
├── komari.local.json       # 本地热重载连接凭据 (已在 .gitignore 中忽略)
├── net-forecast.zip        # 一键安装分发包
├── package.json            # 项目配置与脚本
└── tsconfig.json           # TypeScript 配置
```

---

## 🚀 安装与调试

### 方式 1：热重载实时调试 (开发模式)
已预先配置好 `komari.local.json`，在本地安装依赖后运行：
```bash
npm install
npm run dev
```
修改 `src/` 或 `pages/admin.html` 时，插件会自动打包、上传至实例 (`https://komari.leohou.org`) 并重新载入，终端实时输出日志。

### 方式 2：管理后台手动上传 ZIP
根目录下已生成 [net-forecast.zip](file:///Users/leovannys/github/Komari-Plugin-NetForecast/net-forecast.zip)：
1. 登录你的 Komari 管理后台：`https://komari.leohou.org/admin/`
2. 进入 **插件管理 (Plugins)**。
3. 点击 **上传插件**，选择项目根目录下的 `net-forecast.zip`。
4. 上传完成后在插件列表中找到 **NetForecast (网络流量预测)** 并点击启用。
5. 在左侧菜单或设置中即可看到 **流量预测** 管理页面。
