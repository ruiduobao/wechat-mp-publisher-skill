#!/usr/bin/env node
/**
 * 登录态时间线报告：读取私有 keepalive-history.jsonl，按天统计三态并列出
 * 每一次状态切换，用来快速回答“什么时候掉的、掉了多久、是否被误报”。
 *
 * 用法:
 *   node scripts/keepalive-report.mjs [天数=7]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const days = Number.parseInt(process.argv[2] || '7', 10);
const file = process.env.WECHAT_KEEPALIVE_LOG || path.join(
  process.env.USERPROFILE || process.env.HOME || '.',
  '.agents', 'skills', 'wechat-md-pipeline', 'data', 'keepalive-history.jsonl'
);

if (!fs.existsSync(file)) {
  console.log(`暂无保活记录: ${file}`);
  process.exit(0);
}

const since = Date.now() - (Number.isFinite(days) ? days : 7) * 86_400_000;
const rows = [];
for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  try {
    const item = JSON.parse(line);
    if (Date.parse(item.at) >= since) rows.push(item);
  } catch {}
}
rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

console.log(`最近 ${days} 天保活记录: ${rows.length} 次 | ${file}`);
if (rows.length === 0) process.exit(0);

const counts = {};
for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;
console.log('状态分布:', Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' | '));

let previous = null;
console.log('\n状态切换:');
for (const row of rows) {
  if (row.status === previous) continue;
  const time = new Date(row.at).toLocaleString('zh-CN', { hour12: false });
  console.log(`  ${time}  ${row.status}${row.reason ? ` (${row.reason})` : ''}`);
  previous = row.status;
}

const last = rows[rows.length - 1];
console.log(`\n最近一次: ${new Date(last.at).toLocaleString('zh-CN', { hour12: false })} ${last.status}${last.reason ? ` (${last.reason})` : ''}`);
