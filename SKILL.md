---
name: wechat-mp-publisher
description: >-
  微信公众号推文排版与全流程自动推送到草稿箱技能。支持 Markdown 自动转微信排版、单窗口多标签无感批量录入、不超过15字标题自动精炼、全流程空行深度净化、论文原图高清替换、及多目录增量推文草稿箱同步。当用户提到“发布公众号”、“公众号推文排版”、“存入草稿箱”、“批量推草稿”、“同步推文到微信”、“公众号草稿箱同步”时使用。
---

# 微信公众号自动化发布与草稿箱同步技能 (WeChat MP Publisher)

专为 AI Agent、技术自媒体团队及科研博客打造的**微信公众号全流程自动化排版与批量草稿箱录入技能**。基于 Chrome/Edge CDP 浏览器协议深度驱动，实现**免微信开放平台认证、免 AppSecret、免配置出口 IP 白名单**的全自动发布。

---

## 🌟 核心特性与架构亮点

1. **单窗口多标签页常驻流水线（彻底告别重复开窗与重复扫码）**
   - 浏览器常驻后台公众号主页（`cgi-bin/home`）；
   - 批量录入时，在同窗口内点击“文章”唤起新标签页，完成正文填充、图片挂载与草稿保存后**立即自动销毁编辑标签页**，瞬间回到主页切入下一篇；
   - 首次扫码后登录态永久持久化在独立 Profile 中，后续批量推送 100% 自动运行，全程零人工干预。

2. **标题严格限制（≤ 15 个汉字）**
   - 内置智能精炼压缩引擎，自动剔除冗长的期刊前缀、标点符号、期卷信息及营销口吻；
   - 严格锁定标题在 15 个汉字以内，超长自动提炼核心主干（如团队名称+技术突破），确保在微信移动端各列表展现时标题一目了然且不被折叠截断。

3. **全流程空行深度净化（杜绝异常留白）**
   - **Markdown 语法层**：自动压缩连续空行，清除引用块、列表内部的多余空行；
   - **HTML 结构层**：正则清除任何空白的 `<p><br></p>` 或 `&nbsp;` 容器；
   - **ProseMirror 核心 DOM 扫除**：在微信编辑器灌入富文本后，通过原生 DOM 遍历直接清除无文本、无图片的空白块级节点，彻底消灭微信端因空行造成的视觉脱节。

4. **双源目录增量同步与去重追踪**
   - 原生支持扫描多个推文来源（如外部同步目录 `F:\同步文件夹\公众号\每日推文\` 与 本地独立生成目录 `Z:\自媒体\公众号\每日推文\`）；
   - 内置 `wechat-draft-history.json` 状态数据库，记录每篇推文的推送状态与微信返回的 `appmsgid`，杜绝重复录入。

---

## 📂 项目结构规范

```text
wechat-mp-publisher-skill/
├── SKILL.md                          # 技能定义文件 (触发器与操作指南)
├── README.md                         # 详细中英文开源文档
├── package.json                      # 依赖与脚本定义
├── tsconfig.json                     # TypeScript 配置
├── .gitignore                        # Git 忽略配置
├── scripts/
│   ├── batch-fast-wechat.ts          # 【核心】单窗口多标签批量录入器 (≤15字标题 + 深度去空行)
│   ├── sync-wechat-drafts.ts         # 多目录推文定时扫描与增量同步管理器
│   ├── wechat-article.ts             # 单篇推文全能发布驱动脚本
│   ├── md-to-wechat.ts               # Markdown 转微信富文本渲染器
│   ├── build-wechat-html.mjs         # 独立内联 HTML 合成与 Base64 嵌入工具
│   ├── cdp.ts                        # 浏览器 CDP 通信、多标签生命周期与文件直传底层
│   ├── wechat-image-processor.ts     # WebP/PNG/JPEG 本地图片预处理模块
│   └── wechat-extend-config.ts       # 多账号与自定义偏好配置加载器
├── references/
│   ├── architecture.md               # 架构设计与 CDP 驱动原理
│   ├── configuration.md              # 浏览器路径、Profile 与环境变量配置
│   └── title-and-spacing-rules.md    # 15字标题与排版防空行规则详解
└── assets/
    └── .gitkeep                      # 模板及静态资产目录
```

---

## 🚀 核心工作流与使用指引

### 1. 批量将本地推文一次性推入草稿箱（推荐）

在当前浏览器会话中开启多标签并发流水线，自动扫描本地及同步目录，按顺序推入公众号草稿箱：

```bash
cd scripts
bun run batch-fast-wechat.ts
```

运行特性：
- 自动读取所有未入库推文；
- 原文标题自动压缩为 `<= 15` 字精简版；
- 全自动剔除文章中的所有多余空行；
- 依次上传并替换文章中的本地高清图片；
- 单标签存入草稿箱并获取微信 `appmsgid` 后自动关闭标签，循环进入下一篇。

### 2. 单篇推文直接发布到草稿箱

针对单篇 Markdown 文档进行测试或临时推送：

```bash
cd scripts
bun run wechat-article.ts --markdown "/path/to/article.md" --title "精炼标题" --submit
```

可选参数：
- `--theme <name>`：主题样式，支持 `default`、`grace`、`simple`、`modern`；
- `--color <hex>`：主色调配置（如 `#d97758` 暖橙色）；
- `--author <name>`：署名作者；
- `--submit`：自动点击“保存为草稿”（若不加则保留在打开的编辑页供人工确认）。

### 3. 多目录增量同步与去重检查

检查哪些文章尚未推送到微信草稿箱（支持干跑预览）：

```bash
cd scripts
# 仅列出待推送清单，不执行实际操作
bun run sync-wechat-drafts.ts --dry-run

# 仅同步最近 2 天内的新推文
bun run sync-wechat-drafts.ts --days 2

# 指定同步特定批次文件夹
bun run sync-wechat-drafts.ts --batch 20261110_0700
```

---

## ⚙️ 环境依赖与前置准备

1. **运行时**：
   - [Bun](https://bun.sh/)（推荐，`bun install` 极速安装）或 Node.js ≥ 20；
2. **浏览器支持**：
   - 自动检测并兼容本地已安装的 **Google Chrome** 或 **Microsoft Edge**；
   - 首次使用时会自动弹出授权窗口，用微信公众号管理员手机扫码一次即可；
   - 凭证将自动持久化保存在 `%APPDATA%\baoyu-skills\chrome-profile`，永久有效。
