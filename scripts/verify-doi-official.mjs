#!/usr/bin/env node
/**
 * DOI 官网二次核验工具：当 verify 报“doi.org 超时 / 403”时，用本工具做
 * Crossref 元数据 + doi.org Handle 双重确认，并给出标题相似度，避免手工
 * curl/node -e 因引号、编码、代理而反复失败。
 *
 * 用法:
 *   node scripts/verify-doi-official.mjs 10.1016/j.cities.2026.107758
 *   node scripts/verify-doi-official.mjs 10.1016/j.cities.2026.107758 --title "推文里的英文标题"
 *
 * 需要走代理时：用 Node 24 的 NODE_USE_ENV_PROXY=1 配合 HTTP_PROXY/HTTPS_PROXY，
 * 本脚本自身不读取代理参数，避免把本地 127.0.0.1 误送进代理。
 *
 * 退出码: 0 元数据与 Handle 均通过；2 任一失败；3 参数错误。
 */
import process from 'node:process';

const args = process.argv.slice(2);
const doi = args[0];
if (!doi || doi.startsWith('--')) {
  console.error('用法: node scripts/verify-doi-official.mjs <doi> [--title "..."]');
  process.exit(3);
}
const titleIndex = args.indexOf('--title');
const expectedTitle = titleIndex >= 0 ? args[titleIndex + 1] : undefined;

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'wechat-mp-publisher/verify-doi-official' },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function normalize(text) {
  return String(text || '').toLowerCase().replace(/[\s\-_—–:：,，.。'’"“”()（）\[\]【】/]/g, '');
}

function similarity(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return 0;
  const setX = new Set(x);
  const setY = new Set(y);
  let overlap = 0;
  for (const ch of setX) if (setY.has(ch)) overlap += 1;
  return (2 * overlap) / (setX.size + setY.size);
}

let ok = true;
console.log(`DOI: ${doi}`);

try {
  const crossref = await getJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
  const message = crossref?.message || {};
  const title = Array.isArray(message.title) ? message.title[0] : message.title;
  const journal = Array.isArray(message['container-title']) ? message['container-title'][0] : message['container-title'];
  const authors = (message.author || []).slice(0, 6).map(a => `${a.given || ''} ${a.family || ''}`.trim()).join(', ');
  const date = message.published?.['date-parts']?.[0]?.join('-') || '未知';
  console.log('Crossref: ✅');
  console.log(`  标题: ${title || '（空）'}`);
  console.log(`  期刊: ${journal || '（空）'}`);
  console.log(`  日期: ${date}`);
  console.log(`  作者: ${authors || '（空）'}`);
  if (expectedTitle) {
    const score = similarity(expectedTitle, title);
    console.log(`  标题相似度: ${(score * 100).toFixed(1)}%`);
    if (score < 0.75) {
      console.warn('  ⚠️ 相似度低于 75%，请人工确认是否为同一篇论文');
      ok = false;
    }
  }
} catch (error) {
  console.error(`Crossref: ❌ ${error.message}`);
  ok = false;
}

try {
  const res = await fetch(`https://doi.org/${encodeURIComponent(doi)}`, {
    method: 'HEAD',
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  const location = res.headers.get('location') || '';
  if (res.status >= 300 && res.status < 400 && location) {
    console.log(`doi.org: ✅ ${res.status} -> ${new URL(location, 'https://doi.org').host}`);
  } else if (res.status === 200) {
    console.log('doi.org: ✅ 200');
  } else {
    console.error(`doi.org: ❌ HTTP ${res.status}`);
    ok = false;
  }
} catch (error) {
  console.error(`doi.org: ❌ ${error.message}`);
  ok = false;
}

console.log(ok ? '\n结论: 元数据与 Handle 均通过，可用于官网二次核实记录' : '\n结论: 未能完成双重核验，请换网络/代理重试或继续查出版社官网');
process.exit(ok ? 0 : 2);
