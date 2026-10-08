# Komari 插件：NetForecast (网络流量预测与限额预警)

面向 Komari 监控面板的高性能网络流量预测插件。

## 🌟 功能特性

1. **全节点单页平铺展示 (30 天固定窗口)**：
   - 告别单节点反复下拉切换，一页内直观展示所有节点的健康状态与流量走势。
   - 固定 30 天统一时间窗口，便于横向对比各节点业务负荷。
2. **多限额计费模式（Traffic Threshold Mode）自适应**：
   - 原生支持 Komari 的 5 种计费统计模式：
     - `sum`：双向求和（入站 + 出站）
     - `max`：双向取大（`MAX(入站, 出站)`）
     - `min`：双向取小（`MIN(入站, 出站)`）
     - `upload` / `up`：仅计出站（出网流量）
     - `download` / `down`：仅计入站（入网流量）
   - **图表智能视觉区分**：计费流量柱状图实心突出，非计费流量半透明弱化；累计折线严格追踪计费规则累计。
3. **直连核心数据库，绝不作本地配置缓存**：
   - 节点限额（`traffic_limit`）、计费类型（`traffic_limit_type`）与每月重置日（`traffic_reset_day`）**永远以 Komari 核心数据库中的 Client 原生设置为准**。
   - 插件本地仅存储采集的时序测量数据（`traffic_records.json`），插件自身不缓存或覆盖任何节点配置。
   - 在节点卡片点击「⚙️ 设置限额」弹窗修改后，**直接持久化回写至 Komari 核心数据库**（`POST /api/admin/client/:uuid/edit` / `admin:editClient` RPC）。
4. **未配额节点平滑支持**：
   - 未在核心配置配额的节点显示为 `⚪ 未配置限额`，绝不误触发超限告警。
   - 依然完整保留 30 天消耗柱状图、日均消耗与自然月外推预测虚线。
5. **动态交互式过滤药丸**：
   - 顶部快捷过滤器（`全部节点`、`🚨 超限告警`、`⚡ 接近限额`、`✅ 预算安全`、`⚪ 未配额`）一键切换筛选。

---

## 📁 项目目录结构

```text
Komari-Plugin-NetForecast/
├── komari-plugin.json      # 插件清单 (声明权限、配置项与管理页面)
├── script.js               # Goja 运行时入口核心逻辑 (直连核心数据库，无本地设置缓存)
├── pages/
│   └── admin.html          # 管理后台全节点平铺仪表盘 (Canvas 复合图表 + 直写核心模态框)
├── assets/
│   └── icon.svg            # 插件图标
├── src/
│   ├── plugin.ts           # TypeScript 源码入口
│   ├── forecast.ts         # 账单周期与多模式流量预测算法模块
│   ├── storage.ts          # 时序数据持久化管理器 (仅存采样计数，无节点配置缓存)
│   └── types.ts            # 类型定义
├── komari.local.json       # 本地热重载连接凭据 (已在 .gitignore 中忽略)
├── net-forecast.zip        # 一键安装分发包
├── package.json            # 项目配置与脚本
└── tsconfig.json           # TypeScript 配置
```

---

## 🚀 安装与使用

### 管理后台上传 ZIP 安装
根目录下已打包生成最新的 [net-forecast.zip](file:///Users/leovannys/github/Komari-Plugin-NetForecast/net-forecast.zip)：
1. 登录你的 Komari 管理后台：`https://komari.leohou.org/admin/`
2. 进入 **插件管理 (Plugins)**。
3. 点击 **上传插件**，选择项目根目录下的 `net-forecast.zip`。
4. 上传完成后在插件列表中找到 **NetForecast (网络流量预测)** 并点击启用。
5. 点击左侧导航栏的 **流量预测** 即可进入全节点 30 天走势与智能预警总览。
