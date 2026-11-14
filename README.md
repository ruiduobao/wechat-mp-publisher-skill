# WeChat MP Publisher Skill

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/Node-%3E%3D20-green.svg" alt="Node" />
  <img src="https://img.shields.io/badge/Bun-%3E%3D1.4-orange.svg" alt="Bun" />
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6.svg" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Protocol-Chrome%20CDP-red.svg" alt="Chrome CDP" />
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" /></a>
</p>

一个面向 **个人自媒体创作者、科研团队及 AI Agent（ZCode / Claude Code / Codex）** 的开源微信公众号 Markdown 排版与草稿箱自动录入技能。

通过 **Chrome/Edge DevTools Protocol (CDP)** 原生驱动本地浏览器登录态：**无需企业认证、无需配置公众号 AppID/AppSecret、无需公网服务器 IP 白名单**，自动完成从本地 Markdown 到微信公众号草稿箱的全流程写入与保存后物理重开复验。

> **安全边界**：本工具**仅保存草稿（Drafts Only）**，绝不代替用户执行发表、群发或通知关注者。所有文章原文、草稿状态、Cookies 与测试截图均与源码物理隔离，不进入公开仓库。

---

## 核心特性

- **双层标题架构**：列表外显标题支持 ≤15 字语义短标题覆写（`--titles` / `bun run titles`），避免移动端被截断；正文首位始终保留完整学术/长文 `<h1>` 原标题，不截断、不重复。
- **原生 HTML 复制粘贴与选区防抖**：在任务自有临时标签准备排版 HTML 并原生触发复制粘贴，轮询等待新正文真正替换旧正文；逐张通过带选区抖动重试的 `Input.insertText` 替换占位符，严禁直接修改正文 DOM 假冒模型更新。
- **高清原图 CDP 直传与像素顺位校验**：自动转换大于 1MB 或非标准格式（如 WebP）图片，直接调用 `DOM.setFileInputFiles` 上传为微信官方 CDN 素材；保存重开后优先核对合法 qpic 域名 `/0`、`/640` 尺寸归一化，若微信去重或重签名改变 URL 路径，自动以 **32×32 RGBA 内存像素交叉 MAE** 检验内容与顺序无误。
- **封面与官方原生名片**：支持正文首图裁剪封面及零正文图文章独立封面；支持插入与验证微信官方原生 `<mp-common-profile>` 名片组件居于正文末尾（新用户也可通过 `.env` 设为 `WECHAT_SKIP_PROFILE_CARD=1` 先跳过名片快速跑通）。
- **保存后独立新标签物理重开复验**：保存取得 `appmsgid` 后立即持久化保全为 `saved-unverified`，关闭编辑页后新建独立标签页拉取同一草稿，严格核验文字、图片顺序与加载、首位唯一 H1、作者、外题、封面及名片 7 项指标，全部达标才推进指纹。
- **前置论文真实性与 DOI/arXiv 在线核查**：每次同步前自动（或通过 `bun run verify` / `--check --verify`）并发调用 Crossref、doi.org Handles、arXiv Export API 与原文链接校验——自动核对 DOI 与 arXiv 编号是否真实存在、解析出来的真实论文标题是否与推文一致，直接拦截假 DOI、张冠李戴、死链、0 字节图片和 TODO 占位符。
- **高效本地批量同步**：正文粘贴与多图压缩预处理**并行重叠**执行，已知图片轮播草稿（`unsupported-message-type`）自动持久化记忆跳过，避免每次全量同步反复超时；配合 `--search`、`--latest` 与 `bun run titles` 一键完成日常同步。

---

## 新用户 5 分钟快速上手

本轮完整现场实测环境为 **Windows + Edge + Node.js ≥ 20 + Bun ≥ 1.4**（macOS/Linux 需保证已安装 Chrome/Edge 并自行适配测试）。

### 第 1 步：准备运行环境

1. 安装 [Node.js](https://nodejs.org/)（≥ 20）
2. 安装 [Bun](https://bun.sh/)（≥ 1.4）：
   - Windows PowerShell：`powershell -c "irm bun.sh/install.ps1 | iex"`
   - macOS / Linux：`curl -fsSL https://bun.sh/install | bash`
3. 确保本机已安装 **Microsoft Edge** 或 **Google Chrome**。

### 第 2 步：克隆仓库与安装依赖

```bash
git clone https://github.com/ruiduobao/wechat-mp-publisher-skill.git
cd wechat-mp-publisher-skill
bun install
```

验证离线环境（类型检查 + 单元测试）：

```bash
bun run typecheck
bun run test
```

### 第 3 步：创建个人 `.env` 配置（无需改动源码）

复制仓库根目录的配置模板 [`.env.example`](.env.example) 为 `.env`：

```bash
cp .env.example .env
```

打开 `.env`，按你的实际需求修改这几项即可：

```dotenv
# 1. 你的 Markdown 推文存放目录（目录内按 YYYYMMDD_HHMM 批次子文件夹存放 01_xxx.md）
WECHAT_LOCAL_ROOT=./my-articles
WECHAT_MUSE_ROOT=./my-external-articles

# 2. 状态库、锁、缓存与短标题映射保存位置（放在源码仓库外的私有目录或被 gitignore 的目录）
WECHAT_HISTORY_FILE=./private-data/wechat-draft-history.json
WECHAT_BASELINE_FILE=./private-data/wechat-legacy-baseline.json
WECHAT_LOCK_FILE=./private-data/wechat-publisher.lock
WECHAT_STATE_CACHE_DIR=./private-data/cache
WECHAT_TITLES_FILE=./private-data/titles-override.json
WECHAT_COVER_OVERRIDES_FILE=./private-data/cover-overrides.json

# 3. 你的公众号作者名；首次跑通可先设 WECHAT_SKIP_PROFILE_CARD=1 跳过文末名片
WECHAT_AUTHOR=你的作者名
WECHAT_SKIP_PROFILE_CARD=1
```

> 准备一篇测试文章：在 `./my-articles/20261113_1200/` 下放一个 `01_测试文章.md`（开头写 `# 完整原标题`，正文带 1 张本地图片 `./fig1.png` 以便自动选作封面）。
> 如果这是你第一次在该目录下全新初始化且希望把目录里已有文章纳入新草稿管理，先放好文章再首次运行或先用单篇命令测试（注意：若没有 `wechat-legacy-baseline.json`，首次扫描会将当时已存在文章标记为待核对基线防重；先在空目录建好 `baseline.json` 写入 `[]` 再放入测试文章即可视作新文章创建）。

### 第 4 步：只读预检与设置短标题

```bash
# 1. 只读预检（不写状态、不启浏览器）
node bin/launch-publisher.mjs --check

# 2. 按关键词检索或查看最新一篇
node bin/launch-publisher.mjs --check --latest

# 3. 为长标题文章设置 ≤15 字的列表短标题（自动检查字数并安全合并到 titles-override.json）
bun run titles "local:20261113_1200:01=我的测试短标题"
```

### 第 5 步：首次扫码登录并推送到草稿箱

```bash
# 运行单篇发布或批量同步（正式写入前自动执行 tsc --noEmit）
node bin/launch-publisher.mjs --latest 1 --titles ./private-data/titles-override.json
```

- 引擎会自动以独立脱管进程启动带调试端口的专用浏览器（使用隔离的 Profile，**不会关闭或影响你的日常浏览器**）。
- 首次运行若未登录，请在弹出的专用浏览器中用微信扫码登录公众平台后台，登录后重新运行上面的命令即可；登录态（Cookies）会在专用 Profile 内持久保留直到平台过期。
- 完成后前往公众号后台「草稿箱」，即可看到排版精美、带封面与高清图片的草稿。

---

## 常用命令行速查

所有正式入口统一通过 `bin/launch-publisher.mjs`（正式写入前自动运行 TypeScript 检查）：

```bash
# 第一步：核查待同步推文的真实性（论文标题 / DOI / arXiv / 原文链接 / 图片）
bun run verify
bun run verify --latest 3

# 只读演练与查找（可加 --verify 一并核查）
node bin/launch-publisher.mjs --check --verify
node bin/launch-publisher.mjs --check --search "关键词"       # 按 ID/文件名/标题/正文搜索（含已跳过项）
node bin/launch-publisher.mjs --check --latest 3              # 查看最新 3 篇状态

# 短标题管理（<= 15 Unicode 字符，自动合并写盘）
bun run titles "<articleId>=<≤15字短标题>"
bun run titles --list

# 正式写入草稿箱（仅保存草稿）
node bin/launch-publisher.mjs --id <articleId> --title-override "短标题"   # 单篇智能处理（新建/更新/跳过）
node bin/launch-publisher.mjs --repair --id <articleId>                    # 仅原地修补 H1/作者/封面/名片
node bin/launch-publisher.mjs --refresh-content --id <articleId>           # 在原草稿上按源文重建完整正文与图片
node bin/launch-publisher.mjs --titles "<path/to/titles-override.json>"    # 批量同步就绪文章

# 轻量登录态保活（每天执行一次，静默刷新后台首页顺延 96 小时滑动 Cookie，不改写草稿）
bun run keepalive
node bin/launch-publisher.mjs --keepalive

# 轻量单篇脚本（直接指定本地单个 Markdown 文件快速推送草稿）
bun run article --markdown "path/to/post.md" --title "短标题" --author "作者" --submit

# 查看完整 CLI 参数
node bin/launch-publisher.mjs --help
```

---

## 作为 AI Agent Skill 安装（ZCode / Claude Code）

本仓库根目录自带完整规范的 [`SKILL.md`](SKILL.md) 与 `references/` 手册，可直接安装为通用 Agent 技能：

1. 将仓库克隆到本机固定目录（例如 `~/wechat-mp-publisher-skill`）；
2. 在你的用户技能目录建立符号链接到该仓库（不要复制代码副本，确保后续 `git pull` 即刻生效）：
   - **Windows (PowerShell / CMD 管理员或开发者模式)**：
     `New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.agents\skills\wechat-mp-publisher" -Target "<仓库绝对路径>"`
   - **macOS / Linux**：
     `ln -s /path/to/wechat-mp-publisher-skill ~/.agents/skills/wechat-mp-publisher`
3. 之后只需对 Agent 说：“更新公众号草稿”、“把某某文章更新到公众号”或“拉取最新推文存草稿”，Agent 即可按照 `SKILL.md` 规范自动完成检索、提炼短标题、推送与重开复验。

---

## 项目目录架构

| 文件 / 目录 | 说明 |
|---|---|
| [`SKILL.md`](SKILL.md) / [`AGENTS.md`](AGENTS.md) | AI Agent 技能定义、执行规范与验收标准 |
| [`bin/launch-publisher.mjs`](bin/launch-publisher.mjs) | 统一启动器（自动加载 `.env`、`--check` 映射、正式写入前执行 TypeScript 检查） |
| [`scripts/batch-fast-wechat.ts`](scripts/batch-fast-wechat.ts) | 单窗口多标签批处理引擎、原生复制粘贴调度、保存与独立重开复验 |
| [`scripts/draft-state.ts`](scripts/draft-state.ts) | 双源扫描、SHA-256 指纹、原子状态合并、进程互斥锁与候选 ID 防重 |
| [`scripts/article-content.ts`](scripts/article-content.ts) | Markdown 渲染、原生选区重试、逐图直传与 32×32 像素顺位校验 |
| [`scripts/editor-input.ts`](scripts/editor-input.ts) | 任务自有空白标签原生 HTML 复制粘贴与新正文替代轮询 |
| [`scripts/editor-mode.ts`](scripts/editor-mode.ts) | 普通长文可见性/可编辑性守卫，拦截图片轮播消息隐藏镜像 |
| [`scripts/editor-features.ts`](scripts/editor-features.ts) | 完整原题 H1、2.35:1 封面裁剪选择、原生 `mp-common-profile` 名片与巡检 |
| [`scripts/verify-article.ts`](scripts/verify-article.ts) | 推文真实性、论文标题、DOI/arXiv/原文链接与图片核查（`bun run verify`） |
| [`scripts/set-titles.ts`](scripts/set-titles.ts) | 15 字短标题校验与安全合并工具（`bun run titles`） |
| [`scripts/wechat-article.ts`](scripts/wechat-article.ts) | 单篇独立发布命令行工具（`bun run article`） |
| [`.env.example`](.env.example) | 环境变量配置模板（复制为 `.env` 即可快速定制你的账号与目录） |
| [`references/`](references/operations.md) | 详细操作手册、故障排查、配置说明、独立测试矩阵与验证记录 |
| [`NOTICE`](NOTICE) / [`LICENSE`](LICENSE) | MIT 开源协议及上游归属声明 |

---

## 安全边界与注意事项

- **会话时效**：公众号网页端登录 Cookies 存在有效期，平台风控或长期不用后会过期，**不存在“永久免登”**；失效时会提示人工在专用浏览器重新扫码。
- **不代点群发**：代码只触发 `#js_submit` 保存草稿按钮，绝不触碰发表或群发。
- **隐私隔离**：`.gitignore` 已默认忽略 `.env`、`data/`、`cache/`、`chrome-profile/`、`wechat-draft-history.json`、`tests/reports/`、`tests/private/` 等全部私有路径；提交前仍建议审计暂存区。

---

## 开源许可与致谢

- 本项目采用 **[MIT License](LICENSE)** 开源，欢迎遵循 [CONTRIBUTING.md](CONTRIBUTING.md) 参与共建。
- CDP 通信与 Markdown 转换基础源自 [baoyu-skills](https://github.com/JimLiu/baoyu-skills)（Jim Liu，MIT License）与 [doocs/md](https://github.com/doocs/md)（Doocs，WTFPL License），详见 [NOTICE](NOTICE)。
