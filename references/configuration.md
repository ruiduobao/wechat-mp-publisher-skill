# 运行环境与配置

统一入口需要 Node.js（≥ 20）、Bun（≥ 1.4）和已安装的 Edge 或 Chrome。仓库自带 [`.env.example`](../.env.example)，`bin/launch-publisher.mjs` 启动时会自动读取仓库根目录 `.env` 中尚未设置的变量（不覆盖命令行显式环境变量）。

`node bin/launch-publisher.mjs` 优先使用 `WECHAT_BUN_PATH`，其次 `~/.bun/bin/bun[.exe]`，最后 PATH 中的 `bun`。正式写入前使用本仓库 TypeScript 检查；`--help` 和 `--check` 保持只读。

## 环境变量说明

| 变量 | 说明 | 本机默认值（未设置 `.env` 时） |
|---|---|---|
| `WECHAT_LOCAL_ROOT` | 本地推文源目录（只读扫描） | `Z:\自媒体\公众号\每日推文` |
| `WECHAT_MUSE_ROOT` | 外部同步源目录（严格只读） | `F:\同步文件夹\公众号\每日推文` |
| `WECHAT_HISTORY_FILE` | 历史草稿映射数据库 JSON | `C:\Users\Administrator\.agents\skills\wechat-md-pipeline\data\wechat-draft-history.json` |
| `WECHAT_BASELINE_FILE` | 遗留基线文件 JSON | 同一 data 目录 `wechat-legacy-baseline.json` |
| `WECHAT_LOCK_FILE` | 跨进程互斥锁文件 | 同一 data 目录 `wechat-publisher.lock` |
| `WECHAT_STATE_CACHE_DIR` | 渲染临时 HTML 与mismatch缓存目录 | `C:\Users\Administrator\.agents\skills\wechat-md-pipeline\cache` |
| `WECHAT_TITLES_FILE` | `bun run titles` 默认写入的外题映射 | 同一 data 目录 `titles-override.json` |
| `WECHAT_COVER_OVERRIDES_FILE` | 独立封面映射（`articleId -> 绝对路径`） | 同一 data 目录 `cover-overrides.json` |
| `WECHAT_AUTHOR` | 公众号后台作者栏写入名称 | `锐多宝` |
| `WECHAT_SKIP_PROFILE_CARD` | 设为 `1` / `true` 时跳过文末名片插入与校验（适合新用户快速上手） | `false`（启用名片） |
| `WECHAT_PROFILE_NAME` | 文末原生名片昵称 | `锐多宝` |
| `WECHAT_PROFILE_DATA_ID` | 文末原生名片 `data-id` | `MzAwODU3NDc2Nw==` |
| `WECHAT_PROFILE_DESC_KEYWORD` | 工具栏搜索名片时的简介核对关键词 | `原名:遥感之家` |
| `WECHAT_PROFILE_EXCLUDED` | 搜索名片时排除的同名/旧号昵称（逗号分隔） | `锐多宝的地理空间` |
| `WECHAT_PROFILE_TEMPLATE_FILE` | 从已验证草稿采集的原生名片模板路径 | 同一 data 目录 `native-card-template.html` |
| `WECHAT_BROWSER_CHROME_PATH` | 手动指定 Edge/Chrome 可执行文件 | 自动探测系统路径 |
| `BAOYU_CHROME_PROFILE_DIR` / `WECHAT_BROWSER_PROFILE_DIR` | 专用浏览器 Profile 目录 | `%APPDATA%\baoyu-skills\chrome-profile` |

两个文章源目录发布只读；不得把缓存、封面、报告写入源目录。已安装的两处 `wechat-mp-publisher` 技能目录链接到代码库，无需再复制运行时代码。

## 首次安装与新账号配置

公开仓库不包含真实历史、初始映射、已验证原生名片模板、封面文件或本机封面生成器。

1. 新用户克隆后复制 `.env.example` 为 `.env`，修改 `WECHAT_LOCAL_ROOT`、`WECHAT_HISTORY_FILE`、`WECHAT_AUTHOR` 等为自己的独立路径；若暂不配置名片模板，设 `WECHAT_SKIP_PROFILE_CARD=1`。
2. 已有账号迁移应保留其最新历史与基线文件，避免重新创建草稿；配置 JSON 损坏时先修复，不能当作空字典覆盖。
3. 基线缺失时，状态模块先将当前扫描文章作为历史候选处理，正式运行才受控写出基线。新创建空项目并准备发布第一批新文章前，可先创建内容为 `[]` 的 `WECHAT_BASELINE_FILE`，以免首批文章被当成待核对历史基线。操作细节见 [operations.md](operations.md)。

## 浏览器与剪贴板行为

- 按 `WECHAT_BROWSER_PROFILE_DIR` 查找当前运行中的浏览器进程及调试端口，再取 `/json/version` 的实际 WebSocket 地址。
- 若专用浏览器尚未运行，统一引擎自动以独立脱管进程安全拉起专用 Profile（不杀其它 Edge、不关闭用户标签、不反复开窗或自动弹二维码图片）。
- 登录过期报告 `needs-attention`，保留映射并等待用户扫码续期；不要当成内容或模型服务故障。
- HTML 原生复制会用本次排版内容覆盖系统剪贴板，不读取或记录用户原剪贴板。临时复制页只包含本次内容，复制后立即关闭。
