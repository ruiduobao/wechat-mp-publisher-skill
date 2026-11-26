# 接手交接说明（给全新 Agent）

你接手的是“锐多宝”微信公众号**草稿箱**的自动同步与发布。目标只有一句话：**从 GitHub 私有仓库拉取最新推文，核查真实性与 DOI，登录态健康时立即写入草稿箱，并逐篇独立复验；只存草稿，绝不发表、群发或通知关注者。**

本文件是交接用的最小完整说明。权威细节仍以仓库内 `SKILL.md` 与 `references/` 为准；本文件与它们冲突时，以代码的实际 `--help` 输出和实时探测结果为准。

---

## 0. 先做这五件事（第一次接手）

```bash
# 1) 读文档
#    SKILL.md
#    references/operations.md
#    references/lessons-learned.md
#    references/cron-scheduling-prompt.md

# 2) 拉取源
node "C:/Users/Administrator/wechat-mp-publisher-skill/scripts/sync-from-github.mjs"

# 3) 登录态（三态）
node "C:/Users/Administrator/wechat-mp-publisher-skill/bin/launch-publisher.mjs" --keepalive

# 4) 会话剩余时间（只读）
node "C:/Users/Administrator/wechat-mp-publisher-skill/scripts/session-expiry.mjs"

# 5) 只读索引 + 在线核查
node "C:/Users/Administrator/wechat-mp-publisher-skill/bin/launch-publisher.mjs" --check --verify
```

不要凭记忆报“现在有 100 多篇”“端口是 5xxxx”“上次 appmsgid 是多少”。**篇数、端口、appmsgid、会话剩余时间全部以本次命令输出为准。**

---

## 1. 权威位置

| 用途 | 路径 |
|---|---|
| 唯一执行入口 | `C:/Users/Administrator/wechat-mp-publisher-skill/bin/launch-publisher.mjs` |
| 统一代码库 | `C:/Users/Administrator/wechat-mp-publisher-skill` |
| GitHub 拉取 | `scripts/sync-from-github.mjs` |
| GitHub 镜像（只读） | `C:/Users/Administrator/zimeiti-sync/公众号/每日推文` |
| 本地独立源（只读） | `Z:/自媒体/公众号/每日推文` |
| 私有状态/标题/修正/封面模板 | `C:/Users/Administrator/.agents/skills/wechat-md-pipeline/data` |
| 专用浏览器 Profile | `C:/Users/Administrator/AppData/Roaming/baoyu-skills/chrome-profile` |
| 定时任务说明 | `references/cron-scheduling-prompt.md` |

`F:/同步文件夹` 是历史归档，**只读**，不要作为当前源，也不要写入任何临时文件。

---

## 2. 每小时固定流程

```bash
# ① 拉取（失败就停，不得当成“没有新文”）
node "C:/Users/Administrator/wechat-mp-publisher-skill/scripts/sync-from-github.mjs"

# ② 登录态（healthy / needs-qr / unknown，退出码 0/3/4）
node "C:/Users/Administrator/wechat-mp-publisher-skill/bin/launch-publisher.mjs" --keepalive

# ③ 会话剩余（0 正常；3 不足 24h；4 无法确认；5 未登录）
node "C:/Users/Administrator/wechat-mp-publisher-skill/scripts/session-expiry.mjs"

# ④ 只读扫描 + 真实性核查（FAIL 会输出）
node "C:/Users/Administrator/wechat-mp-publisher-skill/bin/launch-publisher.mjs" --check --verify
```

有新文且全部通过后：

```bash
# ⑤ 每篇拟定 ≤15 个 Unicode 字符的语义短标题，原子合并
bun run --cwd "C:/Users/Administrator/wechat-mp-publisher-skill" titles "<articleId>=<短标题>"

# ⑥ 立即写入草稿箱（不要攒批次）
node "C:/Users/Administrator/wechat-mp-publisher-skill/bin/launch-publisher.mjs" --titles "C:/Users/Administrator/.agents/skills/wechat-md-pipeline/data/titles-override.json"

# ⑦ 收尾确认未入库新篇为 0
node "C:/Users/Administrator/wechat-mp-publisher-skill/bin/launch-publisher.mjs" --check
```

无正文图且缺封面时，可运行私有 `python -I "C:/Users/Administrator/.agents/skills/wechat-md-pipeline/scripts/generate-covers.py"`；仍缺则报告 `needs-cover`，**不要往正文塞图凑封面**。

已有草稿的更新规则：
- 仅元数据修补：`--repair --id <articleId>`
- 源正文/图片变化：走完整内容路径（默认）
- 显式重建：`--refresh-content --id <articleId>`
- 标题结构异常：从源文重建，不能直接改 DOM 冒充成功

---

## 3. 判断矩阵（照这个做，不要自由发挥）

| 现象 | 动作 |
|---|---|
| GitHub 拉取失败（网络/TLS/鉴权） | 如实报告并**停止**；不得说“本轮没有新推文” |
| `keepalive-status=healthy` | 继续 |
| `needs-qr`（退出码 3） | 提醒用户在**专用 Baoyu Profile 窗口**扫码；停止本轮发布 |
| `unknown`（退出码 4） | 先跑 `keepalive-report.mjs`、看端口/代理/磁盘；**不写草稿**，报告可重试 |
| `session-expiry` 退出码 3 | 报告显著提示“剩余不足 24h，请安排扫码”；本轮仍可发布 |
| `session-expiry` 退出码 4/5 | 4 = 无法确认，不要误报扫码；5 = 未登录，按 needs-qr 处理 |
| 核查 FAIL（DOI 404、死链、伪造） | 去期刊/出版社/arXiv/Dryad/官方新闻室二次核实；可修正的登记修正并复验；无法核实坚决拦截 |
| 核查 WARN（403、超时、无 DOI） | 官网二次核实；确认真实则可发；否则拦截 |
| `needs-title` | 补 ≤15 字语义标题；**禁止机械截断**，不得覆盖既有映射 |
| `needs-cover` | 生成独立封面或报告缺失；不要改正文 |
| `saved-unverified` | 只是“已保全 ID、尚未复验”的中间态，**不是失败**；以独立重开 8 项为准 |
| 封面/CDN/页面加载超时 | 引擎会自动重试一次；仍失败先查磁盘与网络，不要改内容 |
| `ENOSPC` / 磁盘不足 | 清理可再生缓存或把 `TMP/TEMP` 指向 `D:/Temp/zcode`；启动器低于 300MB 会直接停 |
| `needs-attention` | 登录/环境问题，停止并明确告知用户，不要硬跑 |

---

## 4. 十条硬规则（来自真实事故）

1. **真实路径优先**：登录看真实导航后的页面；保存看独立重开；论文看官方元数据。Cookie 存在、HTTP 200、fetch 成功都不等于成功。
2. **三态输出**：healthy / needs-qr / unknown 对应继续 / 扫码 / 可重试；不确定时不写草稿，也不误报扫码。
3. **不承诺平台期限**：会话 Cookie 是 96h 窗口，访问根路径会刷新，但服务端可随时撤销；“扫一次管一个月”不成立。
4. **登录只在专用 Profile**：任何其它浏览器/设备登录同一账号都可能顶掉自动化会话。
5. **本地回环永不走代理**：启动器已强制 `NO_PROXY=127.0.0.1,localhost,::1`；不要给本地 CDP 配代理。
6. **标识符按边界匹配**：占位符、DOI、URL、标题长度按语法边界/码点处理；不要用全局 `indexOf` + 前缀猜测。
7. **派生状态只经工具改**：标题用 `bun run titles`；内容修正用 `node scripts/private-json.mjs corrections add <spec.json>`；**禁止内联 `node -e`/heredoc 拼 JSON**。
8. **写入前一次性 preflight**：缺标题、真实性、图片完整性、锁与队列一次校验；不合格在写第一笔之前停止。
9. **瞬时错误与内容错误分开**：封面/CDN/页面加载超时自动重试一次；内容、标题、核查错误绝不重试。
10. **先看时间线再下结论**：排障先跑 `node scripts/keepalive-report.mjs 7`，确认是真掉线、误报还是环境故障。

---

## 5. 关键状态语义

- `saved-unverified`：已拿到 appmsgid 并落盘保全，但还没通过独立重开复验。
- `appliedFingerprint`：只有“完整正文 + 图片保存 + 独立重开 8 项全过”才推进；metadata repair 不推进。
- `pendingContentUpdate`：正文尚未验收，重跑要继续原 ID 全量更新，不能降级成 `--repair`。
- `candidateAppmsgids`：自动保存候选 ID，必须先核实身份；禁止从 0 重建重复稿。
- `legacyBaseline`：旧基线，只增不减；禁止清库、删基线、覆盖新 ID。

独立重开 8 项：正文文字与图片顺序、零空行、零异常缩进、唯一完整首位 H1、作者=锐多宝、外题、封面、末尾原生 `mp-common-profile`；图片数量/顺序/加载全对（URL 去重时用 32×32 RGBA 像素交叉 MAE）。

---

## 6. 报告模板（每轮照这个写）

```
本轮: [无新推文 / 新增 N 篇]
四项指标: keepalive-status=... | 会话剩余=...h | 磁盘剩余=...G | 待处理=N
GitHub: 提交 ... -> ...，命中 ... 个文件，下载 ... 个，失败 ...
核查: PASS ... / WARN ... / FAIL ...（FAIL 的处理与结论）
草稿: 短标题 -> appmsgid（逐篇），8 项复验 PASSED/失败
结果: 新增 ... | 更新 ... | 已验证跳过 ... | 待核对 ... | 缺图 ... | 失败/未复验 ...
```

日志脱敏：不输出 token、Cookie 值、私有正文或截图。

---

## 7. 环境事实（本机）

- Windows，Git Bash；路径含中文，命令统一用绝对路径加引号。
- 专用浏览器由启动器按需脱管拉起；**只关闭任务自有标签**，不杀其它 Edge、不关用户标签、不弹二维码图片。
- 浏览器缓存已外置：`.env` 中 `WECHAT_BROWSER_CACHE_DIR=D:\Temp\edge-cache`。
- 发布临时目录建议：`TMP=D:/Temp/zcode TEMP=D:/Temp/zcode`。
- 磁盘长期紧张：C: 经常 100%；启动器有 300MB 安全线，低于即退出。
- 常用诊断：
  - `node scripts/keepalive-report.mjs 7` 登录态时间线
  - `node scripts/session-expiry.mjs` 会话剩余
  - `node scripts/verify-doi-official.mjs <doi> --title "<英文标题>"` DOI 双核验
  - `node scripts/private-json.mjs corrections list` 查看已登记修正

---

## 8. 禁止事项

- 不发表、不群发、不通知关注者；只点“保存草稿”。
- 不清库、不删历史、不删基线、不覆盖新 ID、不用旧副本重建。
- 不修改 `F:/同步文件夹`、`Z:/自媒体/公众号/每日推文`、GitHub 镜像里的源文件。
- 不把私有正文、状态、截图、凭据提交到公开仓库。
- 不承诺“一次扫码管一个月/几个月”，不自动续期，不绕过人工扫码。
- 不在 `unknown` 时写草稿，也不把 `unknown` 说成 `needs-qr`。
