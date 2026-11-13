import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {
  prepareMarkdownWithAbsoluteImages,
  sanitizeWechatHtml,
  cleanupEmptyParagraphsNatively,
  inspectEditorLayoutHealth,
} from './article-content.ts';
import type { EditorSession } from './editor-features.ts';

test('prepareMarkdownWithAbsoluteImages 清除普通段落前导缩进与多余空行，同时保留代码块缩进与尾部两空格硬换行', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-indent-md-'));
  try {
    const rawMd = `# 完整标题\n\n>   **栏目**：遥感技术\n>   说明第一行  \n> \u3000说明第二行\n\n\u3000\u3000这是带全角缩进的第一段。\n\n    这是带四个空格缩进的第二段。\n\n\n\n\`\`\`python\n    def keep_indent():\n        return True\n\`\`\`\n\n  -   列表项一\n`;
    const { processedMd } = prepareMarkdownWithAbsoluteImages(rawMd, root);
    expect(processedMd).toContain('> **栏目**：遥感技术<br />');
    expect(processedMd).toContain('> 说明第一行  \n');
    expect(processedMd).toContain('> 说明第二行\n');
    expect(processedMd).toContain('这是带全角缩进的第一段。');
    expect(processedMd).toContain('这是带四个空格缩进的第二段。');
    expect(processedMd).not.toContain('\u3000');
    expect(processedMd).not.toContain('\n\n\n');
    // 代码块内缩进 100% 保留
    expect(processedMd).toContain('    def keep_indent():\n        return True');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sanitizeWechatHtml 彻底消除 <p>/<ul>/<ol>/<li> 水平缩进、前导 &nbsp; 与空段落，保留 <pre> 代码块', () => {
  const inputHtml = `
    <section class="container">
      <p class="p" style="margin: 1.5em 8px; text-indent: 2em; color: #3f3f3f;"><span>&nbsp;\u3000</span>第一段正文</p>
      <p class="p" style="margin: 1.5em 8px;"><span leaf=""><br class="ProseMirror-trailingBreak"></span></p>
      <div class="empty" style="margin: 8px;"> &nbsp; </div>
      <ul class="ul" style="margin-left: 0; padding-left: 1.5em;">
        <li class="listitem" style="margin: 0.5em 8px;">&nbsp;列表一</li>
      </ul>
      <pre><code>    keep_me()\n</code></pre>
    </section>
  `;
  const out = sanitizeWechatHtml(inputHtml);
  expect(out).not.toContain('1.5em 8px');
  expect(out).not.toContain('0.5em 8px');
  expect(out).not.toContain('padding-left: 1.5em');
  expect(out).not.toContain('text-indent: 2em');
  expect(out).not.toContain('class="empty"');
  expect(out).not.toContain('ProseMirror-trailingBreak');
  expect(out).not.toContain('&nbsp;列表一');
  expect(out).not.toContain('\u3000');
  expect(out).toContain('margin-left: 0; padding-left: 0; text-indent: 0;');
  expect(out).toContain('<span></span>第一段正文');
  expect(out).toContain('<pre><code>    keep_me()\n</code></pre>');
});

test('cleanupEmptyParagraphsNatively 与 inspectEditorLayoutHealth 通过原生按键清理空段并检测缩进', async () => {
  type FakeNode = {
    tagName: string;
    textContent: string;
    style: Record<string, string>;
    previousElementSibling: FakeNode | null;
    nextElementSibling: FakeNode | null;
    hasMedia?: boolean;
    isCard?: boolean;
    closest: (sel: string) => any;
    querySelector: (sel: string) => any;
    scrollIntoView: () => void;
    compareDocumentPosition: (other: FakeNode) => number;
  };

  const blocks: FakeNode[] = [];
  const makeNode = (tagName: string, textContent: string, style: Record<string, string> = {}, extra: Partial<FakeNode> = {}): FakeNode => {
    const self: FakeNode = {
      tagName,
      textContent,
      style,
      previousElementSibling: null,
      nextElementSibling: null,
      closest: () => null,
      querySelector: (sel: string) => {
        if (extra.hasMedia && sel.includes('img')) return {};
        if (extra.isCard && sel.includes('mp-common-profile')) return {};
        return null;
      },
      scrollIntoView: () => {},
      compareDocumentPosition: (other: FakeNode) => {
        const myIdx = blocks.indexOf(self);
        const otherIdx = blocks.indexOf(other);
        return otherIdx > myIdx ? 4 : 2;
      },
      ...extra,
    };
    return self;
  };

  const node = makeNode('H1', '原标题');
  const emptyAfterH1 = makeNode('P', '');
  const bodyP = makeNode('P', '正文段落', { textIndent: '0px', marginLeft: '0px', paddingLeft: '0px' });
  const emptyBeforeImg = makeNode('P', '   ');
  const imgSec = makeNode('SECTION', '', {}, { hasMedia: true });
  const cardSec = makeNode('SECTION', '', {}, { isCard: true });
  const trailingP = makeNode('P', ''); // 名片后尾部允许保留的一个装饰空段

  blocks.push(node, emptyAfterH1, bodyP, emptyBeforeImg, imgSec, cardSec, trailingP);
  const relink = () => {
    for (let i = 0; i < blocks.length; i++) {
      blocks[i]!.previousElementSibling = i > 0 ? blocks[i - 1]! : null;
      blocks[i]!.nextElementSibling = i < blocks.length - 1 ? blocks[i + 1]! : null;
    }
  };
  relink();

  let selectedTarget: FakeNode | null = null;
  const editor: any = {
    focus() {},
    querySelector: (sel: string) => (sel === 'mp-common-profile' ? cardSec : null),
    querySelectorAll: (sel: string) => {
      if (sel.includes('li')) return blocks.filter(b => b.tagName === 'P' || b.tagName === 'DIV' || b.tagName === 'LI');
      return blocks.filter(b => b.tagName === 'P' || b.tagName === 'DIV');
    },
  };
  const selection = {
    removeAllRanges() {},
    addRange() {},
  };
  const context = vm.createContext({
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    getComputedStyle: (el: FakeNode) => ({
      textIndent: el.style.textIndent || '0px',
      marginLeft: el.style.marginLeft || '0px',
      paddingLeft: el.style.paddingLeft || '0px',
    }),
    getSelection: () => selection,
    document: {
      querySelector: () => editor,
      createRange: () => ({
        selectNodeContents(el: FakeNode) { selectedTarget = el; },
        collapse() {},
      }),
    },
  });

  const session: EditorSession = {
    sessionId: 'layout-sess',
    cdp: {
      async send(method, params): Promise<any> {
        if (method === 'Runtime.evaluate') return { result: { value: vm.runInContext(params?.expression, context) } };
        if (method === 'Input.dispatchKeyEvent' && params?.type === 'keyDown' && selectedTarget) {
          const idx = blocks.indexOf(selectedTarget);
          if (idx >= 0) {
            blocks.splice(idx, 1);
            relink();
            selectedTarget = null;
          }
        }
        return {};
      },
    },
  };

  const beforeHealth = await inspectEditorLayoutHealth(session);
  expect(beforeHealth.emptyParagraphCount).toBe(2);
  expect(beforeHealth.indentedParagraphCount).toBe(0);

  const removed = await cleanupEmptyParagraphsNatively(session);
  expect(removed).toBe(2);

  const afterHealth = await inspectEditorLayoutHealth(session);
  expect(afterHealth.emptyParagraphCount).toBe(0);
  expect(afterHealth.indentedParagraphCount).toBe(0);
  // 名片之后的尾部装饰空段未被破坏，且前面 2 个空段已由原生按键清除
  expect(blocks.includes(trailingP)).toBe(true);
});
