/**
 * scripts/article-content.ts
 * 微信公众号新文/变更文章渲染与 ProseMirror 编辑器内容/本地图片上传核心模块 (返工强化版)
 *
 * 核心架构准则与职责：
 * 1. 【安全隔离与纯净缓存】：严禁向源目录 (如 F/Z 盘源推文目录) 写入任何文件或临时转换；
 *    所有中间渲染与临时加工严格在专用 cache 或系统临时目录中完成，提供自动 cleanup 清理。
 * 2. 【代码块保护与深层括号/空格路径解析】：
 *    - 保护围栏代码块 (```...```) 与行内代码 (`...`)，代码示例中的图片语法绝不被误替换；
 *    - 基于括号平衡深度解析带空格与嵌套括号的路径 (如 foo(1).png, <my folder/pic 1.png>)；
 *    - 重写后的绝对路径统一添加 <...> 保护，彻底解决 markdown-it / CommonMark renderer 路径截断问题。
 * 3. 【正文排版与元数据规整】：
 *    - 保留元数据引用块非字段行的合法 trailing two spaces 硬换行；
 *    - 仅对元数据字段行加独立 <br />；
 *    - 剥离正文首行顶级 H1 (由 A 模块统一插入)；
 *    - 外层 title / author 不在此模块修改。
 * 4. 【ProseMirror 事务模型注入与占位符入模复核】：
 *    - 使用 editor 全选与 execCommand('insertHTML') 替换旧文，拒绝暴力 DOM innerHTML 与 Range.deleteContents；
 *    - 注入后深度校验所有目标占位符集合确实全部进入模型，杜绝假成功；
 *    - 统一通过 evaluatePage 执行，严格捕获并抛出 exceptionDetails。
 * 5. 【逐图目标区精确定位与增量关联 (彻底消除全局 Fallback)】：
 *    - 在目标占位符插入唯一锚点，并对现存图片做 DOM 节点快照；
 *    - 仅在锚点目标容器邻近区域检测全新插入的节点，严禁使用 global last fallback；
 *    - 相同图片多次引用逐 occurrence 独立检测，不依赖 unique URL；
 *    - 严格校验 new URL(src).hostname 以 .qpic.cn 结尾 (防伪域欺骗)，并要求 complete === true && naturalWidth > 0。
 * 6. 【严苛编辑态全要素质量门禁 (Zero Defects Guarantee)】：
 *    - 零残余占位符；
 *    - 零未就绪图片 (pending complete=false 严格视作未完成/破损)；
 *    - 零本地/相对/blob/data 路径；
 *    - 零未识别 remote 地址；
 *    - 微信 CDN 图片数量必须精确等于期望总数 (本次上传 + 原稿已有微信 CDN 独立统计)。
 *
 * 代码出处与归属 (Attributions):
 * - 格式探测、大图压缩与 WebP/Jimp 处理管线复用并适配自 scripts/wechat-image-processor.ts (MIT)
 * - 编辑器占位符定位、CDP input 注入、空行消除复用并重构自 scripts/wechat-article.ts (baoyu-chrome-cdp, MIT)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertMarkdown } from './md-to-wechat.ts';
import {
  prepareWechatBodyImageUpload,
  needsWechatBodyImageProcessing,
  type WechatUploadAsset,
} from './wechat-image-processor.ts';
import { BODY_EDITOR_SELECTOR, evaluatePage, escapeHtml, type EditorSession } from './editor-features.ts';
import { assertArticleEditor } from './editor-mode.ts';
import { pasteHtmlNatively } from './editor-input.ts';

// 默认专用缓存目录
export const DEFAULT_CACHE_DIR = 'C:\\Users\\Administrator\\.agents\\skills\\wechat-md-pipeline\\cache';

// -----------------------------------------------------------------------------
// 类型定义 (固定签名，易于给 B 接线与联调)
// -----------------------------------------------------------------------------
export interface ContentImageItem {
  placeholder: string;
  localPath: string;
  originalPath: string;
  alt?: string;
}

export interface RenderArticleOptions {
  cacheRoot?: string;
  theme?: string;
  color?: string;
  citeStatus?: boolean;
}

export interface RenderArticleResult {
  html: string;
  images: ContentImageItem[];
  existingCdnImages: string[];
  summary: string;
  title: string;
  author: string;
  cleanup: () => void;
}

export interface ApplyArticleContentOptions {
  timeoutMs?: number;
  uploadTimeoutMs?: number;
  expectedTitle?: string;
}

export interface ApplyArticleEvidence {
  ok: boolean;
  insertedImagesCount: number;
  expectedImagesCount: number;
  cdnImagesCount: number;
  existingCdnCount: number;
  residualPlaceholders: string[];
  brokenImages: string[];
  localImagesRemaining: string[];
  unrecognizedRemote: string[];
  details: string;
  error?: string;
}

// -----------------------------------------------------------------------------
// 1. 域名与基础路径安全工具
// -----------------------------------------------------------------------------

/**
 * 严格基于 new URL hostname 校验微信官方 CDN 地址 (防 fake-qpic.cn 伪域)
 */
export function wechatImageIdentity(urlStr: string): string {
  if (!isWechatCdnHostname(urlStr)) return urlStr;
  const url = new URL(urlStr);
  url.pathname = url.pathname.replace(/\/(?:0|640)$/, '/display-size');
  return url.toString();
}

export function isWechatCdnHostname(urlStr: string): boolean {
  if (!urlStr) return false;
  try {
    const url = new URL(urlStr);
    const host = url.hostname.toLowerCase();
    return host === 'qpic.cn' || host.endsWith('.qpic.cn');
  } catch {
    return false;
  }
}

/**
 * 安全解码 URI 路径 (避免中文或空格在 URL 编码下无法与本地文件匹配)
 */
export function safeDecodeImagePath(rawPath: string): string {
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return rawPath;
  }
}

/**
 * 判断是否为已有微信 CDN 或网络链接
 */
export function isRemoteOrCdnImageUrl(url: string): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  if (
    trimmed.startsWith('data:') ||
    trimmed.startsWith('blob:') ||
    trimmed.startsWith('WECHATIMGPH_')
  ) {
    return true;
  }
  return isWechatCdnHostname(trimmed) || trimmed.startsWith('http://') || trimmed.startsWith('https://');
}

// -----------------------------------------------------------------------------
// 2. 代码块保护与带空格/括号路径的深层 Markdown 解析
// -----------------------------------------------------------------------------

/**
 * 保护代码块中的内容，防止示例代码中的图片语法被误替换
 */
export function protectCodeBlocks(markdown: string): {
  maskedMarkdown: string;
  restore: (text: string, options?: { escapeImagesInCode?: boolean }) => string;
} {
  const blocks: string[] = [];
  // 1. 保护围栏代码块 ```...``` 或 ~~~...~~~
  let masked = markdown.replace(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g, (match) => {
    const placeholder = `\u0000CODEBLOCK_${blocks.length}\u0000`;
    blocks.push(match);
    return placeholder;
  });

  // 2. 保护行内代码 `...`
  masked = masked.replace(/(`[^`\n]+`)/g, (match) => {
    const placeholder = `\u0000CODEBLOCK_${blocks.length}\u0000`;
    blocks.push(match);
    return placeholder;
  });

  const restore = (text: string, options?: { escapeImagesInCode?: boolean }): string => {
    let restored = text;
    for (let i = 0; i < blocks.length; i++) {
      let blockContent = blocks[i]!;
      if (options?.escapeImagesInCode) {
        // 在代码块内部将 ![ 替换为 !​[ (带零宽不换行空格)，彻底阻断下游转换器将其误提取为图片
        blockContent = blockContent.replace(/!\[/g, '!\u200B[');
      }
      restored = restored.replace(`\u0000CODEBLOCK_${i}\u0000`, blockContent);
    }
    return restored;
  };

  return { maskedMarkdown: masked, restore };
}

export interface ExtractedImageSpan {
  rawMatch: string;
  alt: string;
  rawUrl: string;
  cleanUrl: string;
  isHtml: boolean;
  startIdx: number;
  endIdx: number;
}

/**
 * 基于括号平衡与尖括号深度的可靠 Markdown/HTML 图片扫描器
 * 支持：
 * - ![alt](url)
 * - ![alt](<url with spaces and (brackets)>)
 * - ![alt](path/to/pic(1).png "optional title")
 * - <img src="..." />
 */
export function extractMarkdownImages(text: string): ExtractedImageSpan[] {
  const images: ExtractedImageSpan[] = [];

  // 1. 扫描 HTML <img> 标签
  const htmlImgRegex = /<img\b[^>]*\bsrc=(["'])(.*?)\1[^>]*>/gi;
  let htmlMatch: RegExpExecArray | null;
  while ((htmlMatch = htmlImgRegex.exec(text)) !== null) {
    images.push({
      rawMatch: htmlMatch[0],
      alt: '',
      rawUrl: htmlMatch[2]!,
      cleanUrl: htmlMatch[2]!.trim(),
      isHtml: true,
      startIdx: htmlMatch.index,
      endIdx: htmlMatch.index + htmlMatch[0].length,
    });
  }

  // 2. 扫描 Markdown 图片语法: ![alt](url)
  let i = 0;
  while (i < text.length - 2) {
    if (text[i] === '!' && text[i + 1] === '[') {
      const altStart = i + 2;
      let altEnd = -1;
      let depth = 1;
      let j = altStart;
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === '[') depth++;
        else if (text[j] === ']') {
          depth--;
          if (depth === 0) {
            altEnd = j;
            break;
          }
        }
        j++;
      }

      if (altEnd !== -1 && text[altEnd + 1] === '(') {
        const altText = text.slice(altStart, altEnd);
        const parenStart = altEnd + 1;
        let k = parenStart + 1;
        while (k < text.length && /\s/.test(text[k]!)) k++;

        let rawUrlPart = '';
        let fullParenEnd = -1;

        if (text[k] === '<') {
          // 尖括号语法: <url...>
          const angleStart = k + 1;
          const angleEnd = text.indexOf('>', angleStart);
          if (angleEnd !== -1) {
            rawUrlPart = text.slice(angleStart, angleEnd);
            const closeParenIdx = text.indexOf(')', angleEnd + 1);
            if (closeParenIdx !== -1) {
              fullParenEnd = closeParenIdx;
            }
          }
        } else {
          // 普通语法：平衡圆括号扫描
          let pDepth = 1;
          const urlContentStart = k;
          let inQuotes = false;
          let quoteChar = '';

          while (k < text.length) {
            const ch = text[k];
            if (ch === '\\') {
              k += 2;
              continue;
            }
            if (inQuotes) {
              if (ch === quoteChar) inQuotes = false;
            } else {
              if (ch === '"' || ch === "'") {
                inQuotes = true;
                quoteChar = ch;
              } else if (ch === '(') {
                pDepth++;
              } else if (ch === ')') {
                pDepth--;
                if (pDepth === 0) {
                  fullParenEnd = k;
                  break;
                }
              }
            }
            k++;
          }

          if (fullParenEnd !== -1) {
            const inside = text.slice(urlContentStart, fullParenEnd).trim();
            const titleMatch = inside.match(/\s+["'][\s\S]*["']$/);
            if (titleMatch) {
              rawUrlPart = inside.slice(0, titleMatch.index).trim();
            } else {
              rawUrlPart = inside;
            }
          }
        }

        if (fullParenEnd !== -1) {
          const rawMatch = text.slice(i, fullParenEnd + 1);
          images.push({
            rawMatch,
            alt: altText,
            rawUrl: rawUrlPart,
            cleanUrl: rawUrlPart.trim(),
            isHtml: false,
            startIdx: i,
            endIdx: fullParenEnd + 1,
          });
          i = fullParenEnd + 1;
          continue;
        }
      }
    }
    i++;
  }

  // 按起始索引倒序排序，确保从后往前替换不发生位移错位
  images.sort((a, b) => b.startIdx - a.startIdx);
  return images;
}

/**
 * 预处理 Markdown：
 * 1. 剥离顶级 H1；
 * 2. 规整元数据引用块硬换行 (保留非字段行行尾空格，仅字段行补 <br />)；
 * 3. 保护代码块，提取并转换相对图片为带 <...> 保护的规范绝对路径；
 * 4. 严苛本地图片读前完整性预检。
 */
export function prepareMarkdownWithAbsoluteImages(
  rawMd: string,
  sourceDir: string
): {
  processedMd: string;
  referencedImages: Array<{ original: string; resolvedPath: string }>;
  existingCdnImages: string[];
} {
  let text = rawMd.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 1. 剥离开头顶级标题 H1 (# 标题)，由 A 模块统一接管插入
  text = text.replace(/^#\s+[^\n]*\n+/m, '');

  // 2. 规范化元数据引用块硬换行 (严格保留非字段行末尾两空格等合法换行)
  text = text.replace(/^>[\s\S]*?(?=\n\n|\n[^- >#])/m, (block) => {
    return block
      .split('\n')
      .map((line) => {
        const isFieldLine = /^>\s*\*\*[^*]+\*\*：/.test(line);
        if (isFieldLine) {
          if (!/<br\s*\/?>/i.test(line)) {
            return line.replace(/\s+$/, '') + '<br />';
          }
          return line;
        }
        // 非字段行：绝对不 trimEnd()，原样保留尾部空格
        return line;
      })
      .join('\n');
  });

  // 3. 保护代码块
  const { maskedMarkdown, restore } = protectCodeBlocks(text);

  // 4. 提取非代码块中的所有图片
  const extractedImages = extractMarkdownImages(maskedMarkdown);
  const referencedImages: Array<{ original: string; resolvedPath: string }> = [];
  const existingCdnImages: string[] = [];
  const missingImages: string[] = [];

  let replacedText = maskedMarkdown;

  for (const img of extractedImages) {
    const rawUrl = img.cleanUrl;

    // 检查是否已有微信官方 CDN
    if (isWechatCdnHostname(rawUrl)) {
      existingCdnImages.push(rawUrl);
      continue;
    }

    // 忽略普通远程图片或占位符
    if (isRemoteOrCdnImageUrl(rawUrl)) {
      continue;
    }

    const decoded = safeDecodeImagePath(rawUrl);
    const resolved = path.isAbsolute(decoded)
      ? path.normalize(decoded)
      : path.normalize(path.resolve(sourceDir, decoded));

    referencedImages.push({ original: img.rawUrl, resolvedPath: resolved });

    // 严密文件存在性与大小完整性检查
    if (!fs.existsSync(resolved)) {
      missingImages.push(resolved);
    } else {
      try {
        const stat = fs.statSync(resolved);
        if (!stat.isFile() || stat.size === 0) {
          missingImages.push(`${resolved} (空文件或无效文件)`);
        }
      } catch (err: any) {
        missingImages.push(`${resolved} (${err?.message || '读取错误'})`);
      }
    }

    // 统一正斜杠并进行标准 URL escape (转义空格与括号)，彻底避免被 baoyu-md / CommonMark renderer 截断
    const normalizedSlash = resolved.split(path.sep).join('/');
    const safeEscapedUrl = encodeURI(normalizedSlash).replace(/\(/g, '%28').replace(/\)/g, '%29');
    let replacement: string;
    if (img.isHtml) {
      replacement = img.rawMatch.replace(img.rawUrl, safeEscapedUrl);
    } else {
      replacement = `![${img.alt}](${safeEscapedUrl})`;
    }

    replacedText =
      replacedText.slice(0, img.startIdx) +
      replacement +
      replacedText.slice(img.endIdx);
  }

  // 5. 阻断缺失图片
  if (missingImages.length > 0) {
    const uniqueMissing = Array.from(new Set(missingImages));
    throw new Error(
      `[article-content] 本地图片完整性预检失败，存在 ${uniqueMissing.length} 个缺失或损坏图片: \n${uniqueMissing.join('\n')}`
    );
  }

  // 6. 还原代码块 (开启 escapeImagesInCode 防止下游转换器将代码块内容提取为图片)
  const finalMd = restore(replacedText, { escapeImagesInCode: true });

  return {
    processedMd: finalMd,
    referencedImages,
    existingCdnImages,
  };
}

// -----------------------------------------------------------------------------
// 3. 核心接口 1: renderArticleContent
// -----------------------------------------------------------------------------
/**
 * 渲染文章内容并生成微信就绪 HTML 及待上传图片表
 * - 纯净读源文件，严禁向源目录写任何文件；
 * - 隔离缓存渲染，自动将相对图片转为带尖括号保护的绝对路径；
 * - 返回 cleanup 回调安全清理临时转换文件。
 */
export async function renderArticleContent(
  sourcePath: string,
  cacheRootOrOptions?: string | RenderArticleOptions
): Promise<RenderArticleResult> {
  const resolvedSourcePath = path.resolve(sourcePath);
  if (!fs.existsSync(resolvedSourcePath)) {
    throw new Error(`[article-content] 源文件不存在: ${resolvedSourcePath}`);
  }

  let options: RenderArticleOptions = {};
  if (typeof cacheRootOrOptions === 'string') {
    options = { cacheRoot: cacheRootOrOptions };
  } else if (cacheRootOrOptions) {
    options = cacheRootOrOptions;
  }

  const cacheRoot = options.cacheRoot || (fs.existsSync(DEFAULT_CACHE_DIR) ? DEFAULT_CACHE_DIR : os.tmpdir());
  if (!fs.existsSync(cacheRoot)) {
    fs.mkdirSync(cacheRoot, { recursive: true });
  }

  const theme = options.theme || 'grace';
  const color = options.color || '#0052ff';
  const citeStatus = options.citeStatus ?? true;

  const rawMd = fs.readFileSync(resolvedSourcePath, 'utf-8');
  const sourceDir = path.dirname(resolvedSourcePath);

  // 执行安全预检、代码块隔离并规整相对路径为绝对路径
  const { processedMd, existingCdnImages } = prepareMarkdownWithAbsoluteImages(rawMd, sourceDir);

  // 创建临时 Markdown 转换文件
  const tempId = `temp_render_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tempMdPath = path.join(cacheRoot, `${tempId}.md`);
  fs.writeFileSync(tempMdPath, processedMd, 'utf-8');

  let generatedHtmlPath: string | null = null;
  const tempFilesToClean: string[] = [tempMdPath];

  try {
    const parsed = await convertMarkdown(tempMdPath, {
      theme,
      color,
      citeStatus,
    });
    generatedHtmlPath = parsed.htmlPath;
    if (generatedHtmlPath) {
      tempFilesToClean.push(generatedHtmlPath);
      const htmlDir = path.dirname(generatedHtmlPath);
      if (htmlDir.includes('wechat-article-images-')) {
        tempFilesToClean.push(htmlDir);
      }
    }

    let html = fs.readFileSync(parsed.htmlPath, 'utf-8');

    // 清除零宽保护符并清理无用空段落标签
    html = html.replace(/\u200B/g, '');
    html = html.replace(/<p>\s*(<br\s*\/?>|&nbsp;|\s*)*<\/p>/gi, '');
    html = html.replace(/<div>\s*(<br\s*\/?>|&nbsp;|\s*)*<\/div>/gi, '');

    // 图片二次存在性确认
    const contentImages: ContentImageItem[] = (parsed.contentImages || []).map((img) => ({
      placeholder: img.placeholder,
      localPath: img.localPath,
      originalPath: img.originalPath,
      alt: img.alt,
    }));

    for (const item of contentImages) {
      if (!fs.existsSync(item.localPath)) {
        throw new Error(`[article-content] 转换器输出的本地图片未就绪: ${item.localPath}`);
      }
    }

    const cleanup = () => {
      for (const itemPath of tempFilesToClean) {
        try {
          if (fs.existsSync(itemPath)) {
            const stat = fs.statSync(itemPath);
            if (stat.isDirectory()) {
              fs.rmSync(itemPath, { recursive: true, force: true });
            } else {
              fs.unlinkSync(itemPath);
            }
          }
        } catch {}
      }
    };

    return {
      html,
      images: contentImages,
      existingCdnImages,
      summary: parsed.summary || '',
      title: parsed.title || '',
      author: parsed.author || '',
      cleanup,
    };
  } catch (err: any) {
    try { fs.unlinkSync(tempMdPath); } catch {}
    throw err;
  }
}

// -----------------------------------------------------------------------------
// 4. 图片格式与尺寸合规化 (严格通过 WechatUploadAsset 类型检查)
// -----------------------------------------------------------------------------
function inferImageContentType(imagePath: string): string {
  const ext = path.extname(imagePath).toLowerCase();
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.bmp':
      return 'image/bmp';
    default:
      return 'application/octet-stream';
  }
}

async function prepareImageForWechatUpload(imagePath: string): Promise<{
  uploadPath: string;
  cleanup: () => void;
}> {
  const absolutePath = path.resolve(imagePath);
  const buffer = fs.readFileSync(absolutePath);
  const asset: WechatUploadAsset = {
    buffer,
    filename: path.basename(absolutePath),
    contentType: inferImageContentType(absolutePath),
    fileExt: path.extname(absolutePath).toLowerCase(),
    fileSize: buffer.length,
  };

  if (!needsWechatBodyImageProcessing(asset)) {
    return { uploadPath: absolutePath, cleanup: () => {} };
  }

  const processed = await prepareWechatBodyImageUpload(asset);
  if (!processed.wasProcessed) {
    return { uploadPath: absolutePath, cleanup: () => {} };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-proc-img-'));
  const uploadPath = path.join(tempDir, processed.filename);
  fs.writeFileSync(uploadPath, processed.buffer);

  return {
    uploadPath,
    cleanup: () => {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    },
  };
}

// -----------------------------------------------------------------------------
// 5. 编辑器操作：ProseMirror 模型注入与占位符精准定位
// -----------------------------------------------------------------------------

export interface EditorFocusedResult {
  activeTag: string;
  isFocused: boolean;
  isContentEditable: boolean;
  hasFocus: boolean;
  rect?: { x: number; y: number; width: number; height: number };
}

/**
 * 确保微信公众号正文编辑器处于前台激活、完成 ProseMirror 异步初始化 (isContentEditable===true)、
 * 且真实物理焦点位于 contenteditable 区域
 */
export async function ensureEditorFocusedAndActive(
  session: EditorSession,
  timeoutMs = 15_000
): Promise<EditorFocusedResult> {
  await assertArticleEditor(session, timeoutMs);

  // 1. Browser 级别激活目标标签页 (不带 sessionId，若提供 targetId 则必须成功执行)
  if (session.targetId) {
    await session.cdp.send('Target.activateTarget', { targetId: session.targetId });
    await new Promise((r) => setTimeout(r, 100));
  }

  // 2. Page 级别将页面推到前台
  await session.cdp.send('Page.bringToFront', {}, { sessionId: session.sessionId }).catch(() => {});

  // 3. 启用 CDP Emulation 焦点模拟，确保在 OS 后台窗口下 document.hasFocus() 为 true
  await session.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, { sessionId: session.sessionId }).catch(() => {});

  const startTime = Date.now();
  let lastDiag: any = null;

  // 4. 轮询等待编辑器从页面异步初始化就绪 (解决微信后台前数秒 isContentEditable=false 问题)
  while (Date.now() - startTime < timeoutMs) {
    interface DiagCheck {
      found: boolean;
      visibleCount: number;
      tagName?: string;
      isContentEditable?: boolean;
      display?: string;
      visibility?: string;
      hasFocus?: boolean;
      activeTag?: string;
      rect?: { x: number; y: number; width: number; height: number } | null;
      clickPoint?: { x: number; y: number };
      hitTag?: string;
      isEditorHit?: boolean;
    }

    const check = await evaluatePage<DiagCheck>(
      session,
      `
        (function() {
          const target = document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)});
          if (!target) return { found: false, visibleCount: 0 };

          target.scrollIntoView({ block: 'start', inline: 'nearest' });
          const targetRect = target.getBoundingClientRect();
          const left = Math.max(0, targetRect.left);
          const right = Math.min(innerWidth, targetRect.right);
          const top = Math.max(100, targetRect.top);
          const bottom = Math.min(innerHeight - 80, targetRect.bottom);
          const clickX = right > left ? Math.round(left + Math.min(60, (right - left) / 2)) : 0;
          const clickY = bottom > top ? Math.round(top + Math.min(60, (bottom - top) / 2)) : 0;
          const hitEl = (clickX > 0 && clickY > 0) ? document.elementFromPoint(clickX, clickY) : null;
          const isEditorHit = !!hitEl && (hitEl === target || target.contains(hitEl));
          const active = document.activeElement;
          const activeTag = active ? (active.tagName + '#' + (active.id || '')) : '(none)';

          return {
            found: true,
            visibleCount: 1,
            tagName: target.tagName,
            isContentEditable: target.isContentEditable,
            display: window.getComputedStyle(target).display,
            visibility: window.getComputedStyle(target).visibility,
            hasFocus: document.hasFocus(),
            activeTag,
            rect: targetRect && targetRect.width > 0 ? {
              x: targetRect.x,
              y: targetRect.y,
              width: targetRect.width,
              height: targetRect.height
            } : null,
            clickPoint: isEditorHit ? { x: clickX, y: clickY } : null,
            isEditorHit,
            hitTag: hitEl ? (hitEl.tagName + '#' + (hitEl.id || '')) : '(none)'
          };
        })()
      `
    );

    lastDiag = check;

    // 只要 isContentEditable 就绪，结合可用 clickPoint 进行真实物理点击
    if (check && check.found && check.isContentEditable && check.clickPoint) {
      const clickX = check.clickPoint.x;
      const clickY = check.clickPoint.y;

      if (clickX > 0 && clickY > 0 && clickX < 2500 && clickY < 2500) {
        await session.cdp.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: clickX,
          y: clickY,
          button: 'left',
          clickCount: 1,
        }, { sessionId: session.sessionId });

        await new Promise((r) => setTimeout(r, 40));

        await session.cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: clickX,
          y: clickY,
          button: 'left',
          clickCount: 1,
        }, { sessionId: session.sessionId });

        await new Promise((r) => setTimeout(r, 120));
      }

      // 核验点击后的真实聚焦状态
      interface FocusConfirm {
        hasFocus: boolean;
        isFocused: boolean;
        activeTag: string;
      }

      const confirm = await evaluatePage<FocusConfirm>(
        session,
        `
          (function() {
            const editor = document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)});
            if (!editor) return { hasFocus: false, isFocused: false, activeTag: '(none)' };

            editor.focus();
            const active = document.activeElement;
            const hasFocus = document.hasFocus();
            // 真实严格核验：焦点必须真正在 editor 或其子节点内部，绝不用 selection 冒充，绝无 || true 假通过
            const isFocused = !!active && (active === editor || editor.contains(active));
            const activeTag = active ? (active.tagName + '#' + (active.id || '')) : '(none)';

            return { hasFocus, isFocused, activeTag };
          })()
        `
      );

      // 必须同时严格满足 document.hasFocus() 为真且 activeElement 确凿位于编辑器内部
      if (confirm && confirm.hasFocus && confirm.isFocused) {
        return {
          activeTag: confirm.activeTag,
          isFocused: true,
          isContentEditable: true,
          hasFocus: true,
          rect: check.rect,
        };
      }
    }

    await new Promise((r) => setTimeout(r, 400));
  }

  // 严格抛出真实诊断，绝不硬报 isFocused: true
  const reason = lastDiag
    ? `isContentEditable=${lastDiag.isContentEditable}, hasFocus=${lastDiag.hasFocus}, activeTag=${lastDiag.activeTag}, hitTag=${lastDiag.hitTag}, visibleCount=${lastDiag.visibleCount}`
    : '编辑器未能在超时内就绪';
  throw new Error(`[article-content] 正文编辑器聚焦就绪超时 (${timeoutMs}ms): ${reason}`);
}

/**
 * 注入 HTML 进入 ProseMirror 模型 (选区覆盖事务注入，复核占位符集合确实进入 model)
 */
export async function injectHtmlIntoProseMirror(
  session: EditorSession,
  html: string,
  contentImages: ContentImageItem[],
  originalTitle?: string
): Promise<void> {
  const replacements = contentImages.map((img) => ({
    placeholder: img.placeholder,
    localPath: img.localPath,
  }));
  const expectedPlaceholders = contentImages.map((img) => img.placeholder);

  // 1. 前置严密校验：待注入的 HTML 自身必须完整包含所有 contentImages 的占位符
  // 避免渲染转换阶段因模板/样式清洗导致占位符源头丢失，却被误判为页面选区或焦点问题
  const missingInHtml = expectedPlaceholders.filter((ph) => !html.includes(ph));
  if (missingInHtml.length > 0) {
    throw new Error(
      `[article-content] 渲染输出的 HTML 自身缺少待注入占位符 (${missingInHtml.length}个): ${missingInHtml.join(', ')}。请排查 Markdown 转换阶段是否丢失占位符！`
    );
  }

  // 2. 前置调用真实前台激活与物理点击定位，确保焦点脱离 BODY# 真正进入 .ProseMirror
  await ensureEditorFocusedAndActive(session);

  const preparedHtml = await evaluatePage<string>(session, `(() => {
    const template = document.createElement('template');
    template.innerHTML = ${JSON.stringify(html)};
    const replacements = ${JSON.stringify(replacements)};
    for (const img of Array.from(template.content.querySelectorAll('img'))) {
      const rep = replacements.find(r => r.placeholder === img.getAttribute('src') || r.localPath === img.getAttribute('data-local-path'));
      if (rep) img.replaceWith(document.createTextNode(rep.placeholder));
    }
    const output = template.content.querySelector('#output');
    const wrapper = document.createElement('div');
    wrapper.appendChild(output ? output.cloneNode(true) : template.content.cloneNode(true));
    const titleHtml = ${JSON.stringify(originalTitle ? `<h1>${escapeHtml(originalTitle)}</h1>` : '')};
    if (titleHtml) wrapper.insertAdjacentHTML('afterbegin', titleHtml);
    return wrapper.innerHTML;
  })()`);
  const result = await pasteHtmlNatively(session, preparedHtml);
  const missing = expectedPlaceholders.filter(ph => !result.actualText.includes(ph));
  if (missing.length) throw new Error(`[article-content] 原生粘贴后丢失占位符: ${missing.join(', ')}`);
  const normalize = (text: string) => text.replace(/[\s\u200B-\u200D\uFEFF]/g, '');
  if (!normalize(result.expectedText) || normalize(result.expectedText) !== normalize(result.actualText)) {
    throw new Error('[article-content] 原生粘贴后正文与渲染内容不一致，未保存');
  }
}

/**
 * 在 ProseMirror 编辑器中查找占位符并精准建立锚点，记录上传前现存图片快照
 */
export async function locatePlaceholderAndSetAnchor(
  session: EditorSession,
  placeholder: string,
  anchorId: string
): Promise<boolean> {
  const selected = await evaluatePage<{ expectedText: string } | null>(session, `(() => {
    const editor = document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)});
    if (!editor) return null;
    const target = ${JSON.stringify(placeholder)};
    const marker = ${JSON.stringify(`⟦${anchorId}⟧`)};
    const text = editor.textContent || '';
    const indices = [];
    for (let offset = 0; offset < text.length;) {
      const index = text.indexOf(target, offset);
      if (index < 0) break;
      if (!/\\d/.test(text[index + target.length] || '')) indices.push(index);
      offset = index + target.length;
    }
    if (indices.length !== 1 || text.includes(marker)) return null;
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      for (let offset = 0; offset < node.textContent.length;) {
        const index = node.textContent.indexOf(target, offset);
        if (index < 0) break;
        offset = index + target.length;
        if (/\\d/.test(node.textContent[index + target.length] || '')) continue;
        node.parentElement.scrollIntoView({ block: 'center' }); editor.focus();
        const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + target.length);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        window[${JSON.stringify(anchorId)}] = { oldImages: new Set(editor.querySelectorAll('img')) };
        return { expectedText: text.slice(0, indices[0]) + marker + text.slice(indices[0] + target.length) };
      }
    }
    return null;
  })()`);
  if (!selected) return false;
  await new Promise(resolve => setTimeout(resolve, 150));
  const selectionReady = await evaluatePage<boolean>(session, `(() => {
    const editor = document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)});
    const selection = getSelection();
    return !!editor && document.activeElement === editor && !!selection &&
      editor.contains(selection.anchorNode) && editor.contains(selection.focusNode) &&
      selection.toString() === ${JSON.stringify(placeholder)};
  })()`);
  if (!selectionReady) {
    await evaluatePage(session, `delete window[${JSON.stringify(anchorId)}]`);
    return false;
  }
  await session.cdp.send('Input.insertText', { text: `⟦${anchorId}⟧` }, { sessionId: session.sessionId });
  await new Promise(resolve => setTimeout(resolve, 150));
  const replaced = await evaluatePage<boolean>(session, `document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)})?.textContent === ${JSON.stringify(selected.expectedText)}`);
  if (!replaced) {
    await evaluatePage(session, `delete window[${JSON.stringify(anchorId)}]`);
    throw new Error(`[article-content] 占位符未被原生输入准确替换: ${placeholder}，已停止该篇`);
  }
  return true;
}

/** Only accept a new, loaded image in the marker block or its immediately following image block. */
export async function waitForTargetImageLoaded(
  session: EditorSession,
  anchorId: string,
  timeoutMs = 40_000
): Promise<{ ok: boolean; src?: string; error?: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await evaluatePage<{ ok: boolean; reason?: string; src?: string }>(session, `(() => {
      const editor = document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)});
      const evidence = window[${JSON.stringify(anchorId)}];
      if (!editor || !evidence) return { ok: false, reason: 'anchor-missing' };
      const marker = ${JSON.stringify(`⟦${anchorId}⟧`)};
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      let node; let anchor;
      while ((node = walker.nextNode())) if (node.textContent.includes(marker)) { anchor = node.parentElement; break; }
      if (!anchor) return { ok: false, reason: 'anchor-missing' };
      const block = anchor.closest('p, section, div');
      const candidates = Array.from(block?.querySelectorAll('img:not(.ProseMirror-separator)') || []);
      const next = block?.nextElementSibling;
      if (next && !next.textContent.trim()) candidates.push(...next.querySelectorAll('img:not(.ProseMirror-separator)'));
      const candidate = candidates.find(img => !evidence.oldImages.has(img));
      if (!candidate) return { ok: false, reason: 'waiting-new-node' };
      const src = candidate.getAttribute('src') || '';
      let valid = false;
      try { const url = new URL(src); valid = ['https:', 'http:'].includes(url.protocol) && (url.hostname === 'qpic.cn' || url.hostname.endsWith('.qpic.cn')); } catch {}
      if (!valid || !candidate.complete || !candidate.naturalWidth || !candidate.naturalHeight) return { ok: false, reason: 'loading' };
      return { ok: true, src };
    })()`);
    if (state?.ok) {
      const selected = await evaluatePage<boolean>(session, `(() => {
        const editor = document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)});
        const marker = ${JSON.stringify(`⟦${anchorId}⟧`)};
        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT); let node;
        while ((node = walker.nextNode())) {
          const index = node.textContent.indexOf(marker); if (index < 0) continue;
          editor.focus(); const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + marker.length);
          const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); return true;
        }
        return false;
      })()`);
      if (!selected) throw new Error('[article-content] 上传后定位标记丢失，未保存');
      await new Promise(resolve => setTimeout(resolve, 150));
      await session.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, { sessionId: session.sessionId });
      await session.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, { sessionId: session.sessionId });
      await new Promise(resolve => setTimeout(resolve, 150));
      const markerRemoved = await evaluatePage<boolean>(session, `!document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)}).textContent.includes(${JSON.stringify(`⟦${anchorId}⟧`)})`);
      if (!markerRemoved) throw new Error('[article-content] 图片定位标记未被编辑器删除，未保存');
      await evaluatePage(session, `delete window[${JSON.stringify(anchorId)}]`);
      return { ok: true, src: state.src };
    }
    await new Promise(resolve => setTimeout(resolve, 600));
  }
  return { ok: false, error: `等待目标微信 CDN 图片就绪超时 (${timeoutMs}ms)` };
}

/**
 * 上传图片后消除微信编辑器多余生成的空行
 */
export async function removeExtraEmptyLineAfterImage(session: EditorSession): Promise<boolean> {
  const result = await evaluatePage<boolean>(
    session,
    `
      (function() {
        const editor = document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)});
        if (!editor) return false;

        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return false;

        let node = sel.anchorNode;
        if (!node) return false;
        let element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        if (!element || !editor.contains(element)) return false;

        const isEmptyParagraph = (el) => {
          if (!el || el.tagName !== 'P') return false;
          const text = (el.textContent || '').trim();
          if (text.length > 0) return false;
          return el.querySelectorAll('img, figure, video, iframe').length === 0;
        };

        const hasImage = (el) => {
          if (!el) return false;
          return !!el.querySelector('img, figure img, picture img');
        };

        const placeCursorAfter = (el) => {
          if (!el) return;
          const range = document.createRange();
          range.setStartAfter(el);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        };

        const emptyPara = element.closest('p');
        if (emptyPara && editor.contains(emptyPara) && isEmptyParagraph(emptyPara)) {
          const prev = emptyPara.previousElementSibling;
          if (prev && hasImage(prev)) {
            emptyPara.remove();
            placeCursorAfter(prev);
            return true;
          }
        }

        const imageBlock = element.closest('figure, p');
        if (imageBlock && editor.contains(imageBlock) && hasImage(imageBlock)) {
          const next = imageBlock.nextElementSibling;
          if (next && isEmptyParagraph(next)) {
            next.remove();
            placeCursorAfter(imageBlock);
            return true;
          }
        }

        return false;
      })()
    `
  );

  return Boolean(result);
}

/**
 * 上传完成后进行严密编辑态质量复查 (完全禁止 pending、非 CDN、残余占位符)
 */
export async function inspectEditorPostContent(session: EditorSession): Promise<{
  ok: boolean;
  residualPlaceholders: string[];
  brokenImages: string[];
  localImagesRemaining: string[];
  unrecognizedRemote: string[];
  cdnImagesCount: number;
  totalImagesCount: number;
}> {
  interface InspectRaw {
    ok: boolean;
    residualPlaceholders: string[];
    brokenImages: string[];
    localImagesRemaining: string[];
    unrecognizedRemote: string[];
    cdnImagesCount: number;
    totalImagesCount: number;
  }

  const raw = await evaluatePage<InspectRaw>(
    session,
    `
      (function() {
        const editor = document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)});
        if (!editor) {
          return {
            ok: false,
            residualPlaceholders: [],
            brokenImages: ['editor-missing'],
            localImagesRemaining: [],
            unrecognizedRemote: [],
            cdnImagesCount: 0,
            totalImagesCount: 0
          };
        }

        // 1. 检查残余占位符
        const residualPlaceholders = [];
        const text = editor.innerText || '';
        const phMatches = text.match(/WECHATIMGPH_\\d+/g) || [];
        for (const m of phMatches) {
          if (!residualPlaceholders.includes(m)) residualPlaceholders.push(m);
        }

        // 2. 检查所有图片
        const imgs = Array.from(editor.querySelectorAll('img')).filter(
          img => !img.classList.contains('ProseMirror-separator')
        );

        const brokenImages = [];
        const localImagesRemaining = [];
        const unrecognizedRemote = [];
        let cdnImagesCount = 0;

        for (const img of imgs) {
          const src = (img.getAttribute('src') || '').trim();
          if (!src) {
            brokenImages.push('(empty-src)');
            continue;
          }

          // pending 加载中直接判定为未就绪/损坏
          if (!img.complete) {
            brokenImages.push('pending-not-loaded: ' + src.slice(0, 45));
            continue;
          }
          if (img.naturalWidth === 0 || img.naturalHeight === 0) {
            brokenImages.push('zero-dimension: ' + src.slice(0, 45));
            continue;
          }

          // 本地/相对/blob/data 路径严格归类
          if (
            src.startsWith('data:') ||
            src.startsWith('file:') ||
            src.startsWith('blob:') ||
            src.startsWith('/') ||
            src.startsWith('./') ||
            /^[a-zA-Z]:/.test(src) ||
            !src.includes('://')
          ) {
            localImagesRemaining.push(src.slice(0, 50));
            continue;
          }

          // URL 校验
          try {
            const u = new URL(src);
            const host = u.hostname.toLowerCase();
            if (host === 'qpic.cn' || host.endsWith('.qpic.cn')) {
              cdnImagesCount++;
            } else {
              unrecognizedRemote.push(src.slice(0, 50));
            }
          } catch {
            localImagesRemaining.push(src.slice(0, 50));
          }
        }

        const ok =
          residualPlaceholders.length === 0 &&
          localImagesRemaining.length === 0 &&
          brokenImages.length === 0 &&
          unrecognizedRemote.length === 0;

        return {
          ok,
          residualPlaceholders,
          brokenImages,
          localImagesRemaining,
          unrecognizedRemote,
          cdnImagesCount,
          totalImagesCount: imgs.length
        };
      })()
    `
  );

  return raw || {
    ok: false,
    residualPlaceholders: [],
    brokenImages: ['inspect-eval-empty'],
    localImagesRemaining: [],
    unrecognizedRemote: [],
    cdnImagesCount: 0,
    totalImagesCount: 0,
  };
}

// -----------------------------------------------------------------------------
// 6. 核心接口 2: applyArticleContent
// -----------------------------------------------------------------------------
/**
 * 将渲染后的文章正文与图片深度应用至微信公众号编辑器
 * 1. 选区事务注入 ProseMirror 模型并复查占位符；
 * 2. 逐图按占位符精确定位锚点、CDP DOM.setFileInputFiles 增量上传；
 * 3. 严格确认微信 CDN 图片稳定加载 (防 fake-qpic.cn，无 global last fallback)；
 * 4. 严苛质量门禁复查，缺图/残余/超时/未加载立即抛错；
 * 5. 返回结构化证据 ApplyArticleEvidence 供 B 记录与闭环。
 */
export async function applyArticleContent(
  session: EditorSession,
  contentResult: RenderArticleResult,
  options?: ApplyArticleContentOptions
): Promise<ApplyArticleEvidence> {
  const uploadTimeoutMs = options?.uploadTimeoutMs ?? 40_000;

  // 1. 编辑器存在性预检
  const isEditorReady = await evaluatePage<boolean>(
    session,
    `!!document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)})`
  ).catch(() => false);

  if (!isEditorReady) {
    throw new Error('[article-content] 微信编辑器正文区 (.ProseMirror) 未就绪');
  }

  // 2. 注入正文进入 ProseMirror 模型
  await injectHtmlIntoProseMirror(session, contentResult.html, contentResult.images, options?.expectedTitle);

  // 3. 逐个占位符精准上传图片 (支持同图重复引用的逐 occurrence 检测)
  const expectedCount = contentResult.images.length;
  let insertedCount = 0;

  for (let i = 0; i < contentResult.images.length; i++) {
    const item = contentResult.images[i]!;
    const anchorId = `_anchor_ph_${i}_${Date.now()}`;

    // 定位占位符并建立锚点
    const found = await locatePlaceholderAndSetAnchor(session, item.placeholder, anchorId);
    if (!found) {
      throw new Error(
        `[article-content] 正文中未定位到占位符: ${item.placeholder} (${path.basename(item.localPath)})`
      );
    }

    if (!fs.existsSync(item.localPath)) {
      throw new Error(`[article-content] 待上传图片文件丢失: ${item.localPath}`);
    }

    const { uploadPath, cleanup: cleanupPrepared } = await prepareImageForWechatUpload(item.localPath);

    try {
      const doc = await session.cdp.send<{ root: { nodeId: number } }>('DOM.getDocument', {
        depth: -1,
        pierce: true,
      }, { sessionId: session.sessionId });

      const inputNode = await session.cdp.send<{ nodeId: number }>('DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector: 'input[type="file"][accept*="image"]',
      }, { sessionId: session.sessionId });

      if (!inputNode || !inputNode.nodeId) {
        throw new Error('[article-content] 微信本地图片上传 input 控件未找到');
      }

      await session.cdp.send('DOM.setFileInputFiles', {
        nodeId: inputNode.nodeId,
        files: [uploadPath],
      }, { sessionId: session.sessionId });

      // 严格等待目标位置出现已就绪的全新微信 CDN 图片 (无 global last fallback)
      const waitResult = await waitForTargetImageLoaded(session, anchorId, uploadTimeoutMs);
      if (!waitResult.ok) {
        throw new Error(
          `[article-content] 图片上传就绪失败 [${i + 1}/${expectedCount}] (${path.basename(item.localPath)}): ${waitResult.error}`
        );
      }

      insertedCount++;
      await removeExtraEmptyLineAfterImage(session);
    } finally {
      cleanupPrepared();
    }
  }

  // 4. 编辑态最终质量严审
  const inspect = await inspectEditorPostContent(session);

  if (!inspect.ok) {
    const reasons: string[] = [];
    if (inspect.residualPlaceholders.length > 0) {
      reasons.push(`残余占位符未替换: ${inspect.residualPlaceholders.join(', ')}`);
    }
    if (inspect.localImagesRemaining.length > 0) {
      reasons.push(`存在未上传本地图片/相对路径: ${inspect.localImagesRemaining.join(', ')}`);
    }
    if (inspect.brokenImages.length > 0) {
      reasons.push(`存在破损或未完成加载图片: ${inspect.brokenImages.join(', ')}`);
    }
    if (inspect.unrecognizedRemote.length > 0) {
      reasons.push(`存在未识别非微信 CDN 地址: ${inspect.unrecognizedRemote.join(', ')}`);
    }
    throw new Error(`[article-content] 编辑态质量检验失败:\n${reasons.join('\n')}`);
  }

  // 数量严格对应：微信 CDN 图片总数必须精确等于 (新上传数量 + 原稿已有合法 CDN 图片数)
  const existingCdnCount = contentResult.existingCdnImages ? contentResult.existingCdnImages.length : 0;
  const expectedTotalCdn = expectedCount + existingCdnCount;

  if (inspect.cdnImagesCount !== expectedTotalCdn) {
    throw new Error(
      `[article-content] 微信 CDN 图片数量不匹配: 期望严格为 ${expectedTotalCdn} 张 (新上传 ${expectedCount} + 原稿保留 ${existingCdnCount})，实际存在 ${inspect.cdnImagesCount} 张`
    );
  }

  return {
    ok: true,
    insertedImagesCount: insertedCount,
    expectedImagesCount: expectedCount,
    cdnImagesCount: inspect.cdnImagesCount,
    existingCdnCount,
    residualPlaceholders: inspect.residualPlaceholders,
    brokenImages: inspect.brokenImages,
    localImagesRemaining: inspect.localImagesRemaining,
    unrecognizedRemote: inspect.unrecognizedRemote,
    details: `正文与 ${insertedCount}/${expectedCount} 张本地图片已成功注入 ProseMirror 并就绪于微信 CDN (保留原有 CDN 图 ${existingCdnCount} 张)`,
  };
}
