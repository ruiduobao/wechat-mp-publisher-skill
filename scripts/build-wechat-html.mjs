#!/usr/bin/env node
/**
 * build-wechat-html.mjs — 公众号 HTML 合成器（ruiduobao 管线）
 * 用法：
 *   node build-wechat-html.mjs --html <草稿.html(含 {{IMG:n}} 占位)> \
 *     --base <图片根目录> --map "0=相对路径1;1=相对路径2" \
 *     --title <文章标题(≤32字)> --out <最终.html>
 * 行为：
 *   1. 把 {{IMG:n}} 替换为 <img src="data:..."> （base64 内嵌，公众号编辑器粘贴时自动转存素材库）
 *   2. 校验：禁止 <style>/<link>/script/外部 http 图片引用；占位符必须全部被替换
 *   3. 输出最终 HTML + 统计
 */
import fs from "node:fs";
import path from "node:path";

function arg(name) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const htmlFile = arg("html");
const baseDir = arg("base") || ".";
const mapArg = arg("map") || "";
const title = arg("title");
const out = arg("out");

if (!htmlFile || !out) {
  console.error("usage: node build-wechat-html.mjs --html draft.html --base imgdir --map '0=a.png;1=b.png' --title '...' --out final.html");
  process.exit(2);
}

let html = fs.readFileSync(htmlFile, "utf8");

// 图片映射与内嵌
const pairs = mapArg.split(";").filter(Boolean).map(p => {
  const [idx, rel] = p.split("=");
  return { idx: idx.trim(), rel: rel.trim() };
});
let embedded = 0;
for (const { idx, rel } of pairs) {
  const abs = path.resolve(baseDir, rel);
  const buf = fs.readFileSync(abs);
  const ext = path.extname(abs).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : "image/jpeg";
  const tag = `<img src="data:${mime};base64,${buf.toString("base64")}" alt="" data-orig="${rel}" style="display:block;max-width:100%;height:auto;border-radius:12px;margin:16px auto;">`;
  const ph = new RegExp("\\{\\{IMG:" + idx + "\\}\\}", "g");
  if (!ph.test(html)) console.error(`WARN: placeholder {{IMG:${idx}}} not found in draft`);
  html = html.replace(ph, () => tag);
  embedded++;
}

// 校验
const problems = [];
if (/\{\{IMG:\d+\}\}/.test(html)) problems.push("存在未替换的 {{IMG:n}} 占位符");
if (/<style[\s>]/i.test(html)) problems.push("包含 <style> 标签（公众号会剥离）");
if (/<link[\s>]/i.test(html)) problems.push("包含 <link> 外链（公众号会剥离）");
if (/<script[\s>]/i.test(html)) problems.push("包含 <script>（公众号禁止）");
const remoteImgs = (html.match(/<img[^>]+src=["']https?:\/\//g) || []).length;
if (remoteImgs) problems.push(`包含 ${remoteImgs} 个远程 http 图片（粘贴到公众号不会自动上传，需先内嵌或传素材库）`);
const imgCount = (html.match(/<img/g) || []).length;
if (title && title.length > 32) problems.push(`标题 ${title.length} 字超过 32 上限`);

if (problems.length) {
  console.error("FAIL:");
  for (const p of problems) console.error("  ✗ " + p);
  process.exit(1);
}

fs.writeFileSync(out, html, "utf8");
console.log(`OK: ${out}`);
console.log(`  内嵌图片: ${embedded}，正文 <img> 总数: ${imgCount}`);
console.log(`  大小: ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
console.log(`  标题(${title ? title.length : "?"}字): ${title || "(未提供)"}`);
