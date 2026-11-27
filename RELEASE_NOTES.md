# v26.1126.1 — 账期用量与耗尽预警 / Billing-cycle usage and quota alerts

## 中文更新日志

### 新增功能
- 公开看板、管理看板和浮窗按节点的每月重置日统一显示账期已用、累计趋势和额度预测。

### 问题修复
- 修复跨账期的原始网卡累计被计入本期用量的问题。累计折线从账期内的每日增量起算，额度预测与耗尽预警使用同一份账期累计。
- 修复今日打点时间戳重复应用统计时区偏移的问题。旧版快照仍可按统计日期正确归入账期。
- 修复前端同步后，本地采样可能重复计入同一段实时流量的问题。首次有效计数建立基准，后续采样识别网卡归零并累计新增流量。

### 优化与改进
- 按统计日期筛选最近 7 个有用量的完整日计算加权均速，避免旧快照的「今日」标记影响日均耗用。
- 时序查询失败时沿用已保存的每日采样，并在看板提示当前用量和预测的历史覆盖情况。
- 24 项自动化测试、类型检查、双看板浏览器同步和真实诊断快照回放均通过。另有四项浮窗主题或渲染用例在原始版本和本版均失败。

## English Changelog

### Features
- The public dashboard, admin dashboard, and floating widget use each node's monthly reset day for billing-cycle usage, cumulative trends, and quota forecasts.

### Bug Fixes
- Fixed raw network interface totals carrying usage from earlier cycles into the current cycle. The cumulative line starts with current-cycle daily increments, and quota forecasts and exhaustion alerts use that same usage total.
- Fixed the configured timezone offset being applied twice to today's sample timestamp. Older snapshots still map to the correct billing cycle by their reporting date.
- Fixed a live traffic interval being counted twice after a dashboard sync. The first valid counter establishes a baseline, and subsequent samples handle interface counter resets.

### Improvements
- The weighted run rate uses the last seven complete days with recorded usage. The reporting date determines whether a day is complete, including for older snapshots.
- If historical records fail to load, dashboards use saved daily samples and show that usage and forecasts may have incomplete coverage.
- All 24 automated tests, type checks, dashboard browser sync checks, and replay of a real diagnostic snapshot passed. Four separate floating-widget theme or rendering tests failed on both the baseline and this version.
