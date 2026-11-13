#!/usr/bin/env bun
/**
 * scripts/batch-fast-wechat.ts — 微信公众号草稿箱在原草稿更新与发布主编排引擎
 * 
 * 核心架构准则 (返工终审硬要求)：
 * 1. 【严密的 Action Routing】：规划明确的 repair / content-update / create / skip / needs-reconcile。
 *    - 显式 --repair 仅 metadata 修补；
 *    - 日常调度下，有 applied 且变更走 E 模块；
 *    - 历史旧稿完成排版复验且本地未变自动 skip，杜绝 08/20 每日全量重复修；
 *    - 相对上一次排版观察发生实质变动，走 E 模块更新原草稿；
 *    - 基线内旧稿缺少 ID 严格 needs-reconcile，绝不因 --id 从 0 重建。
 * 2. 【状态持久化与先存后验】：加锁后先持久化合并记录 (避免新文丢失 item)；保存一旦拿得 ID 立即先持久化保全为 saved-unverified，再进入重开物理复验。
 * 3. 【缺图安全分流】：原地 repair 且已有微信 CDN 图放行，全量发布/新文严格阻断。
 * 4. 【Reload URL 与图片集合严格比对】：new URL().searchParams 校验目标 appmsgid，原图 URL 集合与加载完成全量比对。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  CdpConnection,
  findChromeExecutable,
  findExistingChromeDebugPort,
  getDefaultProfileDir,
  getFreePort,
  sleep,
  waitForChromeDebugPort,
  type ChromeSession,
} from './cdp.ts';
import {
  acquireProcessLock,
  releaseProcessLock,
  computeStateCatalog,
  recordVerifiedDraft,
  recordDraftCandidate,
  buildWechatEditUrl,
  sanitizeUrlForLog,
  verifyImagesIntegrity,
  getOrCreateLegacyBaseline,
  getStatePaths,
  CURRENT_FEATURE_VERSION,
  type DraftStateRecord,
} from './draft-state.ts';
import {
  ensureOriginalTitleH1,
  setCoverFromFirstImage,
  insertNativeRuiduobaoCard,
  inspectEditorFeatures,
  evaluatePage,
  BODY_EDITOR_SELECTOR,
  RUIDUOBAO_TARGET_DATA_ID,
  RUIDUOBAO_TARGET_NICKNAME,
  type EditorSession,
} from './editor-features.ts';
import {
  renderArticleContent,
  applyArticleContent,
  wechatImageIdentity,
  verifyReopenedImagesMatch,
  type RenderArticleResult,
} from './article-content.ts';
import { assertArticleEditor } from './editor-mode.ts';
export { evaluateEditorMessageType, type EditorTypeSnapshot } from './editor-mode.ts';

const WECHAT_URL = 'https://mp.weixin.qq.com/';

// -----------------------------------------------------------------------------
// CLI 参数解析与门禁检查
// -----------------------------------------------------------------------------
export interface BatchCliOptions {
  dryRun: boolean;
  repair: boolean;
  refreshContent: boolean;
  id?: string;
  search?: string;
  latest?: number;
  limit?: number;
  batch?: string;
  days?: number;
  source: 'all' | 'local' | 'muse';
  titleOverride?: string;
  titlesFile?: string;
  titleMap?: Record<string, string>;
}

export function printHelpAndExit(): never {
  console.log(`
微信公众号草稿箱在原草稿更新与修复引擎 (Safe Repair Spine)

用法:
  bun run scripts/batch-fast-wechat.ts [选项]

选项:
  --dry-run                 纯读演练模式 (不获取锁、不修改磁盘、不触碰浏览器)
  --repair                  安全原地精修模式 (优先在原草稿上修补 H1/作者/封面/名片，保留正文CDN图)
  --refresh-content         强制在原草稿上使用 E 模块重建正文与图片 (必须与 --id 配合)
  --id <articleId>          指定单篇推文处理 (例如 local:20261106_1800:02)
  --search <keyword>        按关键词检索推文 (匹配 ID/文件名/标题/正文; 别名 --find)
  --latest [N]              按批次与文件时间选择最新 N 篇文章 (默认 1 篇)
  --limit <N>               限制本次处理的最大篇数 (必须为正整数)
  --batch <batchName>       按批次目录过滤 (例如 20261106_1800)
  --days <N>                仅处理最近 N 天内的批次推文 (必须为正整数)
  --source <all|local|muse> 来源过滤 (默认 all)
  --title-override <title>  覆盖写入外层标题栏 (仅限单篇模式，须配合 --id 或 --latest 1)
  --titles <path.json>      加载外部短标题映射文件 (格式: { [articleId]: shortTitle })
  -h, --help                显示本帮助信息并退出 (退出码 0)
`.trim());
  process.exit(0);
}

export function parseBatchArgs(): BatchCliOptions {
  const args = process.argv.slice(2);
  let dryRun = false;
  let repair = false;
  let refreshContent = false;
  let id: string | undefined;
  let search: string | undefined;
  let latest: number | undefined;
  let limit: number | undefined;
  let batch: string | undefined;
  let days: number | undefined;
  let source: 'all' | 'local' | 'muse' = 'all';
  let titleOverride: string | undefined;
  let titlesFile: string | undefined;
  let titleMap: Record<string, string> | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--help' || a === '-h') {
      printHelpAndExit();
    } else if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--repair') {
      repair = true;
    } else if (a === '--refresh-content') {
      refreshContent = true;
    } else if (a === '--id') {
      if (i + 1 >= args.length || args[i + 1]!.startsWith('--')) {
        console.error('❌ 参数错误: --id 缺少参数值');
        process.exit(2);
      }
      id = args[++i];
    } else if (a === '--search' || a === '--find') {
      if (i + 1 >= args.length || args[i + 1]!.startsWith('--')) {
        console.error(`❌ 参数错误: ${a} 缺少关键词参数`);
        process.exit(2);
      }
      search = args[++i];
    } else if (a === '--latest') {
      if (i + 1 < args.length && !args[i + 1]!.startsWith('--')) {
        const val = parseInt(args[++i]!, 10);
        if (isNaN(val) || val <= 0) {
          console.error(`❌ 参数错误: --latest 必须为正整数，收到: ${args[i]}`);
          process.exit(2);
        }
        latest = val;
      } else {
        latest = 1;
      }
    } else if (a === '--limit') {
      if (i + 1 >= args.length || args[i + 1]!.startsWith('--')) {
        console.error('❌ 参数错误: --limit 缺少参数值');
        process.exit(2);
      }
      const val = parseInt(args[++i]!, 10);
      if (isNaN(val) || val <= 0) {
        console.error(`❌ 参数错误: --limit 必须为正整数，收到: ${args[i]}`);
        process.exit(2);
      }
      limit = val;
    } else if (a === '--batch') {
      if (i + 1 >= args.length || args[i + 1]!.startsWith('--')) {
        console.error('❌ 参数错误: --batch 缺少参数值');
        process.exit(2);
      }
      batch = args[++i];
    } else if (a === '--days') {
      if (i + 1 >= args.length || args[i + 1]!.startsWith('--')) {
        console.error('❌ 参数错误: --days 缺少参数值');
        process.exit(2);
      }
      const val = parseInt(args[++i]!, 10);
      if (isNaN(val) || val <= 0) {
        console.error(`❌ 参数错误: --days 必须为正整数，收到: ${args[i]}`);
        process.exit(2);
      }
      days = val;
    } else if (a === '--source') {
      if (i + 1 >= args.length || args[i + 1]!.startsWith('--')) {
        console.error('❌ 参数错误: --source 缺少参数值');
        process.exit(2);
      }
      const val = args[++i]!;
      if (val !== 'all' && val !== 'local' && val !== 'muse') {
        console.error(`❌ 参数错误: --source 仅支持 all | local | muse，收到: ${val}`);
        process.exit(2);
      }
      source = val;
    } else if (a === '--title-override') {
      if (i + 1 >= args.length || args[i + 1]!.startsWith('--')) {
        console.error('❌ 参数错误: --title-override 缺少参数值');
        process.exit(2);
      }
      titleOverride = args[++i];
    } else if (a === '--titles') {
      if (i + 1 >= args.length || args[i + 1]!.startsWith('--')) {
        console.error('❌ 参数错误: --titles 缺少参数值');
        process.exit(2);
      }
      titlesFile = args[++i];
      if (!fs.existsSync(titlesFile)) {
        console.error(`❌ 参数错误: 指定的短标题映射文件不存在: ${titlesFile}`);
        process.exit(2);
      }
      try {
        titleMap = JSON.parse(fs.readFileSync(titlesFile, 'utf-8'));
      } catch (err: any) {
        console.error(`❌ 参数错误: 短标题映射文件 JSON 解析失败: ${err.message}`);
        process.exit(2);
      }
    } else {
      console.error(`❌ 未知参数: ${a}。运行 --help 查看用法。`);
      process.exit(2);
    }
  }

  // 严格门禁：--refresh-content 必须与 --id 配合，防止全量覆盖已有稿件
  if (refreshContent && !id) {
    console.error('❌ 参数错误: --refresh-content 必须与 --id <articleId> 配合使用 (避免全量重建已有稿件)');
    process.exit(2);
  }

  // 严格门禁：--title-override 仅限单篇模式，防止将同一短标题误应用到多篇
  if (titleOverride && !id && latest !== 1 && !search) {
    console.error('❌ 参数错误: --title-override 仅限单篇模式 (须与 --id 或 --latest 1 配合；批量请使用 --titles <json>)');
    process.exit(2);
  }

  return { dryRun, repair, refreshContent, id, search, latest, limit, batch, days, source, titleOverride, titlesFile, titleMap };
}

// -----------------------------------------------------------------------------
// 动作规划器 (明确的 Action Routing)
// -----------------------------------------------------------------------------
export type PlannedAction = 'repair' | 'content-update' | 'create' | 'skip' | 'needs-reconcile';

export function planArticleAction(
  item: DraftStateRecord,
  options: BatchCliOptions,
  legacyBaseline: Set<string>
): { action: PlannedAction; reason: string } {
  const isBaseline = legacyBaseline.has(item.id);

  // 检查是否存在与当前外层标题不同的显式覆盖诉求
  const explicitOverrideTitle = options.titleOverride || (options.titleMap && options.titleMap[item.id]);
  const hasDifferentTitleOverride = !!(explicitOverrideTitle && explicitOverrideTitle.trim() !== '' && explicitOverrideTitle.trim() !== (item.outerTitle || '').trim());

  // 0. 显式 --refresh-content 模式 (窄可控入口: 原草稿上用 E 模块重建正文与高清图片)
  if (options.refreshContent) {
    if (!item.appmsgid) {
      return { action: 'needs-reconcile', reason: '--refresh-content 仅支持已有 appmsgid 的草稿，缺失无法原稿重建' };
    }
    return { action: 'content-update', reason: '显式指令: 在原草稿上强制使用 E 模块重建正文与上传高清图片 (--refresh-content)' };
  }

  if (item.appmsgid && (item.pendingContentUpdate || (!isBaseline && !item.appliedFingerprint))) {
    if (options.repair) return { action: 'needs-reconcile', reason: 'needs-content-refresh: 完整正文尚未验收，不能用元数据修补替代，请使用 --refresh-content --id' };
    return { action: 'content-update', reason: '已保全草稿 ID，但完整正文更新未验收，继续在原稿完成正文与图片' };
  }

  // 1. 显式 --repair 模式 (仅执行元数据/封面/名片修补)
  if (options.repair) {
    if (!item.appmsgid) {
      return { action: 'needs-reconcile', reason: 'repair 模式要求文章必须已有 appmsgid，缺失无法原地修补' };
    }
    const isFeatureDone = item.verification?.verified &&
      item.featureRepairObservedFingerprint === item.observedFingerprint?.compositeHash &&
      item.featureVersion === CURRENT_FEATURE_VERSION;
    // 仅当排版已验收且无不同标题覆盖诉求时才 skip；若有新的不同标题覆盖，必须放行 repair
    if (isFeatureDone && !hasDifferentTitleOverride) {
      return { action: 'skip', reason: '当前排版特性已在最新文件指纹下验收通过，且无新外层标题覆盖，无需重复 repair' };
    }
    return { action: 'repair', reason: hasDifferentTitleOverride ? '显式短标题覆盖更新 (在原草稿上更新外层标题)' : '在原草稿上执行 H1/封面/名片修补 (保留现有微信正文与CDN图)' };
  }

  // 2. 默认模式：已有草稿 ID
  if (item.appmsgid) {
    const hasApplied = !!item.appliedFingerprint;
    const isContentUnchanged = hasApplied &&
      item.appliedFingerprint!.compositeHash === item.observedFingerprint?.compositeHash;

    if (hasApplied) {
      if (isContentUnchanged && item.verification?.verified && !hasDifferentTitleOverride) {
        return { action: 'skip', reason: '全量内容与排版特性均已最新且复验通过' };
      }
      if (hasDifferentTitleOverride && isContentUnchanged && item.verification?.verified) {
        return { action: 'repair', reason: '显式短标题覆盖更新 (在原草稿上更新外层标题)' };
      }
      return { action: 'content-update', reason: '本地内容或图片发生变更，在原草稿上通过 E 模块更新正文与CDN图' };
    }

    // 历史旧稿（无 appliedFingerprint）：
    const isFeatureDone = item.verification?.verified &&
      item.featureRepairObservedFingerprint === item.observedFingerprint?.compositeHash &&
      item.featureVersion === CURRENT_FEATURE_VERSION;

    if (isFeatureDone && !hasDifferentTitleOverride) {
      return { action: 'skip', reason: '历史草稿已完成排版验收且本地源文件未变更，跳过' };
    }

    if (hasDifferentTitleOverride) {
      return { action: 'repair', reason: '显式短标题覆盖更新 (在原草稿上更新外层标题)' };
    }

    if (item.featureRepairObservedFingerprint && item.featureRepairObservedFingerprint !== item.observedFingerprint?.compositeHash) {
      return { action: 'content-update', reason: '历史草稿本地文件发生实质变动，通过 E 模块更新原草稿' };
    }

    return { action: 'repair', reason: '首次历史草稿排版元数据定向精修' };
  }

  // 3. 无草稿 ID：
  if (isBaseline || item.candidateAppmsgids?.length) {
    return { action: 'needs-reconcile', reason: item.candidateAppmsgids?.length ? '已有候选保存 ID 尚待身份核对，禁止从 0 重复建稿' : '属于旧基线文章但缺少确证草稿 ID，禁止从 0 重复建稿' };
  }

  // 基线之外的崭新文章
  return { action: 'create', reason: '基线外崭新文章，创建新草稿并注入全量内容' };
}

// -----------------------------------------------------------------------------
// 页面通用等待
// -----------------------------------------------------------------------------
async function waitForSelector(session: EditorSession, selector: string, timeoutMs = 25_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await evaluatePage<boolean>(session, `!!document.querySelector(${JSON.stringify(selector)})`).catch(() => false);
    if (found) return true;
    await sleep(400);
  }
  return false;
}

async function waitForNewTab(cdp: CdpConnection, initialIds: Set<string>, urlPattern: string, timeoutMs = 30_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const targets = await cdp.send<{ targetInfos: Array<{ targetId: string; url: string; type: string }> }>('Target.getTargets');
    for (const t of targets.targetInfos) {
      if (t.type === 'page' && !initialIds.has(t.targetId) && t.url.includes(urlPattern)) {
        return t.targetId;
      }
    }
    await sleep(400);
  }
  throw new Error(`等待新标签页超时: ${urlPattern}`);
}

// -----------------------------------------------------------------------------
// 保存操作真实网络监听
// -----------------------------------------------------------------------------
export interface SaveNetworkResponse {
  ret: number;
  appMsgId?: string;
  timestamp: number;
}

async function installSaveNetworkHook(session: EditorSession): Promise<void> {
  await evaluatePage(session, `
    (function() {
      if (window.__saveHookInstalled) return;
      window.__saveHookInstalled = true;
      window.__lastSaveResponse = null;

      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url) {
        this.__interceptUrl = url;
        return origOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function() {
        if (this.__interceptUrl && this.__interceptUrl.includes('operate_appmsg')) {
          this.addEventListener('load', function() {
            try {
              const res = JSON.parse(this.responseText);
              window.__lastSaveResponse = {
                ret: res.base_resp ? res.base_resp.ret : res.ret,
                appMsgId: String(res.appMsgId || res.appmsgid || ''),
                timestamp: Date.now()
              };
            } catch {}
          });
        }
        return origSend.apply(this, arguments);
      };

      if (window.fetch) {
        const origFetch = window.fetch;
        window.fetch = async function(input, init) {
          const res = await origFetch.apply(this, arguments);
          try {
            const url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
            if (url.includes('operate_appmsg')) {
              const clone = res.clone();
              clone.json().then(data => {
                window.__lastSaveResponse = {
                  ret: data.base_resp ? data.base_resp.ret : data.ret,
                  appMsgId: String(data.appMsgId || data.appmsgid || ''),
                  timestamp: Date.now()
                };
              }).catch(() => {});
            }
          } catch {}
          return res;
        };
      }
    })()
  `);
}

async function waitForRealSaveNetworkResponse(
  session: EditorSession,
  triggerTime: number,
  fallbackAppmsgid?: string | null,
  timeoutMs = 35_000
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const netRes = await evaluatePage<SaveNetworkResponse | null>(session, `
      (function() {
        const r = window.__lastSaveResponse;
        if (r && r.timestamp >= ${triggerTime}) return r;
        return null;
      })()
    `).catch(() => null);

    if (netRes && netRes.ret === 0) {
      if (netRes.appMsgId && netRes.appMsgId.trim() !== '') {
        return netRes.appMsgId.trim();
      }
      if (fallbackAppmsgid) {
        return fallbackAppmsgid;
      }
      const assignedId = await evaluatePage<string | null>(session, `new URL(location.href).searchParams.get('appmsgid')`);
      if (assignedId && /^\d+$/.test(assignedId)) return assignedId;
    }

    // 仅当等待超过 8 秒且捕获到明确的保存 Toast 时，才允许降级使用 fallbackAppmsgid (杜绝 autosave 旧 Toast 冒认)
    const toastSuccess = await evaluatePage<boolean>(session, `
      (function() {
        const toast = document.querySelector('.weui-desktop-toast_success, .toast-success');
        return !!(toast && /保存成功|已保存/.test(toast.textContent || ''));
      })()
    `).catch(() => false);

    if (toastSuccess && fallbackAppmsgid && Date.now() - triggerTime > 8000) {
      return fallbackAppmsgid;
    }

    await sleep(600);
  }

  if (fallbackAppmsgid) {
    console.warn(`[wechat-batch] ⚠️ 网络回包捕获未就绪，使用当前草稿 ID (${fallbackAppmsgid}) 交由后续独立重开物理复验做最终判定 (saveResponseUnavailable)`);
    return fallbackAppmsgid;
  }

  throw new Error('等待草稿箱保存确认超时，且无可用回退 ID');
}

// -----------------------------------------------------------------------------
// 浏览器连接与主页会话管理
// -----------------------------------------------------------------------------
export interface ConnectedHome {
  cdp: CdpConnection;
  homeSession: EditorSession;
  token: string;
}

export async function findEdgeDebugPort(targetProfileDir: string): Promise<number | null> {
  try {
    const { execFileSync } = await import('node:child_process');
    const ps = '$p = Get-CimInstance Win32_Process -Filter "name=\'msedge.exe\'" | Select-Object ProcessId, CommandLine; $p | ConvertTo-Json -Compress';
    const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], {
      timeout: 10_000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    if (!output || output.trim() === '') return null;
    const parsed = JSON.parse(output.trim());
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const normTarget = path.resolve(targetProfileDir).toLowerCase();

    for (const proc of list) {
      const cmd = proc?.CommandLine || '';
      const mDir = cmd.match(/--user-data-dir=(?:"([^"]+)"|([^\s]+))/i);
      if (mDir) {
        const rawDir = mDir[1] || mDir[2] || '';
        const normDir = path.resolve(rawDir).toLowerCase();
        if (normDir === normTarget) {
          const mPort = cmd.match(/--remote-debugging-port=(\d+)/i);
          if (mPort) return parseInt(mPort[1]!, 10);
        }
      }
    }
  } catch {}
  return null;
}

export async function connectOrCreateHomeSession(): Promise<ConnectedHome> {
  const profileDir = getDefaultProfileDir();
  let cdp: CdpConnection;

  let port = await findEdgeDebugPort(profileDir);
  if (!port) {
    port = await findExistingChromeDebugPort(profileDir);
  }

  if (port) {
    try {
      const version = await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.json());
      cdp = await CdpConnection.connect(version.webSocketDebuggerUrl, 12_000);
      console.log(`[wechat-batch] 成功连接已有浏览器调试端口: ${port}`);
    } catch (connErr: any) {
      throw new Error(`[wechat-batch] 发现调试端口 ${port} 但无法建立 WebSocket 连接: ${connErr?.message || connErr}`);
    }
  } else {
    const chromePath = findChromeExecutable();
    if (!chromePath) {
      throw new Error('[wechat-batch] 未找到可用的 Edge/Chrome 可执行文件，请设置 WECHAT_BROWSER_CHROME_PATH (需要 attention)');
    }
    const freePort = await getFreePort();
    console.log(`[wechat-batch] 专用 Profile 浏览器未运行，正在独立拉起常驻实例 (port: ${freePort})...`);
    const child = spawn(
      chromePath,
      [
        `--remote-debugging-port=${freePort}`,
        `--user-data-dir=${profileDir}`,
        '--disable-blink-features=AutomationControlled',
        '--start-maximized',
        '--no-first-run',
        '--no-default-browser-check',
        `${WECHAT_URL}cgi-bin/home?t=home/index`,
      ],
      { detached: true, stdio: 'ignore', windowsHide: false }
    );
    child.unref();

    const wsUrl = await waitForChromeDebugPort(freePort, 25_000, { includeLastError: true });
    cdp = await CdpConnection.connect(wsUrl, 12_000);
    console.log(`[wechat-batch] ✅ 已独立拉起并连接专用浏览器调试端口: ${freePort}`);
  }

  await sleep(400);
  const targets = await cdp.send<{ targetInfos: Array<{ targetId: string; url: string; type: string }> }>('Target.getTargets');

  let homeTarget = targets.targetInfos.find(t => t.type === 'page' && t.url.includes('/cgi-bin/home'));

  if (!homeTarget) {
    const created = await cdp.send<{ targetId: string }>('Target.createTarget', { url: `${WECHAT_URL}cgi-bin/home?t=home/index` });
    homeTarget = { targetId: created.targetId, url: WECHAT_URL, type: 'page' };
    await sleep(1500);
  }

  const { sessionId: homeSid } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: homeTarget.targetId, flatten: true });
  const homeSession: EditorSession = { cdp, sessionId: homeSid, targetId: homeTarget.targetId };

  await cdp.send('Page.enable', {}, { sessionId: homeSid }).catch(() => {});
  await cdp.send('Runtime.enable', {}, { sessionId: homeSid }).catch(() => {});

  const currentUrl = await evaluatePage<string>(homeSession, 'window.location.href');
  if (!currentUrl.includes('/cgi-bin/home')) {
    console.log(`[wechat-batch] 导航至公众号后台首页...`);
    await evaluatePage(homeSession, `window.location.href = '${WECHAT_URL}cgi-bin/home?t=home/index'`);
    await sleep(1200);
  }

  const isMenuReady = await waitForSelector(homeSession, '.new-creation__menu', 25_000);
  if (!isMenuReady) {
    throw new Error('[wechat-batch] 公众号后台登录态已失效或首页加载超时，请在专用浏览器扫码续期后重试 (needs-attention)');
  }

  const homeFinalUrl = await evaluatePage<string>(homeSession, 'window.location.href');
  const tokenMatch = homeFinalUrl.match(/token=(\d+)/);
  if (!tokenMatch) {
    throw new Error('[wechat-batch] 无法从后台首页 URL 中解析出有效 token');
  }
  const token = tokenMatch[1]!;

  return { cdp, homeSession, token };
}

// -----------------------------------------------------------------------------
// 外部私有封面映射工具 (支持路径注入与坏JSON防吞)
// -----------------------------------------------------------------------------
export const PRIVATE_COVER_OVERRIDES_PATH = 'C:\\Users\\Administrator\\.agents\\skills\\wechat-md-pipeline\\data\\cover-overrides.json';

export function loadPrivateCoverOverrides(customPath?: string): Record<string, string> {
  const filePath = customPath || process.env.WECHAT_COVER_OVERRIDES_FILE || PRIVATE_COVER_OVERRIDES_PATH;
  if (!fs.existsSync(filePath)) return {};

  const raw = fs.readFileSync(filePath, 'utf-8');
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`[wechat-batch] FATAL: 封面映射文件 JSON 格式损坏: ${filePath} (${err.message})`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`[wechat-batch] FATAL: 封面映射文件结构错误，必须为对象字典: ${filePath}`);
  }

  return parsed;
}

// -----------------------------------------------------------------------------
// 标题决策工具 (不盲截，优先使用显式映射或已有外层标题)
// -----------------------------------------------------------------------------
export function resolveOuterTitle(
  item: DraftStateRecord,
  currentEditorTitle: string,
  options: BatchCliOptions
): string {
  const explicit = (options.titleOverride || options.titleMap?.[item.id])?.trim();
  if (explicit) {
    if (Array.from(explicit).length > 15) throw new Error('needs-title: 显式外题超过15字，请按语义提炼');
    return explicit;
  }
  const title = currentEditorTitle.trim() || item.outerTitle?.trim() || item.title;
  if (!item.appmsgid && Array.from(title).length > 15) {
    throw new Error(`needs-title: 新文 ${item.id} 需要15字以内语义外题，请提供 --title-override 或 --titles`);
  }
  return title;
}

// -----------------------------------------------------------------------------
// 单篇安全处理流水线
// -----------------------------------------------------------------------------
export async function processSingleArticle(
  item: DraftStateRecord,
  connected: ConnectedHome,
  options: BatchCliOptions,
  legacyBaseline: Set<string>
): Promise<{ success: boolean; appmsgid?: string; verified: boolean; error?: string }> {
  const { cdp, homeSession, token } = connected;
  let editorTargetId: string | null = null;
  let editSession: EditorSession | undefined;
  let renderResult: RenderArticleResult | null = null;

  try {
    const rawMd = fs.readFileSync(item.fullPath, 'utf-8');
    const baseDir = path.dirname(item.fullPath);
    const imgReport = verifyImagesIntegrity(rawMd, baseDir);

    // 动作规划
    const plan = planArticleAction(item, options, legacyBaseline);
    console.log(`[wechat-batch] 规划动作: [${plan.action.toUpperCase()}] -> ${plan.reason}`);

    if (plan.action === 'skip') {
      return { success: true, appmsgid: item.appmsgid || undefined, verified: true };
    }

    if (plan.action === 'needs-reconcile') {
      throw new Error(`文章 "${item.id}" 处于 needs-reconcile 状态，禁止自动从零建稿 (需要 attention)`);
    }

    const isRepairMode = plan.action === 'repair';

    // 缺图校验：仅非 repair 模式下缺图才阻断；原地 repair 允许复用微信已有 CDN 图
    if (!isRepairMode && !imgReport.ok) {
      throw new Error(`全量发布本地图片预检失败，拒绝修改: ${imgReport.missingPaths.join('; ')}`);
    } else if (!imgReport.ok) {
      console.warn(`[wechat-batch] ⚠️ 提示: 本地缺少部分源图，但在原地 repair 模式下复用微信草稿箱现有 CDN 图，不阻断封面名片精修`);
    }

    // 1. 打开编辑器标签页
    const currentTargets = await cdp.send<{ targetInfos: Array<{ targetId: string; url: string; type: string }> }>('Target.getTargets');
    const beforeIds = new Set(currentTargets.targetInfos.map(t => t.targetId));

    if (item.appmsgid) {
      const editUrl = buildWechatEditUrl(item.appmsgid, token);
      console.log(`[wechat-batch] 正在原草稿上打开编辑: ${sanitizeUrlForLog(editUrl)}`);
      const created = await cdp.send<{ targetId: string }>('Target.createTarget', { url: editUrl });
      editorTargetId = created.targetId;
    } else {
      console.log(`[wechat-batch] 从主页点击“文章”打开新草稿标签页...`);
      await evaluatePage(homeSession, `
        (function() {
          const items = document.querySelectorAll('.new-creation__menu .new-creation__menu-item');
          for (const it of items) {
            const t = it.querySelector('.new-creation__menu-title');
            if (t && t.textContent.trim() === '文章') {
              it.click();
              return true;
            }
          }
          return false;
        })()
      `);
      editorTargetId = await waitForNewTab(cdp, beforeIds, 'mp.weixin.qq.com', 30_000);
    }

    const { sessionId: editSid } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: editorTargetId, flatten: true });
    editSession = { cdp, sessionId: editSid, targetId: editorTargetId };

    await cdp.send('Page.enable', {}, { sessionId: editSid });
    await cdp.send('Runtime.enable', {}, { sessionId: editSid });
    await cdp.send('DOM.enable', {}, { sessionId: editSid });

    // 等待编辑器加载就绪
    const titleReady = await waitForSelector(editSession, '#title', 30_000);
    if (!titleReady) throw new Error('编辑器标题输入框 (#title) 加载超时');
    await waitForSelector(editSession, BODY_EDITOR_SELECTOR, 20_000);
    await assertArticleEditor(editSession);
    await sleep(600);
    await installSaveNetworkHook(editSession);

    // 2. 捕获进入时的原正文与图片 URL 集合快照
    const initialFeatures = await evaluatePage<{ title: string; imageUrls: string[] }>(editSession, `
      (function() {
        const titleEl = document.querySelector('#title');
        const editor = document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)});
        const imgs = editor ? Array.from(editor.querySelectorAll('img:not(.ProseMirror-separator)')) : [];
        return {
          title: titleEl ? (titleEl.value || '').trim() : '',
          imageUrls: imgs.map(i => i.src)
        };
      })()
    `);
    const initialImgSet = new Set(initialFeatures.imageUrls);

    // 零图与封面就绪判定 (该阻断仅适用于纯 metadata repair 模式；create 与 content-update 会在后续由 E 模块注入图片，故不在此早拦)
    const coverOverrides = loadPrivateCoverOverrides();
    const coverOverridePath = coverOverrides[item.id];

    if (isRepairMode && initialFeatures.imageUrls.length === 0) {
      const hasExistingCover = await evaluatePage<boolean>(editSession, `
        (function() {
          const area = document.querySelector('#js_cover_area');
          if (!area) return false;
          const el = area.querySelector('.first_appmsg_cover') || area.querySelector('[style*="background-image"]');
          if (!el) return false;
          const bg = window.getComputedStyle(el).backgroundImage || '';
          return bg.includes('url(') && !bg.includes('none');
        })()
      `).catch(() => false);

      if (!hasExistingCover && (!coverOverridePath || !fs.existsSync(coverOverridePath))) {
        if (imgReport.images.length > 0) {
          throw new Error(`[needs-content-refresh] 原草稿微信正文缺少图片 (本地源包含 ${imgReport.images.length} 张图，微信正文0图)。请使用 --refresh-content --id ${item.id} 在原草稿上使用 E 模块重建正文与图片`);
        } else {
          console.warn(`[wechat-batch] ⚠️ 提示 (needs-cover): 文章 "${item.id}" 正文无图且缺少外部封面映射，跳过等待封面生成，不中断整批`);
          await cdp.send('Target.closeTarget', { targetId: editorTargetId });
          editorTargetId = null;
          return { success: false, verified: false, error: 'needs-cover: 正文无图且缺少外部封面映射' };
        }
      }
    }

    // 3. 外层标题保护与作者填写
    const finalOuterTitle = resolveOuterTitle(item, initialFeatures.title, options);
    console.log(`[wechat-batch] 外层标题栏确定: "${finalOuterTitle}"`);

    const targetAuthor = (process.env.WECHAT_AUTHOR || RUIDUOBAO_TARGET_NICKNAME).trim();
    const skipProfileCard = process.env.WECHAT_SKIP_PROFILE_CARD === '1' || process.env.WECHAT_SKIP_PROFILE_CARD === 'true';
    const statePaths = getStatePaths();

    await evaluatePage(editSession, `
      (function() {
        const tEl = document.querySelector('#title');
        if (tEl) {
          tEl.focus();
          tEl.value = ${JSON.stringify(finalOuterTitle)};
          tEl.dispatchEvent(new Event('input', { bubbles: true }));
          tEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const aEl = document.querySelector('#author');
        if (aEl) {
          aEl.focus();
          aEl.value = ${JSON.stringify(targetAuthor)};
          aEl.dispatchEvent(new Event('input', { bubbles: true }));
          aEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()
    `);

    // 4. 若非纯 repair 模式，调用 E 模块进行 ProseMirror 事务注入与图片上传
    if (!isRepairMode) {
      if (item.appmsgid) {
        recordVerifiedDraft(item.id, item.appmsgid, { verified: false, evidenceNotes: 'Full content update started; remains pending until independent reopen passes' }, { mode: 'full-content', outerTitle: finalOuterTitle });
      }
      console.log(`[wechat-batch] 调用 E 模块: 渲染正文与上传本地图片...`);
      renderResult = await renderArticleContent(item.fullPath, { cacheRoot: statePaths.stateCacheDir });
      const applyRes = await applyArticleContent(editSession, renderResult, { expectedTitle: item.title });
      if (!applyRes.ok) {
        throw new Error(`E 模块正文或图片上传未完全就绪: ${applyRes.error || applyRes.details}`);
      }
      console.log(`[wechat-batch] ✅ E 模块正文注入与 CDN 图片就绪 (上传数: ${applyRes.insertedImagesCount}, CDN数: ${applyRes.cdnImagesCount})`);
    }

    // 5. 调用 A 模块接口：确保正文开头保留未缩减原标题 H1 (返回 !ok 必须立即 throw)
    console.log(`[wechat-batch] 调用 A 模块: 确保正文开头原标题 H1...`);
    const h1Result = await ensureOriginalTitleH1(editSession, item.title);
    if (!h1Result.ok) {
      throw new Error(`A模块设置 H1 失败: ${h1Result.details || h1Result.error}`);
    }
    console.log(`[wechat-batch] ✅ 正文开头完整原标题 H1 确认就绪`);

    // 6. 调用 A 模块接口：设置 2.35:1 封面 (支持外部 coverFilePath 直传或现有封面复用)
    console.log(`[wechat-batch] 调用 A 模块: 设置封面预览图...`);
    const coverResult = await setCoverFromFirstImage(editSession, {
      timeoutMs: 25_000,
      coverFilePath: coverOverridePath,
    });
    if (!coverResult.ok) {
      throw new Error(`A模块设置封面失败: ${coverResult.details || coverResult.error}`);
    }
    console.log(`[wechat-batch] ✅ 文章封面预览图设置成功`);

    // 7. 调用 A 模块接口：插入官方原生账号名片 (私有模板支持，防止搜索超时；可通过 WECHAT_SKIP_PROFILE_CARD=1 跳过)
    if (!skipProfileCard) {
      console.log(`[wechat-batch] 调用 A 模块: 插入原生账号名片...`);
      const privateCardTemplatePath = process.env.WECHAT_PROFILE_TEMPLATE_FILE || 'C:\\Users\\Administrator\\.agents\\skills\\wechat-md-pipeline\\data\\native-card-template.html';
      let nativeCardTemplate: string | undefined;
      try {
        if (fs.existsSync(privateCardTemplatePath)) {
          const raw = fs.readFileSync(privateCardTemplatePath, 'utf-8').trim();
          if (raw.includes('mp-common-profile') && raw.includes(RUIDUOBAO_TARGET_DATA_ID)) {
            nativeCardTemplate = raw;
          }
        }
      } catch {}

      const cardResult = await insertNativeRuiduobaoCard(editSession, {
        timeoutMs: 25_000,
        nativeCardTemplateHtml: nativeCardTemplate,
        nativeCardHtml: nativeCardTemplate,
        preferNativeTemplate: !!nativeCardTemplate,
      });
      if (!cardResult.ok) {
        throw new Error(`A模块插入原生名片失败: ${cardResult.details || cardResult.error}`);
      }
      console.log(`[wechat-batch] ✅ 原生【${RUIDUOBAO_TARGET_NICKNAME}】名片插入成功 (${cardResult.details})`);
    } else {
      console.log(`[wechat-batch] ℹ️ 已配置 WECHAT_SKIP_PROFILE_CARD=1，跳过名片插入。`);
    }

    // 8. 保存前全要素快速 inspect，防止未关闭 modal 误点保存
    const preSaveInspect = await inspectEditorFeatures(editSession);
    const preCardOk = skipProfileCard || (
      preSaveInspect.profileCard.isRealMpCommonProfile &&
      preSaveInspect.profileCard.isAtEnd &&
      preSaveInspect.profileCard.dataId === RUIDUOBAO_TARGET_DATA_ID &&
      preSaveInspect.profileCard.dataNickname === RUIDUOBAO_TARGET_NICKNAME
    );
    if (!preSaveInspect.titleH1.exists || preSaveInspect.titleH1.count !== 1 ||
        !preSaveInspect.titleH1.isFirstElement || preSaveInspect.titleH1.text?.trim() !== item.title.trim() ||
        !preSaveInspect.cover.hasCover || !preCardOk) {
      throw new Error(`保存前预检失败: H1=${preSaveInspect.titleH1.exists}, 封面=${preSaveInspect.cover.hasCover}, 名片=${preSaveInspect.profileCard.exists}`);
    }
    const contentSnapshotExpression = `(() => {
      const editor = document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)});
      const clone = editor.cloneNode(true);
      clone.querySelectorAll('mp-common-profile').forEach(node => node.remove());
      return { text: (clone.textContent || '').replace(/[\\s\\u200B-\\u200D\\uFEFF]/g, ''),
        images: Array.from(editor.querySelectorAll('img:not(.ProseMirror-separator)')).map(img => img.src) };
    })()`;
    const beforeSaveContent = await evaluatePage<{ text: string; images: string[] }>(editSession, contentSnapshotExpression);
    if (/WECHATIMGPH_\d+|⟦_anchor_ph_/.test(beforeSaveContent.text)) throw new Error('保存前仍有图片占位符，未保存');

    // 9. 安装网络监听并点击保存草稿
    await installSaveNetworkHook(editSession);
    console.log(`[wechat-batch] 提交保存至草稿箱...`);
    const triggerTime = Date.now();
    await evaluatePage(editSession, `
      (function() {
        const btn = document.querySelector('#js_submit button');
        if (btn) btn.click();
      })()
    `);

    const savedAppmsgid = await waitForRealSaveNetworkResponse(editSession, triggerTime, item.appmsgid);
    console.log(`[wechat-batch] ✅ 保存确认！获得 appmsgid: ${savedAppmsgid}`);

    // 10. 核心时序防丢 ID (硬要求)：一旦保存拿到 ID，立即在重开前持久化保全为 saved-unverified！
    if (!options.dryRun) {
      recordVerifiedDraft(item.id, savedAppmsgid, {
        verified: false,
        evidenceNotes: `pre-reopen save secured (appmsgid=${savedAppmsgid})`,
      }, {
        mode: isRepairMode ? 'metadata-repair' : 'full-content',
        outerTitle: finalOuterTitle,
      });
      console.log(`[wechat-batch] 💾 草稿 ID ${savedAppmsgid} 已在重开前落盘保全 (saved-unverified, outerTitle="${finalOuterTitle}")`);
    }

    // 11. 保存后新建独立的 task-owned reopen tab 进行物理重开复验 (彻底消除同 href 假刷新与 DOM 残留)
    console.log(`[wechat-batch] 正在新建独立标签页执行保存后重开物理复验 (Reload Verification)...`);
    const inspectUrl = buildWechatEditUrl(savedAppmsgid, token);

    // 首先关闭原编辑标签页，释放其 DOM 与所有临时内存
    if (editorTargetId) {
      try { await cdp.send('Target.closeTarget', { targetId: editorTargetId }); } catch {}
      editorTargetId = null;
    }
    await sleep(1000); // 缓冲原标签页关闭

    // 使用 CDP Target.createTarget 新建一个绝对干净的独立重开标签页
    const createdReopen = await cdp.send<{ targetId: string }>('Target.createTarget', { url: inspectUrl });
    const reopenTargetId = createdReopen.targetId;

    let isAllVerified = false;

    try {
      const { sessionId: reopenSid } = await cdp.send<{ sessionId: string }>(
        'Target.attachToTarget',
        { targetId: reopenTargetId, flatten: true }
      );
      const reopenSession: EditorSession = { cdp, sessionId: reopenSid, targetId: reopenTargetId };

      await cdp.send('Page.enable', {}, { sessionId: reopenSid });
      await cdp.send('Runtime.enable', {}, { sessionId: reopenSid });
      await cdp.send('DOM.enable', {}, { sessionId: reopenSid });

      // 严格等待全新 document 从服务器拉取并完成基础 DOM 加载
      await waitForSelector(reopenSession, '#title', 30_000);
      await waitForSelector(reopenSession, BODY_EDITOR_SELECTOR, 25_000);

      // 条件轮询等待微信异步自定义元素 mp-common-profile、封面背景图和正文图片解码完成
      const expectedImageCount = renderResult ? renderResult.images.length + renderResult.existingCdnImages.length : imgReport.images.length;
      const mediaWaitStarted = Date.now();
      while (Date.now() - mediaWaitStarted < 35_000) {
        const ready = await evaluatePage<boolean>(reopenSession, `(() => {
          const t = document.querySelector('#title');
          const editor = document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)});
          if (!t || !editor || !t.value?.trim()) return false;
          if (!${JSON.stringify(skipProfileCard)}) {
            const card = editor.querySelector('mp-common-profile');
            if (!card) return false;
          }
          const area = document.querySelector('#js_cover_area');
          const coverEl = area?.querySelector('.first_appmsg_cover') || area?.querySelector('[style*="background-image"]');
          const bg = coverEl ? (window.getComputedStyle(coverEl).backgroundImage || coverEl.style.backgroundImage || '') : '';
          if (!bg.includes('url(') || bg.includes('none')) return false;
          const imgs = Array.from(editor.querySelectorAll('img:not(.ProseMirror-separator)'));
          if (!${JSON.stringify(isRepairMode)} && imgs.length !== ${expectedImageCount}) return false;
          return imgs.every(img => img.complete && img.naturalWidth > 0);
        })()`).catch(() => false);
        if (ready) break;
        await sleep(300);
      }
      await sleep(200);

      // 严格使用 new URL().searchParams.get('appmsgid') 校验重开草稿 ID
      const reloadedHref = await evaluatePage<string>(reopenSession, 'window.location.href');
      const urlObj = new URL(reloadedHref);
      const reloadedId = urlObj.searchParams.get('appmsgid');
      if (reloadedId !== String(savedAppmsgid)) {
        throw new Error(`重开页面 URL appmsgid (${reloadedId}) 与目标 ID (${savedAppmsgid}) 不符: ${reloadedHref}`);
      }

      const inspection = await inspectEditorFeatures(reopenSession);

      // 严格获取重开后特征：作者、外层标题、图片URL集合、所有图片 complete/naturalWidth 加载状态
      const reloadedFeatures = await evaluatePage<{
        author: string;
        title: string;
        imageUrls: string[];
        allImagesLoaded: boolean;
      }>(reopenSession, `
        (function() {
          const a = document.querySelector('#author');
          const t = document.querySelector('#title');
          const editor = document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)});
          const imgs = editor ? Array.from(editor.querySelectorAll('img:not(.ProseMirror-separator)')) : [];
          const loaded = imgs.every(img => img.complete && img.naturalWidth > 0);
          return {
            author: a ? (a.value || '').trim() : '',
            title: t ? (t.value || '').trim() : '',
            imageUrls: imgs.map(img => img.src),
            allImagesLoaded: loaded
          };
        })()
      `);

      const h1Strict = inspection.titleH1.exists &&
        inspection.titleH1.count === 1 &&
        inspection.titleH1.isFirstElement &&
        inspection.titleH1.text?.trim() === item.title.trim();

      const cardStrict = skipProfileCard || (
        inspection.profileCard.exists &&
        inspection.profileCard.isRealMpCommonProfile &&
        inspection.profileCard.isAtEnd &&
        inspection.profileCard.dataNickname === RUIDUOBAO_TARGET_NICKNAME &&
        inspection.profileCard.dataId === RUIDUOBAO_TARGET_DATA_ID
      );

      const coverStrict = inspection.cover.hasCover &&
        !!inspection.cover.coverUrl &&
        inspection.cover.coverUrl.trim() !== '';

      const authorStrict = reloadedFeatures.author === targetAuthor;
      const titleStrict = reloadedFeatures.title === finalOuterTitle;

      const afterSaveContent = await evaluatePage<{ text: string; images: string[] }>(reopenSession, contentSnapshotExpression);
      const textPreserved = beforeSaveContent.text === afterSaveContent.text;
      const imgVerify = await verifyReopenedImagesMatch(beforeSaveContent.images, afterSaveContent.images, {
        localImagePaths: !isRepairMode && renderResult && renderResult.existingCdnImages.length === 0
          ? renderResult.images.map(x => x.localPath)
          : undefined,
      });
      const contentPreserved = textPreserved && imgVerify.matched;
      if (!contentPreserved) {
        fs.mkdirSync(statePaths.stateCacheDir, { recursive: true });
        fs.writeFileSync(path.join(statePaths.stateCacheDir, 'last-content-mismatch.json'), JSON.stringify({
          id: item.id,
          textPreserved,
          imageMatch: imgVerify,
          before: beforeSaveContent,
          after: afterSaveContent,
        }, null, 2));
      }
      const imagesNotLost = isRepairMode
        ? imgVerify.matched && reloadedFeatures.allImagesLoaded
        : (reloadedFeatures.imageUrls.length === expectedImageCount) && reloadedFeatures.allImagesLoaded && imgVerify.matched;

      isAllVerified = h1Strict && cardStrict && coverStrict && authorStrict && titleStrict && imagesNotLost && contentPreserved;

      console.log(`[wechat-batch] 严格复验报告 (独立重开标签页):
  - 正文文字和图片顺序: ${contentPreserved} (${imgVerify.method}${imgVerify.maxMae !== undefined ? `, maxMAE=${imgVerify.maxMae.toFixed(4)}` : ''}${imgVerify.reason ? `, reason=${imgVerify.reason}` : ''})
  - H1 匹配且首位唯一: ${h1Strict}
  - 名片组件且居尾端:   ${cardStrict}
  - 封面非空实际 URL:  ${coverStrict}
  - 作者实际填写锐多宝: ${authorStrict}
  - 外部标题严格保持:   ${titleStrict}
  - 正文图片集合无损:   ${imagesNotLost} (重开图片数: ${reloadedFeatures.imageUrls.length}, 全部已加载: ${reloadedFeatures.allImagesLoaded})
  -> 综合复验判定: ${isAllVerified ? 'PASSED (全部达标)' : 'FAILED (部分未达标)'}`);

      // 12. 复验通过后晋升持久化状态
      if (!options.dryRun) {
        recordVerifiedDraft(item.id, savedAppmsgid, {
          verified: isAllVerified,
          verifiedAt: new Date().toISOString(),
          h1Matched: h1Strict,
          authorMatched: authorStrict,
          coverMatched: coverStrict,
          cardMatched: cardStrict,
          reloadedAppmsgid: savedAppmsgid,
          evidenceNotes: `H1:${h1Strict} | Card:${cardStrict} | Cover:${coverStrict} | Author:${authorStrict} | Imgs:${imagesNotLost}`,
        }, {
          mode: isRepairMode ? 'metadata-repair' : 'full-content',
          outerTitle: finalOuterTitle,
        });
      }
    } finally {
      // 无论复验结果如何，关闭独立新建的 reopen 标签页释放内存
      try { await cdp.send('Target.closeTarget', { targetId: reopenTargetId }); } catch {}
    }

    return {
      success: isAllVerified,
      appmsgid: savedAppmsgid,
      verified: isAllVerified,
      error: isAllVerified ? undefined : '保存后独立标签重开复验未全部满足严格证据要求',
    };
  } catch (err: any) {
    console.error(`[wechat-batch] ❌ 本篇处理异常:`, err?.message || err);
    // 微信可能在手动保存前自动落库。先重开确认文章身份并保全 ID，避免失败重跑再建副本。
    if (!item.appmsgid && editSession && editorTargetId) {
      let recoveryTarget: string | undefined;
      try {
        const assignedId = await evaluatePage<string | null>(editSession, `new URL(location.href).searchParams.get('appmsgid')`);
        if (assignedId && /^\d+$/.test(assignedId)) {
          recordDraftCandidate(item.id, assignedId, 'Task-owned edit page received an autosaved ID; independent identity confirmation pending');
          const created = await cdp.send<{ targetId: string }>('Target.createTarget', { url: buildWechatEditUrl(assignedId, token) });
          recoveryTarget = created.targetId;
          const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: recoveryTarget, flatten: true });
          const recoverySession = { cdp, sessionId, targetId: recoveryTarget };
          await waitForSelector(recoverySession, BODY_EDITOR_SELECTOR, 20_000);
          await assertArticleEditor(recoverySession);
          const identityMatches = await evaluatePage<boolean>(recoverySession, `document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)})?.textContent.includes(${JSON.stringify(item.title)})`);
          if (identityMatches) {
            recordVerifiedDraft(item.id, assignedId, { verified: false, evidenceNotes: 'Autosaved draft identity confirmed by independent reopen; processing requires retry' }, { mode: 'full-content', outerTitle: options.titleOverride || item.outerTitle });
          }
        }
      } catch (recoveryError: any) {
        console.error(`[wechat-batch] 自动保存 ID 核对未完成: ${recoveryError.message}`);
      } finally {
        if (recoveryTarget) await cdp.send('Target.closeTarget', { targetId: recoveryTarget });
      }
    }
    if (editorTargetId && connected.cdp) {
      try { await connected.cdp.send('Target.closeTarget', { targetId: editorTargetId }); } catch {}
    }
    return { success: false, verified: false, error: err?.message || String(err) };
  } finally {
    if (renderResult) {
      try { renderResult.cleanup(); } catch {}
    }
  }
}

// -----------------------------------------------------------------------------
// 主编排执行入口
// -----------------------------------------------------------------------------
export async function runBatchPipeline(options: BatchCliOptions = parseBatchArgs()): Promise<number> {
  console.log(`================================================================`);
  console.log(`[wechat-batch] 微信公众号草稿箱在原草稿更新与发布引擎 (Safe Spine + E 接线)`);
  console.log(`  模式: ${options.dryRun ? 'DRY-RUN (纯读演练)' : options.repair ? 'REPAIR (原稿精修)' : 'FULL-PIPELINE'}`);
  if (options.id) console.log(`  单篇过滤: ${options.id}`);
  if (options.search) console.log(`  关键词检索: "${options.search}"`);
  if (options.latest) console.log(`  最新推文选取: 最近 ${options.latest} 篇`);
  if (options.limit) console.log(`  处理上限: ${options.limit} 篇`);
  if (options.days) console.log(`  天数范围: 最近 ${options.days} 天`);
  console.log(`================================================================`);

  let lockAcquired = false;
  if (!options.dryRun) {
    lockAcquired = acquireProcessLock('batch-fast-wechat');
    if (!lockAcquired) {
      console.error(`[wechat-batch] ❌ 无法获取进程锁，可能另有实例正在运行，退出。`);
      return 1;
    }
  }

  try {
    const legacyBaseline = getOrCreateLegacyBaseline({ persist: !options.dryRun });

    // 锁内先持久化当前合并记录 (新文在此刻已入库，status: untracked，避免 record 时找不到 target)
    const catalog = computeStateCatalog({
      dryRun: options.dryRun,
      targetId: options.id,
      persist: !options.dryRun,
    });

    console.log(`[wechat-batch] 状态库统计: 总计 ${catalog.totalScanned} 篇 | 活跃已确立: ${catalog.activeCount} 篇 | 待对齐: ${catalog.needsReconcileCount} 篇 | 缺图拦截: ${catalog.missingImageCount} 篇 | 未入库新篇: ${catalog.untrackedCount} 篇`);

    if (options.id) {
      const targetExists = catalog.articles.some(a => a.id === options.id);
      if (!targetExists) {
        console.error(`❌ [wechat-batch] 未找到指定文章 ID: ${options.id} (请运行 --check --search "<关键词>" 确认精确 articleId)`);
        return 1;
      }
    }

    let scopedArticles = catalog.articles;
    if (options.id) {
      scopedArticles = scopedArticles.filter(a => a.id === options.id);
    }
    if (options.batch) {
      scopedArticles = scopedArticles.filter(a => a.batch === options.batch);
    }
    if (options.source && options.source !== 'all') {
      scopedArticles = scopedArticles.filter(a => a.source === options.source);
    }
    if (options.days && options.days > 0) {
      const d = new Date();
      d.setDate(d.getDate() - options.days);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const cutoff = `${yyyy}${mm}${dd}`;
      scopedArticles = scopedArticles.filter(a => a.batch.slice(0, 8) >= cutoff);
    }

    if (options.search) {
      const kw = options.search.trim().toLowerCase();
      scopedArticles = scopedArticles.filter(a => {
        if (
          a.id.toLowerCase().includes(kw) ||
          a.file.toLowerCase().includes(kw) ||
          a.title.toLowerCase().includes(kw) ||
          (a.outerTitle || '').toLowerCase().includes(kw)
        ) {
          return true;
        }
        if (a.fullPath && fs.existsSync(a.fullPath)) {
          try {
            const text = fs.readFileSync(a.fullPath, 'utf-8').slice(0, 3000).toLowerCase();
            return text.includes(kw);
          } catch {}
        }
        return false;
      });
    }

    if (options.latest && options.latest > 0) {
      scopedArticles = scopedArticles
        .filter(a => a.fullPath && fs.existsSync(a.fullPath))
        .map(a => {
          let mtimeMs = 0;
          try { mtimeMs = fs.statSync(a.fullPath).mtimeMs; } catch {}
          return { article: a, mtimeMs };
        })
        .sort((x, y) => y.article.batch.localeCompare(x.article.batch) || (y.mtimeMs - x.mtimeMs))
        .slice(0, options.latest)
        .map(x => x.article);
    }

    // 在 --dry-run 且显式使用 --search 或 --latest 时，打印所有命中文章（包含已 skip 的现状），便于迅速查看定位
    if (options.dryRun && (options.search || options.latest)) {
      console.log(`\n--- [DRY-RUN 检索/最新匹配结果 (${scopedArticles.length} 篇)] ---`);
      for (const a of scopedArticles) {
        const plan = planArticleAction(a, options, legacyBaseline);
        console.log(`* [${a.id}] status=${a.status} verified=${!!a.verification?.verified} appmsgid=${a.appmsgid || 'new'} action=${plan.action.toUpperCase()}`);
        console.log(`    文件: ${a.fullPath}`);
        console.log(`    完整标题: "${a.title}"`);
        console.log(`    当前外题: "${a.outerTitle}"`);
      }
      if (scopedArticles.length === 0) {
        console.log(`  (未匹配到任何文章)`);
      }
    }

    let candidates = scopedArticles.filter(item => {
      const plan = planArticleAction(item, options, legacyBaseline);

      if (plan.action === 'skip') return false;

      // needs-reconcile 项即使指定 --id 也绝对不得进入自动流程
      if (plan.action === 'needs-reconcile') {
        if (options.id) {
          console.error(`❌ [wechat-batch] 拒绝处理: 文章 "${item.id}" ${plan.reason}。--id 不是从零重建历史的授权！`);
        }
        return false;
      }

      // 缺图分流：原地 repair 允许复用微信已有 CDN 图；其他模式阻断
      if (item.status === 'missing-image' && plan.action !== 'repair') {
        return false;
      }

      return true;
    });

    if (!options.latest) {
      candidates.sort((a, b) => a.id.localeCompare(b.id));
    }

    if (options.limit && options.limit > 0) {
      candidates = candidates.slice(0, options.limit);
    }

    console.log(`[wechat-batch] 本次就绪待处理篇数: ${candidates.length} 篇`);

    if (candidates.length === 0) {
      console.log(`[wechat-batch] 无待处理任务，流程正常结束，不触碰浏览器。`);
      return 0;
    }

    if (options.dryRun) {
      console.log(`\n--- [DRY-RUN 待处理文章演练清单] ---`);
      let needsTitleCount = 0;
      const missingTitleIds: string[] = [];
      for (const c of candidates) {
        const plan = planArticleAction(c, options, legacyBaseline);
        let resolvedTitle: string | undefined;
        let titleProblem: string | undefined;
        try {
          resolvedTitle = resolveOuterTitle(c, '', options);
        } catch (error: any) {
          if (!String(error.message).startsWith('needs-title:')) throw error;
          titleProblem = error.message;
          needsTitleCount++;
          missingTitleIds.push(c.id);
        }
        console.log(`* [${c.id}] action=${plan.action.toUpperCase()} appmsgid=${c.appmsgid || 'new'} file=${c.file}`);
        console.log(`    计划说明: ${plan.reason}`);
        console.log(`    完整标题: "${c.title}"`);
        if (titleProblem) {
          console.log(`    [needs-title] ${titleProblem}`);
          if (c.fullPath && fs.existsSync(c.fullPath)) {
            try {
              const snippetLines = fs.readFileSync(c.fullPath, 'utf-8')
                .split('\n')
                .map(l => l.trim())
                .filter(l => l && !l.startsWith('#'))
                .slice(0, 2)
                .join(' ');
              if (snippetLines) {
                console.log(`    内容摘要: ${snippetLines.slice(0, 120)}${snippetLines.length > 120 ? '...' : ''}`);
              }
            } catch {}
          }
        } else {
          console.log(`    外部标题: "${resolvedTitle}"`);
        }
      }
      if (needsTitleCount > 0) {
        console.log(`[wechat-batch] 待补语义外题: ${needsTitleCount} 篇；可用 \`bun run titles "${missingTitleIds[0]}=<≤15字短标题>"\` 合并写入 titles-override.json。`);
      } else {
        console.log(`[wechat-batch] 待补语义外题: 0 篇；正式写入仍要求标题校验通过。`);
      }
      console.log(`\n[wechat-batch] DRY-RUN 完成，未修改任何真实草稿或数据库文件。`);
      return 0;
    }

    const connected = await connectOrCreateHomeSession();
    console.log(`[wechat-batch] ✅ 公众号后台会话就绪，Token: ***${connected.token.slice(-4)}`);

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < candidates.length; i++) {
      const item = candidates[i]!;
      console.log(`\n----------------------------------------------------------------`);
      console.log(`[wechat-batch] 进度 [${i + 1}/${candidates.length}] 处理: ${item.id} (appmsgid: ${item.appmsgid || '新建'})`);

      const res = await processSingleArticle(item, connected, options, legacyBaseline);
      if (res.success) {
        successCount++;
      } else {
        failCount++;
      }

      if (i < candidates.length - 1) {
        await sleep(1200);
      }
    }

    console.log(`\n================================================================`);
    console.log(`[wechat-batch] 批次执行完成: 成功 ${successCount} 篇 | 失败 ${failCount} 篇`);
    console.log(`================================================================`);

    return failCount > 0 ? 1 : 0;
  } finally {
    if (lockAcquired) {
      releaseProcessLock();
    }
  }
}

if (import.meta.main) {
  runBatchPipeline().then(exitCode => {
    process.exit(exitCode);
  }).catch(err => {
    console.error('[wechat-batch] 致命崩溃:', err);
    process.exit(1);
  });
}
