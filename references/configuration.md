# 运行环境与配置

统一入口需要 Node.js、Bun 和已安装的 Edge/Chrome。本轮实测 Windows 10.0.22631、Node.js 24.3、Bun 1.4.3、Edge。先在仓库执行 `bun install`。

`node bin/launch-publisher.mjs` 优先使用 `WECHAT_BUN_PATH`，其次 `~/.bun/bin/bun[.exe]`，最后 PATH 中的 `bun`。正式写入前使用本仓库 TypeScript 检查；`--help` 和 `--check` 保持只读。

## 默认路径

| 项目 | 本机默认值 |
|---|---|
| 代码库 | `C:\Users\Administrator\wechat-mp-publisher-skill` |
| Muse 来源 | `F:\同步文件夹\公众号\每日推文` |
| 本地独立来源 | `Z:\自媒体\公众号\每日推文` |
| 历史 | `C:\Users\Administrator\.agents\skills\wechat-md-pipeline\data\wechat-draft-history.json` |
| 基线 | 同一 data 目录的 `wechat-legacy-baseline.json` |
| 锁 | 同一 data 目录的 `wechat-publisher.lock` |
| 封面映射 | 同一 data 目录的 `cover-overrides.json`，内容为 `articleId -> 绝对文件路径` |
| 原生名片模板 | 同一 data 目录的 `native-card-template.html`，由已验证草稿采集 |
| 缓存 | `C:\Users\Administrator\.agents\skills\wechat-md-pipeline\cache` |
| 浏览器 Profile | `%APPDATA%\baoyu-skills\chrome-profile` |

这两个来源由不同生成/同步任务维护，发布只读；不得把缓存、封面、报告写入来源。已安装的两处 `wechat-mp-publisher` 技能目录链接到代码库，无需再复制运行时代码。

`getStatePaths` 支持 `WECHAT_HISTORY_FILE`、`WECHAT_LOCK_FILE`、`WECHAT_BASELINE_FILE`、`WECHAT_STATE_CACHE_DIR`、`WECHAT_MUSE_ROOT`、`WECHAT_LOCAL_ROOT`。当前批处理的封面和名片私有配置仍使用本机 data 路径，迁移设备时应核对调用处，不要假定全部路径自动迁移。

## 浏览器

- 可通过 `WECHAT_BROWSER_CHROME_PATH` 指定可执行文件。
- Profile 可用 `BAOYU_CHROME_PROFILE_DIR` / `WECHAT_BROWSER_PROFILE_DIR` 指定。
- 按 Profile 查找当前进程及调试端口，再取 `/json/version` 的实际 WebSocket 地址。
- 复用有效登录主页；不杀其它 Edge，不关闭用户标签，不自动弹二维码图片。
- 登录过期报告 `needs-attention`，保留映射并等待用户续期；不要当成内容或模型服务故障。

HTML 原生复制会用本次排版内容覆盖系统剪贴板，不读取或记录用户原剪贴板。临时复制页只包含本次内容，复制后关闭。
