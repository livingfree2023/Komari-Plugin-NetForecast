# Komari Plugin: NetForecast (网络流量预测)

基于 TypeScript 和 `@komari-monitor/plugin-sdk` 开发的 Komari 插件项目。

## 项目结构

```text
.
├── src/
│   └── plugin.ts          # 插件核心逻辑源码 (TypeScript)
├── komari-plugin.json     # 插件清单声明 (元信息、权限、配置声明)
├── komari.local.json      # 本地调试配置 (包含开发服务器与 API Key，已加入 .gitignore)
├── package.json           # 项目依赖与构建脚本
├── tsconfig.json          # TypeScript 编译配置
└── README.md              # 项目说明文档
```

## 开发与热重载

1. **安装依赖**：
   ```bash
   npm install
   ```

2. **启动热重载开发环境**：
   ```bash
   npm run dev
   ```
   - 自动监视 `src/` 与 `komari-plugin.json` 变动。
   - 自动打包、分块上传到配置的 Komari 实例 (`https://komari.leohou.org`) 并重新载入插件。
   - 在终端实时打印插件运行日志。

3. **打包插件**：
   ```bash
   npm run build
   # 或
   npm run package
   ```
   打包完成后生成可分发/上传的 `.zip` 插件包。
