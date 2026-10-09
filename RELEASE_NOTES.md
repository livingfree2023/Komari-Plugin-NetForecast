## 🇨🇳 中文更新日志 (Changelog - zh_CN)

### 🐛 关键问题修复 (Bug Fixes)
- **修复 `sendJSON` 响应挂起与前端卡死问题 (Critical)**：
  - 修复 `script.js` 中 `sendJSON()` 辅助函数缺失 `res.end(JSON.stringify(data))` 导致 HTTP 响应流未正常结束的问题。
  - 彻底解决前台浮出层小组件一直显示“正在计算全节点流量与预算预测...”加载状态以及 `/public.html` 公开看板页面加载超时报错的严重缺陷。
  - 在核心源码与开发规范文档 `agent.md` 中补充详细高危避坑注释与服务端 HTTP 响应规范，防止后续迭代意外引入连接泄露。

### 🎨 界面与设计优化 (UI & Banner)
- **全新 16:9 海报式 3D 透视预览图**：
  - 更新 `assets/preview.svg`：左侧 30% 采用极简海报排版，保留主标题与 4 项核心特性卡片；右侧 70% 呈现双层 3D 透视倾斜叠放窗口（完整后台管理看板 + 前景悬浮小组件），全方位展示流量预测与前台交互场景。

### ⚡ 自动化与发布流程改进 (Workflow Improvements)
- **GitHub Release 更新日志全自动注入**：
  - 优化 `.github/workflows/release.yml`，每次推送 Tag 后由流水线自动读取根目录 `RELEASE_NOTES.md` 注入 GitHub Release 正文，无需手动在网页复制粘贴中英文更新日志。

---

## 🇬🇧 English Changelog (en)

### 🐛 Critical Bug Fixes
- **Fixed `sendJSON` Response Hang and Frontend Freeze (Critical)**:
  - Restored `res.end(JSON.stringify(data))` inside `sendJSON()` in `script.js`, ensuring all HTTP response streams terminate properly in Komari's Goja runtime.
  - Completely resolved the issue where the frontend floating widget remained permanently stuck on "Calculating traffic forecast..." and `/public.html` timed out with loading errors.
  - Added comprehensive safeguard comments in source code and documented Goja HTTP response standards in `agent.md` to prevent future connection hang regressions.

### 🎨 UI & Design Enhancements
- **New 16:9 Poster-Style 3D Perspective Banner**:
  - Redesigned `assets/preview.svg`: Features a clean, centered 30% left column with typography and 4 key feature cards, paired with a 70% right canvas showcasing dual 3D tilted windows (full management dashboard and foreground floating widget overlay).

### ⚡ Workflow & Automation Improvements
- **Automated GitHub Release Notes Injection**:
  - Enhanced `.github/workflows/release.yml` to automatically read `RELEASE_NOTES.md` and populate the GitHub Release body upon tag push, eliminating manual changelog publishing.
