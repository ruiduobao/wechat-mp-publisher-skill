#!/usr/bin/env node
/**
 * 登录态到期诊断（只读）：读取专用浏览器中 weixin.qq.com 的 Cookie 名称与到期时间，
 * 绝不输出 Cookie 值。用于回答“还能撑多久、为什么又掉了”，并供每小时巡检自动提醒。
 *
 * 用法:
 *   node scripts/session-expiry.mjs [--warn-hours 24] [--json]
 *
 * 退出码:
 *   0 = 正常，剩余时间 >= 阈值
 *   3 = 即将到期（剩余 < 阈值），需要安排扫码
 *   4 = 专用浏览器未运行 / CDP 不可用（unknown，不要误报成需要扫码）
 *   5 = 未发现微信会话 Cookie（needs-qr）
 *
 * 说明: 微信会话 Cookie（slave_sid/data_ticket/bizuin 等）由平台签发，
 * 实测 Max-Age 固定约 96 小时，页面访问不会顺延；本工具只报告剩余时间。
 */
import { execFileSync } from 'node:child_process';
import process from 'node:process';

// 本地 CDP 绝不能走代理：某些环境会开启 NODE_USE_ENV_PROXY 让 fetch 读取 HTTP_PROXY。
const noProxy = new Set(String(process.env.NO_PROXY || process.env.no_proxy || '').split(',').map(v => v.trim()).filter(Boolean));
for (const host of ['127.0.0.1', 'localhost', '::1']) noProxy.add(host);
process.env.NO_PROXY = [...noProxy].join(',');
process.env.no_proxy = process.env.NO_PROXY;

const PROFILE_DIR = process.env.WECHAT_BROWSER_PROFILE_DIR
  || 'C:\\Users\\Administrator\\AppData\\Roaming\\baoyu-skills\\chrome-profile';

const args = process.argv.slice(2);
const warnIndex = args.indexOf('--warn-hours');
const warnHours = warnIndex >= 0 ? Number(args[warnIndex + 1]) : 24;
const jsonOutput = args.includes('--json');
const thresholdHours = Number.isFinite(warnHours) ? Math.max(0, warnHours) : 24;

function findDebugPort() {
  const script = [
    "$target = '" + PROFILE_DIR.replace(/'/g, "''") + "'",
    "$procs = Get-CimInstance Win32_Process -Filter \"name='msedge.exe'\"",
    'foreach ($p in $procs) {',
    '  $cmd = $p.CommandLine',
    '  if (-not $cmd) { continue }',
    '  if ($cmd.ToLower().Contains($target.ToLower())) {',
    "    if ($cmd -match '--remote-debugging-port=(\\d+)') { Write-Output $matches[1]; break }",
    '  }',
    '}',
  ].join('\n');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf-8', timeout: 15_000 });
  const port = Number.parseInt(out.trim(), 10);
  return Number.isFinite(port) ? port : null;
}

function emit(result) {
  if (jsonOutput) {
    console.log(JSON.stringify(result));
    return;
  }
  const { status, hours, expiresAt, rows } = result;
  for (const row of rows || []) {
    console.log(`${row.name}: ${row.session ? '会话 Cookie（关浏览器即失效）' : `剩余 ${row.hours.toFixed(1)} 小时（约 ${(row.hours / 24).toFixed(1)} 天）`}`);
  }
  console.log(`session-expiry-status=${status}${Number.isFinite(hours) ? ` hours=${hours.toFixed(1)}` : ''}`);
  if (expiresAt) console.log(`预计最早失效: ${expiresAt}`);
  if (status === 'expiring') console.log(`⚠️ 登录态剩余不足 ${thresholdHours} 小时，请尽快在专用 Baoyu Profile 窗口扫码。`);
  else if (status === 'ok') console.log('✅ 暂不需要扫码。');
  else if (status === 'needs-qr') console.log('⚠️ 当前未登录，请在专用 Baoyu Profile 窗口扫码。');
  else console.log('ℹ️ 无法确认登录态（浏览器未运行或 CDP 不可用），不要据此提示扫码。');
}

const port = findDebugPort();
if (!port) {
  emit({ status: 'unknown', hours: NaN, expiresAt: null, rows: [] });
  process.exit(4);
}

let version;
try {
  version = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(8_000) }).then(r => r.json());
} catch {
  emit({ status: 'unknown', hours: NaN, expiresAt: null, rows: [] });
  process.exit(4);
}

const ws = new WebSocket(version.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}
ws.addEventListener('message', ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
});
try {
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
    setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 8_000);
  });
} catch {
  emit({ status: 'unknown', hours: NaN, expiresAt: null, rows: [] });
  process.exit(4);
}

let snap;
try {
  snap = await send('Storage.getCookies', {});
} catch {
  emit({ status: 'unknown', hours: NaN, expiresAt: null, rows: [] });
  process.exit(4);
} finally {
  try { ws.close(); } catch {}
}

const now = Date.now() / 1000;
const interesting = ['slave_sid', 'data_ticket', 'bizuin', 'slave_bizuin', 'data_bizuin'];
const rows = (snap.cookies || [])
  .filter(c => c.domain.includes('weixin.qq.com') && interesting.includes(c.name))
  .map(c => ({ name: c.name, hours: (c.expires - now) / 3600, session: c.session }));

if (rows.length === 0) {
  emit({ status: 'needs-qr', hours: NaN, expiresAt: null, rows: [] });
  process.exit(5);
}
const persistent = rows.filter(r => !r.session);
const minHours = persistent.length ? Math.min(...persistent.map(r => r.hours)) : NaN;
const status = !Number.isFinite(minHours) || minHours <= 0 ? 'needs-qr' : minHours < thresholdHours ? 'expiring' : 'ok';
emit({
  status,
  hours: minHours,
  expiresAt: Number.isFinite(minHours) ? new Date((now + minHours * 3600) * 1000).toLocaleString('zh-CN', { hour12: false }) : null,
  rows,
});
process.exit(status === 'expiring' ? 3 : status === 'needs-qr' ? 5 : 0);
