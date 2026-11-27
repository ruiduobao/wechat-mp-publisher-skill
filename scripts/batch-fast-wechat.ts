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
import { spawn, spawnSync } from 'node:child_process';
import {
  CdpConnection,
  findChromeExecutable,
  findExistingChromeDebugPort,
  getDefaultProfileDir,
  getFreePort,
  sleep,
  type ChromeSession,
} from './cdp.ts';
import {
  acquireProcessLock,
  releaseProcessLock,
  computeStateCatalog,
  recordVerifiedDraft,
  recordDraftCandidate,
  recordUnsupportedDraft,
  buildWechatEditUrl,
  sanitizeUrlForLog,
  verifyImagesIntegrity,
  getOrCreateLegacyBaseline,
  getStatePaths,
  loadHistoryDatabase,
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
  cleanupEmptyParagraphsNatively,
  inspectEditorLayoutHealth,
  type RenderArticleResult,
} from './article-content.ts';
import { assertArticleEditor } from './editor-mode.ts';
import { verifyArticleTruth, type ArticleVerificationReport } from './verify-article.ts';
export { evaluateEditorMessageType, type EditorTypeSnapshot } from './editor-mode.ts';

const WECHAT_URL = 'https://mp.weixin.qq.com/';

// -----------------------------------------------------------------------------
// CLI 参数解析与门禁检查
// -----------------------------------------------------------------------------
export interface BatchCliOptions {
  dryRun: boolean;
  keepalive?: boolean;
  repair: boolean;
  refreshContent: boolean;
  verify?: boolean;
  skipVerify?: boolean;
  strictVerify?: boolean;
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
  --keepalive               轻量登录态探测 (单独使用；仅访问官方后台首页检测当前登录态，不扫描/不改写草稿，不保证续期时长)
  --verify                  配合 --check 运行在线论文真实性与 DOI/arXiv/链接核查
  --skip-verify             显式跳过正式写入前的在线 DOI/arXiv 真实性门禁
  --strict-verify           严格核查模式 (遇到警告如无DOI/链接403也阻断发布)
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
  // 帮助优先：--help/-h 出现在任意位置都直接输出帮助并退出 0，不先被业务参数值/缺值分支拦截。
  if (args.some(a => a === '--help' || a === '-h')) {
    printHelpAndExit();
  }
  let dryRun = false;
  let keepalive = false;
  let verify = false;
  let skipVerify = false;
  let strictVerify = false;
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
  let businessArgSeen = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    // 只把开关本身计入业务参数；带值参数的值由对应分支消费，不当作独立开关。
    if (a.startsWith('-') && a !== '--keepalive') businessArgSeen = true;
    if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--keepalive') {
      keepalive = true;
    } else if (a === '--verify') {
      verify = true;
    } else if (a === '--skip-verify') {
      skipVerify = true;
    } else if (a === '--strict-verify') {
      strictVerify = true;
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

  // 严格门禁：--keepalive 只能单独使用（--help 已在解析时提前退出）
  if (keepalive && businessArgSeen) {
    console.error('❌ 参数错误: --keepalive 必须单独使用（仅可与 --help 配合），不能与其它业务参数组合');
    process.exit(2);
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

  return { dryRun, keepalive, verify, skipVerify, strictVerify, repair, refreshContent, id, search, latest, limit, batch, days, source, titleOverride, titlesFile, titleMap };
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

  // 已知不支持的图片轮播等特殊消息类型：在未指定单篇 --id 强制重检时，直接安全跳过避免每次开浏览器等超时
  if (item.unsupportedMessageType && !options.id && !options.refreshContent) {
    return { action: 'skip', reason: `已保留非普通长文原稿 (${item.unsupportedMessageType})` };
  }

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
  errMsg?: string;
  appMsgId?: string;
  timestamp: number;
}

async function installSaveNetworkHook(session: EditorSession): Promise<void> {
  await evaluatePage(session, `
    (function() {
      if (window.__saveHookInstalled) return;
      window.__saveHookInstalled = true;
      window.__lastSaveResponse = null;

      const isSaveActionUrl = (url) => {
        if (!url || !url.includes('operate_appmsg')) return false;
        if (url.includes('pre_load_')) return false;
        return url.includes('sub=create') || url.includes('sub=update') || !url.includes('sub=');
      };

      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url) {
        this.__interceptUrl = url;
        return origOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function() {
        if (isSaveActionUrl(this.__interceptUrl)) {
          this.addEventListener('load', function() {
            try {
              const res = JSON.parse(this.responseText);
              const retRaw = res.base_resp ? res.base_resp.ret : res.ret;
              window.__lastSaveResponse = {
                ret: Number(retRaw),
                errMsg: (res.base_resp && res.base_resp.err_msg) || res.msg || '',
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
            if (isSaveActionUrl(url)) {
              const clone = res.clone();
              clone.json().then(data => {
                const retRaw = data.base_resp ? data.base_resp.ret : data.ret;
                window.__lastSaveResponse = {
                  ret: Number(retRaw),
                  errMsg: (data.base_resp && data.base_resp.err_msg) || data.msg || '',
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

    if (netRes) {
      if (netRes.ret !== 0) {
        throw new Error(`微信保存草稿被服务端拒绝 (ret=${netRes.ret}): ${netRes.errMsg || '未知原因'}`);
      }
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

/**
 * 只接受真正位于官方后台首页的标签：https、无自定义端口、host 精确为
 * mp.weixin.qq.com、pathname 为 /cgi-bin/home（允许结尾斜杠）。
 * 拒绝同路径的非官方 host、子域、http 与带端口 URL。
 */
export function isOfficialHomeTargetUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'mp.weixin.qq.com' || url.port !== '') return false;
    return url.pathname === '/cgi-bin/home' || url.pathname === '/cgi-bin/home/';
  } catch {
    return false;
  }
}

/**
 * 专用 Profile 的调试端口可能“进程还在、CDP 已无响应”（浏览器卡死或代理拦截）。
 * 此时按未运行处理：只终止 user-data-dir 精确等于专用 Profile 的 Edge 进程，
 * 再由启动逻辑重新拉起常驻实例。绝不触碰用户其它 Edge 窗口。
 */
export function terminateDedicatedBrowser(profileDir: string): number {
  if (process.platform !== 'win32') return 0;
  try {
    const target = path.resolve(profileDir).replace(/'/g, "''");
    const script = [
      `$target = '${target}'`,
      "$procs = Get-CimInstance Win32_Process -Filter \"name='msedge.exe'\"",
      '$killed = 0',
      'foreach ($p in $procs) {',
      '  $cmd = $p.CommandLine',
      '  if (-not $cmd) { continue }',
      '  if ($cmd.ToLower().Contains($target.ToLower())) {',
      '    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $killed++ } catch {}',
      '  }',
      '}',
      'Write-Output $killed',
    ].join('\n');
    const output = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf-8',
      timeout: 15_000,
    });
    const count = parseInt((output.stdout || '').trim(), 10);
    return Number.isFinite(count) ? count : 0;
  } catch {
    return 0;
  }
}

/** 读取 CDP 版本信息；端口未就绪或代理干扰时返回 null，不抛出。 */
async function fetchCdpVersion(port: number, timeoutMs = 2500): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 轮询等待调试端口真正可用（浏览器冷启动时端口可能晚于进程出现）。 */
async function waitForCdpVersion(port: number, timeoutMs: number): Promise<any | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const version = await fetchCdpVersion(port);
    if (version?.webSocketDebuggerUrl) return version;
    await sleep(500);
  }
  return null;
}

export interface HomeSessionOptions {
  /** 保活路径必须为 false：不读取 Storage.getCookies，也不导出任何 Cookie 元数据。 */
  checkSessionCookie?: boolean;
  /** 保活路径允许未就绪首页返回，由后续三态探测判定，避免把加载超时误报为登录失效。 */
  requireReadyHome?: boolean;
}

export async function connectOrCreateHomeSession(options: HomeSessionOptions = {}): Promise<ConnectedHome> {
  const { checkSessionCookie = true, requireReadyHome = true } = options;
  const profileDir = getDefaultProfileDir();
  let cdp: CdpConnection | undefined;

  let port = await findEdgeDebugPort(profileDir);
  if (!port) {
    port = await findExistingChromeDebugPort(profileDir);
  }

  if (port) {
    // 先用轮询确认端口真的可服务，避免冷启动竞态把“还没起来”误判成“连不上”。
    let version = await waitForCdpVersion(port, 3_000);
    if (version) {
      try {
        cdp = await CdpConnection.connect(version.webSocketDebuggerUrl, 12_000);
      } catch {
        cdp = undefined;
      }
    }
    if (cdp) {
      console.log(`[wechat-batch] 成功连接已有浏览器调试端口: ${port}`);
    } else {
      console.warn(`[wechat-batch] 调试端口 ${port} 无响应，专用浏览器可能已卡死`);
      if (process.env.WECHAT_NO_BROWSER_AUTORESTART === '1') {
        throw new Error(`[wechat-batch] 调试端口 ${port} 无法建立连接，且已禁用自动重启 (WECHAT_NO_BROWSER_AUTORESTART=1)`);
      }
      const killed = terminateDedicatedBrowser(profileDir);
      console.warn(`[wechat-batch] 已终止专用 Profile 卡死进程 ${killed} 个，准备重新拉起`);
      await sleep(1_500);
      port = undefined;
    }
  }

  if (!cdp) {
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
        // 浏览器磁盘缓存可外置，避免 C: 盘紧张时拖垮保存与重开复验。
        ...(process.env.WECHAT_BROWSER_CACHE_DIR ? [`--disk-cache-dir=${process.env.WECHAT_BROWSER_CACHE_DIR}`] : []),
        '--disable-blink-features=AutomationControlled',
        '--start-maximized',
        '--no-first-run',
        '--no-default-browser-check',
        `${WECHAT_URL}cgi-bin/home?t=home/index`,
      ],
      { detached: true, stdio: 'ignore', windowsHide: false }
    );
    child.unref();

    // 冷启动时端口可能明显晚于进程出现；轮询 45 秒，避免一次过早判断就失败。
    const version = await waitForCdpVersion(freePort, 45_000);
    if (!version?.webSocketDebuggerUrl) {
      throw new Error(`[wechat-batch] 专用浏览器已启动但调试端口 ${freePort} 在 45 秒内未就绪`);
    }
    cdp = await CdpConnection.connect(version.webSocketDebuggerUrl, 12_000);
    console.log(`[wechat-batch] ✅ 已独立拉起并连接专用浏览器调试端口: ${freePort}`);
  }

  if (!cdp) {
    throw new Error('[wechat-batch] 无法建立专用浏览器 CDP 连接');
  }

  // CDP 连接成功后任何 Target/attach/evaluate 失败都必须关闭连接再抛出，
  // 避免保活或发布路径在 runKeepaliveSession 之外泄漏 WebSocket 资源。
  try {
    await sleep(400);
    const targets = await cdp.send<{ targetInfos: Array<{ targetId: string; url: string; type: string }> }>('Target.getTargets');

    // 冷启动可能同时恢复多个后台首页标签（含已失效的“请重新登录”页），
    // 仅选择官方 host + /cgi-bin/home path 的 page；优先带 token= 的有效会话标签。
    const homeCandidates = targets.targetInfos.filter(t => t.type === 'page' && isOfficialHomeTargetUrl(t.url));
    let homeTarget = homeCandidates.find(t => /[?&]token=\d+/.test(t.url)) || homeCandidates[0];

    if (!homeTarget) {
      const created = await cdp.send<{ targetId: string }>('Target.createTarget', { url: `${WECHAT_URL}cgi-bin/home?t=home/index` });
      homeTarget = { targetId: created.targetId, url: WECHAT_URL, type: 'page' };
      await sleep(1500);
    }

    const { sessionId: homeSid } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: homeTarget.targetId, flatten: true });
    const homeSession: EditorSession = { cdp, sessionId: homeSid, targetId: homeTarget.targetId };

    await cdp.send('Page.enable', {}, { sessionId: homeSid }).catch(() => {});
    await cdp.send('Runtime.enable', {}, { sessionId: homeSid }).catch(() => {});

    // 等待首页完成重定向和加载 (避免刚冷启动 Edge 时中途打断 /cgi-bin/home 302 跳转)
    if (requireReadyHome) {
      let isMenuReady = await waitForSelector(homeSession, '.new-creation__menu', 10_000);
      if (!isMenuReady) {
        const currentUrl = await evaluatePage<string>(homeSession, 'window.location.href');
        const hasToken = /[?&]token=\d+/.test(currentUrl);
        if (!hasToken) {
          // 冷启动恢复的旧标签可能停留在“请重新登录”壳页面（URL 仍含 /cgi-bin/home 但无 token）。
          // 直接访问站点根路径会由服务端 302 到带 token 的后台首页，从而拿到有效会话。
          console.log(`[wechat-batch] 首页缺少 token，导航至站点根路径以获取有效会话...`);
          await evaluatePage(homeSession, `window.location.href = '${WECHAT_URL}'`);
          await sleep(4000);
        } else if (!currentUrl.includes('/cgi-bin/home')) {
          console.log(`[wechat-batch] 导航至公众号后台首页...`);
          await evaluatePage(homeSession, `window.location.href = '${WECHAT_URL}cgi-bin/home?t=home/index'`);
          await sleep(1500);
        }
        isMenuReady = await waitForSelector(homeSession, '.new-creation__menu', 18_000);
      }
      if (!isMenuReady) {
        throw new Error('[wechat-batch] 公众号后台登录态已失效或首页加载超时，请在专用浏览器扫码续期后重试 (needs-attention)');
      }
    }

    // 只有发布路径（requireReadyHome）才解析 token；保活探针只需一个合法的
    // ConnectedHome 结构，返回空 token 即可，绝不在页面里执行 URL/token 读取。
    let token = '';
    if (requireReadyHome) {
      const homeFinalUrl = await evaluatePage<string>(homeSession, 'window.location.href');
      const tokenMatch = homeFinalUrl.match(/token=(\d+)/);
      token = tokenMatch?.[1] || '';
      if (!token) {
        throw new Error('[wechat-batch] 无法从后台首页 URL 中解析出有效 token');
      }
    }

    // 会话真实性守卫（仅普通发布路径）：首页可能只是缓存渲染（菜单存在、token 仍在 URL 中），
    // 但后台接口实际已返回“登录超时”。以是否存在 slave_sid 会话 Cookie 作为硬判据，
    // 避免误报“会话就绪”后逐篇空转 30 秒。保活路径明确跳过本段，绝不读取 Cookie。
    // 本段只读取 Cookie 的名称/域等元数据，不记录、不导出任何 Cookie 值。
    if (checkSessionCookie) {
      const cookieSnapshot = await cdp.send<{ cookies?: Array<{ name: string; domain: string; session: boolean; expires: number }> }>(
        'Storage.getCookies'
      ).catch(() => null);
      const wechatCookies = (cookieSnapshot?.cookies || []).filter(c => c.domain.includes('weixin.qq.com'));
      const hasSessionCookie = wechatCookies.some(c => c.name === 'slave_sid');
      if (cookieSnapshot && !hasSessionCookie) {
        throw new Error(
          `[wechat-batch] 公众号登录态已失效 (缺少 slave_sid 会话 Cookie，当前仅有 ${wechatCookies.length} 条 weixin Cookie)，` +
          `请在专用浏览器扫码续期后重试 (needs-attention)`
        );
      }
    }

    return { cdp, homeSession, token };
  } catch (err) {
    try { cdp.close(); } catch {}
    throw err;
  }
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

export const PRIVATE_CONTENT_CORRECTIONS_PATH = 'C:\\Users\\Administrator\\.agents\\skills\\wechat-md-pipeline\\data\\content-corrections.json';

export interface ContentCorrectionRule {
  find: string;
  replaceWith: string;
  note?: string;
}

export interface LoadedContentCorrections {
  map: Record<string, ContentCorrectionRule[]>;
  path: string;
}

export function loadContentCorrections(customPath?: string): LoadedContentCorrections {
  const filePath = customPath || process.env.WECHAT_CONTENT_CORRECTIONS_FILE || PRIVATE_CONTENT_CORRECTIONS_PATH;
  if (!fs.existsSync(filePath)) return { map: {}, path: filePath };

  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err: any) {
    throw new Error(`[wechat-batch] FATAL: 内容修正映射文件 JSON 格式损坏: ${filePath} (${err.message})`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`[wechat-batch] FATAL: 内容修正映射文件结构错误，必须为 { articleId: [{ find, replaceWith }] } 字典: ${filePath}`);
  }

  for (const [articleId, rules] of Object.entries(parsed)) {
    if (!Array.isArray(rules) || rules.length === 0) {
      throw new Error(`[wechat-batch] FATAL: 内容修正映射文件 ${articleId} 的规则必须为非空数组: ${filePath}`);
    }
    for (const rule of rules as any) {
      if (typeof rule?.find !== 'string' || rule.find.length === 0 || typeof rule?.replaceWith !== 'string') {
        throw new Error(`[wechat-batch] FATAL: 内容修正映射文件 ${articleId} 存在非法规则 (find 必须为非空字符串，replaceWith 必须为字符串): ${filePath}`);
      }
    }
  }

  return { map: parsed as Record<string, ContentCorrectionRule[]>, path: filePath };
}

export function applyContentCorrections(
  markdown: string,
  articleId: string,
  corrections?: LoadedContentCorrections
): string {
  const rules = corrections?.map[articleId];
  if (!rules || rules.length === 0) return markdown;
  let applied: string[] = [];
  let corrected = markdown;
  for (const rule of rules) {
    if (corrected.includes(rule.find)) {
      corrected = corrected.split(rule.find).join(rule.replaceWith);
      applied.push(`${rule.find} -> ${rule.replaceWith}${rule.note ? ` (${rule.note})` : ''}`);
    }
  }
  if (applied.length > 0) {
    console.log(`[content-corrections] ✅ 已按私有修正映射改写 ${articleId} 的内存内容 (${applied.length} 处，源文件保持只读):`);
    for (const a of applied) console.log(`    - ${a}`);
  }
  return corrected;
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

/**
 * 区分“外部瞬时故障”与“内容/流程错误”：前者重试一次通常即可恢复，
 * 后者重试只会浪费时间和 CDN 配额。只对明确的超时/页面加载类错误放行。
 */
export function isTransientPublishFailure(message?: string): boolean {
  const text = String(message || '');
  if (!text) return false;
  if (/needs-title|needs-cover|needs-attention|占位符|未定位|真实性|核查|标题/i.test(text)) return false;
  return /封面|cover background image|cdn 图片就绪超时|图片上传就绪失败|cloneNode|timeout|超时|execution exception/i.test(text);
}

/**
 * 同一篇文章可能以不同路径/批次再次出现（例如同步源改名后重推）。
 * 对“准备新建”的候选，若其完整内容指纹与某个已确立记录完全一致，则视为重复，
 * 返回 candidateId -> existingId，避免创建第二份草稿。
 */
export function findDuplicateCreateIds(
  candidates: DraftStateRecord[],
  history: Record<string, DraftStateRecord>,
  options: BatchCliOptions,
  legacyBaseline: Set<string>
): Map<string, string> {
  const duplicates = new Map<string, string>();
  if (options.id) return duplicates; // 显式单篇允许人工强制处理
  // 指纹中的 imageHash 含绝对路径，换挂载目录后会不同；重复判定改用
  // “正文内容哈希 + 逐图 sha256 顺序”，忽略路径与 mtime。
  const contentSignature = (fp?: DraftStateRecord['observedFingerprint']): string | null => {
    if (!fp) return null;
    const shas = (fp.images || []).map(img => img.sha256 || 'missing').join(',');
    return `${fp.contentHash}|${shas}`;
  };
  const establishedBySignature = new Map<string, string>();
  for (const [id, record] of Object.entries(history)) {
    const signature = contentSignature(record.observedFingerprint);
    if (signature && record.appmsgid && record.verification?.verified) establishedBySignature.set(signature, id);
  }
  for (const candidate of candidates) {
    if (planArticleAction(candidate, options, legacyBaseline).action !== 'create') continue;
    const signature = contentSignature(candidate.observedFingerprint);
    if (!signature) continue;
    const existing = establishedBySignature.get(signature);
    if (existing && existing !== candidate.id) duplicates.set(candidate.id, existing);
  }
  return duplicates;
}

export function collectNewArticleTitleProblems(
  candidates: DraftStateRecord[],
  options: BatchCliOptions,
  legacyBaseline: Set<string>
): string[] {
  const problems: string[] = [];
  for (const candidate of candidates) {
    if (planArticleAction(candidate, options, legacyBaseline).action !== 'create') continue;
    try {
      resolveOuterTitle(candidate, '', options);
    } catch (error: any) {
      if (!String(error?.message).startsWith('needs-title:')) throw error;
      problems.push(`${candidate.id}: ${error.message}`);
    }
  }
  return problems;
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
    const rawMd = applyContentCorrections(
      fs.readFileSync(item.fullPath, 'utf-8'),
      item.id,
      pipelineCorrections.contentCorrections
    );
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
      renderResult = await renderArticleContent(item.fullPath, { cacheRoot: statePaths.stateCacheDir, markdownOverride: pipelineCorrections.correctedMarkdownById.get(item.id) });
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

    // 7.5 保存前通过编辑器原生按键彻底清理多余空段落 (H1后、图片前后、正文内部、名片前)
    const cleanedEmptyCount = await cleanupEmptyParagraphsNatively(editSession);
    if (cleanedEmptyCount > 0) {
      console.log(`[wechat-batch] 🧹 已通过原生按键清除 ${cleanedEmptyCount} 个多余空段落`);
    }

    // 8. 保存前全要素快速 inspect，防止未关闭 modal 误点保存
    const preSaveInspect = await inspectEditorFeatures(editSession);
    const preLayout = await inspectEditorLayoutHealth(editSession);
    const preCardOk = skipProfileCard || (
      preSaveInspect.profileCard.isRealMpCommonProfile &&
      preSaveInspect.profileCard.isAtEnd &&
      preSaveInspect.profileCard.dataId === RUIDUOBAO_TARGET_DATA_ID &&
      preSaveInspect.profileCard.dataNickname === RUIDUOBAO_TARGET_NICKNAME
    );
    if (!preSaveInspect.titleH1.exists || preSaveInspect.titleH1.count !== 1 ||
        !preSaveInspect.titleH1.isFirstElement || preSaveInspect.titleH1.text?.trim() !== item.title.trim() ||
        !preSaveInspect.cover.hasCover || !preCardOk ||
        preLayout.emptyParagraphCount > 0 || (!isRepairMode && preLayout.indentedParagraphCount > 0)) {
      throw new Error(`保存前预检失败: H1=${preSaveInspect.titleH1.exists}, 封面=${preSaveInspect.cover.hasCover}, 名片=${preSaveInspect.profileCard.exists}, 空行=${preLayout.emptyParagraphCount}, 异常缩进=${preLayout.indentedParagraphCount}`);
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

      const reopenLayout = await inspectEditorLayoutHealth(reopenSession);
      const noEmptyParagraphs = reopenLayout.emptyParagraphCount === 0;
      const noUnexpectedIndent = isRepairMode ? true : reopenLayout.indentedParagraphCount === 0;

      isAllVerified = h1Strict && cardStrict && coverStrict && authorStrict && titleStrict && imagesNotLost && contentPreserved && noEmptyParagraphs && noUnexpectedIndent;

      console.log(`[wechat-batch] 严格复验报告 (独立重开标签页):
  - 正文文字和图片顺序: ${contentPreserved} (${imgVerify.method}${imgVerify.maxMae !== undefined ? `, maxMAE=${imgVerify.maxMae.toFixed(4)}` : ''}${imgVerify.reason ? `, reason=${imgVerify.reason}` : ''})
  - 零空行与无异常缩进: ${noEmptyParagraphs && noUnexpectedIndent} (空行=${reopenLayout.emptyParagraphCount}, 异常缩进=${reopenLayout.indentedParagraphCount})
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
    const errMsg = err?.message || String(err);
    console.error(`[wechat-batch] ❌ 本篇处理异常:`, errMsg);
    if (!options.dryRun && (errMsg.includes('unsupported-message-type') || errMsg.includes('ret=320005')) && item.appmsgid) {
      try {
        recordUnsupportedDraft(item.id, item.appmsgid, errMsg);
        console.warn(`[wechat-batch] 💾 已将 ${item.id} (${item.appmsgid}) 标记保留原稿，后续全量同步将自动跳过`);
      } catch {}
    }
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

export type KeepaliveStatus = 'healthy' | 'needs-qr' | 'unknown';

export interface KeepaliveObservation {
  httpStatus?: number;
  /** 最终官方 origin + pathname，不含 query/token。 */
  finalUrl?: string;
  /** 仅用于纯函数测试兼容输入；生产探针绝不返回 HTML。 */
  html?: string;
  hasToken?: boolean;
  hasHomeMenu?: boolean;
  hasLoginFrame?: boolean;
  /** 受保护的官方后台入口明确返回认证拒绝（如“登录超时/请重新登录”）。 */
  hasAuthRejected?: boolean;
  error?: string;
}

export interface KeepaliveClassification {
  status: KeepaliveStatus;
  reason: string;
}

export const KEEPALIVE_EXIT_CODES: Record<KeepaliveStatus, number> = {
  healthy: 0,
  'needs-qr': 3,
  unknown: 4,
};

/**
 * 三态判定（纯函数）。观测对象仅携带同一次 fetch 的状态、脱敏最终路径和页面标记布尔值，
 * 不把响应 HTML、query 或 token 值返回 Node：
 * - healthy: HTTP 2xx + 官方 HTTPS 后台首页 path + token 存在 + 后台菜单标记；
 * - needs-qr: HTTP 2xx + 明确 loginpage path 优先，或后台页缺少 home marker 且存在 login_frame；
 * - unknown: 网络/CDP 错误、非整数/非 2xx、非官方 URL、未知/维护页面。
 * 不读取 Cookie expiry，也不要求任何有效期变化。
 */
export function classifyKeepaliveObservation(observation: KeepaliveObservation): KeepaliveClassification {
  const { httpStatus, finalUrl, html, hasToken: observedHasToken, hasHomeMenu: observedHomeMenu, hasLoginFrame: observedLoginFrame, hasAuthRejected: observedAuthRejected, error } = observation;
  if (error) return { status: 'unknown', reason: 'network-or-cdp-error' };
  if (
    typeof httpStatus !== 'number' || !Number.isInteger(httpStatus) || !Number.isFinite(httpStatus) ||
    typeof finalUrl !== 'string' || finalUrl === ''
  ) {
    return { status: 'unknown', reason: 'incomplete-observation' };
  }
  // Legacy/fake observations may provide HTML; production probes provide only booleans.
  const hasHomeMenu = typeof observedHomeMenu === 'boolean' ? observedHomeMenu : typeof html === 'string' && html.includes('new-creation__menu');
  const hasLoginFrame = typeof observedLoginFrame === 'boolean' ? observedLoginFrame : typeof html === 'string' && /\bid\s*=\s*(?:"login_frame"|'login_frame'|login_frame)(?=[\s>])/i.test(html);
  const hasTokenFromUrl = typeof observedHasToken === 'boolean' ? observedHasToken : undefined;
  const hasAuthRejected = typeof observedAuthRejected === 'boolean'
    ? observedAuthRejected
    : typeof html === 'string' && /登录超时/.test(html);
  if (httpStatus === 429) return { status: 'unknown', reason: 'http-429' };
  if (httpStatus < 200 || httpStatus >= 300) return { status: 'unknown', reason: `http-${httpStatus}` };

  let final: URL;
  try {
    final = new URL(finalUrl);
  } catch {
    return { status: 'unknown', reason: 'invalid-final-url' };
  }
  // 官方后台必须是无自定义端口的 https://mp.weixin.qq.com。
  if (final.protocol !== 'https:' || final.hostname !== 'mp.weixin.qq.com' || final.port !== '') {
    return { status: 'unknown', reason: 'non-official-final-url' };
  }

  const finalPath = final.pathname.toLowerCase();
  // 官方二维码连接页 / 登录页都属明确登录入口，不依赖页面文案。
  if (
    finalPath === '/cgi-bin/loginpage' || finalPath.startsWith('/cgi-bin/loginpage/') ||
    finalPath === '/cgi-bin/mpqrconnect' || finalPath.startsWith('/cgi-bin/mpqrconnect/')
  ) {
    return { status: 'needs-qr', reason: 'explicit-login-page' };
  }

  const isHomePath = finalPath === '/cgi-bin/home' || finalPath.startsWith('/cgi-bin/home/');
  // 登出后访问站点根路径会停留在官网登录落地页（path 为 "/"），
  // 页面同时出现“微信扫一扫/使用账号登录/立即注册”等明确登录 UI。
  if (!isHomePath && finalPath === '/' && hasLoginFrame) {
    return { status: 'needs-qr', reason: 'explicit-login-page' };
  }
  if (!isHomePath) return { status: 'unknown', reason: 'unexpected-final-path' };

  const tokenPattern = /[?&]token=\d+/;
  const hasToken = typeof observedHasToken === 'boolean' ? observedHasToken : tokenPattern.test(final.search);
  if (hasToken && hasHomeMenu) return { status: 'healthy', reason: 'authenticated-home-page' };
  if (!hasHomeMenu && (hasLoginFrame || hasAuthRejected)) {
    return { status: 'needs-qr', reason: 'explicit-login-page' };
  }

  return {
    status: 'unknown',
    reason: hasHomeMenu
      ? 'home-marker-without-token'
      : hasToken ? 'missing-home-menu-marker' : 'missing-token-in-final-url',
  };
}

/** 确保任何失败信息都不会带出 token/Cookie 值。 */
export function sanitizeKeepaliveError(message: unknown): string {
  return String(message ?? '')
    .replace(/(^|[?&\s])token=([^&\s"'<>]+)/gi, '$1token=***')
    .replace(/(^|[?&\s])token%3D([^%&\s"'<>]+)/gi, '$1token%3D***')
    .replace(/\b(cookie\s*[:=]\s*)[^\r\n]+/gi, '$1***')
    .replace(/\b\d{8,}\b/g, '***');
}

/**
 * 页面内探测脚本：从当前官方 origin 的首页路径发起同源 GET，返回同一响应的
 * status/final URL(path)/HTML/hasToken。finalUrl 仅保留 origin+pathname，
 * token 只以布尔值带出，绝不把查询串或 token 值返回给 Node 侧。
 */
const KEEPALIVE_PROBE_EXPRESSION = `(async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const officialOrigin = 'https://mp.weixin.qq.com';
    const pageOrigin = typeof location !== 'undefined' && location.origin === officialOrigin
      ? location.origin
      : officialOrigin;
    const res = await fetch(pageOrigin + '/cgi-bin/home?t=home/index&lang=zh_CN', {
      method: 'GET',
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store',
      signal: controller.signal,
    });
    const html = await res.text();
    let finalUrl = pageOrigin;
    let hasToken = false;
    let hasHomeMenu = false;
    let hasLoginFrame = false;
    try {
      const final = new URL(res.url || pageOrigin);
      finalUrl = final.origin + final.pathname;
      hasToken = /[?&]token=\\d+/.test(final.search);
    } catch {
      finalUrl = pageOrigin;
    }
    // 只在页面上下文检查结构标记，不把响应 HTML/查询串/token 返回 Node。
    hasHomeMenu = html.includes('new-creation__menu');
    hasLoginFrame = /\\bid\\s*=\\s*(?:"login_frame"|'login_frame'|login_frame)(?=[\\s>])/i.test(html);
    // 受保护入口若返回平台明确认证拒绝，说明会话已失效；仅在缺少 home marker 时才采信。
    const hasAuthRejected = /登录超时/.test(html);
    return { httpStatus: res.status, finalUrl, hasToken, hasHomeMenu, hasLoginFrame, hasAuthRejected };
  } catch (err) {
    return { error: err && err.name === 'AbortError' ? 'fetch-timeout' : String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
})()`;

/** 仅对官方站点发起一次 HTTPS GET；不读取 Cookie，不导出 token。 */
export async function observeKeepalivePage(session: EditorSession): Promise<KeepaliveObservation> {
  try {
    const observation = await evaluatePage<KeepaliveObservation>(session, KEEPALIVE_PROBE_EXPRESSION);
    return observation && typeof observation === 'object' ? observation : { error: 'empty-observation' };
  } catch (err: any) {
    return { error: `cdp-evaluate-failed: ${err?.message || err}` };
  }
}

/**
 * 以“真实导航 + 页面状态”判定登录态：开一个任务自有标签访问官方首页，
 * 等文档加载完成，读取最终 pathname、是否带 token、是否出现后台菜单/登录框，
 * 结束后关闭标签。相比页内 fetch，这条路与用户实际打开后台的行为一致，
 * 不会因缺少 token 查询串或 Referer 被服务端误判成登录超时。
 */
export async function probeKeepaliveByNavigation(cdp: any): Promise<KeepaliveObservation> {
  let targetId: string | undefined;
  try {
    const created: any = await cdp.send('Target.createTarget', { url: 'https://mp.weixin.qq.com/' });
    targetId = created?.targetId;
    if (!targetId) return { error: 'probe-tab-create-failed' };
    const attached: any = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = attached?.sessionId;
    if (!sessionId) return { error: 'probe-tab-attach-failed' };

    let observation: KeepaliveObservation | undefined;
    for (let i = 0; i < 40; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const evaluated: any = await cdp
        .send(
          'Runtime.evaluate',
          {
            expression: `(() => {
              const text = document.body ? (document.body.innerText || '') : '';
              return {
                ready: document.readyState,
                path: location.pathname,
                hasToken: /[?&]token=\\d+/.test(location.search),
                hasHomeMenu: Boolean(document.querySelector('.new-creation__menu')),
                hasLoginFrame: Boolean(document.querySelector('#login_frame')) ||
                  (/微信扫一扫/.test(text) && /使用账号登录/.test(text)),
                hasAuthRejected: text.includes('登录超时'),
              };
            })()`,
            returnByValue: true,
          },
          { sessionId }
        )
        .catch(() => null);
      const value = evaluated?.result?.value;
      if (!value || value.ready !== 'complete') continue;
      const path = String(value.path || '');
      const rootLogin = path === '/' && Boolean(value.hasLoginFrame);
      if (!path.startsWith('/cgi-bin/') && !rootLogin) continue;
      observation = {
        httpStatus: 200,
        finalUrl: `https://mp.weixin.qq.com${path}`,
        hasToken: Boolean(value.hasToken),
        hasHomeMenu: Boolean(value.hasHomeMenu),
        hasLoginFrame: Boolean(value.hasLoginFrame),
        hasAuthRejected: Boolean(value.hasAuthRejected),
      };
      const settled =
        rootLogin ||
        path.startsWith('/cgi-bin/home') ||
        path.startsWith('/cgi-bin/loginpage') ||
        path.startsWith('/cgi-bin/mpqrconnect');
      if (settled) break;
    }
    return observation ?? { error: 'probe-tab-not-ready' };
  } catch (err: any) {
    return { error: `probe-tab-failed: ${err?.message || err}` };
  } finally {
    if (targetId) {
      try { await cdp.send('Target.closeTarget', { targetId }); } catch {}
    }
  }
}

export interface KeepaliveDependencies {
  connect?: () => Promise<{ cdp: Pick<CdpConnection, 'close'>; homeSession: EditorSession }>;
  observe?: (session: EditorSession) => Promise<KeepaliveObservation>;
  observeFreshTab?: (cdp: any) => Promise<KeepaliveObservation>;
  /** 私有保活观测日志路径；传 null 关闭。仅生产路径（未注入 connect）默认开启。 */
  telemetryPath?: string | null;
  log?: (message: string) => void;
  logError?: (message: string) => void;
}

export async function runKeepaliveSession(dependencies: KeepaliveDependencies = {}): Promise<number> {
  const log = dependencies.log || ((message: string) => console.log(message));
  const logError = dependencies.logError || ((message: string) => console.error(message));
  const telemetryPath = dependencies.telemetryPath !== undefined
    ? dependencies.telemetryPath
    : process.env.WECHAT_KEEPALIVE_LOG
      || (dependencies.connect
        ? null
        : path.join(process.env.USERPROFILE || process.env.HOME || '.', '.agents', 'skills', 'wechat-md-pipeline', 'data', 'keepalive-history.jsonl'));
  const recordTelemetry = (status: string, reason: string, httpStatus?: number) => {
    if (!telemetryPath) return;
    try {
      fs.appendFileSync(
        telemetryPath,
        `${JSON.stringify({ at: new Date().toISOString(), status, reason, httpStatus: httpStatus ?? null })}\n`
      );
    } catch {}
  };
  let cdp: Pick<CdpConnection, 'close'> | undefined;
  try {
    const connected = dependencies.connect
      ? await dependencies.connect()
      : await connectOrCreateHomeSession({ checkSessionCookie: false, requireReadyHome: false });
    cdp = connected.cdp;

    // 后台标签会被浏览器节流（visibilityState=hidden），渲染进程也可能被冻结。
    // 探测前把现有任务标签切到前台；实际判定走任务自有新标签的真实导航。
    const probeCdp: any = (connected.homeSession as any)?.cdp;
    if (probeCdp && typeof probeCdp.send === 'function' && connected.homeSession.sessionId) {
      try {
        await probeCdp.send('Page.bringToFront', {}, { sessionId: connected.homeSession.sessionId });
      } catch {}
    }

    let observation = dependencies.observe
      ? await dependencies.observe(connected.homeSession)
      : await probeKeepaliveByNavigation(cdp as any);

    // 导航探测失败时，如注入了复核实现则再试一次；避免把可明确判定的
    // needs-qr / healthy 误报成 unknown。
    if (observation.error && typeof (cdp as any)?.send === 'function' && dependencies.observeFreshTab) {
      log('[wechat-batch] 导航探测失败，改用注入的复核实现再探测一次…');
      const fresh = await dependencies.observeFreshTab(cdp as any);
      if (!fresh.error) observation = fresh;
      else logError(`[wechat-batch] 复核探测也失败: ${sanitizeKeepaliveError(fresh.error)}`);
    }

    const verdict = classifyKeepaliveObservation(observation);
    recordTelemetry(verdict.status, verdict.reason, observation.httpStatus);

    if (verdict.status === 'healthy') {
      log(`[wechat-batch] keepalive-status=healthy (HTTP ${observation.httpStatus}, 官方后台首页标记正常)`);
    } else if (verdict.status === 'needs-qr') {
      log('[wechat-batch] keepalive-status=needs-qr (检测到明确登录页，请在专用浏览器中人工扫码续期)');
    } else {
      log(`[wechat-batch] keepalive-status=unknown (${verdict.reason}；未确认后台可用，请人工检查专用浏览器网络与登录态)`);
    }
    return KEEPALIVE_EXIT_CODES[verdict.status];
  } catch (err: any) {
    const safeMessage = sanitizeKeepaliveError(err?.message || err);
    recordTelemetry('unknown', 'connect-or-observe-failed');
    logError(`[wechat-batch] keepalive-status=unknown (无法完成后台访问: ${safeMessage})`);
    logError('[wechat-batch] 未确认后台可用，请人工检查专用浏览器网络与登录态');
    return KEEPALIVE_EXIT_CODES.unknown;
  } finally {
    try { cdp?.close(); } catch {}
  }
}

// -----------------------------------------------------------------------------
// 主编排执行入口
// -----------------------------------------------------------------------------
// 单次批处理运行内的私有内容修正上下文 (进程生命周期内共享，避免逐层传参)
const pipelineCorrections: {
  contentCorrections: LoadedContentCorrections;
  correctedMarkdownById: Map<string, string>;
} = {
  contentCorrections: { map: {}, path: '' },
  correctedMarkdownById: new Map<string, string>(),
};

export async function runBatchPipeline(options: BatchCliOptions = parseBatchArgs()): Promise<number> {
  console.log(`================================================================`);
  console.log(`[wechat-batch] 微信公众号草稿箱在原草稿更新与发布引擎 (Safe Spine + E 接线)`);
  console.log(`  模式: ${options.dryRun ? 'DRY-RUN (纯读演练)' : options.keepalive ? 'KEEPALIVE (轻量登录态保活)' : options.repair ? 'REPAIR (原稿精修)' : 'FULL-PIPELINE'}`);
  if (options.id) console.log(`  单篇过滤: ${options.id}`);
  if (options.search) console.log(`  关键词检索: "${options.search}"`);
  if (options.latest) console.log(`  最新推文选取: 最近 ${options.latest} 篇`);
  if (options.limit) console.log(`  处理上限: ${options.limit} 篇`);
  if (options.days) console.log(`  天数范围: 最近 ${options.days} 天`);
  console.log(`================================================================`);

  // 保活是只读探测：不获取进程锁、不写状态库，也不与正式发布互相阻塞。
  if (options.keepalive) {
    return await runKeepaliveSession();
  }

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

    // 加载私有内容修正映射 (源文件保持只读，仅对内存读取结果做逐字替换)
    const contentCorrections = loadContentCorrections();
    const correctedMarkdownById = new Map<string, string>();
    for (const [articleId, rules] of Object.entries(contentCorrections.map)) {
      const record = catalog.articles.find(a => a.id === articleId);
      if (!record?.fullPath || !fs.existsSync(record.fullPath)) continue;
      const raw = fs.readFileSync(record.fullPath, 'utf-8');
      const corrected = applyContentCorrections(raw, articleId, contentCorrections);
      if (corrected !== raw) correctedMarkdownById.set(articleId, corrected);
    }
    pipelineCorrections.contentCorrections = contentCorrections;
    pipelineCorrections.correctedMarkdownById = correctedMarkdownById;

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

    let skippedUnsupportedCount = 0;
    let candidates = scopedArticles.filter(item => {
      const plan = planArticleAction(item, options, legacyBaseline);

      if (plan.action === 'skip') {
        if (item.unsupportedMessageType) skippedUnsupportedCount++;
        return false;
      }

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

    // 同一篇文章换路径/批次重推时，按完整内容指纹识别重复，绝不创建第二份草稿。
    const duplicates = findDuplicateCreateIds(candidates, loadHistoryDatabase(), options, legacyBaseline);
    if (duplicates.size > 0) {
      for (const [candidateId, existingId] of duplicates) {
        console.log(`[wechat-batch] ℹ️ 跳过重复内容 [${candidateId}]：与已确立的 ${existingId} 完整内容指纹一致`);
      }
      candidates = candidates.filter(item => !duplicates.has(item.id));
    }

    if (options.limit && options.limit > 0) {
      candidates = candidates.slice(0, options.limit);
    }

    if (skippedUnsupportedCount > 0) {
      console.log(`[wechat-batch] ℹ️ 已自动保留并跳过 ${skippedUnsupportedCount} 篇已知非普通长文 (图片轮播等，免除重复打开超时)`);
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

      if (options.verify) {
        console.log(`\n--- [DRY-RUN 在线论文真实性与 DOI/arXiv/链接核查] ---`);
        const reports = await Promise.all(
          candidates.map(c => verifyArticleTruth(c.fullPath, { articleId: c.id, markdownOverride: correctedMarkdownById.get(c.id) }))
        );
        let verifyFail = 0;
        for (const r of reports) {
          const icon = r.status === 'pass' ? '✅ PASS' : r.status === 'warn' ? '⚠️ WARN' : '❌ FAIL';
          console.log(`${icon} [${r.articleId}] ${r.extracted.articleTitle}`);
          for (const d of r.doiChecks) console.log(`    [DOI] ${d.doi} -> ${d.status}: ${d.message}`);
          for (const a of r.arxivChecks) console.log(`    [arXiv] ${a.arxivId} -> ${a.status}: ${a.message}`);
          for (const u of r.urlChecks) console.log(`    [URL] ${u.url} -> ${u.status}: ${u.message}`);
          for (const e of r.errors) console.error(`    ❌ ${e}`);
          for (const w of r.warnings) console.warn(`    ⚠️ ${w}`);
          if (r.status === 'fail' || (options.strictVerify && r.status === 'warn')) verifyFail++;
        }
        if (verifyFail > 0) {
          console.error(`\n❌ [wechat-batch] 真实性核查发现 ${verifyFail} 篇存在致命问题或严格警告，已拦截。`);
          return 1;
        }
      }

      console.log(`\n[wechat-batch] DRY-RUN 完成，未修改任何真实草稿或数据库文件。`);
      return 0;
    }

    // 正式写入前：默认并行核查待写入正文篇目的真实性、DOI、arXiv 与原文链接，防止虚假或残缺推文进入草稿箱
    let verifiedCandidates = candidates;
    let preVerifyFailCount = 0;
    if (!options.skipVerify) {
      const toVerify = candidates.filter(c => planArticleAction(c, options, legacyBaseline).action !== 'repair');
      if (toVerify.length > 0) {
        console.log(`[wechat-batch] 正在执行前置推文真实性与 DOI/arXiv/链接核查 (${toVerify.length} 篇)...`);
        const reports = await Promise.all(
          toVerify.map(c => verifyArticleTruth(c.fullPath, { articleId: c.id, markdownOverride: correctedMarkdownById.get(c.id) }))
        );
        const reportMap = new Map(reports.map(r => [r.articleId!, r]));
        verifiedCandidates = candidates.filter(c => {
          const rep = reportMap.get(c.id);
          if (!rep) return true;
          const isBlocked = rep.status === 'fail' || (options.strictVerify && rep.status === 'warn');
          if (isBlocked) {
            preVerifyFailCount++;
            console.error(`❌ [wechat-batch] 拦截问题推文 [${c.id}] (${c.file}):`);
            for (const e of rep.errors) console.error(`    错误: ${e}`);
            for (const w of rep.warnings) console.error(`    警告: ${w}`);
            return false;
          }
          if (rep.status === 'warn') {
            console.warn(`⚠️ [wechat-batch] 真实性核查警告 [${c.id}]: ${rep.warnings.join('; ')}`);
          } else {
            console.log(`✅ [wechat-batch] 真实性核查通过 [${c.id}] (DOI:${rep.doiChecks.length} arXiv:${rep.arxivChecks.length} URL:${rep.urlChecks.length})`);
          }
          return true;
        });
      }
    }

    if (verifiedCandidates.length === 0) {
      console.error(`[wechat-batch] ❌ 全部待处理文章均未通过前置真实性/DOI 核查，未启动浏览器，退出。`);
      return 1;
    }

    // 写入前一次性校验所有新文外题，避免批量跑到中途才因缺标题停住（留下半批状态）。
    const missingTitles = collectNewArticleTitleProblems(verifiedCandidates, options, legacyBaseline);
    if (missingTitles.length > 0) {
      console.error(`[wechat-batch] ❌ 以下 ${missingTitles.length} 篇新文缺少 ≤15 字外题，已在写入前停止：`);
      for (const line of missingTitles) console.error(`   - ${line}`);
      console.error('   修复: bun run titles "<articleId>=<短标题>"，再带 --titles 重跑');
      return 1;
    }

    const connected = await connectOrCreateHomeSession();
    console.log(`[wechat-batch] ✅ 公众号后台会话就绪，Token: ***${connected.token.slice(-4)}`);

    let successCount = 0;
    let failCount = preVerifyFailCount;

    for (let i = 0; i < verifiedCandidates.length; i++) {
      const item = verifiedCandidates[i]!;
      console.log(`\n----------------------------------------------------------------`);
      console.log(`[wechat-batch] 进度 [${i + 1}/${verifiedCandidates.length}] 处理: ${item.id} (appmsgid: ${item.appmsgid || '新建'})`);

      let res = await processSingleArticle(item, connected, options, legacyBaseline);
      if (!res.success && isTransientPublishFailure(res.error)) {
        console.warn(`[wechat-batch] ⚠️ 瞬时故障（封面/CDN/页面加载），3 秒后重试一次: ${res.error}`);
        await sleep(3_000);
        res = await processSingleArticle(item, connected, options, legacyBaseline);
      }
      if (res.success) {
        successCount++;
      } else {
        failCount++;
      }

      if (i < verifiedCandidates.length - 1) {
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
