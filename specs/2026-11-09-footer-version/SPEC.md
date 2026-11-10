# 页脚版本同步

两个看板页脚硬编码 v1.2.0。以 komari-plugin.json 为版本来源，同步静态页脚，保持原布局。

scripts/sync-version.cjs 校验 package 与清单一致，更新两页页脚。npm package 自动在打包前同步；npm check 校验页脚不落后于清单，避免再交付错误版本。无新增运行时请求。

验证：同步脚本、类型检查、既有回归、ZIP 页脚与清单一致性。无需新增布局原型。
