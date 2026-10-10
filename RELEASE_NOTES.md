## 🇨🇳 中文更新日志 (Changelog - zh_CN)

### 🚀 新增功能与体验优化 (Features & Improvements)
- **自定义统计基准时区 (Timezone Offset)**：
  - 在插件设置面板中新增 `timezone_offset` 配置项（默认预设为 `8` 即东八区 UTC+8 北京时间，单位为小时）。
  - **彻底与宿主机/容器环境时区解耦**：计算账单周期与重置日（`calculateBillingCycle`）、生成预测时序走势（`buildCycleSeries`）、定时历史采样（`recordSample`）以及前端按日聚合（`aggregateDailyFromRecords`）均统一基于配置的时区偏移量进行绝对时间戳数学折算。
  - **解决重置日时差问题**：即使 Komari 运行在默认 UTC 的 Docker 容器中，重置日也会在本地时间午夜 00:00 准时无缝切换，不再产生 8 小时的周期判断延迟；同时每日柱状图严格按照配置时区的 00:00:00 ~ 23:59:59 完整切片。
  - **海外用户自由适配**：欧洲、美东、美西、日韩等海外用户亦可在设置中自由填写对应时区偏移（如 `0`、`1`、`-5`、`-7`、`9` 等）。
- **完善项目文档与开发规范**：
  - 更新 `README.md`，增加时区自由配置的特性亮点说明；
  - 更新 `agent.md`，确立时区偏移计算标准与多端同步要求。

---

## 🇬🇧 English Changelog (en)

### 🚀 Features & Improvements
- **Configurable Timezone Offset for Statistics**:
  - Added `timezone_offset` configuration in the plugin settings (defaults to `8` for UTC+8 Beijing Time, in hours).
  - **Full Decoupling from Host/Container OS Timezone**: Billing cycle range calculation (`calculateBillingCycle`), forecast series (`buildCycleSeries`), periodic background sampling (`recordSample`), and frontend daily history aggregation (`aggregateDailyFromRecords`) are now all mathematically aligned based on the configured timezone offset.
  - **Eliminated Reset Day Boundary Delay**: Even when Komari runs in a default UTC Docker container, monthly reset days transition seamlessly at local midnight 00:00 without the previous 8-hour UTC lag. Daily bar slices strictly cover 00:00:00 to 23:59:59 in the target timezone.
  - **Worldwide Timezone Compatibility**: Users in Europe, the Americas, Japan, etc., can easily set their respective UTC offset (e.g. `0`, `1`, `-5`, `-7`, `9`).
- **Documentation & Agent Guidelines Update**:
  - Updated `README.md` highlighting the new timezone offset capability;
  - Formalized timezone offset calculation principles in `agent.md`.
