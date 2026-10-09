# Komari 插件：NetForecast (网络流量预测与限额预警)

> 面向 [Komari 监控面板](https://github.com/komari-monitor) 的全节点网络流量智能预测与多模式计费限额告警插件。

<p align="center">
  <img src="assets/preview.svg" alt="NetForecast Dashboard Preview" width="100%" />
</p>

<p align="center">
  <a href="https://github.com/livingfree2023/Komari-Plugin-NetForecast/releases"><img src="https://img.shields.io/github/v/release/livingfree2023/Komari-Plugin-NetForecast?color=6366f1&label=Release" alt="Release"></a>
  <img src="https://img.shields.io/badge/License-MIT-10b981.svg" alt="License">
  <img src="https://img.shields.io/badge/Komari%20Plugin-v1.1%2B-38bdf8.svg" alt="Komari Compatibility">
</p>

---

## 🌟 核心功能亮点

- 📊 **30 天全景平铺监控**：全节点 30 天统一时间窗口，每日进出站增量堆叠柱状图 + 周期计费走势折线图平铺展示，告别繁琐下拉切换。
- ⚡ **当日流量实时呈现**：自适应计算今日 00:00 至当前时刻的实时增量，最右侧柱子告别空白，精准反映当天最新消耗（Tooltip 标注 `今日实时`）。
- ⚖️ **5 种计费统计模式自适应**：
  - `sum`：双向求和（入站 + 出站）
  - `max`：双向取大（`MAX(入站, 出站)`）
  - `min`：双向取小（`MIN(入站, 出站)`）
  - `upload` / `up`：仅计出站（出网流量）
  - `download` / `down`：仅计入站（入网流量）
  - *图表智能视觉区分：计费流量高亮显示，非计费流量自动半透明弱化。*
- 🗓️ **账单周期自动对齐**：自动提取节点到期日（`expired_at`）作为每月重置日（如 8 号到期即每月 8 号重置，未配置时自动按自然月 1 号重置）。
- 🔮 **智能耗尽推算与阈值告警**：基于 7 天加权移动均速推算重置日总消耗，提前预测流量超标并在耗尽时提供精确倒计时天数。
- 💨 **流光加载与平滑渲染**：多节点并发同步配备动态加载进度条与步骤提示，内置超时熔断保护，告别页面卡顿。
- ⚙️ **直连核心数据库**：在卡片右上角点击「设置限额」，直接持久化回写至 Komari 核心数据库，无插件层私有缓存。
- 💾 **极轻量日结存储**：后台仅按天归结每日一条极简记录，内置 90 天自动滑动清理，百台节点总存储不足 1 MB。

---

## 🚀 快速安装与使用

### 方式一：通过专属插件源订阅安装（推荐实时获取最新版）

在 Komari 插件市场设置中添加本仓库专属的自定义插件源订阅地址（直连 `refs/heads/main`，穿透 GitHub CDN 缓存，确保第一时间获取最新版本）：
```text
https://raw.githubusercontent.com/livingfree2023/Komari-Plugin-NetForecast/refs/heads/main/v1.json
```

### 方式二：通过 Komari 官方插件市场安装（版本可能有滞后）

1. 登录您的 Komari 管理后台。
2. 导航至左侧 **插件市场 (Plugin Market)**。
3. 在搜索框中输入 **`NetForecast`** 或 **`流量预测`**。
4. 找到插件后点击 **安装 (Install)**，系统将自动从官方市场目录拉取最新版本并一键安装。
5. 安装完成后在「插件管理」中点击 **启用**，左侧菜单即会出现 **流量预测** 仪表盘入口。

### 方式三：从 GitHub Releases 手动上传安装

1. 前往本仓库 [Releases 页面](https://github.com/livingfree2023/Komari-Plugin-NetForecast/releases) 下载最新版本的 **`net-forecast.zip`**。
2. 登录您的 Komari 管理后台，进入 **插件管理 (Plugins)**。
3. 点击右上角 **上传插件**，选择下载好的 `net-forecast.zip`。
4. 上传完成后点击启用即可。


---

## 🛠️ 自行构建

如需对源码进行二次开发并手动打包：
```bash
zip -r net-forecast.zip komari-plugin.json script.js pages assets README.md LICENSE
```

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 协议开源。
