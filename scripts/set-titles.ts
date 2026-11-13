#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_TITLES_FILE = 'C:\\Users\\Administrator\\.agents\\skills\\wechat-md-pipeline\\data\\titles-override.json';

export function resolveTitlesFilePath(override?: string): string {
  return override || process.env.WECHAT_TITLES_FILE || DEFAULT_TITLES_FILE;
}

export function loadTitlesMap(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf-8');
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`FATAL: 标题映射文件 JSON 已损坏，拒绝覆盖: ${filePath} (${err.message})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`FATAL: 标题映射文件结构错误，期望字典对象: ${filePath}`);
  }
  return parsed;
}

export function mergeShortTitles(
  updates: Record<string, string>,
  filePath = resolveTitlesFilePath()
): { filePath: string; total: number; updatedKeys: string[] } {
  const existing = loadTitlesMap(filePath);
  const updatedKeys: string[] = [];

  for (const [id, rawTitle] of Object.entries(updates)) {
    const cleanId = id.trim();
    const cleanTitle = rawTitle.trim();
    if (!cleanId) throw new Error('articleId 不能为空');
    if (!cleanTitle) throw new Error(`${cleanId} 的短标题不能为空`);
    const len = Array.from(cleanTitle).length;
    if (len > 15) {
      throw new Error(`needs-title: ${cleanId} 短标题 "${cleanTitle}" 长度为 ${len} 字，超过 15 字上限`);
    }
    existing[cleanId] = cleanTitle;
    updatedKeys.push(cleanId);
  }

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tempFile = path.join(dir, `.titles-override.tmp.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tempFile, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
  fs.renameSync(tempFile, filePath);

  return { filePath, total: Object.keys(existing).length, updatedKeys };
}

function main() {
  const args = process.argv.slice(2);
  let outFile: string | undefined;
  let fromJson: string | undefined;
  let listOnly = false;
  const pairs: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') {
      console.log(`
用法:
  bun run scripts/set-titles.ts "<articleId>=<15字以内短标题>" [...]
  bun run scripts/set-titles.ts --from-json <input.json>
  bun run scripts/set-titles.ts --list

选项:
  --out, -o <file>     目标映射文件 (默认: ${DEFAULT_TITLES_FILE})
  --from-json <file>   从指定 JSON 文件批量合并校验
  --list, -l           只读列出当前已保存的短标题映射
`.trim());
      process.exit(0);
    } else if (arg === '--out' || arg === '-o') {
      outFile = args[++i];
    } else if (arg === '--from-json') {
      fromJson = args[++i];
    } else if (arg === '--list' || arg === '-l') {
      listOnly = true;
    } else {
      const eqIdx = arg.indexOf('=');
      if (eqIdx <= 0) {
        console.error(`❌ 参数格式错误，期望 "<articleId>=<短标题>"，收到: ${arg}`);
        process.exit(2);
      }
      const key = arg.slice(0, eqIdx).trim();
      const val = arg.slice(eqIdx + 1).trim();
      pairs[key] = val;
    }
  }

  const targetFile = resolveTitlesFilePath(outFile);

  if (listOnly) {
    const map = loadTitlesMap(targetFile);
    console.log(`当前映射 (${targetFile}) 共 ${Object.keys(map).length} 条:`);
    for (const [k, v] of Object.entries(map)) {
      console.log(`  ${k} => "${v}" (${Array.from(v).length}字)`);
    }
    return;
  }

  if (fromJson) {
    const incoming = loadTitlesMap(fromJson);
    Object.assign(pairs, incoming);
  }

  if (Object.keys(pairs).length === 0) {
    console.error('❌ 未提供任何需要写入的短标题。运行 --help 查看用法。');
    process.exit(2);
  }

  const res = mergeShortTitles(pairs, targetFile);
  console.log(`✅ 已原子合并 ${res.updatedKeys.length} 条短标题至 ${res.filePath} (总计 ${res.total} 条):`);
  for (const k of res.updatedKeys) {
    console.log(`  * ${k} => "${pairs[k]}" (${Array.from(pairs[k]!).length}字)`);
  }
}

if (import.meta.main) {
  main();
}
