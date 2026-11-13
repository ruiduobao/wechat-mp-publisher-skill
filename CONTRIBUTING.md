# 贡献指南 (Contributing)

欢迎提交 Issue 与 Pull Request 一起改进 `wechat-mp-publisher-skill`！

## 隐私与安全底线

在提交 PR 或代码前，请务必确认：

1. **绝不提交私有数据**：真实文章正文、草稿状态数据库（`wechat-draft-history.json`）、浏览器登录态（`chrome-profile/`）、Cookies/Token、`.env`、原生名片 HTML 模板、截图与测试报告（`tests/reports/`）均不得提交。
2. **安全边界**：本仓库设计目标是**仅保存草稿（Drafts Only）**，不接受自动群发、发表或绕过微信登录风控的代码。
3. **不伪造验证**：编辑器事务和保存复验不可用直接改写 DOM、删除错误断言或模拟成功回包的方式跳过。

## 开发与提交前检查

```bash
# 1. 安装依赖
bun install

# 2. 类型检查
bun run typecheck

# 3. 运行离线回归测试套件
bun run test
```

若修改了微信编辑器交互、粘贴或保存复验逻辑，建议按照 [references/testing.md](references/testing.md) 对照测试矩阵，在真实草稿箱上验证保存并独立重开后确认通过，并在 PR 中注明实测环境、已验证项与未覆盖项。

## 开源许可

提交到本仓库的代码将默认采用本项目的 [MIT License](LICENSE) 开源协议；第三方依赖与历史归属详见 [NOTICE](NOTICE)。
