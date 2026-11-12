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

`getStatePaths` 支持 `WECHAT_HISTORY_FILE`、`WECHAT_LOCK_FILE`、`WECHAT_BASELINE_FILE`、`WECHAT_STATE_CACHE_DIR`、`WECHAT_MUSE_ROOT`、`WECHAT_LOCAL_ROOT`。这描述的是状态模块的注入能力；当前批处理的完整渲染和差异缓存仍使用导出的默认 `STATE_CACHE_DIR`，不能据此宣称设置环境变量已隔离所有正式产物。临时测试应显式传入渲染 cacheRoot，正式迁移时核对所有调用处。

封面映射读取支持 `WECHAT_COVER_OVERRIDES_FILE`。名片模板仍使用本机 data 路径，作者和目标名片身份由 `editor-features.ts` / 批处理中的账号常量确定。当前项目针对已配置的“锐多宝”账号，不是填一个 Profile 就能切换任意公众号的通用多账号工具。换设备或换账号时，应核对模板路径、账号身份、作者、封面映射和来源，先独立验收再批量执行。

## 私有配置与首次安装

公开仓库不包含真实历史、初始映射、已验证原生名片模板、封面文件或本机封面生成器。已有账号迁移应保留其最新状态与基线，避免重新生成草稿；配置坏 JSON 不能用空文件覆盖。

基线缺失时，状态模块先将当前扫描文章作为历史候选处理，正式运行才受控写出基线。刚克隆仓库看到 needs-reconcile 是防重保护，并不表示文章已经在微信保存。完整初始对齐与日常命令见 [operations.md](operations.md)。

## 浏览器

- 可通过 `WECHAT_BROWSER_CHROME_PATH` 指定可执行文件。
- Profile 可用 `BAOYU_CHROME_PROFILE_DIR` / `WECHAT_BROWSER_PROFILE_DIR` 指定。
- 按 Profile 查找当前进程及调试端口，再取 `/json/version` 的实际 WebSocket 地址。
- 复用有效登录主页；不杀其它 Edge，不关闭用户标签，不自动弹二维码图片。
- 登录过期报告 `needs-attention`，保留映射并等待用户续期；不要当成内容或模型服务故障。

HTML 原生复制会用本次排版内容覆盖系统剪贴板，不读取或记录用户原剪贴板。临时复制页只包含本次内容，复制后关闭。
