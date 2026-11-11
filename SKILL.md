---
name: wechat-mp-publisher
description: 将 Markdown 文章保存到微信公众号草稿箱，或按已有草稿 ID 更新正文、图片、完整原题 H1、作者、封面和原生公众号名片。支持 Muse 与本地目录增量同步；用于保存草稿和原稿修补，不执行群发。
---

# 微信公众号草稿编辑

使用本技能的统一入口 `bin/launch-publisher.mjs`。本机代码库为 `C:\Users\Administrator\wechat-mp-publisher-skill`；已安装技能目录只负责路由到此代码库，不能再复制一套扫描器或发布脚本。

## 直接执行

先检查当前文件和状态，再处理明确的文章身份：

```bash
node bin/launch-publisher.mjs --check
node bin/launch-publisher.mjs --id muse:20261109_1700:04
```

- `--check` 等价于 `--dry-run`，只读扫描，不写历史、不建基线、不触碰浏览器。
- 默认根据已应用/已观察指纹选择原稿修补、正文更新、新稿或跳过。已有 ID 必须原地更新。
- 仅补 H1、作者、封面、名片：`--repair --id <articleId>`，保留现有正文和 CDN 图片。
- 明确重建已有普通长文：`--refresh-content --id <articleId>`，渲染完整源文，通过原生 HTML 复制粘贴写入完整原题和正文，再逐图上传。临时复制页仅包含本次排版，复制后关闭；操作会覆盖系统剪贴板，不读取用户原剪贴板。
- 标题修补也走原生输入。发现多个 H1 或 H1 包裹实质正文时，报告 `needs-content-refresh`，按源文在原草稿重建，不能直接删改 DOM 伪造修复。
- 外题使用 `--title-override "准确短标题"`（单篇）或 `--titles <private.json>`。本账号新外题不超过 15 字，按语义提炼；正文 H1 始终保留完整原题。旧外题默认保留，已确认科学表述错误时显式修正。
- 不清空历史、不移除旧基线来强行建稿。历史缺映射先按真实正文或论文身份核实候选。
- “最新一篇”先比较当前两个来源的批次时间和文件修改时间，排除汇总/纯文字变体，选定身份后用 `--id` 执行。源文件已对应草稿时复用它，不新建副本。

查看所有可用参数：`node bin/launch-publisher.mjs --help`。只使用帮助中实际存在的参数。

## 执行前必须分清的情况

1. **消息类型**：普通长文的正文是可见、可编辑的 `.rich_media_content .ProseMirror`。图片轮播消息（如 `item_show_type=8`）也可能留有隐藏的同名编辑器；其中“从这里开始写正文”不代表空稿。统一入口在任何编辑写入前检查类型，遇到隐藏正文/图片消息保留原稿并报告 `unsupported-message-type`。检查是否另有同篇普通长文，不能改 CSS、隐藏类型值或向镜像 DOM 注入来冒充成功。
2. **浏览器**：复用宝玉路线的专用 Edge/Chrome Profile 和已有登录主页，逐篇创建本任务编辑标签。调试端口按 Profile 动态查找，WebSocket 地址取实际 `/json/version` 返回值。会话过期报告 `needs-attention`；不杀无关浏览器、不反复开窗、不弹二维码图片。
3. **状态与源文件**：Muse 位于 `F:\同步文件夹\公众号\每日推文`，本地独立产文位于 `Z:\自媒体\公众号\每日推文`。发布只读访问源文，cache、封面、状态、截图写私有目录。缺图/同步未稳定/坏 JSON 必须保留 ID 并明确报告。
4. **配置**：读取本机的私有封面映射及已验证原生名片模板。无正文图是合法情况；可使用独立封面文件，不得为选封面而向正文插图。配置、登录态、原文和验收报告不提交公开仓库。

运行时与路径配置见 [references/configuration.md](references/configuration.md)。日常调度见 [references/cron-scheduling-prompt.md](references/cron-scheduling-prompt.md)。

## 成功判定

由统一入口完成保存，并在**独立新标签中打开同一草稿 ID**核验：

- 第一元素为完整原题 H1，文本正确且只出现一次；作者正确。
- 封面为实际非空图片 URL，裁剪选择在重开后仍保留。
- 正文末尾是真正的 `mp-common-profile`，昵称和账号 ID 与私有配置一致；可视仿制卡片不能通过。
- 原稿修补保留正文与原图；完整更新的图片数量准确、全部加载、无本地路径和残余占位符。重开后正文文字和图片顺序与保存前一致；同一微信素材的 `/0` 与 `/640` 尺寸变化不算丢图。
- 外题与本次选择一致，重开 ID 与保存 ID 相同。

点击、toast、编辑态 DOM、保存回包均不能单独算完成。保存后立即保全 ID；复验失败标 `saved-unverified`。元数据修补只记录特性修复指纹，不能晋升未实际更新的正文指纹。

封面选择、名片和实际故障处理见 [references/editor-reliability.md](references/editor-reliability.md)。

## 修改本技能后的检查

```bash
bun run typecheck
bun run test
```

统一启动器在正式写入前运行类型检查；失败时停止。修改编辑流程还需对已授权的真实草稿执行一次保存与独立重开验证，记录实际结果和源码版本。离线测试通过不能代替网站实测。新窗口、登录过期、平台改版等真实限制要明确报告，不能承诺永久免登或无条件成功。
