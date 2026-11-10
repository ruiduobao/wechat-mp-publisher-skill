#!/usr/bin/env bun
/**
 * sync-wechat-drafts.ts — 每日双源推文自动同步到微信公众号草稿箱
 * 
 * 覆盖两大来源：
 *   1. Muse 同步推文：F:\同步文件夹\公众号\每日推文\YYYYMMDD_HH00\ (优先选 *_本地版.md)
 *   2. 本地自动推文：Z:\自媒体\公众号\每日推文\YYYYMMDD_HH00\ (01_*.md ~ 04_*.md)
 * 
 * 特性：
 *   - 历史去重数据库：记录每篇推文的推送状态与微信 appmsgid，保证绝对不重复推稿
 *   - 自动调用已授权的 baoyu-post-to-wechat 浏览器通道，免凭据、免扫码
 *   - 支持参数：--days <N>（默认最近2天）、--all（全量扫描）、--batch <批次名>、--dry-run
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MUSE_ROOT = 'F:\\同步文件夹\\公众号\\每日推文';
const LOCAL_ROOT = 'Z:\\自媒体\\公众号\\每日推文';
const HISTORY_FILE = 'C:\\Users\\Administrator\\.agents\\skills\\wechat-md-pipeline\\data\\wechat-draft-history.json';
const WECHAT_ARTICLE_SCRIPT = 'C:\\Users\\Administrator\\.agents\\skills\\baoyu-post-to-wechat\\scripts\\wechat-article.ts';

interface HistoryRecord {
  appmsgid: string;
  title: string;
  source: 'muse' | 'local';
  batch: string;
  file: string;
  fullPath: string;
  pushedAt: string;
}

interface ArticleItem {
  id: string; // unique key e.g. "muse:20261109_1700:01"
  source: 'muse' | 'local';
  batch: string;
  file: string;
  fullPath: string;
}

function loadHistory(): Record<string, HistoryRecord> {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('[warn] Failed to read history file, starting fresh:', err);
  }
  return {};
}

function saveHistory(history: Record<string, HistoryRecord>): void {
  const dir = path.dirname(HISTORY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
}

function parseArgs(): { days: number; all: boolean; batch?: string; dryRun: boolean; source: 'all' | 'muse' | 'local' } {
  const args = process.argv.slice(2);
  let days = 2; // 默认检查最近 2 天
  let all = false;
  let batch: string | undefined;
  let dryRun = false;
  let source: 'all' | 'muse' | 'local' = 'all';

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--days' && args[i + 1]) days = parseInt(args[++i]!, 10);
    else if (a === '--all') all = true;
    else if (a === '--batch' && args[i + 1]) batch = args[++i];
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--source' && args[i + 1]) source = args[++i] as any;
  }
  return { days, all, batch, dryRun, source };
}

function getCutoffDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

function scanMuse(targetBatch?: string, cutoff?: string): ArticleItem[] {
  if (!fs.existsSync(MUSE_ROOT)) return [];
  let batches = fs.readdirSync(MUSE_ROOT).filter(d => /^\d{8}_\d{4}$/.test(d)).sort();
  if (targetBatch) batches = batches.filter(b => b === targetBatch);
  else if (cutoff) batches = batches.filter(b => b.slice(0, 8) >= cutoff);

  const items: ArticleItem[] = [];
  for (const b of batches) {
    const bDir = path.join(MUSE_ROOT, b);
    const files = fs.readdirSync(bDir).filter(f => f.endsWith('.md') && !f.startsWith('00_') && !f.includes('纯文本'));
    
    // 按前缀分组 (01, 02, 03, ...)
    const groups: Record<string, string[]> = {};
    for (const f of files) {
      const m = f.match(/^(\d{2})_/);
      if (m) {
        const prefix = m[1]!;
        if (!groups[prefix]) groups[prefix] = [];
        groups[prefix].push(f);
      }
    }

    for (const prefix of Object.keys(groups).sort()) {
      const list = groups[prefix]!;
      // 优先使用本地版（带真实图片提取路径）
      const localVer = list.find(f => f.includes('本地版'));
      const chosen = localVer || list[0]!;
      items.push({
        id: `muse:${b}:${prefix}`,
        source: 'muse',
        batch: b,
        file: chosen,
        fullPath: path.join(bDir, chosen),
      });
    }
  }
  return items;
}

function scanLocal(targetBatch?: string, cutoff?: string): ArticleItem[] {
  if (!fs.existsSync(LOCAL_ROOT)) return [];
  let batches = fs.readdirSync(LOCAL_ROOT).filter(d => /^\d{8}_\d{4}$/.test(d)).sort();
  if (targetBatch) batches = batches.filter(b => b === targetBatch);
  else if (cutoff) batches = batches.filter(b => b.slice(0, 8) >= cutoff);

  const items: ArticleItem[] = [];
  for (const b of batches) {
    const bDir = path.join(LOCAL_ROOT, b);
    const files = fs.readdirSync(bDir).filter(f => f.endsWith('.md') && !f.startsWith('00_') && /^\d{2}_/.test(f)).sort();
    
    for (const f of files) {
      const prefix = f.slice(0, 2);
      items.push({
        id: `local:${b}:${prefix}`,
        source: 'local',
        batch: b,
        file: f,
        fullPath: path.join(bDir, f),
      });
    }
  }
  return items;
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const opts = parseArgs();
  console.log(`[sync-wechat] Starting WeChat draft sync pipeline...`);
  console.log(`  Mode: ${opts.all ? 'ALL historical' : opts.batch ? `Batch ${opts.batch}` : `Recent ${opts.days} days`}`);
  console.log(`  Source filter: ${opts.source}, DryRun: ${opts.dryRun}`);

  const history = loadHistory();
  const cutoff = opts.all ? undefined : getCutoffDate(opts.days);

  const museItems = (opts.source === 'all' || opts.source === 'muse') ? scanMuse(opts.batch, cutoff) : [];
  const localItems = (opts.source === 'all' || opts.source === 'local') ? scanLocal(opts.batch, cutoff) : [];
  const allCandidates = [...museItems, ...localItems];

  console.log(`[sync-wechat] Discovered ${allCandidates.length} articles (${museItems.length} Muse, ${localItems.length} Local)`);

  const pending: ArticleItem[] = [];
  let alreadyPushed = 0;

  for (const item of allCandidates) {
    if (history[item.id]) {
      alreadyPushed++;
    } else {
      pending.push(item);
    }
  }

  console.log(`[sync-wechat] Status: ${alreadyPushed} already in drafts, ${pending.length} pending push`);

  if (pending.length === 0) {
    console.log(`[sync-wechat] Everything is up to date. No new drafts needed.`);
    return;
  }

  if (opts.dryRun) {
    console.log(`\n--- Pending articles (Dry Run) ---`);
    for (const p of pending) {
      console.log(`- [${p.source.toUpperCase()}] ${p.batch} / ${p.file}`);
    }
    return;
  }

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < pending.length; i++) {
    const item = pending[i]!;
    console.log(`\n------------------------------------------------------------`);
    console.log(`[sync-wechat] [${i + 1}/${pending.length}] Pushing [${item.source.toUpperCase()}] ${item.batch} / ${item.file}...`);
    
    const startTime = Date.now();
    const result = spawnSync('bun', [
      'run',
      WECHAT_ARTICLE_SCRIPT,
      '--markdown',
      item.fullPath,
      '--theme',
      'default',
      '--submit',
    ], {
      cwd: path.dirname(WECHAT_ARTICLE_SCRIPT),
      encoding: 'utf-8',
      timeout: 180_000,
    });

    const output = (result.stdout || '') + '\n' + (result.stderr || '');
    const appmsgidMatch = output.match(/Draft saved successfully!\s+appmsgid:\s*(\d+)/i);
    const titleMatch = output.match(/\[wechat\]\s+Title:\s*([^\r\n]+)/i);
    const resolvedTitle = titleMatch ? titleMatch[1]!.trim() : item.file;

    if (result.status === 0 && appmsgidMatch) {
      const appmsgid = appmsgidMatch[1]!;
      console.log(`[sync-wechat] ✅ SUCCESS! appmsgid: ${appmsgid} (${((Date.now() - startTime) / 1000).toFixed(1)}s)`);
      console.log(`              Title: "${resolvedTitle}"`);
      
      history[item.id] = {
        appmsgid,
        title: resolvedTitle,
        source: item.source,
        batch: item.batch,
        file: item.file,
        fullPath: item.fullPath,
        pushedAt: new Date().toISOString(),
      };
      saveHistory(history);
      successCount++;
    } else {
      console.error(`[sync-wechat] ❌ FAILED! status: ${result.status}`);
      const errLines = output.split('\n').filter(l => l.includes('Error') || l.includes('timeout') || l.includes('failed')).slice(-3);
      if (errLines.length) console.error(`              Error tail:`, errLines.join(' | '));
      failCount++;
    }

    // 在多篇文章推送之间保持 6 秒缓冲，防止触发微信编辑器频控
    if (i < pending.length - 1) {
      console.log(`[sync-wechat] Waiting 6 seconds before next article...`);
      await sleep(6000);
    }
  }

  console.log(`\n============================================================`);
  console.log(`[sync-wechat] Batch run completed!`);
  console.log(`  Pushed:  ${successCount}`);
  console.log(`  Failed:  ${failCount}`);
  console.log(`  Skipped: ${alreadyPushed}`);
  console.log(`============================================================`);
}

await main();
