# 每隔 3 小时从 GitHub 拉取并更新草稿

本机已配置每 3 小时一次的定时任务（`scheduleRule: hourly / 3`，分钟位 `10`）。推文生产端把 `*_本地版.md` 与 `images/**` 推送到私有仓库 `ruiduobao/zimeiti-sync`；本机任务**先拉取**、再核查、拉到新文就**立即**保存公众号草稿。Z: 本地独立生成源保持独立。

任务先读取当前代码库 `SKILL.md` 和本说明，再执行增量拉取、只读预检与前置真实性核查：

```bash
# 1) 增量拉取私有仓库到本地镜像（仅 *_本地版.md 与 images/**；令牌读私有 .env）
node "C:/Users/Administrator/wechat-mp-publisher-skill/scripts/sync-from-github.mjs"

# 2) 只读预检 + 在线真实性核查
node "C:/Users/Administrator/wechat-mp-publisher-skill/bin/launch-publisher.mjs" --check --verify
```

拉取失败（网络/TLS/鉴权）必须如实报告并停止，**不得**把拉取失败当作“没有新推文”。预检与核查纯读，不建锁、不写历史/基线、不触碰浏览器。没有可执行工作就退出。

**每次有同步文件时，第一件事就是核对推文真实性**：通过 `bun run verify` / `--check --verify` 核实论文是否存在、DOI (Crossref/doi.org) 与 arXiv 编号解析出的真实标题是否与推文一致、原文链接是否可达、本地图片无损坏。遇到 404、标题不符或 403/无 DOI 警告时，**必须进一步前往期刊/出版社/arXiv/Dryad 官方网站二次核实**：若官网证实为刚上线尚未同步至 `doi.org` 的真实 DOI（或仅遇反爬 403），核实无误后可显式 `--id <articleId> --skip-verify` 同步；若官网核对出可据实修正的明确笔误，先在私有 `content-corrections.json`（`{ articleId: [{ find, replaceWith, note }] }`，内存逐字替换、源文件只读、审计日志、坏 JSON fail-closed）登记修正并复验通过，再同步至草稿箱；仅对官网查无此文、假造或无法修正核实的文章坚决拦截，绝不写入草稿箱。

有就绪任务时：

1. 先为新外题按语义拟定15字以内标题，使用 `bun run --cwd "C:/Users/Administrator/wechat-mp-publisher-skill" titles "<articleId>=<≤15字短标题>"` 原子校验并合并至私有 `titles-override.json`（禁止直接覆盖，不能机械截断，不能把完整长题直接保存为新外题）。
2. 正文无图且缺封面的文章可执行本机私有 `generate-covers.py`，产物留在私有目录。已有封面复用，独立封面不插正文充数。
3. 使用统一启动器**立即**正式执行（支持 `--search` 与 `--latest` 筛选），不要攒批次等下一轮。启动器先做 TypeScript 检查；失败不编辑。旧同步入口仅转发到启动器。

```bash
node "C:/Users/Administrator/wechat-mp-publisher-skill/bin/launch-publisher.mjs" --titles "C:/Users/Administrator/.agents/skills/wechat-md-pipeline/data/titles-override.json"
```

仅元数据修补可用 `--repair --id <articleId>`；完整源文或图片变更用原 ID 的完整路径，显式重建用 `--refresh-content --id <articleId>`。图片轮播消息及隐藏长文镜像不支持该路径，保留并报告待处理。不要改 CSS、隐藏类型或另建替代来冒充更新。

任何新旧稿都须保存后独立新标签重开同一 ID，条件轮询等待加载后检查完整首位唯一 H1、作者、外题、封面、末尾正确原生名片、正文文字、零多余空行与零异常段落缩进，以及图片数量/顺序/加载（若微信服务端对同一素材去重或重签名换了 URL 路径，自动采用 32×32 RGBA 内存像素交叉 MAE 验证）。微信自动保存所得 ID 也应先核对保全。只对通过复验的完整正文记录 appliedFingerprint，元数据修复不推进它。

保留进程锁、坏 JSON 失败关闭、缺图保留映射、历史合并和基线防重机制。严禁清库、删除旧基线或覆盖新 ID。GitHub 镜像 / Z: 源树发布只读；缓存、状态、封面、报告、模板在私有目录。

复用专用浏览器主页，按 Profile 查端口；若未运行则以脱管常驻进程安全拉起专用 Profile 浏览器；不杀其它 Edge、不关闭用户标签、不反复新开窗口、不弹二维码图片。登录过期报告需要续期。只保存草稿，不发表、群发或通知关注者。

报告本次 GitHub 拉取结果（提交/文件数/失败原因）、真实扫描数、新增/更新成功数、已验证跳过数、待核对、缺图、特殊消息类型和失败项。未复验通过保持未验收。日志脱敏，私有正文/状态/截图不进公开仓库。验收记录随实际结果更新，不把历史固定篇数当作当前总数。
