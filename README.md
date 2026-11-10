# 微信公众号自动化发布与批量草稿箱技能 (WeChat MP Publisher Skill)

<p align="center">
  <img src="https://img.shields.io/badge/Node-%3E%3D20-green.svg" alt="Node" />
  <img src="https://img.shields.io/badge/Bun-%3E%3D1.4-orange.svg" alt="Bun" />
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License" />
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg" alt="Platform" />
  <img src="https://img.shields.io/badge/Protocol-Chrome%20CDP-red.svg" alt="CDP" />
</p>

专为 **AI Agent、个人自媒体创作者及科研团队** 打造的微信公众号自动化发布与草稿箱同步技能包。基于 **Chrome/Edge CDP 原生协议驱动**，无需调用任何第三方收费 API，无需申请微信开放平台企业认证，免除 AppSecret 和公网固定 IP 白名单限制，全自动完成从 Markdown 到公众号草稿箱的端到端交付。

---

## 🌟 核心优势与特色功能

- 🚀 **单会话多标签流水线（彻底告别重复开窗与弹窗扰民）**：
  浏览器后台常驻微信公众平台主页，每次发布通过新建标签页录入，录入保存后立即自动关闭标签页并切入下一篇。
- 📱 **首次扫码永久免登**：
  独立专属 Profile 持久化存储微信认证 Cookie，扫码一次后长期生效，后续批量发布完全静默运行。
- ✂️ **推文标题严格限制（≤ 15 汉字）**：
  内置智能精炼提取算法，自动剔除冗长的期刊前缀、标点符号与修饰词，保证移动端列表展示一目了然且不被折叠截断。
- 🧹 **全流程空行深度净化（杜绝异常留白）**：
  Markdown 源码清洗 + HTML 空容器正则剔除 + ProseMirror 编辑器内原生 DOM 遍历大扫除，消灭多余空白段落。
- 🖼️ **本地原图 CDP 级直传**：
  直接通过底层 `DOM.setFileInputFiles` 上传，精准替换 Markdown 图片占位符，支持高清大图，告别系统剪贴板冲突。
- 🔄 **双源推文自动扫描与增量去重**：
  原生支持同时扫描外部同步目录（如 Syncthing 同步的推文）与本地自主生成的推文批次，内置状态数据库自动过滤已推文章。

---

## 🛠️ 安装与快速开始

### 1. 克隆代码仓库

```bash
git clone https://github.com/ruiduobao/wechat-mp-publisher-skill.git
cd wechat-mp-publisher-skill
```

### 2. 安装依赖

推荐使用 [Bun](https://bun.sh/)（秒级安装）：

```bash
bun install
```

*(也可以使用 npm/pnpm)*：
```bash
npm install
```

### 3. 一键批量推入公众号草稿箱

扫描本地推文目录，将所有未推送过的推文依次批量写入公众号草稿箱：

```bash
bun run batch
```

---

## 📖 核心命令与用法

### 1. 批量多标签推流 (`batch-fast-wechat.ts`)
```bash
bun run scripts/batch-fast-wechat.ts
```
- 全自动扫描历史所有批次；
- 自动净化空行；
- 自动精炼标题至 ≤15 汉字；
- 单标签开启 -> 录入 -> 保存草稿 -> 关标签循环。

### 2. 多源增量同步调度 (`sync-wechat-drafts.ts`)
```bash
# 仅预览待推送清单，不执行任何写操作
bun run scripts/sync-wechat-drafts.ts --dry-run

# 仅同步最近 2 天内的最新推文
bun run scripts/sync-wechat-drafts.ts --days 2

# 指定同步特定批次文件夹
bun run scripts/sync-wechat-drafts.ts --batch 20261110_0700
```

### 3. 单篇推文精细化推送 (`wechat-article.ts`)
```bash
bun run scripts/wechat-article.ts --markdown "article.md" --title "精炼标题" --submit
```

可选参数：
- `--theme <name>`：内置排版主题，可选 `default`、`grace`、`simple`、`modern`；
- `--color <hex>`：主强调色（如 `#d97758`）；
- `--author <name>`：作者署名；
- `--submit`：自动保存为草稿（缺省则停留在编辑页供目视确认）。

---

## 📋 目录架构

```text
wechat-mp-publisher-skill/
├── SKILL.md                          # ZCode / Claude Code 技能规范定义
├── README.md                         # 本开源项目说明
├── package.json                      # 项目包配置与脚本快捷指令
├── tsconfig.json                     # TypeScript 编译配置
├── .gitignore                        # Git 忽略配置
├── scripts/
│   ├── batch-fast-wechat.ts          # 【核心】单窗口多标签批量推送引擎
│   ├── sync-wechat-drafts.ts         # 多目录增量扫描与状态同步调度器
│   ├── wechat-article.ts             # 单篇推文全流程发布脚本
│   ├── md-to-wechat.ts               # Markdown 渲染与占位符提取器
│   ├── build-wechat-html.mjs         # 独立纯内联 HTML 合成工具
│   ├── cdp.ts                        # Chrome/Edge CDP 通信与底层驱动
│   ├── wechat-image-processor.ts     # 本地图片解析与格式转换
│   └── wechat-extend-config.ts       # 多账号与外部配置适配器
└── references/
    ├── architecture.md               # 深度技术架构与 CDP 机制说明
    ├── configuration.md              # 运行环境、路径与多账号指南
    └── title-and-spacing-rules.md    # 15字标题与防空行规则详解
```

---

## 🔒 隐私与安全性

- **零凭据泄露风险**：本工具绝不会将您的任何公众号 AppSecret、密码或 Cookie 传输到任何远程服务器；
- **本地持久化**：所有登录态均以标准 Chromium Profile 格式存储在您本机的 `%APPDATA%\baoyu-skills\chrome-profile` 目录中；
- **安全边界**：本工具**仅保存草稿**，绝不代替用户执行任何“群发发布”操作，最终发布确认权永远在创作者手中。

---

## 📄 开源许可证

本项目采用 [MIT License](LICENSE) 授权开源，欢迎自由使用、修改和分发。
