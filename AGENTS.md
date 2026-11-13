# AGENTS.md

本仓库为微信公众号（草稿箱）Markdown 排版与同步的权威代码库（`wechat-mp-publisher-skill`）。任何 AI Agent 在本仓库开发、测试或执行草稿同步时，必须遵循以下规范。

## 1. 唯一执行入口

始终通过统一启动器执行（正式写入前自动运行 `tsc --noEmit`；支持根目录 `.env` 自动加载）：

```bash
# 第一件事：先核对推文真实性（论文标题、Crossref/doi.org DOI、arXiv、原文链接与本地图片）
bun run verify
node bin/launch-publisher.mjs --check --verify

# 只读预检、关键词搜索与最新定位（不写状态、不触碰浏览器）
node bin/launch-publisher.mjs --check
node bin/launch-publisher.mjs --check --search "关键词"
node bin/launch-publisher.mjs --check --latest

# 安全合并 ≤15 Unicode 字符语义外题（不覆盖既有映射、坏 JSON 拒写）
bun run titles "<articleId>=<≤15字短标题>"

# 正式保存至草稿箱（仅保存草稿，绝不发表/群发）
node bin/launch-publisher.mjs --id <articleId> --title-override "<≤15字短标题>"
node bin/launch-publisher.mjs --refresh-content --id <articleId>
node bin/launch-publisher.mjs --repair --id <articleId>
node bin/launch-publisher.mjs --titles "<path/to/titles-override.json>"
```

- 禁止复制或另写旁路发布脚本；`scripts/sync-wechat-drafts.ts` 与 `package.json` 的 `start`/`batch` 仅转发到 `bin/launch-publisher.mjs`。
- 只使用 `node bin/launch-publisher.mjs --help` 实际提供的参数。

## 2. 核心规则与不可逾越的红线

1. **草稿箱边界**：仅点击 `#js_submit` 保存草稿，绝不触发发表、群发或通知关注者，绝不擅自删除历史草稿。
2. **第一件事核查推文真伪**：正式 `CREATE`/`CONTENT-UPDATE` 前默认执行 `verifyArticleTruth`；遇 404 假 DOI、DOI/arXiv 标题张冠李戴、死链、0 字节图或占位符残留直接拦截阻断；遇 403/无链接警告时须联网核实真伪再同步。
3. **双源隔离与只读保护**：外部同步源（`WECHAT_MUSE_ROOT`）与本地独立源（`WECHAT_LOCAL_ROOT`）保持独立且发布严格只读；状态、缓存、封面、原生名片模板、截图与报告留在私有目录，**绝不写入源目录或提交公开仓库**。
4. **双层标题**：列表外题新文严格 ≤ 15 字符且按语义提炼；正文首元素保留唯一、完整、未截断的一级标题 `<h1>`。
5. **零缩进与零空行**：
   - `prepareMarkdownWithAbsoluteImages` 剥离非代码块正文段落与列表行首多余缩进（空格/Tab/`\u3000`/`\u00A0`），保留代码块缩进与合法行尾两空格硬换行；
   - `sanitizeWechatHtml` 归零 `<p>`、`<ul>`、`<li>` 水平边距与 `text-indent`，去除 `&nbsp;` 前导空格与空容器；
   - `injectHtmlIntoProseMirror` 展开外层 `section.container` 避免 `<h1>` 后产生隔离空段；
   - 上传图片后如锚点段落变空立即原生折叠，保存前调用 `cleanupEmptyParagraphsNatively` 通过原生 `Backspace`/`Delete` 清除 H1 后、图片前后、正文内与名片前多余空段；禁止直接调用 `el.remove()` 伪造清理。
6. **消息类型与已定时草稿守卫**：编辑前调用 `assertArticleEditor`；遇图片轮播（`item_show_type=8`）、隐藏长文镜像或已设置定时发表（`ret=320005`）的草稿，调用 `recordUnsupportedDraft` 保留原 ID 并记忆跳过（显式 `--id` 仍可单篇检查），绝不强行改 CSS、隐藏 type 或另建副本。
7. **原生事务与独立重开复验**：
   - 正文通过任务自有空白标签原生复制 HTML + 粘贴（轮询等待规范化新正文真正替换旧正文）；
   - 图片占位符通过原生选区重试 + `Input.insertText` 替换并校验全篇文本精确差值；
   - 保存取得 `appmsgid` 后先持久化 `saved-unverified`，再新建独立任务标签物理重开同一 ID，校验文本、图片数量/加载/URL或 32×32 RGBA 像素交叉 MAE、零空行、零异常缩进、唯一首位 H1、作者、外题、封面及文末真 `<mp-common-profile>` 名片全部通过后，才可推进 `appliedFingerprint`。
8. **专用浏览器复用**：按专用 Profile 查找端口并用真实 `/json/version` WebSocket；未运行时以独立脱管进程安全拉起，绝不杀其它 Edge、不关用户标签、不自动弹二维码图片。

## 3. 修改代码后的必检命令

```bash
bun run typecheck
bun run test
```

修改编辑或状态逻辑后须通过全部类型检查与离线回归测试，并在真实已授权草稿上完成保存与独立重开复验，确认无新增私有文件或凭据进入 Git 暂存区后再提交推送。详情见 [SKILL.md](SKILL.md) 与 `references/` 下对应手册。
