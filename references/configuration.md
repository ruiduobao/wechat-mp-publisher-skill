# 运行环境与配置说明

## 1. 运行依赖

- **运行环境**: [Bun](https://bun.sh/)（推荐，`bun install` 极速安装）或 Node.js ≥ 20
- **浏览器**: 本机已安装的 **Google Chrome** 或 **Microsoft Edge**（自动探测，无需手动配置）
- **网络**: 首次扫码登录以及日常推文上传时需保证可以正常访问 `https://mp.weixin.qq.com/`

---

## 2. 核心路径说明

| 配置项 | 默认路径 / 说明 |
|---|---|
| **Chrome/Edge Profile 目录** | `%APPDATA%\baoyu-skills\chrome-profile`（用于持久化保持微信公众平台的登录态） |
| **已推历史数据库** | `~/.agents/skills/wechat-md-pipeline/data/wechat-draft-history.json`（记录所有已推送文章的 appmsgid） |
| **二维码本地暂存路径** | `%USERPROFILE%\wechat-login-qr.png`（首次需要扫码时自动保存并弹窗） |

---

## 3. 可选环境变量

您可以通过系统环境变量或在执行命令前指定以下参数进行个性化调整：

```bash
# 自定义浏览器可执行文件路径（如未在默认路径安装）
export WECHAT_BROWSER_CHROME_PATH="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

# 远程扫码通知（可选）：配置 Telegram Bot 自动推送登录二维码到手机
export TELEGRAM_BOT_TOKEN="your_bot_token"
export TELEGRAM_CHAT_ID="your_chat_id"
```

---

## 4. 多账号支持（可选）

如需管理多个微信公众号，可在 `~/.baoyu-skills/EXTEND.md` 中配置账号别名与专用 Profile：

```yaml
accounts:
  tech_daily:
    name: "科技前沿速递"
    default_author: "科研小助手"
    chrome_profile_path: "C:\\Users\\Administrator\\.baoyu-skills\\profiles\\tech"
  geo_news:
    name: "地信遥感观察"
    default_author: "锐多宝"
    chrome_profile_path: "C:\\Users\\Administrator\\.baoyu-skills\\profiles\\geo"
```

运行时通过 `--account <alias>` 参数进行一键切换：
```bash
bun run wechat-article.ts --account geo_news --markdown article.md --submit
```
