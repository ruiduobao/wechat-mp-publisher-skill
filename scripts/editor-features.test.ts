/**
 * scripts/editor-features.test.ts
 * 微信公众号编辑器高级功能离线测试套件 (重构增强版：覆盖真实陷阱与防御断言)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import type { EditorSession } from './editor-features.ts';
import {
  evaluatePage,
  ensureOriginalTitleH1,
  setCoverFromFirstImage,
  setCoverFromFile,
  insertNativeRuiduobaoCard,
  inspectEditorFeatures,
  escapeHtml,
  BODY_EDITOR_SELECTOR,
  RUIDUOBAO_TARGET_DATA_ID,
  RUIDUOBAO_TARGET_NICKNAME,
  RUIDUOBAO_DESC_KEYWORD,
} from './editor-features.ts';

// -----------------------------------------------------------------------------
// 1. 深度 DOM 模拟器 (支持 getClientRects, offsetWidth, 节点树遍历与事件响应)
// -----------------------------------------------------------------------------

class MockClassList {
  private classes: Set<string>;
  constructor(initial = '') {
    this.classes = new Set(initial.split(/\s+/).filter(Boolean));
  }
  add(...names: string[]) {
    for (const n of names) this.classes.add(n);
  }
  remove(...names: string[]) {
    for (const n of names) this.classes.delete(n);
  }
  contains(name: string): boolean {
    return this.classes.has(name);
  }
  toString(): string {
    return Array.from(this.classes).join(' ');
  }
}

class MockElement {
  tagName: string;
  id: string = '';
  classList: MockClassList;
  style: Record<string, string> = {};
  attributes: Map<string, string> = new Map();
  nodeType: number = 1;
  children: MockElement[] = [];
  parentNode: MockElement | null = null;
  textContent: string = '';
  value: string = '';
  disabled: boolean = false;
  offsetWidth: number = 100;
  offsetHeight: number = 50;
  clientRectsCount: number = 1;

  constructor(tagName: string, className = '', textContent = '') {
    this.tagName = tagName.toUpperCase();
    this.classList = new MockClassList(className);
    this.textContent = textContent;
  }

  complete: boolean = true;
  naturalWidth: number = 200;

  get src(): string {
    return this.getAttribute('src') || '';
  }

  get nodeName(): string {
    return this.tagName;
  }

  get className(): string {
    return this.classList.toString();
  }
  set className(val: string) {
    this.classList = new MockClassList(val);
  }

  get innerText(): string {
    return this.textContent;
  }
  set innerText(val: string) {
    this.textContent = val;
  }

  get firstElementChild(): MockElement | null {
    return this.children[0] || null;
  }

  get lastElementChild(): MockElement | null {
    return this.children[this.children.length - 1] || null;
  }

  get firstChild(): MockElement | null {
    return this.firstElementChild;
  }

  get nextElementSibling(): MockElement | null {
    if (!this.parentNode) return null;
    const idx = this.parentNode.children.indexOf(this);
    if (idx >= 0 && idx < this.parentNode.children.length - 1) {
      return this.parentNode.children[idx + 1];
    }
    return null;
  }

  get nextSibling(): MockElement | null {
    return this.nextElementSibling;
  }

  contains(other: MockElement | null): boolean {
    let curr = other;
    while (curr) {
      if (curr === this) return true;
      curr = curr.parentNode;
    }
    return false;
  }

  get previousElementSibling(): MockElement | null {
    if (!this.parentNode) return null;
    const idx = this.parentNode.children.indexOf(this);
    if (idx > 0) {
      return this.parentNode.children[idx - 1];
    }
    return null;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name.toLowerCase()) ?? null;
  }

  setAttribute(name: string, value: string): void {
    const key = name.toLowerCase();
    this.attributes.set(key, value);
    if (key === 'id') this.id = value;
    if (key === 'class') this.className = value;
    if (key === 'style') {
      const parts = value.split(';');
      for (const part of parts) {
        const [k, v] = part.split(':');
        if (k && v) {
          const camel = k.trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          this.style[camel] = v.trim();
        }
      }
    }
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name.toLowerCase());
  }

  appendChild(child: MockElement): MockElement {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(newChild: MockElement, refChild: MockElement | null): MockElement {
    newChild.parentNode = this;
    if (!refChild) {
      this.children.push(newChild);
      return newChild;
    }
    const idx = this.children.indexOf(refChild);
    if (idx >= 0) {
      this.children.splice(idx, 0, newChild);
    } else {
      this.children.push(newChild);
    }
    return newChild;
  }

  remove(): void {
    if (this.parentNode) {
      const idx = this.parentNode.children.indexOf(this);
      if (idx >= 0) {
        this.parentNode.children.splice(idx, 1);
      }
      this.parentNode = null;
    }
  }

  scrollIntoView(): void {}
  focus(): void {}

  click(): void {
    this.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
  }

  getClientRects() {
    return new Array(this.clientRectsCount).fill({});
  }

  dispatchEvent(event: any): boolean {
    return true;
  }

  get content(): MockElement {
    return this;
  }

  get innerHTML(): string {
    if (this.children.length > 0) {
      return this.children.map((c) => c.outerHTML).join('');
    }
    return this.textContent;
  }

  set innerHTML(html: string) {
    this.children = [];
    const decodeEntities = (s: string) =>
      s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");

    this.textContent = decodeEntities(html.replace(/<[^>]+>/g, ''));
    const matches = Array.from(html.matchAll(/<([a-zA-Z0-9-]+)([^>]*)>(.*?)<\/\1>/gs));
    for (const match of matches) {
      const tag = match[1];
      const attrs = match[2];
      const inner = match[3];
      const child = new MockElement(tag, '', decodeEntities(inner.replace(/<[^>]+>/g, '')));
      for (const m of attrs.matchAll(/([a-zA-Z0-9_-]+)=["']([^"']*)["']/g)) {
        child.setAttribute(m[1], m[2]);
      }
      if (inner.includes('<')) {
        child.innerHTML = inner;
      }
      this.appendChild(child);
    }
  }

  get outerHTML(): string {
    const tag = this.tagName.toLowerCase();
    const attrs: string[] = [];
    if (this.id) attrs.push(`id="${this.id}"`);
    if (this.className) attrs.push(`class="${this.className}"`);
    for (const [k, v] of this.attributes.entries()) {
      if (k !== 'id' && k !== 'class') attrs.push(`${k}="${v}"`);
    }
    const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
    return `<${tag}${attrStr}>${this.innerHTML}</${tag}>`;
  }

  querySelector(selector: string): MockElement | null {
    const list = this.querySelectorAll(selector);
    return list[0] || null;
  }

  querySelectorAll(selector: string): MockElement[] {
    const results: MockElement[] = [];
    const selectors = selector.split(',').map((s) => s.trim());

    const testElement = (el: MockElement, sel: string): boolean => {
      const parts = sel.split(/\s+/).filter(Boolean);
      if (parts.length > 1) {
        const lastPart = parts[parts.length - 1];
        if (!matchCompound(el, lastPart)) return false;
        let currentAncestor = el.parentNode;
        for (let i = parts.length - 2; i >= 0; i--) {
          const reqPart = parts[i];
          let matchedAncestor: MockElement | null = null;
          while (currentAncestor) {
            if (matchCompound(currentAncestor, reqPart)) {
              matchedAncestor = currentAncestor;
              break;
            }
            currentAncestor = currentAncestor.parentNode;
          }
          if (!matchedAncestor) return false;
          currentAncestor = matchedAncestor.parentNode;
        }
        return true;
      }
      return matchCompound(el, sel);
    };

    const matchCompound = (el: MockElement, sel: string): boolean => {
      let rest = sel;
      const tagM = rest.match(/^[a-zA-Z0-9_-]+/);
      if (tagM) {
        if (el.tagName.toLowerCase() !== tagM[0].toLowerCase()) return false;
        rest = rest.slice(tagM[0].length);
      }
      const idM = rest.match(/^#([a-zA-Z0-9_-]+)/);
      if (idM) {
        if (el.id !== idM[1]) return false;
        rest = rest.slice(idM[0].length);
      }
      const classMatches = rest.matchAll(/\.([a-zA-Z0-9_-]+)/g);
      for (const cm of classMatches) {
        if (!el.classList.contains(cm[1])) return false;
      }
      rest = rest.replace(/\.([a-zA-Z0-9_-]+)/g, '');
      const attrMatches = rest.matchAll(/\[([a-zA-Z0-9_-]+)([*~|^$]?=)?["']?([^"'\]]*)["']?\]/g);
      for (const am of attrMatches) {
        const attrName = am[1];
        const op = am[2];
        const attrVal = am[3];
        const actualVal = el.getAttribute(attrName) || (attrName === 'style' ? JSON.stringify(el.style) : '');
        if (!op) {
          if (!el.attributes.has(attrName.toLowerCase())) return false;
        } else if (op === '=') {
          if (actualVal !== attrVal) return false;
        } else if (op === '*=') {
          if (!actualVal.includes(attrVal)) return false;
        }
      }
      return true;
    };

    const traverse = (node: MockElement) => {
      for (const child of node.children) {
        for (const s of selectors) {
          if (testElement(child, s)) {
            results.push(child);
            break;
          }
        }
        traverse(child);
      }
    };

    traverse(this);
    return results;
  }
}

class MockDocument {
  body: MockElement;
  constructor() {
    this.body = new MockElement('body');
  }

  createElement(tag: string): MockElement {
    return new MockElement(tag);
  }

  querySelector(selector: string): MockElement | null {
    if (selector.startsWith('body')) {
      const sub = selector.replace(/^body\s*/, '');
      if (!sub) return this.body;
      return this.body.querySelector(sub);
    }
    return this.body.querySelector(selector);
  }

  querySelectorAll(selector: string): MockElement[] {
    return this.body.querySelectorAll(selector);
  }

  createRange() {
    return {
      selectNodeContents: (el: any) => {},
      collapse: (toStart: boolean) => {},
      selectNode: (el: any) => {},
      setStart: (el: any, offset: number) => {},
      deleteContents: () => {},
    };
  }

  failExecCommand: boolean = false;

  execCommand(cmd: string, showUI: boolean, val?: any): boolean {
    if (this.failExecCommand) return false;
    if (cmd === 'insertHTML') {
      const editor = this.querySelector(BODY_EDITOR_SELECTOR);
      if (editor) {
        const temp = new MockElement('div');
        temp.innerHTML = val || '';
        const child = temp.firstElementChild;
        if (child) {
          if (child.tagName === 'H1') {
            editor.insertBefore(child, editor.firstElementChild);
          } else {
            editor.appendChild(child);
          }
          return true;
        }
      }
    }
    return true;
  }
}

function createMockEnvironment() {
  const doc = new MockDocument();
  const win = {
    document: doc,
    window: null as any,
    getComputedStyle: (el: MockElement) => {
      return {
        display: el.style.display || 'block',
        visibility: el.style.visibility || 'visible',
        opacity: el.style.opacity || '1',
        backgroundImage: el.style.backgroundImage || '',
      };
    },
    getSelection: () => {
      return {
        removeAllRanges: () => {},
        addRange: (r: any) => {},
        rangeCount: 1,
      };
    },
    MouseEvent: class {
      type: string;
      init: any;
      constructor(type: string, init?: any) {
        this.type = type;
        this.init = init;
      }
    },
    InputEvent: class {
      type: string;
      init: any;
      constructor(type: string, init?: any) {
        this.type = type;
        this.init = init;
      }
    },
    KeyboardEvent: class {
      type: string;
      init: any;
      constructor(type: string, init?: any) {
        this.type = type;
        this.init = init;
      }
    },
    Event: class {
      type: string;
      init: any;
      constructor(type: string, init?: any) {
        this.type = type;
        this.init = init;
      }
    },
  };
  win.window = win;
  return { doc, win };
}

function createMockSession(win: any): EditorSession {
  const context = vm.createContext(win);
  return {
    sessionId: 'mock-session-123',
    targetId: 'mock-target-abc',
    cdp: {
      send: async <T = any>(
        method: string,
        params?: Record<string, any>,
        options?: { sessionId?: string }
      ): Promise<T> => {
        if (method === 'Runtime.evaluate') {
          try {
            const expr = params?.expression || '';
            const res = vm.runInContext(expr, context);
            if (params?.returnByValue === false) {
              return {
                result: {
                  type: typeof res,
                  objectId: res ? 'mock-obj-' + Date.now() : undefined,
                  value: res,
                },
              } as unknown as T;
            }
            return {
              result: {
                type: typeof res,
                value: res,
              },
            } as unknown as T;
          } catch (err: any) {
            return {
              exceptionDetails: {
                text: err.message,
                exception: {
                  type: 'object',
                  description: err.stack || err.message,
                },
              },
            } as unknown as T;
          }
        }
        if (method === 'DOM.setFileInputFiles') {
          return {} as unknown as T;
        }
        return {} as unknown as T;
      },
    },
  };
}

// -----------------------------------------------------------------------------
// 2. 离线自动化测试套件
// -----------------------------------------------------------------------------

async function runTests() {
  console.log('=== 开始运行 editor-features 离线测试套件 (含返工防御测试) ===\n');
  let passCount = 0;
  let failCount = 0;

  function assert(condition: boolean, msg: string) {
    if (!condition) {
      console.error(`  FAIL: ${msg}`);
      failCount++;
      throw new Error(`Assertion failed: ${msg}`);
    }
    console.log(`  PASS: ${msg}`);
    passCount++;
  }

  // ---------------------------------------------------------------------------
  // 测试 1: escapeHtml 实体转义
  // ---------------------------------------------------------------------------
  console.log('--- 测试组 1: escapeHtml 实体转义与特殊符号 ---');
  const rawTitle = '<NASA & ESA> 2026 "Global Land Cover" \'Report\'';
  const escaped = escapeHtml(rawTitle);
  assert(
    escaped === '&lt;NASA &amp; ESA&gt; 2026 &quot;Global Land Cover&quot; &#39;Report&#39;',
    '特殊字符 <, >, &, ", \' 均被准确转义为 HTML 实体'
  );

  // ---------------------------------------------------------------------------
  // 测试 2: evaluatePage 正常执行与异常拦截
  // ---------------------------------------------------------------------------
  console.log('\n--- 测试组 2: evaluatePage 正常与异常处理 ---');
  const { win: win2 } = createMockEnvironment();
  const session2 = createMockSession(win2);

  const evalVal = await evaluatePage<number>(session2, '10 + 32');
  assert(evalVal === 42, 'evaluatePage 支持表达式求值并返回正确结果');

  let caught = false;
  try {
    await evaluatePage(session2, 'throw new Error("Simulated DOM crash")');
  } catch (err: any) {
    caught = true;
    assert(err.message.includes('Simulated DOM crash'), 'evaluatePage 严格捕获 exceptionDetails 并向上抛错');
  }
  assert(caught, '确认捕获到求值错误，绝不静默吞掉异常');

  // ---------------------------------------------------------------------------
  // 测试 3: ensureOriginalTitleH1 与编辑态标记、特符保护、重复去重
  // ---------------------------------------------------------------------------
  console.log('\n--- 测试组 3: ensureOriginalTitleH1 正文开头 H1 保留与编辑态验证 ---');
  const { doc: doc3, win: win3 } = createMockEnvironment();
  const baseSession3 = createMockSession(win3);
  let copiedTitleHtml = '';
  const session3: EditorSession = { ...baseSession3, cdp: { async send(method, params, options): Promise<any> {
    if (method === 'Target.createTarget') return { targetId: 'title-copy' };
    if (method === 'Target.attachToTarget') return { sessionId: 'title-copy-session' };
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'title-copy-frame' } } };
    if (method === 'Page.setDocumentContent') { copiedTitleHtml = params?.html.match(/<h1[\s\S]*?<\/h1>/)?.[0] || ''; return {}; }
    if (method === 'Runtime.evaluate') {
      const expr = params?.expression || '';
      if (options?.sessionId === 'title-copy-session') return { result: { value: new MockElement('div').textContent } };
      if (expr.includes('editor.addEventListener')) return { result: { value: true } };
      if (expr.includes('actualText: editor?.textContent')) return { result: { value: { trusted: true, htmlAvailable: true, actualText: '' } } };
    }
    if (method === 'Input.insertText') {
      doc3.querySelector(BODY_EDITOR_SELECTOR)!.firstElementChild!.textContent = params?.text;
      return {};
    }
    if (method === 'Input.dispatchKeyEvent' && params?.key === 'v' && params?.type === 'keyDown') {
      const editor = doc3.querySelector(BODY_EDITOR_SELECTOR)!;
      const wrapper = new MockElement('div'); wrapper.innerHTML = copiedTitleHtml;
      if (editor.firstElementChild?.tagName === 'H1') editor.firstElementChild.remove();
      editor.insertBefore(wrapper.firstElementChild!, editor.firstElementChild);
    }
    return baseSession3.cdp.send(method, params, options);
  } } };

  // 3.1 编辑器不存在
  const resNoEditor = await ensureOriginalTitleH1(session3, '测试学术标题');
  assert(!resNoEditor.ok && resNoEditor.error === 'Editor missing', '编辑器不存在时返回明确诊断状态');

  // 搭建编辑器环境与现有文章段落
  const contentWrapper = new MockElement('div', 'rich_media_content');
  const editorEl = new MockElement('div', 'ProseMirror');
  const existingPara1 = new MockElement('p', '', '这是正文第一段，包含了前沿遥感分析内容。');
  const existingPara2 = new MockElement('p', '', '这是正文第二段。');
  editorEl.appendChild(existingPara1);
  editorEl.appendChild(existingPara2);
  contentWrapper.appendChild(editorEl);
  doc3.body.appendChild(contentWrapper);

  // 3.2 首次插入带特殊符号的 H1
  const complexTitle = 'Deep Learning & Multi-Modal Analysis: "Next-Gen" <AI> 2026';
  const resInsert = await ensureOriginalTitleH1(session3, complexTitle);
  assert(resInsert.ok && resInsert.inEditorVerified, '首次插入复杂标题 H1 返回 ok=true 且标明 inEditorVerified');
  assert(resInsert.inserted, '状态标记为 inserted=true');
  assert(resInsert.isFirstElement === true, 'H1 位于 ProseMirror 首元素');
  assert(resInsert.h1Text === complexTitle, 'H1 文本与原标题完全一致');
  assert(
    editorEl.children.length === 3 && editorEl.children[1].textContent.includes('这是正文第一段'),
    '插入 H1 绝不破坏后续原正文段落结构'
  );

  // 3.3 再次调用识别已存在，不重复插入
  const resAlready = await ensureOriginalTitleH1(session3, complexTitle);
  assert(resAlready.ok && resAlready.alreadyExisted, '再次调用识别 alreadyExisted=true，保证单一原标题 H1');

  const resForce = await ensureOriginalTitleH1(session3, complexTitle, { forceUpdate: true });
  assert(resForce.ok && resForce.updated, '已有 H1 通过原生文字输入更新并保留标题节点');
  assert(editorEl.children[1] === existingPara1 && editorEl.children[2] === existingPara2, '标题原生输入不替换后续正文节点');

  // 3.4 多余历史 H1 安全阻断
  const duplicateH1 = new MockElement('h1', 'article_title', complexTitle);
  editorEl.appendChild(duplicateH1);
  assert(editorEl.querySelectorAll('h1').length === 2, '模拟编辑器存在重复相同标题 H1');
  const resDedupe = await ensureOriginalTitleH1(session3, complexTitle);
  assert(!resDedupe.ok && resDedupe.details.includes('needs-content-refresh'), '重复 H1 结构明确阻断并要求源文重建');
  assert(editorEl.querySelectorAll('h1').length === 2, '异常标题结构不会通过直接删除 DOM 假装修复');
  duplicateH1.remove();

  // ---------------------------------------------------------------------------
  // 测试 4: setCoverFromFirstImage 裁剪弹窗收拢与非空有效 URL 校验
  // ---------------------------------------------------------------------------
  console.log('\n--- 测试组 4: setCoverFromFirstImage 弹窗收拢与严格背景图校验 ---');
  const { doc: doc4, win: win4 } = createMockEnvironment();
  const session4 = createMockSession(win4);

  // 搭建封面区
  const coverArea = new MockElement('div');
  coverArea.id = 'js_cover_area';
  const selectCoverBtn = new MockElement('button', 'js_selectCoverFromContent');
  coverArea.appendChild(selectCoverBtn);
  doc4.body.appendChild(coverArea);

  // 搭建选择弹窗
  const pickerDialog = new MockElement('div', 'weui-desktop-dialog_img-picker');
  const imgList = new MockElement('ul');
  const imgItem = new MockElement('li', 'appmsg_content_img_item');
  const imgMask = new MockElement('div', 'apmsg_content_img_mask');
  imgItem.appendChild(imgMask);
  imgList.appendChild(imgItem);
  pickerDialog.appendChild(imgList);

  const nextBtn = new MockElement('button', '', '下一步');
  nextBtn.disabled = true; // 初始禁用
  pickerDialog.appendChild(nextBtn);
  doc4.body.appendChild(pickerDialog);

  // 模拟单次点击 mask 解锁选中与下一步
  imgMask.dispatchEvent = () => {
    imgItem.classList.add('selected');
    nextBtn.disabled = false;
    return true;
  };

  // 搭建不可见的隐藏干扰对话框（模拟 DOM 遗留组件）
  const hiddenDialog = new MockElement('div', 'cropper-dialog');
  hiddenDialog.style.display = 'none';
  hiddenDialog.clientRectsCount = 0;
  const fakeConfirmBtn = new MockElement('button', 'weui-desktop-btn', '完成');
  hiddenDialog.appendChild(fakeConfirmBtn);
  doc4.body.appendChild(hiddenDialog);

  // 搭建真实的活动可见裁剪对话框
  const activeCropperDialog = new MockElement('div', 'cropper-dialog');
  activeCropperDialog.style.display = 'block';
  activeCropperDialog.style.visibility = 'visible';
  activeCropperDialog.clientRectsCount = 1;
  const realConfirmBtn = new MockElement('button', 'weui-desktop-btn', '完成');
  realConfirmBtn.clientRectsCount = 1;
  activeCropperDialog.appendChild(realConfirmBtn);
  doc4.body.appendChild(activeCropperDialog);

  // 搭建封面展示区
  const coverImgContainer = new MockElement('div', 'first_appmsg_cover');
  coverArea.appendChild(coverImgContainer);

  realConfirmBtn.dispatchEvent = () => {
    coverImgContainer.style.backgroundImage = 'url("https://mmbiz.qpic.cn/mmbiz_png/realCover123/640")';
    return true;
  };

  const resCover = await setCoverFromFirstImage(session4, { timeoutMs: 3000 });
  assert(resCover.ok, '从正文选图并裁剪流程全部通顺，返回 ok=true');
  assert(resCover.pickerOpened && resCover.itemSelected && resCover.cropConfirmed, '单次点击与状态流转证据齐全');
  assert(
    resCover.verified && resCover.coverUrl === 'https://mmbiz.qpic.cn/mmbiz_png/realCover123/640',
    '精确限定在可见裁剪对话框中点击完成，并验证真实非空背景 URL'
  );

  // 4.2 现有合法封面直通：当 #js_cover_area 已有合法封面时直接复用返回 ok
  const resExistingCover = await setCoverFromFirstImage(session4, { timeoutMs: 1500 });
  assert(
    resExistingCover.ok && resExistingCover.pickerOpened === false,
    '检测到已有合法有效封面时直接复用，不重复打开弹窗'
  );

  // 4.3 列表异步延迟加载测试：弹窗打开初始 0 项，延迟后项出现并带有图片/mask
  const { doc: doc43, win: win43 } = createMockEnvironment();
  const session43 = createMockSession(win43);
  const coverArea43 = new MockElement('div');
  coverArea43.id = 'js_cover_area';
  const btn43 = new MockElement('button', 'js_selectCoverFromContent');
  coverArea43.appendChild(btn43);
  doc43.body.appendChild(coverArea43);

  const picker43 = new MockElement('div', 'weui-desktop-dialog_img-picker');
  const list43 = new MockElement('ul');
  picker43.appendChild(list43); // 初始为空列表！
  const nextBtn43 = new MockElement('button', '', '下一步');
  nextBtn43.disabled = true;
  picker43.appendChild(nextBtn43);
  doc43.body.appendChild(picker43);

  const cropper43 = new MockElement('div', 'cropper-dialog');
  const confirm43 = new MockElement('button', 'weui-desktop-btn', '完成');
  cropper43.appendChild(confirm43);
  doc43.body.appendChild(cropper43);

  const preview43 = new MockElement('div', 'first_appmsg_cover');
  coverArea43.appendChild(preview43);

  // 异步延迟 200ms 后才灌入图片项
  setTimeout(() => {
    const item43 = new MockElement('li', 'appmsg_content_img_item');
    const mask43 = new MockElement('div', 'apmsg_content_img_mask');
    item43.appendChild(mask43);
    list43.appendChild(item43);

    mask43.dispatchEvent = () => {
      item43.classList.add('selected');
      nextBtn43.disabled = false;
      return true;
    };
  }, 200);

  confirm43.dispatchEvent = () => {
    preview43.style.backgroundImage = 'url("https://mmbiz.qpic.cn/delayedCover.png")';
    return true;
  };

  const resDelayedCover = await setCoverFromFirstImage(session43, { timeoutMs: 3000, pollIntervalMs: 100 });
  assert(resDelayedCover.ok && resDelayedCover.verified, '图片列表异步延迟加载时 pollUntil 成功等候至条目出现并完成设置');

  // 4.4 单次点击与真实 toggle 语义回归测试 (防两次 click 导致选中文反选)
  const { doc: doc44, win: win44 } = createMockEnvironment();
  const session44 = createMockSession(win44);
  const coverArea44 = new MockElement('div');
  coverArea44.id = 'js_cover_area';
  const btn44 = new MockElement('button', 'js_selectCoverFromContent');
  coverArea44.appendChild(btn44);
  doc44.body.appendChild(coverArea44);

  const picker44 = new MockElement('div', 'weui-desktop-dialog_img-picker');
  const list44 = new MockElement('ul');
  const item44 = new MockElement('li', 'appmsg_content_img_item');
  const mask44 = new MockElement('div', 'apmsg_content_img_mask');
  item44.appendChild(mask44);
  list44.appendChild(item44);
  picker44.appendChild(list44);

  const nextBtn44 = new MockElement('button', '', '下一步');
  nextBtn44.disabled = true;
  picker44.appendChild(nextBtn44);
  doc44.body.appendChild(picker44);

  const cropper44 = new MockElement('div', 'cropper-dialog');
  const confirm44 = new MockElement('button', 'weui-desktop-btn', '完成');
  cropper44.appendChild(confirm44);
  doc44.body.appendChild(cropper44);

  const preview44 = new MockElement('div', 'first_appmsg_cover');
  coverArea44.appendChild(preview44);

  let maskClickCount = 0;
  mask44.dispatchEvent = (ev: any) => {
    if (ev.type === 'click') {
      maskClickCount++;
      // 真实 toggle 语义：奇数次选中，偶数次反选！
      if (maskClickCount % 2 === 1) {
        item44.classList.add('selected');
        nextBtn44.disabled = false;
      } else {
        item44.classList.remove('selected');
        nextBtn44.disabled = true;
      }
    }
    return true;
  };

  confirm44.dispatchEvent = (ev: any) => {
    if (ev.type === 'click') {
      preview44.style.backgroundImage = 'url("https://mmbiz.qpic.cn/toggleCover.png")';
    }
    return true;
  };

  const resToggle = await setCoverFromFirstImage(session44, { timeoutMs: 3000 });
  assert(resToggle.ok && maskClickCount === 1, `严格验证 mask 仅被触发 1 次 click (实际触发 ${maskClickCount} 次)，toggle 后保持选中态并成功应用封面`);

  // 4.5 setCoverFromFile 基于 J 现场 574 验证链测试 (干扰弹窗排除 -> 真实选择图片 -> 注入新图与就绪 -> 编辑封面确认 -> CDN URL 校验)
  console.log('\n--- 测试组 4.5: setCoverFromFile 本地文件上传与 J 现场链测试 ---');
  const tmpCoverFile = path.join(os.tmpdir(), `test_cover_${Date.now()}.png`);
  fs.writeFileSync(tmpCoverFile, 'fake-png-data-1234');

  const { doc: doc45, win: win45 } = createMockEnvironment();
  const session45 = createMockSession(win45);

  const coverArea45 = new MockElement('div');
  coverArea45.id = 'js_cover_area';
  const imgDialogBtn45 = new MockElement('button', 'js_imagedialog', '选择图片');
  coverArea45.appendChild(imgDialogBtn45);
  doc45.body.appendChild(coverArea45);

  // 1. 干扰可见弹窗在前（验证精准匹配标题含“选择图片”，绝不误取其他弹窗）
  const foreignDialog45 = new MockElement('div', 'weui-desktop-dialog');
  foreignDialog45.style.display = 'block';
  foreignDialog45.style.visibility = 'visible';
  foreignDialog45.offsetWidth = 500;
  foreignDialog45.offsetHeight = 400;
  const foreignHeader45 = new MockElement('div', 'weui-desktop-dialog__hd', '系统提示');
  foreignDialog45.appendChild(foreignHeader45);
  doc45.body.appendChild(foreignDialog45);

  // 2. 真正的“选择图片”弹窗
  const selectDialog45 = new MockElement('div', 'weui-desktop-dialog');
  selectDialog45.style.display = 'block';
  selectDialog45.style.visibility = 'visible';
  selectDialog45.offsetWidth = 500;
  selectDialog45.offsetHeight = 400;
  const header45 = new MockElement('div', 'weui-desktop-dialog__hd', '选择图片');
  selectDialog45.appendChild(header45);

  const fileInput45 = new MockElement('input');
  fileInput45.setAttribute('type', 'file');
  fileInput45.setAttribute('accept', 'image/*');
  selectDialog45.appendChild(fileInput45);

  const galleryList45 = new MockElement('ul');
  selectDialog45.appendChild(galleryList45);

  const nextBtn45 = new MockElement('button', 'weui-desktop-btn', '下一步');
  nextBtn45.disabled = true; // 初始禁用
  selectDialog45.appendChild(nextBtn45);
  doc45.body.appendChild(selectDialog45);

  const editDialog45 = new MockElement('div', 'weui-desktop-dialog');
  editDialog45.style.display = 'none'; // 初始不可见
  const editHeader45 = new MockElement('div', 'weui-desktop-dialog__hd', '编辑封面');
  editDialog45.appendChild(editHeader45);
  const confirmCropBtn45 = new MockElement('button', 'weui-desktop-btn weui-desktop-btn_primary', '确认');
  editDialog45.appendChild(confirmCropBtn45);
  doc45.body.appendChild(editDialog45);

  const preview45 = new MockElement('div', 'first_appmsg_cover');
  coverArea45.appendChild(preview45);

  // 模拟上传延迟 150ms 注入新 item（J 实证结构：子节点 i.weui-desktop-img-picker__img-thumb 带背景图，textContent 为文件名）
  setTimeout(() => {
    const uploadedItem = new MockElement('li', 'weui-desktop-img-picker__item selected');
    uploadedItem.textContent = path.basename(tmpCoverFile);
    const thumbEl = new MockElement('i', 'weui-desktop-img-picker__img-thumb');
    thumbEl.style.backgroundImage = 'url("https://mmbiz.qpic.cn/uploaded_raw.png")';
    uploadedItem.appendChild(thumbEl);
    galleryList45.appendChild(uploadedItem);
    nextBtn45.disabled = false;
  }, 150);

  nextBtn45.dispatchEvent = () => {
    selectDialog45.style.display = 'none';
    editDialog45.style.display = 'block';
    editDialog45.style.visibility = 'visible';
    editDialog45.offsetWidth = 500;
    editDialog45.offsetHeight = 400;
    return true;
  };

  let mousedownFired45 = false;
  let mouseupFired45 = false;
  let clickFired45 = false;

  confirmCropBtn45.dispatchEvent = (ev: any) => {
    if (ev.type === 'mousedown') mousedownFired45 = true;
    if (ev.type === 'mouseup') mouseupFired45 = true;
    if (ev.type === 'click') {
      clickFired45 = true;
      // 点击确认后裁剪弹窗关闭
      editDialog45.style.display = 'none';
      editDialog45.clientRectsCount = 0;
      preview45.style.backgroundImage = 'url("https://mmbiz.qpic.cn/uploadedCoverCDN.png")';
    }
    return true;
  };

  const resFileCover = await setCoverFromFile(session45, tmpCoverFile, { timeoutMs: 3000, pollIntervalMs: 100 });
  assert(
    resFileCover.ok && resFileCover.itemSelected && resFileCover.cropConfirmed && resFileCover.verified && mousedownFired45 && mouseupFired45 && clickFired45,
    'setCoverFromFile 按照 J 现场实测 574 链路，触发 mousedown/mouseup/click 单次序列，等待裁剪弹窗真正关闭并校验 CDN URL'
  );

  // 测试 4.6: 0 字节空封面文件安全拦截测试
  console.log('\n--- 测试组 4.6: 0 字节空封面文件安全拦截测试 ---');
  const emptyFile = path.join(os.tmpdir(), `empty_${Date.now()}.png`);
  fs.writeFileSync(emptyFile, '');
  const resEmpty = await setCoverFromFile(session45, emptyFile, { timeoutMs: 1000 });
  assert(resEmpty.ok === false && resEmpty.error?.includes('empty'), '本地 0 字节空封面文件被安全拦截');

  // 测试 4.7: 微信服务端去重复用已有图库同名资产测试 (无新增条目，通过精确 basename 绑定通过)
  console.log('\n--- 测试组 4.7: 微信图库同名去重复用回归测试 ---');
  const dedupCoverFile = path.join(os.tmpdir(), `04_dpc_orbit_polarization.png`);
  fs.writeFileSync(dedupCoverFile, 'dedup-png-data');

  const { doc: doc47, win: win47 } = createMockEnvironment();
  const session47 = createMockSession(win47);

  const coverArea47 = new MockElement('div');
  coverArea47.id = 'js_cover_area';
  const imgDialogBtn47 = new MockElement('button', 'js_imagedialog', '选择图片');
  coverArea47.appendChild(imgDialogBtn47);
  doc47.body.appendChild(coverArea47);

  const selectDialog47 = new MockElement('div', 'weui-desktop-dialog');
  selectDialog47.style.display = 'block';
  selectDialog47.style.visibility = 'visible';
  selectDialog47.offsetWidth = 500;
  selectDialog47.offsetHeight = 400;
  const header47 = new MockElement('div', 'weui-desktop-dialog__hd', '选择图片');
  selectDialog47.appendChild(header47);

  const fileInput47 = new MockElement('input');
  fileInput47.setAttribute('type', 'file');
  selectDialog47.appendChild(fileInput47);

  const galleryList47 = new MockElement('ul');
  // 上传前图库中已存在该同名图片（去重场景，count 不增加）
  const existingSameItem = new MockElement('li', 'weui-desktop-img-picker__item selected');
  existingSameItem.textContent = '04_dpc_orbit_polarization.png';
  const existingThumb = new MockElement('i', 'weui-desktop-img-picker__img-thumb');
  existingThumb.style.backgroundImage = 'url("https://mmbiz.qpic.cn/dedup_item.png")';
  existingSameItem.appendChild(existingThumb);
  galleryList47.appendChild(existingSameItem);
  selectDialog47.appendChild(galleryList47);

  const nextBtn47 = new MockElement('button', 'weui-desktop-btn', '下一步');
  nextBtn47.disabled = false;
  selectDialog47.appendChild(nextBtn47);
  doc47.body.appendChild(selectDialog47);

  const editDialog47 = new MockElement('div', 'weui-desktop-dialog');
  editDialog47.style.display = 'none';
  const editHeader47 = new MockElement('div', 'weui-desktop-dialog__hd', '编辑封面');
  editDialog47.appendChild(editHeader47);
  const confirmCropBtn47 = new MockElement('button', 'weui-desktop-btn weui-desktop-btn_primary', '确认');
  editDialog47.appendChild(confirmCropBtn47);
  doc47.body.appendChild(editDialog47);

  const preview47 = new MockElement('div', 'first_appmsg_cover');
  coverArea47.appendChild(preview47);

  nextBtn47.dispatchEvent = () => {
    selectDialog47.style.display = 'none';
    editDialog47.style.display = 'block';
    editDialog47.style.visibility = 'visible';
    editDialog47.offsetWidth = 500;
    editDialog47.offsetHeight = 400;
    return true;
  };

  confirmCropBtn47.dispatchEvent = (ev: any) => {
    if (ev.type === 'click') {
      editDialog47.style.display = 'none';
      editDialog47.clientRectsCount = 0;
      preview47.style.backgroundImage = 'url("https://mmbiz.qpic.cn/dedupCoverCDN.png")';
    }
    return true;
  };

  const resDedup = await setCoverFromFile(session47, dedupCoverFile, { timeoutMs: 2500 });
  assert(
    resDedup.ok && resDedup.verified,
    '图库已存在同图去重且条目数不增加时，通过精确文件名绑定成功复用并完成裁剪确认'
  );

  // 测试 4.8: 无关旧选中图安全拦截测试 (未匹配到当前上传文件的旧选中文档不能放行)
  console.log('\n--- 测试组 4.8: 无关旧选中图安全拦截测试 ---');
  const unrelatedCoverFile = path.join(os.tmpdir(), `my_new_article_cover.png`);
  fs.writeFileSync(unrelatedCoverFile, 'new-data');

  const { doc: doc48, win: win48 } = createMockEnvironment();
  const session48 = createMockSession(win48);

  const coverArea48 = new MockElement('div');
  coverArea48.id = 'js_cover_area';
  const imgDialogBtn48 = new MockElement('button', 'js_imagedialog', '选择图片');
  coverArea48.appendChild(imgDialogBtn48);
  doc48.body.appendChild(coverArea48);

  const selectDialog48 = new MockElement('div', 'weui-desktop-dialog');
  selectDialog48.style.display = 'block';
  selectDialog48.style.visibility = 'visible';
  selectDialog48.offsetWidth = 500;
  selectDialog48.offsetHeight = 400;
  const header48 = new MockElement('div', 'weui-desktop-dialog__hd', '选择图片');
  selectDialog48.appendChild(header48);

  const fileInput48 = new MockElement('input');
  fileInput48.setAttribute('type', 'file');
  selectDialog48.appendChild(fileInput48);

  const galleryList48 = new MockElement('ul');
  // 残留的无关旧选中项（文件名不匹配，条目数未增）
  const unrelatedOldItem = new MockElement('li', 'weui-desktop-img-picker__item selected');
  unrelatedOldItem.textContent = 'totally_unrelated_old.png';
  const oldThumb = new MockElement('i', 'weui-desktop-img-picker__img-thumb');
  oldThumb.style.backgroundImage = 'url("https://mmbiz.qpic.cn/old_img.png")';
  unrelatedOldItem.appendChild(oldThumb);
  galleryList48.appendChild(unrelatedOldItem);
  selectDialog48.appendChild(galleryList48);

  const nextBtn48 = new MockElement('button', 'weui-desktop-btn', '下一步');
  nextBtn48.disabled = false;
  selectDialog48.appendChild(nextBtn48);
  doc48.body.appendChild(selectDialog48);

  const resUnrelated = await setCoverFromFile(session48, unrelatedCoverFile, { timeoutMs: 1500 });
  assert(
    resUnrelated.ok === false,
    '图库仅有无关旧选中项且名称不匹配时，poll 严格拒绝提前下一步并超时报错，杜绝错选旧图'
  );

  try { fs.unlinkSync(tmpCoverFile); fs.unlinkSync(emptyFile); fs.unlinkSync(dedupCoverFile); fs.unlinkSync(unrelatedCoverFile); } catch(e) {}

  // ---------------------------------------------------------------------------
  // 测试 5: insertNativeRuiduobaoCard 精确匹配、旧号排除与 isAtEnd 深度防御
  // ---------------------------------------------------------------------------
  console.log('\n--- 测试组 5: insertNativeRuiduobaoCard 精确匹配与 isAtEnd 深度防御 ---');
  const { doc: doc5, win: win5 } = createMockEnvironment();
  const session5 = createMockSession(win5);

  const wrapper5 = new MockElement('div', 'rich_media_content');
  const editor5 = new MockElement('div', 'ProseMirror');
  const paraA = new MockElement('p', '', '文章正文引言与分析');
  editor5.appendChild(paraA);
  wrapper5.appendChild(editor5);
  doc5.body.appendChild(wrapper5);

  const toolbarBtn = new MockElement('button');
  toolbarBtn.id = 'js_editor_insertProfile';
  const span = new MockElement('span', '', '名片');
  toolbarBtn.appendChild(span);
  doc5.body.appendChild(toolbarBtn);

  const profileDialog = new MockElement('div', 'profile_dialog');
  const historyItem = new MockElement('div', 'profile_history_item', '锐多宝');
  profileDialog.appendChild(historyItem);

  // 陷阱卡片 1: 迁移旧号（nickname 为“锐多宝的地理空间”，必须被精准排除）
  const cardOld = new MockElement('div', 'appmsg_card_context wx_profile_card');
  const nickOld = new MockElement('span', 'wx_profile_nickname', '锐多宝的地理空间');
  const descOld = new MockElement('div', 'desc', '遥感地理空间技术 (旧号)');
  cardOld.appendChild(nickOld);
  cardOld.appendChild(descOld);
  profileDialog.appendChild(cardOld);

  // 核心真实陷阱卡片 2: 目标官方账号（nickname === '锐多宝'，但 desc 内部包含了 '锐多宝的地理空间 原名:遥感之家'）
  // 验证排除规则绝不误伤此卡片！
  const cardTarget = new MockElement('div', 'appmsg_card_context wx_profile_card');
  const nickTarget = new MockElement('span', 'wx_profile_nickname', '锐多宝');
  const descTarget = new MockElement('div', 'desc', '分享遥感地理空间技术 锐多宝的地理空间 原名:遥感之家');
  cardTarget.appendChild(nickTarget);
  cardTarget.appendChild(descTarget);
  profileDialog.appendChild(cardTarget);

  const insertBtn = new MockElement('button', '', '插入');
  insertBtn.disabled = true;
  profileDialog.appendChild(insertBtn);
  doc5.body.appendChild(profileDialog);

  // 单次点击选中目标卡片
  cardTarget.dispatchEvent = () => {
    cardTarget.classList.add('wx_profile_card_selected');
    insertBtn.disabled = false;
    return true;
  };

  // 插入按钮向正文尾部添加真实的 mp-common-profile
  insertBtn.dispatchEvent = () => {
    const nativeCardNode = new MockElement('mp-common-profile');
    nativeCardNode.setAttribute('data-id', RUIDUOBAO_TARGET_DATA_ID);
    nativeCardNode.setAttribute('data-nickname', RUIDUOBAO_TARGET_NICKNAME);
    editor5.appendChild(nativeCardNode);
    return true;
  };

  const resCard = await insertNativeRuiduobaoCard(session5, { timeoutMs: 4000 });
  assert(resCard.ok, '名片成功插入且返回 ok=true');
  assert(resCard.cardFound && resCard.cardSelected && resCard.insertClicked, '单次触发、只读等待、单次点击全流程闭环');
  assert(resCard.verified, '严格验证 mp-common-profile 节点存在于正文末尾');
  assert(
    resCard.cardEvidence?.dataId === RUIDUOBAO_TARGET_DATA_ID &&
      resCard.cardEvidence?.dataNickname === RUIDUOBAO_TARGET_NICKNAME,
    '属性严格匹配 data-id=MzAwODU3NDc2Nw== 与 data-nickname=锐多宝'
  );

  // ---------------------------------------------------------------------------
  // 测试 5.1: 候选卡片位于首项 (index=0) 回归测试 (确保 pollUntil 允许 0 正常返回)
  // ---------------------------------------------------------------------------
  console.log('\n--- 测试组 5.1: 候选首项 (index=0) pollUntil 回归测试 ---');
  const { doc: doc51, win: win51 } = createMockEnvironment();
  const session51 = createMockSession(win51);

  const wrapper51 = new MockElement('div', 'rich_media_content');
  const editor51 = new MockElement('div', 'ProseMirror');
  wrapper51.appendChild(editor51);
  doc51.body.appendChild(wrapper51);

  const toolbarBtn51 = new MockElement('button');
  toolbarBtn51.id = 'js_editor_insertProfile';
  const span51 = new MockElement('span', '', '名片');
  toolbarBtn51.appendChild(span51);
  doc51.body.appendChild(toolbarBtn51);

  const profileDialog51 = new MockElement('div', 'profile_dialog');
  const historyItem51 = new MockElement('div', 'profile_history_item', '锐多宝');
  profileDialog51.appendChild(historyItem51);

  // 目标卡片直接作为第 0 项！在原错误代码中返回 0 会被当作 falsy 而超时死锁
  const firstCardTarget = new MockElement('div', 'appmsg_card_context wx_profile_card');
  const firstNick = new MockElement('span', 'wx_profile_nickname', '锐多宝');
  const firstDesc = new MockElement('div', 'desc', '遥感之家 原名:遥感之家');
  firstCardTarget.appendChild(firstNick);
  firstCardTarget.appendChild(firstDesc);
  profileDialog51.appendChild(firstCardTarget);

  const insertBtn51 = new MockElement('button', '', '插入');
  insertBtn51.disabled = true;
  profileDialog51.appendChild(insertBtn51);
  doc51.body.appendChild(profileDialog51);

  firstCardTarget.dispatchEvent = () => {
    firstCardTarget.classList.add('wx_profile_card_selected');
    insertBtn51.disabled = false;
    return true;
  };
  insertBtn51.dispatchEvent = () => {
    const cardNode = new MockElement('mp-common-profile');
    cardNode.setAttribute('data-id', RUIDUOBAO_TARGET_DATA_ID);
    cardNode.setAttribute('data-nickname', RUIDUOBAO_TARGET_NICKNAME);
    editor51.appendChild(cardNode);
    return true;
  };

  const resIndexZero = await insertNativeRuiduobaoCard(session51, { timeoutMs: 3000 });
  assert(resIndexZero.ok, '目标卡片位于首项 (index=0) 时 pollUntil 准确返回 0 并成功插入，彻底避免死锁超时');

  // ---------------------------------------------------------------------------
  // 测试 5.2: isAtEnd 陷阱防御测试（假阳性拦截与 section 跨祖先穿透）
  // ---------------------------------------------------------------------------
  console.log('\n--- 测试组 5.2: isAtEnd 假阳性拦截与 section 跨祖先穿透测试 ---');
  // 如果在已有名片之后又添加了实质文本或图片，预检查必须判定 isAtEnd=false
  const middlePara = new MockElement('p', '', '在名片之后意外残留的正文结论段落');
  editor5.appendChild(middlePara);

  // 再次调用 insertNativeRuiduobaoCard，此时 preCheck 应当检测出名片不在末尾
  const resCardNotAtEnd = await inspectEditorFeatures(session5);
  assert(
    resCardNotAtEnd.profileCard.exists && resCardNotAtEnd.profileCard.isAtEnd === false,
    '深度 DOM 遍历成功识别名片后有实质内容，判定 isAtEnd=false，拦截假阳性！'
  );

  // 移除多余段落并留空占位
  middlePara.remove();
  const emptyPara = new MockElement('p', '', '   \n  ');
  editor5.appendChild(emptyPara);
  const resCardAtEnd = await inspectEditorFeatures(session5);
  assert(
    resCardAtEnd.profileCard.isAtEnd === true,
    '名片之后仅含空白占位时，准确识别 isAtEnd=true'
  );

  // 测试 5.3: 模拟 card 嵌套在 <section> 或 <div> 结尾，但 section 之后另有段落
  const nestedSection = new MockElement('section', 'article_section');
  const cardInsideSection = new MockElement('mp-common-profile');
  cardInsideSection.setAttribute('data-id', RUIDUOBAO_TARGET_DATA_ID);
  cardInsideSection.setAttribute('data-nickname', RUIDUOBAO_TARGET_NICKNAME);
  nestedSection.appendChild(cardInsideSection); // card 是 section 的末尾子节点！

  const subsequentPara = new MockElement('p', '', '这是 section 后续的真正文章结语段落');

  const { doc: doc53, win: win53 } = createMockEnvironment();
  const session53 = createMockSession(win53);
  const wrap53 = new MockElement('div', 'rich_media_content');
  const ed53 = new MockElement('div', 'ProseMirror');
  ed53.appendChild(nestedSection);
  ed53.appendChild(subsequentPara);
  wrap53.appendChild(ed53);
  doc53.body.appendChild(wrap53);

  const resNestedSection = await inspectEditorFeatures(session53);
  assert(
    resNestedSection.profileCard.exists && resNestedSection.profileCard.isAtEnd === false,
    'card 虽然是 section 的最后元素，但 section 之后仍有段落时，沿祖先逐层回溯成功判定 isAtEnd=false！'
  );

  // 测试 5.4: 纯搜索触发测试 (无历史项，原生 setter 赋值 + 点击 .weui-desktop-search__btn 按钮)
  console.log('\n--- 测试组 5.4: 纯搜索触发测试 (setter + 搜索按钮) ---');
  const { doc: doc54, win: win54 } = createMockEnvironment();
  const session54 = createMockSession(win54);
  const wrap54 = new MockElement('div', 'rich_media_content');
  const ed54 = new MockElement('div', 'ProseMirror');
  wrap54.appendChild(ed54);
  doc54.body.appendChild(wrap54);

  const tbBtn54 = new MockElement('button');
  tbBtn54.id = 'js_editor_insertProfile';
  doc54.body.appendChild(tbBtn54);

  const dlg54 = new MockElement('div', 'profile_dialog');
  const searchInput54 = new MockElement('input', 'weui-desktop-form__input');
  searchInput54.setAttribute('type', 'text');
  const searchBtn54 = new MockElement('button', 'weui-desktop-search__btn', '搜索');
  dlg54.appendChild(searchInput54);
  dlg54.appendChild(searchBtn54);

  let searchTriggered = false;
  searchBtn54.dispatchEvent = () => {
    searchTriggered = true;
    // 模拟搜索返回结果卡片
    const resCard54 = new MockElement('div', 'appmsg_card_context wx_profile_card');
    const nick54 = new MockElement('span', 'wx_profile_nickname', '锐多宝');
    const desc54 = new MockElement('div', 'desc', '原名：遥感之家 (全角冒号测试)');
    resCard54.appendChild(nick54);
    resCard54.appendChild(desc54);
    dlg54.appendChild(resCard54);

    resCard54.dispatchEvent = () => {
      resCard54.classList.add('wx_profile_card_selected');
      insertBtn54.disabled = false;
      return true;
    };
    return true;
  };

  const insertBtn54 = new MockElement('button', '', '插入');
  insertBtn54.disabled = true;
  dlg54.appendChild(insertBtn54);
  doc54.body.appendChild(dlg54);

  insertBtn54.dispatchEvent = () => {
    const cardNode = new MockElement('mp-common-profile');
    cardNode.setAttribute('data-id', RUIDUOBAO_TARGET_DATA_ID);
    cardNode.setAttribute('data-nickname', RUIDUOBAO_TARGET_NICKNAME);
    ed54.appendChild(cardNode);
    return true;
  };

  const resSearch = await insertNativeRuiduobaoCard(session54, { timeoutMs: 3000 });
  assert(resSearch.ok && searchTriggered, '无历史项时成功使用原生 setter + 触发搜索按钮并成功匹配插入名片');

  // 测试 5.5: 存在隐藏历史残留 .profile_dialog 实例时的活动弹窗穿透回归测试
  console.log('\n--- 测试组 5.5: 隐藏重复 .profile_dialog 穿透回归测试 ---');
  const { doc: doc55, win: win55 } = createMockEnvironment();
  const session55 = createMockSession(win55);
  const wrap55 = new MockElement('div', 'rich_media_content');
  const ed55 = new MockElement('div', 'ProseMirror');
  wrap55.appendChild(ed55);
  doc55.body.appendChild(wrap55);

  const tbBtn55 = new MockElement('button');
  tbBtn55.id = 'js_editor_insertProfile';
  doc55.body.appendChild(tbBtn55);

  // 1. 隐藏的前序残留对话框（display: none, offsetWidth=0）
  const hiddenDlg55 = new MockElement('div', 'profile_dialog');
  hiddenDlg55.style.display = 'none';
  hiddenDlg55.offsetWidth = 0;
  hiddenDlg55.offsetHeight = 0;
  hiddenDlg55.clientRectsCount = 0;
  const fakeInput = new MockElement('input', 'weui-desktop-form__input');
  hiddenDlg55.appendChild(fakeInput);
  doc55.body.appendChild(hiddenDlg55);

  // 2. 真正的活动可见对话框
  const activeDlg55 = new MockElement('div', 'profile_dialog');
  activeDlg55.style.display = 'block';
  activeDlg55.style.visibility = 'visible';
  activeDlg55.offsetWidth = 500;
  activeDlg55.offsetHeight = 400;
  activeDlg55.clientRectsCount = 1;
  const realInput55 = new MockElement('input', 'weui-desktop-form__input');
  realInput55.setAttribute('type', 'text');
  const realSearchBtn55 = new MockElement('button', 'weui-desktop-search__btn', '搜索');
  activeDlg55.appendChild(realInput55);
  activeDlg55.appendChild(realSearchBtn55);

  let activeSearchClicked = false;
  realSearchBtn55.dispatchEvent = () => {
    activeSearchClicked = true;
    const card55 = new MockElement('div', 'appmsg_card_context wx_profile_card');
    const nick55 = new MockElement('span', 'wx_profile_nickname', '锐多宝');
    const desc55 = new MockElement('div', 'desc', '原名:遥感之家');
    card55.appendChild(nick55);
    card55.appendChild(desc55);
    activeDlg55.appendChild(card55);

    card55.dispatchEvent = () => {
      card55.classList.add('wx_profile_card_selected');
      realInsertBtn55.disabled = false;
      return true;
    };
    return true;
  };

  const realInsertBtn55 = new MockElement('button', '', '插入');
  realInsertBtn55.disabled = true;
  activeDlg55.appendChild(realInsertBtn55);
  doc55.body.appendChild(activeDlg55);

  realInsertBtn55.dispatchEvent = () => {
    const cardNode = new MockElement('mp-common-profile');
    cardNode.setAttribute('data-id', RUIDUOBAO_TARGET_DATA_ID);
    cardNode.setAttribute('data-nickname', RUIDUOBAO_TARGET_NICKNAME);
    ed55.appendChild(cardNode);
    return true;
  };

  const resDupDlg = await insertNativeRuiduobaoCard(session55, { timeoutMs: 3000 });
  assert(
    resDupDlg.ok && activeSearchClicked,
    '存在隐藏历史残留 .profile_dialog 时，精准穿透定位活动可见实例并成功完成插入'
  );

  // 测试 5.6: nativeCardHtml 真实 section 包装模板快速注入测试
  console.log('\n--- 测试组 5.6: nativeCardHtml 真实 section 包装模板测试 ---');
  const { doc: doc56, win: win56 } = createMockEnvironment();
  const session56 = createMockSession(win56);
  const wrap56 = new MockElement('div', 'rich_media_content');
  const ed56 = new MockElement('div', 'ProseMirror');
  wrap56.appendChild(ed56);
  doc56.body.appendChild(wrap56);

  // 提供来自实测的带 section wrapper 的真实已证实模板
  const realSectionTemplateHtml = `<section class="custom_select_card_wrp mp_profile_iframe_wrp"><mp-common-profile class="js_uneditable custom_select_card mp_profile_iframe" data-pluginname="mpprofile" data-id="${RUIDUOBAO_TARGET_DATA_ID}" data-nickname="${RUIDUOBAO_TARGET_NICKNAME}" data-headimg="https://mmbiz.qpic.cn/head.jpg" contenteditable="false"></mp-common-profile></section>`;
  const resFallbackTpl = await insertNativeRuiduobaoCard(session56, {
    timeoutMs: 1000,
    nativeCardHtml: realSectionTemplateHtml,
    preferNativeTemplate: true
  });
  assert(
    resFallbackTpl.ok && resFallbackTpl.verified && resFallbackTpl.cardEvidence?.dataId === RUIDUOBAO_TARGET_DATA_ID,
    '通过外层 section 包装的真实 nativeCardHtml + preferNativeTemplate 模式快速无损注入正文末尾'
  );

  // 测试 5.7: 错 id 模板严格拒绝测试
  console.log('\n--- 测试组 5.7: 错 id 模板严格拒绝测试 ---');
  const wrongIdTemplateHtml = `<section><mp-common-profile data-id="WRONG_ID_123" data-nickname="${RUIDUOBAO_TARGET_NICKNAME}"></mp-common-profile></section>`;
  const { doc: doc57, win: win57 } = createMockEnvironment();
  const session57 = createMockSession(win57);
  const wrap57 = new MockElement('div', 'rich_media_content');
  const ed57 = new MockElement('div', 'ProseMirror');
  wrap57.appendChild(ed57);
  doc57.body.appendChild(wrap57);

  const resWrongId = await insertNativeRuiduobaoCard(session57, {
    timeoutMs: 500,
    nativeCardHtml: wrongIdTemplateHtml
  });
  assert(
    resWrongId.ok === false && resWrongId.details.includes('rejected'),
    '错误 data-id 的非法模板被严格拒绝，绝不静默放行'
  );

  // 测试 5.8: 包含 script 危险标签模板严格拦截测试
  console.log('\n--- 测试组 5.8: 包含 script 危险标签模板严格拦截测试 ---');
  const scriptTemplateHtml = `<section><mp-common-profile data-id="${RUIDUOBAO_TARGET_DATA_ID}" data-nickname="${RUIDUOBAO_TARGET_NICKNAME}"></mp-common-profile><script>alert(1)</script></section>`;
  const { doc: doc58, win: win58 } = createMockEnvironment();
  const session58 = createMockSession(win58);
  const wrap58 = new MockElement('div', 'rich_media_content');
  const ed58 = new MockElement('div', 'ProseMirror');
  wrap58.appendChild(ed58);
  doc58.body.appendChild(wrap58);

  const resScript = await insertNativeRuiduobaoCard(session58, {
    timeoutMs: 500,
    nativeCardHtml: scriptTemplateHtml
  });
  assert(
    resScript.ok === false && resScript.details.includes('forbidden script'),
    '包含 script 危险标签的模板被严格拦截'
  );

  // 测试 5.9: execCommand 失败时报错，杜绝 appendChild 假成功
  console.log('\n--- 测试组 5.9: execCommand 失败真实拦截测试 ---');
  const { doc: doc59, win: win59 } = createMockEnvironment();
  doc59.failExecCommand = true; // 模拟 execCommand 返回 false
  const session59 = createMockSession(win59);
  const wrap59 = new MockElement('div', 'rich_media_content');
  const ed59 = new MockElement('div', 'ProseMirror');
  wrap59.appendChild(ed59);
  doc59.body.appendChild(wrap59);

  const resFailCmd = await insertNativeRuiduobaoCard(session59, {
    timeoutMs: 500,
    nativeCardHtml: realSectionTemplateHtml,
    preferNativeTemplate: true
  });
  assert(
    resFailCmd.ok === false && resFailCmd.details.includes('execCommand insertHTML failed'),
    'execCommand 失败时明确报错，杜绝 appendChild 假成功'
  );

  // ---------------------------------------------------------------------------
  // 测试 6: inspectEditorFeatures 综合诊断
  // ---------------------------------------------------------------------------
  console.log('\n--- 测试组 6: inspectEditorFeatures 综合诊断 ---');
  const h1 = new MockElement('h1', 'article_title', complexTitle);
  editor5.insertBefore(h1, editor5.firstElementChild);

  const coverArea5 = new MockElement('div');
  coverArea5.id = 'js_cover_area';
  const cover5 = new MockElement('div', 'first_appmsg_cover');
  cover5.style.backgroundImage = 'url("https://mmbiz.qpic.cn/cover.jpg")';
  coverArea5.appendChild(cover5);
  doc5.body.appendChild(coverArea5);

  const inspection = await inspectEditorFeatures(session5);
  assert(inspection.editorExists, '巡检检测到编辑器存在');
  assert(inspection.titleH1.exists && inspection.titleH1.text === complexTitle, '巡检检测到 H1 且文本匹配');
  assert(inspection.cover.hasCover && inspection.cover.coverUrl === 'https://mmbiz.qpic.cn/cover.jpg', '巡检检测到封面有效 URL');
  assert(
    inspection.profileCard.exists && inspection.profileCard.isRealMpCommonProfile && inspection.profileCard.isAtEnd,
    '巡检检测到末尾原生名片且验证通过'
  );

  console.log(`\n=== 所有测试运行完毕：共 ${passCount} 项全部通过，${failCount} 项失败 ===\n`);
  if (failCount > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('测试运行异常:', err);
  process.exit(1);
});
