---
name: wechat-mp-publisher
description: 保存或更新微信公众号普通长文草稿，包含 Markdown 排版、本地图片、完整原标题 H1、作者、封面和原生公众号名片。用户说“更新公众号”“同步 Muse 推文”“存草稿”“修复封面名片”或要求检查发布管线时使用。支持双源增量和已有草稿原地更新；交付止于草稿箱。
---

# 微信公众号草稿编辑

本机权威代码库为 `C:\Users\Administrator\wechat-mp-publisher-skill`，唯一入口为 `bin/launch-publisher.mjs`。两处已安装同名技能链接到该代码库；不要复制另一套扫描器和状态库。更换设备时先读 [configuration.md](references/configuration.md) 核对本机路径和私有依赖。

## 先检查，再编辑

1. 读取 [operations.md](references/operations.md) 与实际 CLI 帮助。定时任务同时读 [cron-scheduling-prompt.md](references/cron-scheduling-prompt.md)。
2. 执行只读预检：

```bash
node "C:/Users/Administrator/wechat-mp-publisher-skill/bin/launch-publisher.mjs" --check
```

`--check` 等价于 `--dry-run`，不写历史/锁/基线，不触碰浏览器。列出 `needs-title` 时先补短题，不把它当成正文损坏。没有可执行任务就报告退出，仅能说明 PC 当前索引。

3. 为新文按内容生成15字以内语义外题，合并到私有 `titles-override.json`（`articleId -> 短标题`）；英文、数字、连字符也计数。完整原题仍在正文首位 H1 保留。现有外题默认不改，确认有误才显式指定。既有标题映射先读取，坏 JSON 停止修复，不覆盖成空字典。
4. 核对正文图片完整性与独立封面。无正文图合法，缺封面可准备独立 PNG/JPEG；本机私有 `generate-covers.py` 可用，但不随公开仓库分发。不能为选封面往正文塞图。
5. 执行明确范围，保存后独立重开验收。

## 命令选择

`articleId` 是 `source:batch:prefix`；微信数字 `appmsgid` 是远端草稿 ID，两者不同。

```bash
# 按指纹选择新建、原地更新或跳过
node bin/launch-publisher.mjs --id muse:20261112_0700:01 --title-override "全球野火年度遥感观察"

# 仅修补 H1、作者、外题、封面、名片，保留正文与原图
node bin/launch-publisher.mjs --repair --id <articleId>

# 明确从干净源文重建已有普通长文，仍使用原草稿 ID
node bin/launch-publisher.mjs --refresh-content --id <articleId>

# 批量任务
node bin/launch-publisher.mjs --titles "C:/private/titles-override.json"
```

只使用 `--help` 实际提供的参数；没有 `--covers` 参数。正式写入前启动器执行 TypeScript 检查，失败即停止。

“最新一篇”先比较两个来源当前批次与文件修改时间，排除汇总/纯文字变体，再用明确 ID 处理。已有映射原地更新；旧基线无映射先核对真实正文、论文与图片，不清历史、删基线或另建替代。

## 编辑器与来源约束

- 普通长文正文必须是可见可编辑的 `.rich_media_content .ProseMirror`。标题/摘要可能也有 ProseMirror，图片轮播消息还会保留隐藏长文镜像；“从这里开始写正文”不代表真实空稿。遇到 `unsupported-message-type` 保留并报告，不改 CSS 或隐藏类型。
- 复用宝玉 browser 路线专用 Profile 和主页，按 Profile 查端口，使用实际 WebSocket。仅关闭本任务标签；不杀其它 Edge、不关闭用户标签、不反复开窗或弹二维码图片。公众号登录续期和子 agent 模型服务鉴权分开报告。
- Muse 来源 `F:\同步文件夹\公众号\每日推文` 与本地独立来源 `Z:\自媒体\公众号\每日推文` 保持分离且发布只读。缓存、状态、封面、模板、日志与截图留在私有目录。
- 完整正文通过原生 HTML 复制粘贴交给微信编辑器，复制页仅包含本次内容，复制后关闭；这会覆盖系统剪贴板，不读取原剪贴板。逐图准确替换占位符，检查原生输入后的正文比对。残留占位符时停止，不直接改 `textContent` 或 `innerHTML` 假装修复。
- 发现多个 H1 或 H1 包含实质正文时，报告 `needs-content-refresh`，按源文原 ID 重建。原生名片必须是真正 `mp-common-profile`，身份正确并居尾；可视 div 不能替代。

现场规则见 [editor-reliability.md](references/editor-reliability.md)，按错误恢复见 [troubleshooting.md](references/troubleshooting.md)。

## 成功判定与报告

保存取得 ID 后先保全 `saved-unverified`，再从独立新标签读取同一 ID：

- 首位唯一完整原标题 H1，作者和外题正确。
- 正文文字与保存前一致，没有占位符、定位标记或本地图片路径。
- 图片素材身份、顺序及数量正确，全部加载。合法 qpic 同素材 `/0` 与 `/640` 显示尺寸可规范化，其它素材路径和顺序不放宽。
- 封面实际非空，末尾正确原生名片仍存在。

自动保存、按钮、toast、编辑态 DOM、回包均不能单独算完成。失败时先持久化自动保存候选 ID，再独立核对；身份核对失败保留候选并阻止重复新建。完整写入未验收保留 `pendingContentUpdate`，重跑继续原 ID 全量更新，不能降级为元数据修补后跳过。元数据修补只推进特性修复记录；完整正文和图片真实保存并复验通过后才能推进 `appliedFingerprint`。

汇报本次唯一新增成功、已有稿更新、原有已验证跳过、待核对、缺图、特殊类型与未验收。新文先失败后修补成功仍只算一篇新增；不要把有 ID 等同于完整源内容已应用，也不要沿用历史固定篇数。

只保存草稿，不发表、群发或通知关注者。源文、映射、名片模板、截图与凭据不进入公开仓库。

## 更新技能后的独立验证

先执行类型检查和回归，再按 [testing.md](references/testing.md) 让独立子 agent 在不参与实现的条件下测试。测试者先读文档，自行记录命令与退出码；真实测试选已有映射的普通长文，分别覆盖多图与零图稿，原 ID 保存并独立重开。主 agent 在测试期间暂停浏览器写入及相关代码改动。

```bash
bun run typecheck
bun run test
```

明确报告实测覆盖和未覆盖能力。子 agent 启动失败不能算独立测试通过；离线通过不能代替网站实测。登录过期或平台变化时明确停止，不承诺永久免登或无条件成功。
