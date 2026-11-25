#!/usr/bin/env node
/**
 * 登录态到期诊断（只读）：读取专用浏览器中 weixin.qq.com 的 Cookie 名称与到期时间，
 * 绝不输出 Cookie 值。用于回答“还能撑多久、为什么又掉了”。
 *
 * 用法:
 *   node scripts/session-expiry.mjs
 *
 * 说明: 微信会话 Cookie（slave_sid/data_ticket/bizuin 等）由平台签发，
 * 实测 Max-Age 固定约 96 小时，页面访问不会顺延；本工具只报告剩余时间。
 */
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const PROFILE_DIR = process.env.WECHAT_BROWSER_PROFILE_DIR
  || 'C:\\Users\\Administrator\\AppData\\Roaming\\baoyu-skills\\chrome-profile';

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

const port = findDebugPort();
if (!port) {
  console.log('专用浏览器未运行，无法读取登录态到期时间。');
  process.exit(2);
}

const version = await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.json());
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
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
});

const snap = await send('Storage.getCookies', {});
const now = Date.now() / 1000;
const interesting = ['slave_sid', 'data_ticket', 'bizuin', 'slave_bizuin', 'data_bizuin'];
const rows = (snap.cookies || [])
  .filter(c => c.domain.includes('weixin.qq.com') && interesting.includes(c.name))
  .map(c => ({ name: c.name, hours: (c.expires - now) / 3600, session: c.session }));

if (rows.length === 0) {
  console.log('未发现微信会话 Cookie，当前应为未登录状态（needs-qr）。');
  process.exit(3);
}
const minHours = Math.min(...rows.filter(r => !r.session).map(r => r.hours));
for (const row of rows) {
  console.log(`${row.name}: ${row.session ? '会话 Cookie（关浏览器即失效）' : `剩余 ${row.hours.toFixed(1)} 小时（约 ${(row.hours / 24).toFixed(1)} 天）`}`);
}
console.log(`\n预计最早失效: ${new Date((now + minHours * 3600) * 1000).toLocaleString('zh-CN', { hour12: false })}`);
console.log(minHours < 24 ? '⚠️ 不足 24 小时，请安排在专用窗口扫码。' : '✅ 暂不需要扫码。');
ws.close();
process.exit(0);
