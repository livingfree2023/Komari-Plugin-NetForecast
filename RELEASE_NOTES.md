# v26.1109.1 — 配置读取与流量图表一致性 / Configuration and Traffic Chart Consistency

## 🇨🇳 中文更新日志 (Changelog - zh_CN)

### 🚀 新增功能 (Features)
- 新增轻量只读配置接口，看板在聚合每日历史前先获取统计时区，避免首次加载或重新打开页面时按默认时区分桶。
- 增加从插件清单同步管理页与公开页页脚版本的脚本；本地打包前自动同步，检查阶段验证版本一致。

### 🐛 问题修复 (Bug Fixes)
- 修复将宿主 `server.getConfig()` 返回的 Promise 当成配置对象读取的问题。总览、诊断、RPC、定时任务初始化及浮窗注入正确等待配置，恢复管理员配置的重置日、告警阈值、时区、采样频率与浮窗开关。
- 修复默认重置日读取后未传入预测计算的问题，保留节点到期日与节点重置日的既有优先级；无有效到期日的文案显示实际采用的重置日。
- 修复累计折线底数混入上一账单周期历史、未来记录或重复日期的问题。底数与绘图使用相同的本周期至今日数据集合，避免今日点突然补回累计差额；每日物理增量柱体不补入缺失历史。
- 修复预测折线将下一周期零点边界额外算成一个消耗日的问题，使本次验证的双向求和预测终点与顶部周期预测摘要一致。
- 修复两个看板页脚遗留的固定 `v1.2.0` 版本显示。

### ⚡ 优化与改进 (Improvements)
- 补齐 TypeScript 的时区参数、采样时区传递、累计字段类型及 Node 类型依赖。
- 配置读取失败时不静默生成默认配置结果；前端配置获取失败时停止本轮同步，避免按错误时区提交历史。
- 总览与 RPC 复用累计快照前核对配置，避免配置变化后直接沿用旧配置计算的结果。
- 新增异步配置、五种计费模式历史范围、冷启动、重置边界及 TypeScript/部署脚本一致性回归，15 项测试和类型检查通过。
- 真实实例完整同步快照验证了两个目标节点的今日折线增量与柱体精确一致；预测边界修复通过真实快照本地回放及用户测试确认。
- 验证说明：原有浏览器主题套件的四项断言在未修改基线上同样失败，本次未修改浮窗主题代码。

---

## 🇬🇧 English Changelog (en)

### 🚀 Features
- Added a lightweight read-only configuration endpoint so dashboards obtain the configured timezone before aggregating daily history, including first loads and reopened pages.
- Added manifest-driven footer version synchronization for both dashboards, with automatic synchronization before local packaging and consistency checks during validation.

### 🐛 Bug Fixes
- Fixed reading the Promise returned by `server.getConfig()` as a configuration object. Overview, diagnostics, RPC, cron initialization and widget injection now await configuration, restoring configured reset days, warning thresholds, timezone offsets, collection schedules and widget visibility.
- Passed the configured default reset day into forecasting while preserving the existing node expiry and node reset-day precedence. Fallback labels now reflect the reset day actually used.
- Restricted cumulative baseline calculations to unique dates within the current billing cycle through today. Previous-cycle records, future records and overwritten duplicates no longer depress the historical line and cause a sudden catch-up at today's point. Daily bars remain physical daily increments.
- Prevented the next-cycle midnight boundary from adding an extra consumption day to the forecast. The verified SUM-mode endpoints now agree with their forecast summaries.
- Replaced the stale hardcoded `v1.2.0` dashboard footer versions.

### ⚡ Improvements
- Completed TypeScript timezone parameters, sampling timezone propagation, cumulative field types and Node type dependencies.
- Configuration failures no longer silently become default configuration results; dashboards stop the current synchronization if configuration cannot be obtained.
- Overview and RPC snapshot reuse now checks configuration consistency before returning previously calculated results.
- Added regression coverage for asynchronous configuration, history ranges across five billing modes, cold starts, reset boundaries and TypeScript/runtime parity. All 15 tests and type checking pass.
- Full-sync diagnostics from a real instance confirmed exact agreement between today's line increments and daily bars for both target nodes. Forecast boundary corrections were verified by local replay of real diagnostics and user testing.
- Validation note: four existing browser theme assertions also fail on the unchanged baseline. Floating-widget theme code is unchanged in this release.
