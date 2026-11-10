# Release check

仅在用户明确授权发版后执行；普通修改只交付 ZIP，等待验收后才 push。

1. 读取 AGENTS.md、当前特性 SPEC/TASKS 与 .github/workflows/release.yml；检查 git status 和远程差异。
2. 按用户当地日期选择年.月日.修订版本，核对远程 Tag 未占用；同步 package.json、package-lock.json、komari-plugin.json。
3. 编写 RELEASE_NOTES.md 的中文及英文 Features / Bug Fixes / Improvements，明确验证边界。
4. npm run sync:version；npm run check；npm test；如改 UI/主题，执行适用浏览器检查。既有失败应先基线复现并记录。
5. 清理旧 ZIP 后 npm run package，unzip -t 检查；核对包内清单与两个页脚版本；git diff --check。审计凭据、私有域名及临时脚手架不入库；blog/ 必须被忽略。
6. 提交 main 并创建对应 v 前缀 Tag，推送 main 和该 Tag；不推送其它本地 Tag。
7. 用 gh 查询该 Tag 的 Actions 运行，跟进至终态；确认 Release 的 ZIP 和双语正文。
8. 严禁本地修改 v1.json 或手工计算 SHA256 二次提交。等待 Actions 自动回写后 git pull --ff-only origin main，核对索引版本及 URL。
9. 更新 TASKS 的交付状态；向用户提供 Release 链接、中英文摘要与重要验证限制。
