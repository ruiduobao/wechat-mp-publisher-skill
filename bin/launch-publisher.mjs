#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(repoRoot, '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

// 本地 CDP（127.0.0.1）绝不能走系统代理：Bun 的 fetch 会读取 HTTP_PROXY，
// 一旦 Clash 等代理未运行，连接调试端口会误报 ECONNREFUSED。
const noProxyHosts = new Set(
  String(process.env.NO_PROXY || process.env.no_proxy || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
);
for (const host of ['127.0.0.1', 'localhost', '::1']) noProxyHosts.add(host);
process.env.NO_PROXY = [...noProxyHosts].join(',');
process.env.no_proxy = process.env.NO_PROXY;

const localBun = path.join(os.homedir(), '.bun', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
const bunPath = process.env.WECHAT_BUN_PATH || (fs.existsSync(localBun) ? localBun : 'bun');
const batchScript = path.join(repoRoot, 'scripts', 'batch-fast-wechat.ts');
const args = process.argv.slice(2).map(arg => arg === '--check' ? '--dry-run' : arg);

// 磁盘预检：磁盘写满会连锁导致同步 ENOSPC、页面资源加载失败、重开复验 JS 异常。
// 只在低于阈值时清理本工具自己的过期临时目录；仍不足则明确退出，绝不硬着头皮半批写入。
function freeBytes(dir) {
  try {
    const stat = fs.statfsSync(dir);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return null;
  }
}

function cleanupOwnStaleTemp(tempDir, minBytes) {
  const before = freeBytes(tempDir);
  if (before === null || before >= minBytes) return;
  const cutoff = Date.now() - 24 * 3600 * 1000;
  try {
    for (const entry of fs.readdirSync(tempDir)) {
      if (!/^zcode-bash-/i.test(entry)) continue;
      const full = path.join(tempDir, entry);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true });
      } catch {}
    }
  } catch {}
}

const minFreeMb = Number(process.env.WECHAT_MIN_FREE_MB || 300);
const minFreeBytes = Number.isFinite(minFreeMb) ? Math.max(0, minFreeMb) * 1024 * 1024 : 300 * 1024 * 1024;
const tempDir = process.env.TEMP || process.env.TMP || os.tmpdir();
const keepaliveOnly = args.length === 1 && args[0] === '--keepalive';
cleanupOwnStaleTemp(tempDir, minFreeBytes);
if (!keepaliveOnly) {
  for (const [label, dir] of [['仓库盘', repoRoot], ['临时盘', tempDir]]) {
    const free = freeBytes(dir);
    if (free !== null && free < minFreeBytes) {
      console.error(
        `[wechat-launcher] ❌ ${label}空间不足：${dir} 仅剩 ${(free / 1024 / 1024).toFixed(0)}MB，` +
        `低于 ${minFreeMb}MB 安全线。请清理磁盘，或把 TEMP/TMP 指向有空间的盘（例如 D:\\Temp\\zcode）后重试。`
      );
      process.exit(2);
    }
    if (free !== null) {
      console.log(`[wechat-launcher] ${label}可用空间: ${(free / 1024 / 1024).toFixed(0)}MB`);
    }
  }
}

function run(executable, childArgs) {
  return new Promise(resolve => {
    const child = spawn(executable, childArgs, { cwd: repoRoot, stdio: 'inherit', env: process.env });
    child.on('error', err => {
      console.error(`[wechat-launcher] 启动失败: ${err.message}`);
      resolve(1);
    });
    child.on('close', code => resolve(code ?? 1));
  });
}

if (!fs.existsSync(batchScript)) {
  console.error('[wechat-launcher] 未找到统一发布引擎');
  process.exit(1);
}

// 只有严格单独的 --keepalive（或 --help/-h、--dry-run）才跳过 tsc。
// 任何与业务参数混用的 --keepalive 都会先通过 TypeScript 检查，再由参数门禁以退出码 2 拒绝。
const isLoneKeepalive = args.length === 1 && args[0] === '--keepalive';
const isHelpRequest = args.some(arg => arg === '--help' || arg === '-h');
const isDryRun = args.includes('--dry-run');
if (!isLoneKeepalive && !isHelpRequest && !isDryRun) {
  const tsc = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) {
    console.error('[wechat-launcher] 缺少 TypeScript，请先安装项目依赖 (bun install)');
    process.exit(1);
  }
  console.log('[wechat-launcher] 正式写入前检查 TypeScript...');
  const code = await run(process.execPath, [tsc, '--noEmit', '--project', path.join(repoRoot, 'tsconfig.json')]);
  if (code !== 0) process.exit(code);
}

process.exit(await run(bunPath, ['run', batchScript, ...args]));
