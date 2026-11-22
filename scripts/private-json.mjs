#!/usr/bin/env node
/**
 * 私有 JSON 安全编辑工具：避免用内联 node -e / heredoc 修改状态文件时被引号、
 * 反斜杠或中文标点破坏。所有写入均为“解析 → 校验 → 临时文件 → 原子替换”，
 * 解析失败直接退出 1，绝不覆盖原文件。
 *
 * 用法:
 *   node scripts/private-json.mjs corrections list
 *   node scripts/private-json.mjs corrections add <spec.json>
 *   node scripts/private-json.mjs validate <file.json>
 *
 * spec.json 形如:
 *   { "articleId": "muse:20261122_1700:01",
 *     "find": "原文逐字片段",
 *     "replaceWith": "修正后文字",
 *     "note": "官网二次核实说明" }
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_CORRECTIONS = path.join(
  process.env.USERPROFILE || process.env.HOME || '.',
  '.agents', 'skills', 'wechat-md-pipeline', 'data', 'content-corrections.json'
);

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (error) {
    fail(`读取失败 ${file}: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`JSON 解析失败（保持原文件不动）${file}: ${error.message}`);
  }
}

function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmp, file);
}

function assertArticleId(id) {
  if (!/^[a-z]+:\d{8}_\d{4}:\d{2}$/.test(String(id || ''))) {
    fail(`articleId 不合法: ${id}（示例 muse:20261122_1700:01）`);
  }
}

function addCorrection(specPath) {
  const spec = readJson(specPath);
  assertArticleId(spec.articleId);
  for (const key of ['find', 'replaceWith']) {
    if (typeof spec[key] !== 'string' || spec[key].length === 0) {
      fail(`spec.${key} 必须是非空字符串`);
    }
  }
  if (spec.note !== undefined && typeof spec.note !== 'string') {
    fail('spec.note 必须是字符串');
  }
  if (spec.find === spec.replaceWith) {
    fail('find 与 replaceWith 完全相同，无需登记');
  }

  const file = process.env.WECHAT_CONTENT_CORRECTIONS || DEFAULT_CORRECTIONS;
  const data = readJson(file);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    fail('修正映射必须是 { articleId: [ { find, replaceWith, note } ] } 对象');
  }
  const entries = Array.isArray(data[spec.articleId]) ? data[spec.articleId] : [];
  const duplicate = entries.find(item => item.find === spec.find);
  if (duplicate) {
    duplicate.replaceWith = spec.replaceWith;
    if (spec.note) duplicate.note = spec.note;
    console.log(`♻️ 已更新同 find 的既有修正: ${spec.articleId}`);
  } else {
    entries.push({ find: spec.find, replaceWith: spec.replaceWith, ...(spec.note ? { note: spec.note } : {}) });
    console.log(`✅ 已新增修正: ${spec.articleId}（该文章共 ${entries.length} 条）`);
  }
  data[spec.articleId] = entries;
  writeJsonAtomic(file, data);
  console.log(`   文件: ${file}`);
}

function listCorrections() {
  const file = process.env.WECHAT_CONTENT_CORRECTIONS || DEFAULT_CORRECTIONS;
  const data = readJson(file);
  const ids = Object.keys(data || {});
  console.log(`共 ${ids.length} 篇文章登记了修正:`);
  for (const id of ids) {
    const entries = Array.isArray(data[id]) ? data[id] : [];
    console.log(`- ${id}（${entries.length} 条）`);
    for (const entry of entries) {
      const preview = String(entry.find || '').replace(/\s+/g, ' ').slice(0, 60);
      console.log(`    · ${preview}${preview.length >= 60 ? '…' : ''}`);
    }
  }
}

const [, , command, sub, arg] = process.argv;
if (command === 'corrections' && sub === 'list') {
  listCorrections();
} else if (command === 'corrections' && sub === 'add' && arg) {
  addCorrection(arg);
} else if (command === 'validate' && sub) {
  readJson(sub);
  console.log(`✅ JSON 合法: ${sub}`);
} else {
  console.log('用法:');
  console.log('  node scripts/private-json.mjs corrections list');
  console.log('  node scripts/private-json.mjs corrections add <spec.json>');
  console.log('  node scripts/private-json.mjs validate <file.json>');
  process.exit(2);
}
