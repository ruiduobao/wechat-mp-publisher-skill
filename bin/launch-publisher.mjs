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

const localBun = path.join(os.homedir(), '.bun', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
const bunPath = process.env.WECHAT_BUN_PATH || (fs.existsSync(localBun) ? localBun : 'bun');
const batchScript = path.join(repoRoot, 'scripts', 'batch-fast-wechat.ts');
const args = process.argv.slice(2).map(arg => arg === '--check' ? '--dry-run' : arg);

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
