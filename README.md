# 微信公众号草稿编辑技能

把 Markdown 文章保存到微信公众号草稿箱，支持已有草稿的正文更新、图片上传、完整原题 H1、作者、封面和原生公众号名片。通过宝玉 Chrome CDP 路线复用本机浏览器登录态，仅保存草稿。

统一入口是 `bin/launch-publisher.mjs`。旧的批处理和同步入口转发到同一套状态引擎，避免多份扫描器各自维护文章映射。

## 安装与运行

本轮现场验证环境为 Windows、Edge、Node.js 24 和 Bun 1.4。其它平台尚未完成同等现场验证。

```bash
git clone https://github.com/ruiduobao/wechat-mp-publisher-skill.git
cd wechat-mp-publisher-skill
bun install
bun run typecheck
bun run test
node bin/launch-publisher.mjs --check
```

`--check` 等价于 `--dry-run`：只读扫描来源与状态，不写历史、锁、基线，不连接浏览器。缺少语义短题时列出 `needs-title` 并继续预检其它文章；正式写入仍严格校验标题。正式运行前启动器自动执行 TypeScript 检查，失败即停止。

此仓库是已配置账号的运行代码，首次克隆仍需核对来源、私有状态路径、专用浏览器及名片配置。基线不存在时，当前已扫描文章会被视为待核对历史，避免将已有文章重新建稿。不要为绕过这一保护而清空真实基线。完整操作步骤见[日常操作手册](references/operations.md)。

```bash
# 单篇按已识别的文章身份处理，已有 appmsgid 时原地更新
node bin/launch-publisher.mjs --id muse:20261111_2020:01 --title-override "语义短标题"

# 仅修补已有普通长文的标题、作者、封面、名片
node bin/launch-publisher.mjs --repair --id <articleId>

# 明确重建已有普通长文的完整正文与图片
node bin/launch-publisher.mjs --refresh-content --id <articleId>

# 批量处理，使用私有外题映射 articleId -> 短标题
node bin/launch-publisher.mjs --titles <private-titles.json>
node bin/launch-publisher.mjs --help
```

本账号新列表标题按文章语义提炼至 15 字以内。正文开头始终保留完整原标题 H1。旧外题默认保留，确认有误时显式指定新标题。`articleId` 是 `source:batch:prefix`，与微信数字 `appmsgid` 不同。

## 实际编辑与验收

- 复用专用 Profile 和登录主页，按 Profile 动态查找调试端口；每篇仅管理本任务的编辑、复制和复验标签。
- 写入前确认准确的正文 `.rich_media_content .ProseMirror` 可见且可编辑。图片轮播消息会留有隐藏的长文编辑器，不能将它当成空稿。
- 完整正文先在任务自有空白标签中准备，再用原生复制和粘贴键交给微信编辑器处理。检查真实 HTML 粘贴事件、正文文本和图片占位符，避免继承旧首段 H1 格式。
- 本地正文图逐个上传，在准确位置核验新图为已加载的微信 CDN 素材。定位文字通过编辑器输入删除；保存前拒绝残留标记。
- 封面可以复用有效封面、选择正文图或使用独立文件。无正文图合法，封面不插进正文充数。
- 名片要求真正的 `mp-common-profile`，账号身份正确，位于正文末尾。
- 保存取得 ID 后立即保全为 `saved-unverified`，随后独立新标签重开同一 ID，检查正文文字、图片顺序及加载、唯一首位 H1、作者、外题、封面和原生名片。微信把同一素材的 `/0` 改为 `/640` 时按素材身份比较。

按钮、toast、编辑态 DOM 和保存回包均不能单独算成功。完整正文复验通过才记录已应用指纹；元数据修复不会把源正文标为已应用。未完成全量更新会持久化待完成标记，重跑继续原稿全量更新；自动保存身份尚未确认时先保全候选 ID，阻止再次新建。

## 来源和私有数据

默认 Muse 来源为 `F:\同步文件夹\公众号\每日推文`，本地独立来源为 `Z:\自媒体\公众号\每日推文`。发布只读访问两处来源。状态、缓存、封面、登录 Profile、名片模板和报告保存在独立私有目录。

历史坏 JSON、缺图、未稳定文件、旧基线缺映射均明确停止或报告待核对，保留已有草稿 ID。不要清库或删除基线来强行重建文章。

登录态有有效期；过期后报告需要续期。平台编辑器改变时仍需重新验证。代码不会代替用户发表、群发文章。

## 代码与说明

| 文件 | 用途 |
|---|---|
| `SKILL.md` | Agent 执行入口和验收规则 |
| `scripts/batch-fast-wechat.ts` | 单篇与批量编辑、保存、独立复验 |
| `scripts/draft-state.ts` | 双源扫描、指纹、历史合并、进程锁 |
| `scripts/article-content.ts` | Markdown 渲染、原生粘贴、正文图片 |
| `scripts/editor-input.ts` | 任务标签中的原生 HTML 复制粘贴 |
| `scripts/editor-mode.ts` | 普通长文类型及可编辑性检查 |
| `scripts/editor-features.ts` | H1、封面、原生名片及巡检 |
| [日常操作](references/operations.md) | 环境、预检、标题映射、封面、单篇和批量执行、恢复 |
| [故障排查](references/troubleshooting.md) | 常见失败原因、自动保存、防重和处理边界 |
| [独立测试](references/testing.md) | 子 agent 复现步骤、离线与现场验收矩阵 |
| [本轮验证状态](references/validation-status.md) | 实际初审、修复、离线结果及独立现场验收状态 |
| `references/editor-reliability.md` | 已实测故障与定位规则 |
| `references/configuration.md` | 依赖、路径、环境变量 |
| `references/cron-scheduling-prompt.md` | 每日 08:00 / 20:00 调度约定 |

真实文章、状态映射、凭据、截图、报告和现场诊断脚本均不提交公开仓库。忽略规则不能代替提交前内容审核。

## 归属

本项目采用 [MIT License](LICENSE)。CDP 与 Markdown 基础源自 [baoyu-skills](https://github.com/JimLiu/baoyu-skills) 和 [doocs/md](https://github.com/doocs/md)，详见 [NOTICE](NOTICE)。
