/**
 * draft-state.ts — 微信公众号草稿状态引擎与防并发/防历史损毁核心
 *
 * 核心设计准则：
 * 1. 【历史绝不覆写/清空】：损坏或结构异常立即抛出异常保全，禁止空库覆盖。
 * 2. 【深拷贝合并】：状态计算必须从原库继承，缺图/缺源/变更绝对保留原 appmsgid 与候选。
 * 3. 【指纹双层模型】：分离 observedFingerprint (当前实时观察值) 与 appliedFingerprint (已成功入稿并验证的基线)。
 * 4. 【双采样写稳定性】：读前读后两次 stat 校验大小与 mtime，异常即判定不稳定，防 Muse 抢写。
 * 5. 【死进程与锁安全】：利用 ESRCH 精准探测死进程，EPERM 或异常均视为存活；随机 token 防误释；wx 独占创建。
 * 6. 【旧稿基线隔离 (Legacy Baseline)】：当前 63 篇旧稿缺失项绝不自动从零创建，一律标记 needs-reconcile。
 * 7. 【严格的 --dry-run 纯读保证】：dry-run 下严禁写 history、写 lock、写 baseline 临时文件。
 * 8. 【动态 Token 构造与脱敏】：接受真实主页 token 派生编辑 URL，日志输出全部脱敏。
 * 9. 【保留已确认 outerTitle】：旧文优先复用已有 outerTitle，严禁盲截。
 * 10.【路径完全可注入】：支持 StatePathsConfig 与环境变量覆盖，提供纯净独立的测试沙箱。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

export const DEFAULT_HISTORY_FILE = 'C:\\Users\\Administrator\\.agents\\skills\\wechat-md-pipeline\\data\\wechat-draft-history.json';
export const DEFAULT_LOCK_FILE = 'C:\\Users\\Administrator\\.agents\\skills\\wechat-md-pipeline\\data\\wechat-publisher.lock';
export const DEFAULT_BASELINE_FILE = 'C:\\Users\\Administrator\\.agents\\skills\\wechat-md-pipeline\\data\\wechat-legacy-baseline.json';
export const DEFAULT_STATE_CACHE_DIR = 'C:\\Users\\Administrator\\.agents\\skills\\wechat-md-pipeline\\cache';
export const DEFAULT_MUSE_ROOT = 'F:\\同步文件夹\\公众号\\每日推文';
export const DEFAULT_LOCAL_ROOT = 'Z:\\自媒体\\公众号\\每日推文';

// 兼容旧导出
export const HISTORY_FILE = DEFAULT_HISTORY_FILE;
export const LOCK_FILE = DEFAULT_LOCK_FILE;
export const BASELINE_FILE = DEFAULT_BASELINE_FILE;
export const STATE_CACHE_DIR = DEFAULT_STATE_CACHE_DIR;
export const MUSE_ROOT = DEFAULT_MUSE_ROOT;
export const LOCAL_ROOT = DEFAULT_LOCAL_ROOT;

export interface StatePathsConfig {
  historyFile?: string;
  lockFile?: string;
  baselineFile?: string;
  stateCacheDir?: string;
  museRoot?: string;
  localRoot?: string;
}

export function getStatePaths(override?: StatePathsConfig): Required<StatePathsConfig> {
  return {
    historyFile: override?.historyFile || process.env.WECHAT_HISTORY_FILE || DEFAULT_HISTORY_FILE,
    lockFile: override?.lockFile || process.env.WECHAT_LOCK_FILE || DEFAULT_LOCK_FILE,
    baselineFile: override?.baselineFile || process.env.WECHAT_BASELINE_FILE || DEFAULT_BASELINE_FILE,
    stateCacheDir: override?.stateCacheDir || process.env.WECHAT_STATE_CACHE_DIR || DEFAULT_STATE_CACHE_DIR,
    museRoot: override?.museRoot || process.env.WECHAT_MUSE_ROOT || DEFAULT_MUSE_ROOT,
    localRoot: override?.localRoot || process.env.WECHAT_LOCAL_ROOT || DEFAULT_LOCAL_ROOT,
  };
}

// -----------------------------------------------------------------------------
// 数据模型定义
// -----------------------------------------------------------------------------
export interface ImageDetail {
  path: string;
  size: number;
  mtimeMs: number;
  sha256?: string;
  exists: boolean;
  stable: boolean;
}

export interface ContentFingerprint {
  contentHash: string;
  imageHash: string;
  compositeHash: string;
  images: ImageDetail[];
}

export interface VerificationEvidence {
  verified: boolean;
  verifiedAt?: string;
  h1Matched?: boolean;
  authorMatched?: boolean;
  coverMatched?: boolean;
  cardMatched?: boolean;
  reloadedAppmsgid?: string;
  evidenceNotes?: string;
}

export interface CandidateAppmsgid {
  appmsgid: string;
  evidence: string;
  title?: string;
  timestamp?: string;
}

export const CURRENT_FEATURE_VERSION = 1;

export interface DraftStateRecord {
  id: string; // e.g. "local:20261106_1800:01" or "muse:20261107_1100:01"
  source: 'local' | 'muse';
  batch: string;
  prefix: string;
  file: string;
  fullPath: string;
  title: string;           // 完整原标题 (必须用于正文 H1)
  outerTitle: string;      // 微信外层标题框文字 (保留已有值，不盲截)
  author: string;          // 严格为 "锐多宝"
  appmsgid: string | null; // 已验证/已激活的微信草稿 ID
  candidateAppmsgids: CandidateAppmsgid[]; // 历史关联的所有候选 ID
  status: 'active' | 'saved-unverified' | 'needs-reconcile' | 'missing-image' | 'untracked';
  hasCover: boolean;
  hasCard: boolean;
  appliedFingerprint?: ContentFingerprint; // 上次成功全量内容发布并验证通过的基线指纹
  observedFingerprint?: ContentFingerprint;// 当前本地实时指纹
  featureRepairObservedFingerprint?: string; // 最近一次完成排版修复复验时的本地指纹 (防每日重复repair)
  featureVersion?: number;                  // 排版特性版本
  verification: VerificationEvidence;
  pushedAt?: string;
  updatedAt: string;
  reconcileNote?: string;
}

// -----------------------------------------------------------------------------
// 1. 跨进程文件锁 (严谨探测与防误释，支持路径注入)
// -----------------------------------------------------------------------------
export interface ProcessLockInfo {
  pid: number;
  hostname: string;
  acquiredAt: string;
  script: string;
  lockToken: string;
}

let activeLockToken: string | null = null;

export function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true; // 进程存在
  } catch (err: any) {
    if (err.code === 'EPERM') return true; // 存在但无权限发信号，证明进程活着！
    if (err.code === 'ESRCH') return false; // 明确无此进程，已死亡
    return true; // 其他未预料错误保守认定为存活
  }
}

export function acquireProcessLock(scriptName: string = 'publisher-worker', pathsOverride?: StatePathsConfig): boolean {
  const paths = getStatePaths(pathsOverride);
  try {
    const dir = path.dirname(paths.lockFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (fs.existsSync(paths.lockFile)) {
      try {
        const raw = fs.readFileSync(paths.lockFile, 'utf-8');
        const lockInfo: ProcessLockInfo = JSON.parse(raw);
        if (isProcessAlive(lockInfo.pid)) {
          // 进程确实存活，无论多久都不可抢占
          console.error(`[draft-state] ❌ 进程锁已被活动进程占用: PID ${lockInfo.pid} (${lockInfo.script}), 启动于 ${lockInfo.acquiredAt}`);
          return false;
        } else {
          // 仅当确认进程死于 ESRCH 时，回收死锁
          console.warn(`[draft-state] 检测到死亡进程遗留锁 (PID ${lockInfo.pid}), 正在回收...`);
          fs.unlinkSync(paths.lockFile);
        }
      } catch (readErr) {
        // 若锁文件损坏但无法确认状态，不盲删，抛出警告交由人工确认
        console.error(`[draft-state] ❌ 发现未完成或损坏的锁文件，禁止盲删:`, readErr);
        return false;
      }
    }

    const token = crypto.randomBytes(16).toString('hex');
    const lockData: ProcessLockInfo = {
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt: new Date().toISOString(),
      script: scriptName,
      lockToken: token,
    };

    fs.writeFileSync(paths.lockFile, JSON.stringify(lockData, null, 2), { flag: 'wx' });
    activeLockToken = token;

    const cleanup = () => releaseProcessLock(pathsOverride);
    process.once('exit', cleanup);
    process.once('SIGINT', () => { cleanup(); process.exit(130); });
    process.once('SIGTERM', () => { cleanup(); process.exit(143); });

    return true;
  } catch (err: any) {
    console.error(`[draft-state] 获取进程锁异常:`, err?.message || err);
    return false;
  }
}

export function releaseProcessLock(pathsOverride?: StatePathsConfig): void {
  const paths = getStatePaths(pathsOverride);
  try {
    if (fs.existsSync(paths.lockFile) && activeLockToken) {
      const raw = fs.readFileSync(paths.lockFile, 'utf-8');
      const lockInfo: ProcessLockInfo = JSON.parse(raw);
      if (lockInfo.pid === process.pid && lockInfo.lockToken === activeLockToken) {
        fs.unlinkSync(paths.lockFile);
        activeLockToken = null;
      }
    }
  } catch {}
}

// -----------------------------------------------------------------------------
// 2. 双采样文件稳定性与严格图片预检
// -----------------------------------------------------------------------------
export function checkFileStability(filePath: string): { ok: boolean; size: number; mtimeMs: number } {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, size: 0, mtimeMs: 0 };
    const stat1 = fs.statSync(filePath);
    if (stat1.size === 0) return { ok: false, size: 0, mtimeMs: stat1.mtimeMs };

    // 双采样门禁：微延迟检查是否有进程正在写入
    const now = Date.now();
    if (now - stat1.mtimeMs < 2000) {
      // 2秒内被修改过，判定为可能在写
      return { ok: false, size: stat1.size, mtimeMs: stat1.mtimeMs };
    }

    const stat2 = fs.statSync(filePath);
    if (stat1.size !== stat2.size || stat1.mtimeMs !== stat2.mtimeMs) {
      return { ok: false, size: stat2.size, mtimeMs: stat2.mtimeMs };
    }

    return { ok: true, size: stat2.size, mtimeMs: stat2.mtimeMs };
  } catch {
    return { ok: false, size: 0, mtimeMs: 0 };
  }
}

export function extractImageReferences(markdown: string, baseDir: string): string[] {
  const imagePaths: Set<string> = new Set();
  const mdRegex = /!\[.*?\]\((.+?)\)/g;
  let match: RegExpExecArray | null;
  while ((match = mdRegex.exec(markdown)) !== null) {
    const rawUrl = match[1]!.trim().split(/\s+/)[0]!;
    if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://') && !rawUrl.startsWith('data:')) {
      const full = path.isAbsolute(rawUrl) ? rawUrl : path.resolve(baseDir, rawUrl);
      imagePaths.add(full);
    }
  }

  const htmlRegex = /<img[^>]+src=["']([^"']+)["']/gi;
  while ((match = htmlRegex.exec(markdown)) !== null) {
    const rawUrl = match[1]!.trim();
    if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://') && !rawUrl.startsWith('data:')) {
      const full = path.isAbsolute(rawUrl) ? rawUrl : path.resolve(baseDir, rawUrl);
      imagePaths.add(full);
    }
  }
  return Array.from(imagePaths);
}

export interface ImageIntegrityReport {
  ok: boolean;
  stable: boolean;
  images: ImageDetail[];
  missingPaths: string[];
}

export function verifyImagesIntegrity(markdown: string, baseDir: string): ImageIntegrityReport {
  const paths = extractImageReferences(markdown, baseDir);
  const images: ImageDetail[] = [];
  const missingPaths: string[] = [];
  let allStable = true;

  for (const p of paths) {
    const st = checkFileStability(p);
    if (!st.ok) {
      if (!fs.existsSync(p)) {
        missingPaths.push(p + ' [文件不存在]');
      } else if (st.size === 0) {
        missingPaths.push(p + ' [0字节]');
      } else {
        missingPaths.push(p + ' [文件写入未稳定/正在同步]');
        allStable = false;
      }
      images.push({ path: p, size: st.size, mtimeMs: st.mtimeMs, exists: fs.existsSync(p), stable: st.ok });
    } else {
      images.push({ path: p, size: st.size, mtimeMs: st.mtimeMs, exists: true, stable: true });
    }
  }

  return {
    ok: missingPaths.length === 0,
    stable: allStable,
    images,
    missingPaths,
  };
}

export function calculateFingerprint(markdown: string, baseDir: string): ContentFingerprint {
  const contentHash = crypto.createHash('sha256').update(markdown, 'utf-8').digest('hex');
  const report = verifyImagesIntegrity(markdown, baseDir);

  const imgHasher = crypto.createHash('sha256');
  for (const img of report.images) {
    if (img.exists && img.size > 0 && img.stable) {
      try {
        const buf = fs.readFileSync(img.path);
        const fHash = crypto.createHash('sha256').update(buf).digest('hex');
        img.sha256 = fHash;
        imgHasher.update(`${img.path}:${img.size}:${fHash}`);
      } catch (readErr: any) {
        throw new Error(`读取图片字节计算指纹失败: ${img.path} (${readErr?.message})`);
      }
    } else {
      imgHasher.update(`${img.path}:unstable_or_missing`);
    }
  }
  const imageHash = imgHasher.digest('hex');
  const compositeHash = crypto.createHash('sha256').update(`${contentHash}:${imageHash}`).digest('hex');

  return {
    contentHash,
    imageHash,
    compositeHash,
    images: report.images,
  };
}

// -----------------------------------------------------------------------------
// 3. 历史数据库加载 (绝不静默吞错) 与原子持久化 (支持注入)
// -----------------------------------------------------------------------------
export function loadHistoryDatabase(pathsOverride?: StatePathsConfig): Record<string, DraftStateRecord> {
  const paths = getStatePaths(pathsOverride);
  const db: Record<string, DraftStateRecord> = {};
  if (!fs.existsSync(paths.historyFile)) return db;

  const raw = fs.readFileSync(paths.historyFile, 'utf-8');
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (parseErr: any) {
    throw new Error(`[draft-state] FATAL: 历史数据库 JSON 格式已损坏，已阻止加载以保护现场: ${parseErr.message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`[draft-state] FATAL: 历史数据库非法的根节点类型，期望对象字典`);
  }

  for (const [k, v] of Object.entries(parsed)) {
    const item = v as any;
    db[k] = {
      id: k,
      source: item.source || (k.startsWith('muse:') ? 'muse' : 'local'),
      batch: item.batch || '',
      prefix: item.prefix || (item.file ? item.file.slice(0, 2) : '01'),
      file: item.file || '',
      fullPath: item.fullPath || '',
      title: item.title || '',
      outerTitle: item.outerTitle || item.title || '',
      author: item.author || '锐多宝',
      appmsgid: item.appmsgid || null,
      candidateAppmsgids: Array.isArray(item.candidateAppmsgids) ? item.candidateAppmsgids : [],
      status: item.status || (item.appmsgid ? 'active' : 'needs-reconcile'),
      hasCover: item.hasCover === true,
      hasCard: item.hasCard === true,
      appliedFingerprint: item.appliedFingerprint || item.fingerprint,
      observedFingerprint: item.observedFingerprint,
      featureRepairObservedFingerprint: item.featureRepairObservedFingerprint,
      featureVersion: typeof item.featureVersion === 'number' ? item.featureVersion : undefined,
      verification: item.verification || { verified: false, evidenceNotes: 'legacy unverified' },
      pushedAt: item.pushedAt,
      updatedAt: item.updatedAt || new Date().toISOString(),
      reconcileNote: item.reconcileNote,
    };
  }

  return db;
}

export function atomicSaveHistory(database: Record<string, DraftStateRecord>, pathsOverride?: StatePathsConfig): void {
  const paths = getStatePaths(pathsOverride);
  const dir = path.dirname(paths.historyFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tempFile = path.join(dir, `.wechat-draft-history.json.tmp.${process.pid}.${Date.now()}`);
  const payload: Record<string, any> = {};

  for (const [k, v] of Object.entries(database)) {
    payload[k] = {
      appmsgid: v.appmsgid,
      title: v.title,
      outerTitle: v.outerTitle,
      source: v.source,
      batch: v.batch,
      prefix: v.prefix,
      file: v.file,
      fullPath: v.fullPath,
      author: v.author,
      status: v.status,
      candidateAppmsgids: v.candidateAppmsgids,
      hasCover: v.hasCover,
      hasCard: v.hasCard,
      appliedFingerprint: v.appliedFingerprint,
      observedFingerprint: v.observedFingerprint,
      featureRepairObservedFingerprint: v.featureRepairObservedFingerprint,
      featureVersion: v.featureVersion,
      verification: v.verification,
      pushedAt: v.pushedAt,
      updatedAt: v.updatedAt,
      reconcileNote: v.reconcileNote,
    };
  }

  fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2), 'utf-8');
  fs.renameSync(tempFile, paths.historyFile);

  try {
    const backupDir = path.join(dir, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(paths.historyFile, path.join(backupDir, 'wechat-draft-history.json.snapshot'));
  } catch {}
}

// -----------------------------------------------------------------------------
// 4. 标题与 URL 构造
// -----------------------------------------------------------------------------
export function extractOriginalTitle(content: string, fallbackFileName: string): string {
  const m = content.match(/^#\s+(.+)$/m);
  if (m) return m[1]!.trim();
  return path.basename(fallbackFileName, path.extname(fallbackFileName)).replace(/^\d{2}_/, '');
}

export function buildWechatEditUrl(appmsgid: string, token: string): string {
  if (!token) throw new Error('打开草稿编辑界面必须提供有效的后台 token');
  return `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=${appmsgid}&token=${token}&lang=zh_CN`;
}

export function sanitizeUrlForLog(url: string): string {
  return url.replace(/token=([^&]+)/, 'token=***');
}

// -----------------------------------------------------------------------------
// 5. 旧稿基线 (Legacy Baseline) 固化与隔离 (纯读模式绝不落盘，坏格式抛错)
// -----------------------------------------------------------------------------
export function getOrCreateLegacyBaseline(options: { persist?: boolean; paths?: StatePathsConfig } = {}): Set<string> {
  const paths = getStatePaths(options.paths);
  const set = new Set<string>();

  if (fs.existsSync(paths.baselineFile)) {
    const raw = fs.readFileSync(paths.baselineFile, 'utf-8');
    let arr: any;
    try {
      arr = JSON.parse(raw);
    } catch (parseErr: any) {
      throw new Error(`[draft-state] FATAL: Baseline 文件格式损坏，禁止盲目重建: ${parseErr.message}`);
    }
    if (!Array.isArray(arr)) {
      throw new Error(`[draft-state] FATAL: Baseline 文件格式错误，必须为 ID 数组`);
    }
    arr.forEach((id: string) => set.add(id));
    return set;
  }

  // Baseline 尚未创建：从当前扫描（历史旧63篇）生成内存基线
  const candidates = scanAllCandidates(options.paths);
  for (const c of candidates) set.add(c.id);

  // 严格受控落盘：仅在显式 persist 且非只读时写入磁盘
  if (options.persist) {
    const dir = path.dirname(paths.baselineFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(paths.baselineFile, JSON.stringify(Array.from(set).sort(), null, 2), 'utf-8');
  }

  return set;
}

// -----------------------------------------------------------------------------
// 6. 扫描推文与状态计算 (深拷贝、分层指纹、dry-run 安全、支持注入)
// -----------------------------------------------------------------------------
export interface CandidateArticle {
  id: string;
  source: 'local' | 'muse';
  batch: string;
  prefix: string;
  file: string;
  fullPath: string;
}

export function scanAllCandidates(pathsOverride?: StatePathsConfig): CandidateArticle[] {
  const paths = getStatePaths(pathsOverride);
  const list: CandidateArticle[] = [];

  if (fs.existsSync(paths.localRoot)) {
    const batches = fs.readdirSync(paths.localRoot).filter(d => /^\d{8}_\d{4}$/.test(d)).sort();
    for (const b of batches) {
      const bDir = path.join(paths.localRoot, b);
      const files = fs.readdirSync(bDir).filter(f => /^\d{2}_.*\.md$/.test(f) && !f.startsWith('00_')).sort();
      for (const f of files) {
        list.push({
          id: `local:${b}:${f.slice(0, 2)}`,
          source: 'local',
          batch: b,
          prefix: f.slice(0, 2),
          file: f,
          fullPath: path.join(bDir, f),
        });
      }
    }
  }

  if (fs.existsSync(paths.museRoot)) {
    const batches = fs.readdirSync(paths.museRoot).filter(d => /^\d{8}_\d{4}$/.test(d)).sort();
    for (const b of batches) {
      const bDir = path.join(paths.museRoot, b);
      const files = fs.readdirSync(bDir).filter(f => f.endsWith('.md') && !f.startsWith('00_') && !f.includes('纯文本')).sort();
      const groups: Record<string, string[]> = {};
      for (const f of files) {
        const m = f.match(/^(\d{2})_/);
        if (m) {
          const p = m[1]!;
          groups[p] = groups[p] || [];
          groups[p]!.push(f);
        }
      }
      for (const p of Object.keys(groups).sort()) {
        const arr = groups[p]!;
        const chosen = arr.find(f => f.includes('本地版')) || arr[0]!;
        list.push({
          id: `muse:${b}:${p}`,
          source: 'muse',
          batch: b,
          prefix: p,
          file: chosen,
          fullPath: path.join(bDir, chosen),
        });
      }
    }
  }

  return list;
}

export interface StateCalculationResult {
  totalScanned: number;
  activeCount: number;
  needsReconcileCount: number;
  missingImageCount: number;
  untrackedCount: number;
  articles: DraftStateRecord[];
}

export function computeStateCatalog(options: { dryRun?: boolean; targetId?: string; persist?: boolean; paths?: StatePathsConfig } = {}): StateCalculationResult {
  const paths = getStatePaths(options.paths);
  const currentDb = loadHistoryDatabase(paths);
  const legacyBaseline = getOrCreateLegacyBaseline({ persist: !options.dryRun && !!options.persist, paths });
  const candidates = scanAllCandidates(paths);

  // 从原 db 进行深拷贝，防止丢弃未在当前扫描中出现的历史项 (如源文件删除/移走)
  const mergedDb: Record<string, DraftStateRecord> = {};
  for (const [k, v] of Object.entries(currentDb)) {
    mergedDb[k] = { ...v, candidateAppmsgids: [...(v.candidateAppmsgids || [])] };
  }

  let activeCount = 0;
  let needsReconcileCount = 0;
  let missingImageCount = 0;
  let untrackedCount = 0;

  for (const cand of candidates) {
    if (options.targetId && cand.id !== options.targetId) continue;

    const existing = mergedDb[cand.id];
    const rawMd = fs.existsSync(cand.fullPath) ? fs.readFileSync(cand.fullPath, 'utf-8') : '';
    const baseDir = path.dirname(cand.fullPath);
    const originalTitle = extractOriginalTitle(rawMd, cand.file);

    // 图片完整性预检与当前实时指纹
    const imgReport = verifyImagesIntegrity(rawMd, baseDir);
    let observedFp: ContentFingerprint | undefined;
    let fpError: string | undefined;
    if (imgReport.ok) {
      try {
        observedFp = calculateFingerprint(rawMd, baseDir);
      } catch (err: any) {
        fpError = err?.message || String(err);
      }
    }

    let status: DraftStateRecord['status'] = 'untracked';
    let appmsgid: string | null = existing?.appmsgid || null;
    let reconcileNote = existing?.reconcileNote;

    if (!imgReport.ok || fpError) {
      // 缺图或指纹计算异常 (不稳定)：必须保留原有的 appmsgid 与候选！绝不能设为 null！
      status = 'missing-image';
      reconcileNote = fpError ? `指纹计算异常: ${fpError}` : `缺少本地图片或文件正在写入: ${imgReport.missingPaths.join('; ')}`;
      missingImageCount++;
    } else if (existing?.appmsgid) {
      // 保持现有确认映射
      status = 'active';
      activeCount++;
    } else if (legacyBaseline.has(cand.id)) {
      // 历史基线文章，未确认前一律为 needs-reconcile，杜绝从零创建
      status = 'needs-reconcile';
      reconcileNote = existing?.candidateAppmsgids?.length
        ? `存在历史候选 ID: ${existing.candidateAppmsgids.map(c => c.appmsgid).join(', ')}，待 D 验证`
        : '属于旧批次文章但当前无确认 appmsgid，避免重复建稿';
      needsReconcileCount++;
    } else {
      // 仅限基线之外的真正新增篇章才进入 untracked
      status = 'untracked';
      untrackedCount++;
    }

    const item: DraftStateRecord = {
      id: cand.id,
      source: cand.source,
      batch: cand.batch,
      prefix: cand.prefix,
      file: cand.file,
      fullPath: cand.fullPath,
      title: originalTitle,
      // 旧 outerTitle 优先保留；若无则保留完整 title 或由配置指定，不盲截
      outerTitle: existing?.outerTitle || originalTitle,
      author: '锐多宝',
      appmsgid,
      candidateAppmsgids: existing?.candidateAppmsgids || [],
      status,
      hasCover: existing?.hasCover || false,
      hasCard: existing?.hasCard || false,
      appliedFingerprint: existing?.appliedFingerprint,
      observedFingerprint: observedFp,
      featureRepairObservedFingerprint: existing?.featureRepairObservedFingerprint,
      featureVersion: existing?.featureVersion,
      verification: existing?.verification || { verified: false },
      pushedAt: existing?.pushedAt,
      updatedAt: new Date().toISOString(),
      reconcileNote,
    };

    mergedDb[cand.id] = item;
  }

  // 默认不落盘，仅在已获取锁并显式指定 persist: true 时才落盘
  if (options.persist && !options.dryRun) {
    atomicSaveHistory(mergedDb, paths);
  }

  return {
    totalScanned: candidates.length,
    activeCount,
    needsReconcileCount,
    missingImageCount,
    untrackedCount,
    articles: Object.values(mergedDb),
  };
}

// -----------------------------------------------------------------------------
// 7. 更新基线与复验证据记录 (供 A/D 完成后调用，支持注入)
// -----------------------------------------------------------------------------
export function recordVerifiedDraft(
  articleId: string,
  appmsgid: string,
  evidence: VerificationEvidence,
  options: { dryRun?: boolean; mode?: 'metadata-repair' | 'full-content'; outerTitle?: string; paths?: StatePathsConfig } = {}
): DraftStateRecord {
  if (options.dryRun) {
    throw new Error('dry-run 模式下禁止调用 recordVerifiedDraft 写入状态');
  }

  const paths = getStatePaths(options.paths);
  const db = loadHistoryDatabase(paths);
  const target = db[articleId];
  if (!target) throw new Error(`未找到目标推文记录: ${articleId}`);

  const mode = options.mode || 'metadata-repair';

  // 无论复验是否全部通过，已生成的 appmsgid 必须立即保全，杜绝丢 ID
  target.appmsgid = appmsgid;
  target.hasCover = !!evidence.coverMatched;
  target.hasCard = !!evidence.cardMatched;
  target.verification = evidence;
  target.updatedAt = new Date().toISOString();
  target.pushedAt = target.pushedAt || new Date().toISOString();

  // 若传入了生效的外层标题，更新保存到记录中，防止后续因标题不同重复修复
  if (options.outerTitle && options.outerTitle.trim() !== '') {
    target.outerTitle = options.outerTitle.trim();
  }

  if (evidence.verified) {
    target.status = 'active';
    if (mode === 'full-content') {
      // 仅当经过全量内容与图片真实注入发布，才晋升指纹基线
      if (target.observedFingerprint) {
        target.appliedFingerprint = target.observedFingerprint;
      }
    } else {
      // 纯 metadata repair：保留原正文 appliedFingerprint，记录 featureRepairObservedFingerprint 与 featureVersion 防每日重复 repair
      target.featureRepairObservedFingerprint = target.observedFingerprint?.compositeHash;
      target.featureVersion = CURRENT_FEATURE_VERSION;
      console.log(`[draft-state] 文章 ${articleId} 为 metadata-repair 模式，保留原 appliedFingerprint 并标记 featureVersion=${CURRENT_FEATURE_VERSION}`);
    }
  } else {
    // 复验未全部达标：明确标为 saved-unverified，绝不更新 appliedFingerprint，绝不伪造 active
    target.status = 'saved-unverified';
    console.warn(`[draft-state] ⚠️ 文章 ${articleId} 已保存 (appmsgid=${appmsgid}) 但未通过重开复验，标为 saved-unverified`);
  }

  atomicSaveHistory(db, paths);
  return target;
}
