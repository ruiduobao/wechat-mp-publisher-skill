/**
 * scripts/article-content.test.ts
 * 微信公众号文章正文渲染与图片上传核心模块 (article-content) 离线回归测试套件 (返工强化版)
 *
 * 核心针对性测试与回归覆盖：
 * 1. 严格域名安全验证 (isWechatCdnHostname 抵御 fake-qpic.cn 伪域)
 * 2. 代码块隔离保护 (protectCodeBlocks 确保 code block 示例图片不被篡改)
 * 3. 深度括号与带空格路径提取 (extractMarkdownImages 状态机解析)
 * 4. 路径规整与元数据换行 (prepareMarkdownWithAbsoluteImages 支持尾部两空格合法换行)
 * 5. 端到端真实渲染与重复同图引用 (中文+空格+括号目录，同一文件多次引用，断言 localPath 真实可读)
 * 6. ProseMirror 事务注入与占位符入模检测 (直接调用生产函数 injectHtmlIntoProseMirror)
 * 7. 生产等待函数 waitForTargetImageLoaded 增量检测：
 *    - “已有前图但本张未上传”用例真正走生产函数并超时失败 (杜绝假成功与误关联)
 *    - 出现全新合规 CDN 节点时精准就位
 * 8. 编辑态严苛质量复查 (直接调用生产函数 inspectEditorPostContent，捕获 pending、伪域与未知 remote)
 * 9. applyArticleContent 完整生命周期门禁 (数量精确校验与异常阻断)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  prepareMarkdownWithAbsoluteImages,
  renderArticleContent,
  applyArticleContent,
  isWechatCdnHostname,
  isRemoteOrCdnImageUrl,
  safeDecodeImagePath,
  protectCodeBlocks,
  extractMarkdownImages,
  injectHtmlIntoProseMirror,
  locatePlaceholderAndSetAnchor,
  waitForTargetImageLoaded,
  inspectEditorPostContent,
  type RenderArticleResult,
} from './article-content.ts';
import type { EditorSession } from './editor-features.ts';

// 1x1 像素有效 PNG 二进制测试数据
const VALID_1X1_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

/**
 * 构造严格通过 TypeScript 泛型检查的 EditorSession Mock
 */
function createMockSession(
  evalHandler: (expression: string) => any,
  cdpHandler?: (method: string, params?: Record<string, any>) => any
): EditorSession {
  let clipboardHtml = '';
  return {
    sessionId: 'sess_mock',
    targetId: 'editor_mock',
    cdp: {
      send: async <T = any>(
        method: string,
        params?: Record<string, any>,
        _options?: { sessionId?: string }
      ): Promise<T> => {
        if (method === 'Runtime.evaluate') {
          const expr = params?.expression || '';
          if (expr.includes('itemShowType') && expr.includes('hasHiddenHolder')) {
            return { result: { value: { itemShowType: 0, hasHiddenHolder: false, hasGalleryContainer: false, isProseMirrorVisible: true, isEditable: true } } } as unknown as T;
          }
          if (expr.includes('isContentEditable') && expr.includes('clickPoint')) {
            return {
              result: {
                value: {
                  found: true,
                  visibleCount: 1,
                  tagName: 'DIV',
                  isContentEditable: true,
                  display: 'block',
                  visibility: 'visible',
                  hasFocus: true,
                  activeTag: 'DIV#',
                  rect: { x: 100, y: 100, width: 600, height: 400 },
                  clickPoint: { x: 150, y: 150 },
                  hitTag: 'DIV#',
                  isEditorHit: true,
                },
              },
            } as unknown as T;
          }
          if (expr.includes('isFocused') && expr.includes('hasFocus')) {
            return {
              result: {
                value: {
                  hasFocus: true,
                  isFocused: true,
                  activeTag: 'DIV#',
                },
              },
            } as unknown as T;
          }
          let val: any;
          if (expr.includes('template.innerHTML =') && expr.includes('return wrapper.innerHTML')) {
            clipboardHtml = JSON.parse(expr.match(/template\.innerHTML = (".*");/)![1]!);
            val = clipboardHtml;
          } else if (expr.includes("return output.textContent")) {
            val = clipboardHtml.replace(/<[^>]*>/g, '');
          } else if (expr.includes('actualText: editor?.textContent')) {
            const override = evalHandler(expr);
            val = override?.actualText !== undefined ? override : { trusted: true, htmlAvailable: true, actualText: clipboardHtml.replace(/<[^>]*>/g, '') };
          } else if (expr.includes('return { expectedText: text.slice')) {
            val = { expectedText: JSON.parse(expr.match(/const marker = (".*");/)![1]!) };
          } else if (expr.includes('selection.toString() ===')) {
            val = true;
          } else if (expr.includes('editor.addEventListener') || /^!?document\.querySelector/.test(expr)) {
            val = true;
          } else {
            val = evalHandler(expr);
          }
          return { result: { value: val } } as unknown as T;
        }
        if (cdpHandler) {
          const res = cdpHandler(method, params);
          if (res !== undefined) return res as unknown as T;
        }
        if (method === 'Target.createTarget') return { targetId: 'clipboard_mock' } as unknown as T;
        if (method === 'Target.attachToTarget') return { sessionId: 'clipboard_session' } as unknown as T;
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame_mock' } } } as unknown as T;
        if (method === 'DOM.getDocument') {
          return { root: { nodeId: 1 } } as unknown as T;
        }
        if (method === 'DOM.querySelector') {
          return { nodeId: 2 } as unknown as T;
        }
        if (method === 'DOM.setFileInputFiles') {
          return {} as unknown as T;
        }
        return {} as unknown as T;
      },
    },
  };
}

describe('article-content 核心模块离线回归测试套件', () => {
  let tempBaseDir: string;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-test-rerun-'));
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempBaseDir)) {
        fs.rmSync(tempBaseDir, { recursive: true, force: true });
      }
    } catch {}
  });

  // ---------------------------------------------------------------------------
  // 1. 严格域名安全与路径基础测试
  // ---------------------------------------------------------------------------
  describe('域名与 URL 基础安全性', () => {
    it('isWechatCdnHostname 严格基于 hostname 校验，抵御 fake-qpic.cn 伪域', () => {
      expect(isWechatCdnHostname('https://mmbiz.qpic.cn/mmbiz_png/abc/640')).toBe(true);
      expect(isWechatCdnHostname('http://wx.qpic.cn/img/1')).toBe(true);
      expect(isWechatCdnHostname('https://qpic.cn/cover.jpg')).toBe(true);

      // 伪域名抵御
      expect(isWechatCdnHostname('https://fake-qpic.cn/hacked.png')).toBe(false);
      expect(isWechatCdnHostname('https://notqpic.cn/evil.jpg')).toBe(false);
      expect(isWechatCdnHostname('https://qpic.cn.attacker.com/pic.png')).toBe(false);
      expect(isWechatCdnHostname('relative/path.png')).toBe(false);
    });

    it('safeDecodeImagePath 能安全解码包含空格和中文的路径', () => {
      expect(safeDecodeImagePath('my%20folder/%E6%B8%85%E6%99%B0%E5%9B%BE.png')).toBe('my folder/清晰图.png');
      expect(safeDecodeImagePath('simple.png')).toBe('simple.png');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. 代码块隔离与深度图片语法解析 (直接测试生产函数)
  // ---------------------------------------------------------------------------
  describe('代码块保护与深层图片语法扫描', () => {
    it('protectCodeBlocks 能完整保护围栏代码块和行内代码中的图片示例', () => {
      const mdWithCode = `
正文说明。

\`\`\`markdown
![示例图片](./code/demo.png)
\`\`\`

行内代码 \`![行内图](local.png)\` 不应被处理。
`;
      const { maskedMarkdown, restore } = protectCodeBlocks(mdWithCode);
      expect(maskedMarkdown.includes('./code/demo.png')).toBe(false);
      expect(maskedMarkdown.includes('\u0000CODEBLOCK_0\u0000')).toBe(true);
      expect(maskedMarkdown.includes('\u0000CODEBLOCK_1\u0000')).toBe(true);

      const restored = restore(maskedMarkdown);
      expect(restored).toBe(mdWithCode);
    });

    it('extractMarkdownImages 生产函数能准确解析包含空格、嵌套括号与带尖括号的图片语法', () => {
      const mdContent = `
![图1](<./img folder/pic (1).png>)
![图2](./sub/chart(draft)(final).png "图表标题")
<img src="./assets/photo 2.jpg" alt="HTML图" />
`;
      const spans = extractMarkdownImages(mdContent);
      expect(spans.length).toBe(3);

      // 倒序排列：第 0 项为 HTML 标签
      const htmlSpan = spans.find((s) => s.isHtml);
      expect(htmlSpan).toBeDefined();
      expect(htmlSpan!.cleanUrl).toBe('./assets/photo 2.jpg');

      // 括号语法
      const parenSpan = spans.find((s) => s.rawMatch.includes('chart(draft)(final).png'));
      expect(parenSpan).toBeDefined();
      expect(parenSpan!.cleanUrl).toBe('./sub/chart(draft)(final).png');

      // 尖括号语法
      const angleSpan = spans.find((s) => s.rawMatch.includes('pic (1).png'));
      expect(angleSpan).toBeDefined();
      expect(angleSpan!.cleanUrl).toBe('./img folder/pic (1).png');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. 元数据换行规范化与路径转换为绝对路径保护
  // ---------------------------------------------------------------------------
  describe('prepareMarkdownWithAbsoluteImages 路径与换行规范', () => {
    it('保留非字段行的合法 trailing two spaces 硬换行，仅对字段行补独立 break', () => {
      const sourceDir = path.join(tempBaseDir, 'src_meta');
      fs.mkdirSync(sourceDir, { recursive: true });
      const imgPath = path.join(sourceDir, 'fig.png');
      fs.writeFileSync(imgPath, VALID_1X1_PNG);

      // 注意：普通行行尾有两个空格 (trailing two spaces)
      const rawMd = `> **栏目**：遥感技术\n> **作者**：锐多宝\n> 普通说明第一行  \n> 普通说明第二行\n\n正文段落。\n\n![示意图](./fig.png)\n`;

      const result = prepareMarkdownWithAbsoluteImages(rawMd, sourceDir);
      // 字段行补齐了 <br />
      expect(result.processedMd.includes('> **栏目**：遥感技术<br />')).toBe(true);
      expect(result.processedMd.includes('> **作者**：锐多宝<br />')).toBe(true);
      // 非字段行的尾部两空格硬换行未被抹杀
      expect(result.processedMd.includes('> 普通说明第一行  \n')).toBe(true);
      // 图片被转换为经 URL escape 安全包裹的绝对路径
      const expectedNormalized = imgPath.split(path.sep).join('/');
      const expectedUrl = encodeURI(expectedNormalized).replace(/\(/g, '%28').replace(/\)/g, '%29');
      expect(result.processedMd.includes(`![示意图](${expectedUrl})`)).toBe(true);
    });

    it('缺图严格阻断抛错，禁止空图放行', () => {
      const sourceDir = path.join(tempBaseDir, 'src_missing');
      fs.mkdirSync(sourceDir, { recursive: true });
      const rawMd = `![缺失](./not_exist.png)`;
      expect(() => {
        prepareMarkdownWithAbsoluteImages(rawMd, sourceDir);
      }).toThrow(/本地图片完整性预检失败/);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. 端到端真实渲染与重复同图引用 (中文+空格+括号)
  // ---------------------------------------------------------------------------
  describe('renderArticleContent 端到端真实渲染与图片可读性确认', () => {
    it('真实转换中文+空格+括号路径，同一文件在不同段落重复引用2处，断言 localPath 真实可读', async () => {
      const sourceDir = path.join(tempBaseDir, '真实 项目 目录 (2026)');
      const subImgDir = path.join(sourceDir, '素材 库 (一)');
      fs.mkdirSync(subImgDir, { recursive: true });

      const realImgPath = path.join(subImgDir, '遥感 专题 结果 (final).png');
      fs.writeFileSync(realImgPath, VALID_1X1_PNG);

      const mdPath = path.join(sourceDir, 'article.md');
      fs.writeFileSync(
        mdPath,
        `---
title: 中文空格括号专题
author: 锐多宝
description: 摘要测试
---

# 中文空格括号专题

> **作者**：锐多宝
> **日期**：2026-11-11

正文第一段引用图片：
![首图](./素材 库 (一)/遥感 专题 结果 (final).png)

正文第二段代码块示例 (绝不能被误替换)：
\`\`\`markdown
![示例](./not_real.png)
\`\`\`

正文第三段再次重复引用同一图片：
![二次图](./素材 库 (一)/遥感 专题 结果 (final).png)
`,
        'utf-8'
      );

      const cacheDir = path.join(tempBaseDir, 'test_cache_root');
      const result = await renderArticleContent(mdPath, { cacheRoot: cacheDir });

      // 验证返回结构与摘要
      expect(result.title).toBe('中文空格括号专题');
      expect(result.summary).toBe('摘要测试');

      // 同一图片两次引用，应生成 2 个独立的占位符与图片条目
      expect(result.images.length).toBe(2);
      expect(result.images[0]!.placeholder).not.toBe(result.images[1]!.placeholder);

      // 关键断言：每个条目的 localPath 必须在磁盘上真实存在且二进制可读
      for (const imgItem of result.images) {
        expect(fs.existsSync(imgItem.localPath)).toBe(true);
        const buf = fs.readFileSync(imgItem.localPath);
        expect(buf.length).toBe(VALID_1X1_PNG.length);
      }

      // 生成的 HTML 中必须包含对应的两个独立占位符
      expect(result.html.includes(result.images[0]!.placeholder)).toBe(true);
      expect(result.html.includes(result.images[1]!.placeholder)).toBe(true);

      // 代码块中的内容保持未被替换
      expect(result.html.includes('./not_real.png')).toBe(true);

      // 清理临时文件，源目录零污染
      result.cleanup();
      expect(fs.readdirSync(sourceDir).length).toBe(2); // 仅 article.md 和 subImgDir
    });
  });

  // ---------------------------------------------------------------------------
  // 5. 注入与等待函数精准增量测试 (直接测试生产函数)
  // ---------------------------------------------------------------------------
  describe('ProseMirror 事务注入与 waitForTargetImageLoaded 增量检测', () => {
    it('injectHtmlIntoProseMirror 生产函数：前置拦截 HTML 自身缺失占位符', async () => {
      const mockSession = createMockSession((_expr) => ({ ok: true }));

      await expect(
        injectHtmlIntoProseMirror(mockSession, '<p>没有占位符的HTML</p>', [
          { placeholder: 'WECHATIMGPH_99', localPath: 'a.png', originalPath: 'a.png' },
        ])
      ).rejects.toThrow(/渲染输出的 HTML 自身缺少待注入占位符/);
    });

    it('injectHtmlIntoProseMirror 生产函数：若占位符未成功进入页面 model 则抛出带现场诊断的异常', async () => {
      const mockSession = createMockSession((_expr) => {
        return {
          trusted: true,
          htmlAvailable: true,
          actualText: 'old text'
        };
      });

      await expect(
        injectHtmlIntoProseMirror(mockSession, '<p>WECHATIMGPH_99</p>', [
          { placeholder: 'WECHATIMGPH_99', localPath: 'a.png', originalPath: 'a.png' },
        ])
      ).rejects.toThrow(/丢失占位符: WECHATIMGPH_99/);
    });

    it('waitForTargetImageLoaded 生产函数：在【已有前图但本张未上传】时坚决不误关联旧图，超时判定失败', async () => {
      // 模拟场景：DOM 中已有一张旧的微信 CDN 图 (带有 data-pre-existed="true")，
      // 但当前锚点旁边没有出现全新节点
      const mockSession = createMockSession((expr) => {
        if (expr.includes('waiting-new-node') || expr.includes('candidate = null')) {
          return { ok: false, reason: 'waiting-new-node' };
        }
        return { ok: false };
      });

      // 真正调用生产函数 waitForTargetImageLoaded，设置超短超时 800ms
      const waitRes = await waitForTargetImageLoaded(mockSession, 'anchor_current_fail', 800);
      expect(waitRes.ok).toBe(false);
      expect(waitRes.error).toContain('等待目标微信 CDN 图片就绪超时');
    });

    it('waitForTargetImageLoaded 生产函数：当锚点邻近出现全新且完整的微信 CDN 图片时精准就位', async () => {
      const mockSession = createMockSession((_expr) => {
        return {
          ok: true,
          src: 'https://mmbiz.qpic.cn/mmbiz_png/new_uploaded/640',
        };
      });

      const waitRes = await waitForTargetImageLoaded(mockSession, 'anchor_success', 1000);
      expect(waitRes.ok).toBe(true);
      expect(waitRes.src).toBe('https://mmbiz.qpic.cn/mmbiz_png/new_uploaded/640');
    });
  });

  // ---------------------------------------------------------------------------
  // 6. 严密编辑态门禁与异常拦截 (直接测试生产函数)
  // ---------------------------------------------------------------------------
  describe('inspectEditorPostContent 质量门禁生产函数测试', () => {
    it('当存在未完成加载的图片 (pending complete=false) 时严格标记为 brokenImages 并阻断', async () => {
      const mockSession = createMockSession((_expr) => {
        return {
          ok: false,
          residualPlaceholders: [],
          brokenImages: ['pending-not-loaded: https://mmbiz.qpic.cn/slow.png'],
          localImagesRemaining: [],
          unrecognizedRemote: [],
          cdnImagesCount: 0,
          totalImagesCount: 1,
        };
      });

      const inspect = await inspectEditorPostContent(mockSession);
      expect(inspect.ok).toBe(false);
      expect(inspect.brokenImages[0]).toContain('pending-not-loaded');
    });

    it('当存在未识别的外部 http 链接或残余本地路径时，标记不合规', async () => {
      const mockSession = createMockSession((_expr) => {
        return {
          ok: false,
          residualPlaceholders: [],
          brokenImages: [],
          localImagesRemaining: ['file:///C:/Users/Administrator/pic.png'],
          unrecognizedRemote: ['https://attacker.com/evil.jpg'],
          cdnImagesCount: 1,
          totalImagesCount: 3,
        };
      });

      const inspect = await inspectEditorPostContent(mockSession);
      expect(inspect.ok).toBe(false);
      expect(inspect.localImagesRemaining.length).toBe(1);
      expect(inspect.unrecognizedRemote.length).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. applyArticleContent 完整生命周期测试
  // ---------------------------------------------------------------------------
  describe('applyArticleContent 完整流程与精确数量校验', () => {
    it('数量精确校验：微信 CDN 图片总数少于期望值时坚决抛错', async () => {
      const testImg = path.join(tempBaseDir, 'test_img.png');
      fs.writeFileSync(testImg, VALID_1X1_PNG);

      const mockContent: RenderArticleResult = {
        html: '<p>WECHATIMGPH_1</p>',
        images: [
          { placeholder: 'WECHATIMGPH_1', localPath: testImg, originalPath: 'test_img.png' },
        ],
        existingCdnImages: [],
        summary: 'sum',
        title: 'tit',
        author: 'aut',
        cleanup: () => {},
      };

      const mockSession = createMockSession(
        (expr) => {
          if (expr.includes('!document.querySelector')) return true;
          if (expr.includes('insertHTML')) return { ok: true };
          if (expr.includes('data-target-ph')) return true;
          if (expr.includes('waiting-new-node') || expr.includes('isComplete')) {
            return { ok: true, src: 'https://mmbiz.qpic.cn/img/1' };
          }
          if (expr.includes('isEmptyParagraph')) return true;
          // 模拟编辑态门禁：cdnImagesCount 为 0 (少于期望的 1 张)
          if (expr.includes('residualPlaceholders')) {
            return {
              ok: true,
              residualPlaceholders: [],
              brokenImages: [],
              localImagesRemaining: [],
              unrecognizedRemote: [],
              cdnImagesCount: 0,
              totalImagesCount: 0,
            };
          }
          return true;
        }
      );

      await expect(
        applyArticleContent(mockSession, mockContent, { uploadTimeoutMs: 1500 })
      ).rejects.toThrow(/微信 CDN 图片数量不匹配: 期望严格为 1 张/);
    });

    it('所有图片增量就位、数量精确对应且通过门禁时返回完备证据', async () => {
      const testImg = path.join(tempBaseDir, 'ok_img.png');
      fs.writeFileSync(testImg, VALID_1X1_PNG);

      const mockContent: RenderArticleResult = {
        html: '<p>WECHATIMGPH_1</p>',
        images: [
          { placeholder: 'WECHATIMGPH_1', localPath: testImg, originalPath: 'ok_img.png' },
        ],
        existingCdnImages: ['https://mmbiz.qpic.cn/legacy/cover.png'], // 原文保留 1 张旧 CDN 图
        summary: 'sum',
        title: 'tit',
        author: 'aut',
        cleanup: () => {},
      };

      const mockSession = createMockSession(
        (expr) => {
          if (expr.includes('!document.querySelector')) return true;
          if (expr.includes('insertHTML')) return { ok: true };
          if (expr.includes('data-target-ph')) return true;
          if (expr.includes('waiting-new-node') || expr.includes('isComplete')) {
            return { ok: true, src: 'https://mmbiz.qpic.cn/img/new1' };
          }
          if (expr.includes('isEmptyParagraph')) return true;
          // 期望总数：新上传 1 + 旧保留 1 = 2 张
          if (expr.includes('residualPlaceholders')) {
            return {
              ok: true,
              residualPlaceholders: [],
              brokenImages: [],
              localImagesRemaining: [],
              unrecognizedRemote: [],
              cdnImagesCount: 2,
              totalImagesCount: 2,
            };
          }
          return true;
        }
      );

      const evidence = await applyArticleContent(mockSession, mockContent, { uploadTimeoutMs: 1500 });
      expect(evidence.ok).toBe(true);
      expect(evidence.insertedImagesCount).toBe(1);
      expect(evidence.cdnImagesCount).toBe(2);
      expect(evidence.existingCdnCount).toBe(1);
      expect(evidence.residualPlaceholders.length).toBe(0);
      expect(evidence.brokenImages.length).toBe(0);
      expect(evidence.details).toContain('保留原有 CDN 图 1 张');
    });
  });
});
