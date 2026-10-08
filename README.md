# Komari 插件：NetForecast (网络流量预测与限额预警)

面向 [Komari 监控面板](https://github.com/komari-monitor) 的全节点网络流量智能预测与多模式计费限额告警插件。

---

## 🌟 核心功能特性

1. **全节点单页平铺展示 (30 天统一窗口)**
   - 告别单节点反复下拉切换，一页内直观展示所有节点的健康状态、计费规则与流量走势。
   - 固定 30 天统一时间窗口，便于横向横切对比各个节点的网络业务负载。

2. **100% 严格真实数据驱动 (零假数据/零随机种子)**
   - 物理总累计流量直接提取自 Komari 核心内存实时上报（`GET /api/recent/:uuid`），确保与 Komari 节点详情页的累计数值完全一致。
   - 历史每日进出站流量增量直接从 Komari 核心时序数据库（`GET /api/records/load?load_type=network&hours=720`）拉取并按天精准聚合。

3. **今日截至当前时间点流量实时差值呈现**
   - 提取昨日最后一条打点数据作为今日零点基准（Baseline），实时与当前网卡计数器做差值，得出**自今日 00:00 至当前时刻的已发生流量**。
   - 当日柱状图实时呈现，不再为空白；X 轴显式突出标出 **「今日」** 刻度，悬停 Tooltip 明确指示 `(今日截至当前)`。

4. **账单重置日深度绑定节点到期时间 (`expired_at`)**
   - 严格根据节点的 `expired_at` 到期日提取每月账单重置日期（例如 `2027-10-08` 即为每月 8 号重置）；未设置到期时间时自动按自然月（每月 1 号）执行重置。
   - 限额配置模态框内提供只读同步提示，引导用户前往 Komari 节点管理配置到期日，杜绝插件与核心业务逻辑分歧。

5. **加载进度指示器与步骤动态反馈 (Loading Overlay)**
   - 解决多节点拉取大量 30 天高频打点时可能出现的短暂停顿问题，提供暗色流光进度条与双色旋转指示器。
   - 实时反馈加载步骤（如：连接核心服务 -> 节点数据同步 `(3/8): US.VMISS...` -> 科学推算 -> 图表渲染就绪）。
   - 内置请求超时机制（`fetchWithTimeout`），防止个别节点时序数据库响应缓慢阻塞全盘渲染。

6. **多计费模式（Traffic Threshold Modes）自适应适配**
   - 原生支持 Komari 的 5 种流量统计与计费规则：
     - `sum`：双向求和（入站 + 出站）
     - `max`：双向取大（`MAX(入站, 出站)`）
     - `min`：双向取小（`MIN(入站, 出站)`）
     - `upload` / `up`：仅计出站（出网流量）
     - `download` / `down`：仅计入站（入网流量）
   - **智能视觉感知**：计费流量柱状图实心突出，非计费流量半透明弱化；累计折线严格根据当前计费模式进行累加与耗尽预测。

7. **直写核心数据库，无本地缓存污染**
   - 节点的限额（`traffic_limit`）与计费类型（`traffic_limit_type`）修改时，直接通过 RPC / 管理接口回写至 Komari 核心数据库，插件层绝不设置本地私有缓存。

8. **极轻量级时序日结归档 (Collection Cron)**
   - 后台可选通过 Cron 定时轻量采样，严格按日（`YYYY-MM-DD`）归结聚合。
   - 每个节点一天仅产生约 100 字节的极简日结记录，内置 90 天自动滑动清理，百台节点总存储量亦小于 1 MB。

---

## 📁 项目目录结构

```text
Komari-Plugin-NetForecast/
├── .github/
│   └── workflows/
│       └── release.yml     # 自动化打包与 GitHub Release 发布工作流
├── komari-plugin.json      # 插件清单 (声明权限、配置项与管理页面)
├── script.js               # Goja 运行时入口核心逻辑 (直连核心数据库，无本地设置缓存)
├── pages/
│   └── admin.html          # 管理后台全节点平铺仪表盘 (Canvas 复合图表 + 进度条 + 直写核心模态框)
├── assets/
│   └── icon.svg            # 插件矢量图标
├── src/
│   ├── plugin.ts           # TypeScript 源码入口
│   ├── forecast.ts         # 账单周期与多模式流量预测算法模块
│   ├── storage.ts          # 时序数据持久化管理器 (仅存采样计数，无节点配置缓存)
│   └── types.ts            # 全局 TypeScript 接口与类型定义
├── preview.html            # 离线开发与交互演示 Mock-up 页面
├── .gitignore              # Git 忽略配置
├── package.json            # 项目配置与脚本
└── tsconfig.json           # TypeScript 配置
```

---

## 🚀 安装与使用

### 方式一：从 GitHub Releases 下载一键安装包

1. 前往本仓库的 [Releases 页面](https://github.com/livingfree2023/Komari-Plugin-NetForecast/releases) 下载最新版本的 `net-forecast.zip`。
2. 登录您的 Komari 管理后台。
3. 进入 **插件管理 (Plugins)** -> 点击 **上传插件**，上传下载好的 `net-forecast.zip`。
4. 启用插件后，左侧菜单将出现 **流量预测** 入口。

### 方式二：手动打包

如需自行修改源码后打包：
```bash
zip -r net-forecast.zip komari-plugin.json script.js pages assets README.md
```
将打包生成的 `net-forecast.zip` 上传至 Komari 管理面板即可。

---

## 🛠️ GitHub Actions 自动化发布

本仓库已配置自动化构建发布流程（`.github/workflows/release.yml`）：
- 当您在仓库中推送版本 Tag（例如 `v1.1.0`）或在 GitHub Release 界面创建新 Release 时，Action 将自动打包 `net-forecast.zip` 并挂载为 Release Asset。

---

## 📄 开源许可证

本项目采用 [MIT License](LICENSE) 开源协议。
