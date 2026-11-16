#!/usr/bin/env node
/**
 * scripts/sync-from-github.mjs
 *
 * 通过 GitHub REST API 增量拉取私有同步仓库中的「本地版推文 + 配图」到本地镜像目录。
 * 仅下载发布所需的 `*_本地版.md` 与 `images/**`，跳过体积巨大的 `_网页版.html` 与原始大 Markdown。
 *
 * 环境变量：
 *   GITHUB_SYNC_TOKEN  必填，仓库读取权限的令牌（不要写入仓库文件）
 *   GITHUB_SYNC_REPO   默认 ruiduobao/zimeiti-sync
 *   GITHUB_SYNC_REF    默认 main
 *   GITHUB_SYNC_DEST   默认 C:\Users\Administrator\zimeiti-sync
 *   GITHUB_SYNC_SUBDIR 默认 公众号/每日推文
 *   GITHUB_SYNC_PROXY  可选，如 http://127.0.0.1:7897（Node fetch 不自动读系统代理）
 *
 * 用商标记：<DEST>/.sync-manifest.json（path -> blob sha）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

// 优先从仓库根目录私有 .env 读取配置（该文件已被 .gitignore 忽略）
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(repoRoot, '.env');
if (fs.existsSync(envPath)) {
  for (const raw of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}

const TOKEN = process.env.GITHUB_SYNC_TOKEN;
const REPO = process.env.GITHUB_SYNC_REPO || 'ruiduobao/zimeiti-sync';
const REF = process.env.GITHUB_SYNC_REF || 'main';
const DEST = process.env.GITHUB_SYNC_DEST || 'C:\\Users\\Administrator\\zimeiti-sync';
const SUBDIR = (process.env.GITHUB_SYNC_SUBDIR || '公众号/每日推文').replace(/\\/g, '/');
const PROXY = process.env.GITHUB_SYNC_PROXY || '';

if (!TOKEN) {
  console.error('[sync-from-github] 缺少 GITHUB_SYNC_TOKEN 环境变量');
  process.exit(2);
}

if (PROXY) {
  setGlobalDispatcher(new ProxyAgent(PROXY));
  console.log(`[sync-from-github] 使用代理 ${PROXY}`);
}

const API = 'https://api.github.com';
const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'wechat-mp-publisher-sync',
};

function isWanted(filePath) {
  if (!filePath.startsWith(SUBDIR + '/')) return false;
  const rest = filePath.slice(SUBDIR.length + 1);
  if (/_(本地版\.md|本地版\.markdown)$/.test(rest)) return true;
  if (/\/images\//.test(rest)) return true;
  return false;
}

async function ghJson(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
      if (res.status === 401 || res.status === 403) {
        throw new Error(`鉴权失败 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 1200 * attempt));
    }
  }
}

async function downloadRaw(filePath, attempt = 1) {
  const url = `${API}/repos/${REPO}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(REF)}`;
  try {
    const res = await fetch(url, {
      headers: { ...headers, Accept: 'application/vnd.github.raw' },
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (attempt >= 3) throw err;
    await new Promise(r => setTimeout(r, 1500 * attempt));
    return downloadRaw(filePath, attempt + 1);
  }
}

function readManifest() {
  const p = path.join(DEST, '.sync-manifest.json');
  if (!fs.existsSync(p)) return { files: {}, lastCommit: '' };
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return { files: j.files || {}, lastCommit: j.lastCommit || '' };
  } catch {
    return { files: {}, lastCommit: '' };
  }
}

async function main() {
  console.log(`[sync-from-github] 仓库 ${REPO}@${REF} -> ${DEST}`);
  const repoInfo = await ghJson(`${API}/repos/${REPO}`);
  if (repoInfo.default_branch && !process.env.GITHUB_SYNC_REF) {
    // REF 未显式指定时跟随仓库默认分支
  }
  const head = await ghJson(`${API}/repos/${REPO}/commits/${encodeURIComponent(REF)}?per_page=1`);
  const headSha = head.sha;
  const manifest = readManifest();

  if (manifest.lastCommit === headSha) {
    console.log(`[sync-from-github] 已是最新提交 ${headSha.slice(0, 8)}，检查缺失文件...`);
  }

  const tree = await ghJson(`${API}/repos/${REPO}/git/trees/${encodeURIComponent(headSha)}?recursive=1`);
  if (tree.truncated) console.warn('[sync-from-github] ⚠️ 仓库文件树被截断，可能漏掉极深层级');

  const wanted = (tree.tree || []).filter(t => t.type === 'blob' && isWanted(t.path));
  const toDownload = [];
  for (const f of wanted) {
    const local = path.join(DEST, ...f.path.split('/'));
    const knownSha = manifest.files[f.path];
    if (knownSha === f.sha && fs.existsSync(local) && fs.statSync(local).size === f.size) continue;
    toDownload.push(f);
  }

  console.log(`[sync-from-github] 命中文件 ${wanted.length} 个，需下载 ${toDownload.length} 个`);

  let bytes = 0;
  for (const f of toDownload) {
    const buf = await downloadRaw(f.path);
    const local = path.join(DEST, ...f.path.split('/'));
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, buf);
    manifest.files[f.path] = f.sha;
    bytes += buf.length;
    if (f.path.endsWith('_本地版.md')) console.log(`  ✅ ${f.path} (${(buf.length / 1024).toFixed(0)}KB)`);
  }

  // 清理远端已删除、但仍在本地清单中的文件
  const remotePaths = new Set(wanted.map(f => f.path));
  let removed = 0;
  for (const p of Object.keys(manifest.files)) {
    if (remotePaths.has(p)) continue;
    const local = path.join(DEST, ...p.split('/'));
    if (fs.existsSync(local)) {
      fs.rmSync(local, { force: true });
      removed++;
    }
    delete manifest.files[p];
  }

  manifest.lastCommit = headSha;
  fs.mkdirSync(DEST, { recursive: true });
  fs.writeFileSync(path.join(DEST, '.sync-manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

  console.log(`[sync-from-github] 完成：下载 ${toDownload.length} 个文件 ${(bytes / 1048576).toFixed(1)}MB，移除 ${removed} 个，提交 ${headSha.slice(0, 8)}`);
}

main().catch(err => {
  console.error('[sync-from-github] ❌ 失败:', err?.message || err);
  process.exit(1);
});
