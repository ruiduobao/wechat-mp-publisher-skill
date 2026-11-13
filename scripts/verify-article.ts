#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import {
  computeStateCatalog,
  extractOriginalTitle,
  verifyImagesIntegrity,
} from './draft-state.ts';

export interface DoiCheckResult {
  doi: string;
  valid: boolean;
  status: 'verified' | 'not-found' | 'title-mismatch' | 'network-error';
  resolvedTitle?: string;
  titleSimilarity?: number;
  publisher?: string;
  httpStatus?: number;
  message: string;
}

export interface ArxivCheckResult {
  arxivId: string;
  valid: boolean;
  status: 'verified' | 'not-found' | 'title-mismatch' | 'network-error';
  resolvedTitle?: string;
  titleSimilarity?: number;
  message: string;
}

export interface UrlCheckResult {
  url: string;
  status: 'ok' | 'dead' | 'blocked' | 'network-error';
  httpStatus?: number;
  message: string;
}

export interface ExtractedArticleClaims {
  articleTitle: string;
  paperTitle?: string;
  journalOrSource?: string;
  authors?: string;
  dois: string[];
  arxivIds: string[];
  urls: string[];
}

export interface ArticleVerificationReport {
  filePath: string;
  articleId?: string;
  status: 'pass' | 'warn' | 'fail';
  extracted: ExtractedArticleClaims;
  imageCount: number;
  missingImages: string[];
  emptyImages: string[];
  doiChecks: DoiCheckResult[];
  arxivChecks: ArxivCheckResult[];
  urlChecks: UrlCheckResult[];
  errors: string[];
  warnings: string[];
}

export interface VerifyOptions {
  offline?: boolean;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  articleId?: string;
}

function cleanTrailingPunctuation(raw: string): string {
  return raw
    .trim()
    .replace(/[)\]}>,.;:!?'"`~，。；：！？、“”‘’）》】」』]+$/g, '');
}

export function extractArticleClaims(markdown: string, filePath = 'article.md'): ExtractedArticleClaims {
  const articleTitle = extractOriginalTitle(markdown, path.basename(filePath));

  const paperTitleMatch = markdown.match(/^[ \t]*(?:[-*]|\>)\s*\*{0,2}(?:论文题目|论文标题|标题|Title)\s*[：:]\*{0,2}\s*(.+)$/im);
  const paperTitle = paperTitleMatch?.[1]?.replace(/\*/g, '').trim();

  const journalMatch = markdown.match(/^[ \t]*(?:[-*]|\>)\s*\*{0,2}(?:论文期刊|期刊|发表期刊|来源|Journal|Source)\s*[：:]\*{0,2}\s*(.+)$/im);
  const journalOrSource = journalMatch?.[1]?.replace(/\*/g, '').trim();

  const authorMatch = markdown.match(/^[ \t]*(?:[-*]|\>)\s*\*{0,2}(?:通讯作者|作者|Authors?)\s*[：:]\*{0,2}\s*(.+)$/im);
  const authors = authorMatch?.[1]?.replace(/\*/g, '').trim();

  const withoutCode = markdown
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '');

  // 提取标准 DOI (支持 doi.org/10.xxx 或文本 10.xxxx/yyy)
  const doiSet = new Set<string>();
  const doiRegex = /(?:https?:\/\/(?:dx\.)?doi\.org\/|\bDOI\s*[：:]\s*|\b)(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = doiRegex.exec(withoutCode)) !== null) {
    const cleaned = cleanTrailingPunctuation(m[1]!);
    // 排除 arXiv 自身被当作独立 arXiv 检查的假前缀以外的合法 DOI（注：10.48550/arXiv.xxx 也是真实有效的 Crossref/DataCite DOI）
    if (cleaned.length > 7 && cleaned.includes('/')) {
      doiSet.add(cleaned);
    }
  }

  // 提取 arXiv ID
  const arxivSet = new Set<string>();
  const arxivRegex = /(?:arXiv\s*[：:]\s*|arxiv\.org\/(?:abs|pdf|html)\/)(\d{4}\.\d{4,5}(?:v\d+)?)/gi;
  while ((m = arxivRegex.exec(withoutCode)) !== null) {
    arxivSet.add(m[1]!);
  }

  // 提取非图片、非 doi.org、非 arxiv.org 重复的原文参考链接
  const urlSet = new Set<string>();
  const urlRegex = /https?:\/\/[^\s<>()[\]"'`，。；：！？）】」』]+/gi;
  while ((m = urlRegex.exec(withoutCode)) !== null) {
    const u = cleanTrailingPunctuation(m[0]!);
    try {
      const parsed = new URL(u);
      const host = parsed.hostname.toLowerCase();
      if (host === 'qpic.cn' || host.endsWith('.qpic.cn')) continue;
      if (host === 'doi.org' || host === 'dx.doi.org') continue;
      if (host === 'arxiv.org' && arxivSet.size > 0) continue;
      urlSet.add(u);
    } catch {}
  }

  return {
    articleTitle,
    paperTitle,
    journalOrSource,
    authors,
    dois: Array.from(doiSet),
    arxivIds: Array.from(arxivSet),
    urls: Array.from(urlSet).slice(0, 6),
  };
}

export function computeTitleSimilarity(claimedTitle: string, resolvedTitle: string): number {
  const tokenize = (s: string) => {
    const cleaned = s
      .replace(/<[^>]+>/g, ' ')
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
      .trim();
    const tokens = cleaned.split(/\s+/).filter(t => t.length >= 2);
    return new Set(tokens);
  };
  const a = tokenize(claimedTitle);
  const b = tokenize(resolvedTitle);
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = new Set([...a, ...b]).size;
  const jaccard = inter / union;
  const recallA = inter / a.size;
  const recallB = inter / b.size;
  return Math.max(jaccard, Math.min(recallA, recallB));
}

async function fetchWithTimeout(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit = {},
  timeoutMs = 10_000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'User-Agent': 'wechat-mp-publisher-skill/1.0 (https://github.com/ruiduobao/wechat-mp-publisher-skill)',
        ...(init.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function verifySingleDoi(
  doi: string,
  claimedPaperTitle: string | undefined,
  options: VerifyOptions = {}
): Promise<DoiCheckResult> {
  const fetchFn = options.fetchFn || fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  try {
    // 1. 优先查询 Crossref 获取真实论文标题与元数据
    const crossrefUrl = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
    const crRes = await fetchWithTimeout(fetchFn, crossrefUrl, { headers: { Accept: 'application/json' } }, timeoutMs);
    if (crRes.status === 200) {
      const data: any = await crRes.json();
      const msg = data?.message;
      const titles: string[] = Array.isArray(msg?.title) ? msg.title : [];
      const resolvedTitle = titles[0] ? String(titles[0]).replace(/\s+/g, ' ').trim() : undefined;
      const publisher = msg?.publisher ? String(msg.publisher) : undefined;

      if (resolvedTitle && claimedPaperTitle) {
        // 如果推文给出的英文题目和 Crossref 标题差距太大，直接抓出假 DOI 或张冠李戴
        const hasAsciiWords = /[a-zA-Z]{3,}/.test(claimedPaperTitle);
        if (hasAsciiWords) {
          const sim = computeTitleSimilarity(claimedPaperTitle, resolvedTitle);
          if (sim < 0.35) {
            return {
              doi,
              valid: false,
              status: 'title-mismatch',
              resolvedTitle,
              titleSimilarity: sim,
              publisher,
              httpStatus: 200,
              message: `DOI 解析论文标题与推文声明不匹配 (相似度 ${(sim * 100).toFixed(0)}%): 实际="${resolvedTitle}" vs 推文="${claimedPaperTitle}"`,
            };
          }
          return {
            doi,
            valid: true,
            status: 'verified',
            resolvedTitle,
            titleSimilarity: sim,
            publisher,
            httpStatus: 200,
            message: `Crossref 验证通过 (相似度 ${(sim * 100).toFixed(0)}%: "${resolvedTitle}")`,
          };
        }
      }

      return {
        doi,
        valid: true,
        status: 'verified',
        resolvedTitle,
        publisher,
        httpStatus: 200,
        message: resolvedTitle ? `Crossref 验证存在: "${resolvedTitle}"` : 'Crossref 验证 DOI 有效',
      };
    }

    // 2. 非 Crossref 注册 DOI (如 Zenodo DataCite / EarthArXiv / Figshare)，通过 doi.org Handles API 验证真实解析
    const handleUrl = `https://doi.org/api/handles/${encodeURIComponent(doi)}`;
    const handleRes = await fetchWithTimeout(fetchFn, handleUrl, { headers: { Accept: 'application/json' } }, timeoutMs);
    if (handleRes.status === 200) {
      const handleJson: any = await handleRes.json().catch(() => ({}));
      if (handleJson?.responseCode === 1) {
        return {
          doi,
          valid: true,
          status: 'verified',
          httpStatus: 200,
          message: 'doi.org Handle 解析存在且有效',
        };
      }
      if (handleJson?.responseCode === 100) {
        return {
          doi,
          valid: false,
          status: 'not-found',
          httpStatus: 404,
          message: `DOI 在 doi.org 不存在 (Handle responseCode=100): ${doi}`,
        };
      }
    }

    // 3. 尝试直接解析 https://doi.org/<doi>
    const directRes = await fetchWithTimeout(fetchFn, `https://doi.org/${encodeURI(doi)}`, { method: 'HEAD', redirect: 'follow' }, timeoutMs);
    if (directRes.status === 404 || directRes.status === 410) {
      return {
        doi,
        valid: false,
        status: 'not-found',
        httpStatus: directRes.status,
        message: `DOI 无效或已失效 (HTTP ${directRes.status}): ${doi}`,
      };
    }
    if (directRes.ok || directRes.status === 403 || directRes.status === 405) {
      return {
        doi,
        valid: true,
        status: 'verified',
        httpStatus: directRes.status,
        message: `doi.org 重定向可达 (HTTP ${directRes.status})`,
      };
    }

    return {
      doi,
      valid: false,
      status: 'network-error',
      httpStatus: directRes.status,
      message: `DOI 核验返回异常状态 (HTTP ${directRes.status})`,
    };
  } catch (err: any) {
    return {
      doi,
      valid: false,
      status: 'network-error',
      message: `DOI 联网核验超时或网络错误: ${err?.message || err}`,
    };
  }
}

export async function verifySingleArxiv(
  arxivId: string,
  claimedPaperTitle: string | undefined,
  options: VerifyOptions = {}
): Promise<ArxivCheckResult> {
  const fetchFn = options.fetchFn || fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const cleanId = arxivId.replace(/v\d+$/i, '');

  try {
    const apiUrl = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(cleanId)}`;
    const res = await fetchWithTimeout(fetchFn, apiUrl, {}, timeoutMs);
    if (!res.ok) {
      return {
        arxivId,
        valid: false,
        status: 'network-error',
        message: `arXiv API 请求返回 HTTP ${res.status}`,
      };
    }
    const xml = await res.text();
    const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/i);
    const entryBody = entryMatch?.[1] || '';
    const titleMatch = entryBody.match(/<title>([\s\S]*?)<\/title>/i);
    const resolvedTitle = titleMatch?.[1]?.replace(/\s+/g, ' ').trim();

    if (!resolvedTitle || resolvedTitle.toLowerCase() === 'error') {
      return {
        arxivId,
        valid: false,
        status: 'not-found',
        message: `arXiv 编号在官方库不存在: arXiv:${arxivId}`,
      };
    }

    if (claimedPaperTitle && /[a-zA-Z]{3,}/.test(claimedPaperTitle)) {
      const sim = computeTitleSimilarity(claimedPaperTitle, resolvedTitle);
      if (sim < 0.35) {
        return {
          arxivId,
          valid: false,
          status: 'title-mismatch',
          resolvedTitle,
          titleSimilarity: sim,
          message: `arXiv 标题与推文声明不匹配 (相似度 ${(sim * 100).toFixed(0)}%): 实际="${resolvedTitle}" vs 推文="${claimedPaperTitle}"`,
        };
      }
      return {
        arxivId,
        valid: true,
        status: 'verified',
        resolvedTitle,
        titleSimilarity: sim,
        message: `arXiv 验证通过 (相似度 ${(sim * 100).toFixed(0)}%: "${resolvedTitle}")`,
      };
    }

    return {
      arxivId,
      valid: true,
      status: 'verified',
      resolvedTitle,
      message: `arXiv 验证存在: "${resolvedTitle}"`,
    };
  } catch (err: any) {
    return {
      arxivId,
      valid: false,
      status: 'network-error',
      message: `arXiv 联网核验失败: ${err?.message || err}`,
    };
  }
}

export async function verifySingleUrl(url: string, options: VerifyOptions = {}): Promise<UrlCheckResult> {
  const fetchFn = options.fetchFn || fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;
  try {
    let res = await fetchWithTimeout(fetchFn, url, { method: 'HEAD', redirect: 'follow' }, timeoutMs);
    if (res.status === 405 || res.status === 501) {
      res = await fetchWithTimeout(fetchFn, url, { method: 'GET', redirect: 'follow' }, timeoutMs);
    }
    if (res.ok) {
      return { url, status: 'ok', httpStatus: res.status, message: `HTTP ${res.status} 可访问` };
    }
    if (res.status === 404 || res.status === 410) {
      return { url, status: 'dead', httpStatus: res.status, message: `链接失效 HTTP ${res.status}` };
    }
    if (res.status === 403 || res.status === 429) {
      return { url, status: 'blocked', httpStatus: res.status, message: `站方限制/反爬 HTTP ${res.status}，建议浏览器核实` };
    }
    return { url, status: 'network-error', httpStatus: res.status, message: `HTTP ${res.status}` };
  } catch (err: any) {
    return { url, status: 'network-error', message: `连接异常: ${err?.message || err}` };
  }
}

export async function verifyArticleTruth(filePath: string, options: VerifyOptions = {}): Promise<ArticleVerificationReport> {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!fs.existsSync(filePath)) {
    throw new Error(`找不到源文件: ${filePath}`);
  }
  const markdown = fs.readFileSync(filePath, 'utf-8');
  const baseDir = path.dirname(filePath);
  const extracted = extractArticleClaims(markdown, filePath);

  // 1. 本地结构与幻觉/残余检查
  const hasH1 = /^#\s+\S+/m.test(markdown);
  if (!hasH1) errors.push('正文缺少一级标题 (# 原标题)');
  if (markdown.replace(/\s+/g, '').length < 200) warnings.push('文章正文过短 (<200字)，请确认内容是否完整');
  if (/WECHATIMGPH_\d+|⟦_anchor_ph_|\[TODO\]|待补充/i.test(markdown)) {
    errors.push('源文件中发现未完成的占位符或 TODO 标记');
  }

  // 2. 本地图片存在性与非空校验
  const imgReport = verifyImagesIntegrity(markdown, baseDir);
  const emptyImages: string[] = [];
  for (const img of imgReport.images) {
    if (img.size === 0) emptyImages.push(img.path);
  }
  if (imgReport.missingPaths.length > 0) {
    errors.push(`缺失本地图片 (${imgReport.missingPaths.length}张): ${imgReport.missingPaths.join(', ')}`);
  }
  if (emptyImages.length > 0) {
    errors.push(`存在 0 字节损坏图片 (${emptyImages.length}张): ${emptyImages.join(', ')}`);
  }

  // 3. 在线学术核验 (DOI / arXiv / 原文链接)
  let doiChecks: DoiCheckResult[] = [];
  let arxivChecks: ArxivCheckResult[] = [];
  let urlChecks: UrlCheckResult[] = [];

  if (!options.offline) {
    const [dois, arxivs, urls] = await Promise.all([
      Promise.all(extracted.dois.map(d => verifySingleDoi(d, extracted.paperTitle, options))),
      Promise.all(extracted.arxivIds.map(a => verifySingleArxiv(a, extracted.paperTitle, options))),
      Promise.all(extracted.urls.map(u => verifySingleUrl(u, options))),
    ]);
    doiChecks = dois;
    arxivChecks = arxivs;
    urlChecks = urls;

    for (const d of doiChecks) {
      if (d.status === 'not-found' || d.status === 'title-mismatch') {
        errors.push(d.message);
      } else if (d.status === 'network-error') {
        warnings.push(`DOI 联网核验未完成 (${d.doi}): ${d.message}`);
      }
    }
    for (const a of arxivChecks) {
      if (a.status === 'not-found' || a.status === 'title-mismatch') {
        errors.push(a.message);
      } else if (a.status === 'network-error') {
        warnings.push(`arXiv 联网核验未完成 (${a.arxivId}): ${a.message}`);
      }
    }
    for (const u of urlChecks) {
      if (u.status === 'dead') {
        errors.push(`原文链接失效 (${u.url}): ${u.message}`);
      } else if (u.status === 'blocked' || u.status === 'network-error') {
        warnings.push(`原文链接未能自动确认 (${u.url}): ${u.message}`);
      }
    }
  }

  if (extracted.dois.length === 0 && extracted.arxivIds.length === 0 && extracted.urls.length === 0) {
    warnings.push('文章未提供任何 DOI、arXiv 编号或原文链接，建议联网搜索核实论文/事件真实性');
  }

  const status: ArticleVerificationReport['status'] =
    errors.length > 0 ? 'fail' : warnings.length > 0 ? 'warn' : 'pass';

  return {
    filePath,
    articleId: options.articleId,
    status,
    extracted,
    imageCount: imgReport.images.length,
    missingImages: imgReport.missingPaths,
    emptyImages,
    doiChecks,
    arxivChecks,
    urlChecks,
    errors,
    warnings,
  };
}

async function main() {
  const args = process.argv.slice(2);
  let targetId: string | undefined;
  let search: string | undefined;
  let latest: number | undefined;
  let offline = false;
  let checkAll = false;
  let fileArg: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--help' || a === '-h') {
      console.log(`
微信公众号推文源真实性与 DOI/论文核验工具

用法:
  bun run scripts/verify-article.ts [选项]

选项:
  --id <articleId>     核验指定文章 ID
  --file <path.md>     直接核验指定 Markdown 文件
  --latest [N]         核验最新 N 篇文章 (默认 1 篇)
  --search <keyword>   按关键词搜索并核验匹配文章
  --all                核验全部源文章 (默认仅核验待处理/未入库文章)
  --offline            仅执行本地结构、占位符与图片核验，不发网络请求
  -h, --help           显示帮助
`.trim());
      process.exit(0);
    } else if (a === '--id') targetId = args[++i];
    else if (a === '--file') fileArg = args[++i];
    else if (a === '--search') search = args[++i];
    else if (a === '--offline') offline = true;
    else if (a === '--all') checkAll = true;
    else if (a === '--latest') {
      if (i + 1 < args.length && !args[i + 1]!.startsWith('--')) {
        latest = parseInt(args[++i]!, 10);
      } else {
        latest = 1;
      }
    }
  }

  if (fileArg) {
    const rep = await verifyArticleTruth(path.resolve(fileArg), { offline });
    console.log(JSON.stringify(rep, null, 2));
    process.exit(rep.status === 'fail' ? 1 : 0);
  }

  const catalog = computeStateCatalog({ dryRun: true, targetId });
  let targets = catalog.articles.filter(a => a.fullPath && fs.existsSync(a.fullPath));

  if (targetId) {
    targets = targets.filter(a => a.id === targetId);
  } else if (search) {
    const kw = search.toLowerCase();
    targets = targets.filter(a => a.id.toLowerCase().includes(kw) || a.file.toLowerCase().includes(kw) || a.title.toLowerCase().includes(kw));
  } else if (latest) {
    targets = targets
      .map(a => ({ a, mtime: fs.statSync(a.fullPath).mtimeMs }))
      .sort((x, y) => y.a.batch.localeCompare(x.a.batch) || y.mtime - x.mtime)
      .slice(0, latest)
      .map(x => x.a);
  } else if (!checkAll) {
    // 默认核查所有未入库、未验收或源内容发生变动的待同步文章
    targets = targets.filter(a =>
      !a.appmsgid ||
      !a.verification?.verified ||
      a.pendingContentUpdate ||
      (a.appliedFingerprint && a.observedFingerprint && a.appliedFingerprint.compositeHash !== a.observedFingerprint.compositeHash)
    );
  }

  console.log(`[verify-article] 待核查文章数: ${targets.length} 篇 (${offline ? '离线结构检查' : '在线DOI/arXiv/链接+本地检查'})`);
  if (targets.length === 0) {
    console.log('[verify-article] 当前无待同步/待核查推文。');
    process.exit(0);
  }

  let failCount = 0;
  let warnCount = 0;

  for (const t of targets) {
    const rep = await verifyArticleTruth(t.fullPath, { offline, articleId: t.id });
    const icon = rep.status === 'pass' ? '✅ PASS' : rep.status === 'warn' ? '⚠️ WARN' : '❌ FAIL';
    console.log(`\n----------------------------------------------------------------`);
    console.log(`${icon} [${t.id}] ${rep.extracted.articleTitle}`);
    console.log(`  图片: ${rep.imageCount} 张 (缺失: ${rep.missingImages.length}, 空文件: ${rep.emptyImages.length})`);
    if (rep.extracted.paperTitle) console.log(`  论文题目: ${rep.extracted.paperTitle}`);
    for (const d of rep.doiChecks) console.log(`  [DOI] ${d.doi} -> ${d.status}: ${d.message}`);
    for (const a of rep.arxivChecks) console.log(`  [arXiv] ${a.arxivId} -> ${a.status}: ${a.message}`);
    for (const u of rep.urlChecks) console.log(`  [URL] ${u.url} -> ${u.status}: ${u.message}`);
    for (const e of rep.errors) console.error(`  ❌ 错误: ${e}`);
    for (const w of rep.warnings) console.warn(`  ⚠️ 警告: ${w}`);

    if (rep.status === 'fail') failCount++;
    else if (rep.status === 'warn') warnCount++;
  }

  console.log(`\n================================================================`);
  console.log(`[verify-article] 核查汇总: 总计 ${targets.length} 篇 | 通过 ${targets.length - failCount - warnCount} | 警告 ${warnCount} | 拦截失败 ${failCount}`);
  console.log(`================================================================`);

  process.exit(failCount > 0 ? 1 : 0);
}

if (import.meta.main) {
  main().catch(err => {
    console.error('[verify-article] 异常:', err);
    process.exit(1);
  });
}
