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

### 1. 下载插件包
前往本仓库 [Releases 页面](https://github.com/livingfree2023/Komari-Plugin-NetForecast/releases) 下载最新版本的 **`net-forecast.zip`**。

### 2. 上传与启用
1. 登录您的 Komari 管理后台。
2. 导航至 **插件管理 (Plugins)** -> 点击 **上传插件**，选择下载的 `net-forecast.zip`。
3. 上传完成后启用插件，左侧导航栏即会出现 **流量预测** 菜单入口。

---

## 🛠️ 自行构建

如需对源码进行二次开发并手动打包：
```bash
zip -r net-forecast.zip komari-plugin.json script.js pages assets README.md LICENSE
```

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 协议开源。
