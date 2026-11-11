/**
 * scripts/editor-features.ts
 * 微信公众号编辑器高级功能模块 (纯净、强类型、高可诊断性、重构版)
 *
 * 核心功能与修复：
 * 1. evaluatePage: 严格捕获并抛出 CDP Runtime.evaluate exceptionDetails。
 * 2. ensureOriginalTitleH1: 正文开头保留完整原标题 H1 (无损更新、HTML escape、去重且唯一、标记编辑态验证)。
 * 3. setCoverFromFirstImage: 限定可见活动裁剪对话框结合 getClientRects/offsetParent 校验确认按钮，严格验证非空实际封面 URL。
 * 4. insertNativeRuiduobaoCard: 严格分离触发/只读轮询/单次点击/只读校验流程，对独立提取的 nickname 精确比对并排除旧号，
 *    通过 DOM 遍历/Range 深度验证 card 位于正文真正末尾 (无后续实质内容)，严格校验 mp-common-profile data-id=MzAwODU3NDc2Nw==。
 * 5. inspectEditorFeatures: 诊断并输出当前编辑器完整特征证据。
 */

import fs from 'node:fs';
import path from 'node:path';
import { pasteHtmlNatively } from './editor-input.ts';

export const BODY_EDITOR_SELECTOR = '.rich_media_content .ProseMirror';
export const COVER_AREA_SELECTOR = '#js_cover_area';
export const COVER_PREVIEW_SELECTOR = '#js_cover_area .first_appmsg_cover, #js_cover_area [style*="background-image"]';
export const COVER_SELECT_BUTTON_SELECTOR = '.js_selectCoverFromContent';
export const COVER_UPLOAD_BUTTON_SELECTOR = '#js_cover_area .js_imagedialog';
export const COVER_PICKER_DIALOG_SELECTOR = '.weui-desktop-dialog_img-picker';

export const PROFILE_TOOLBAR_BUTTON_SELECTOR = '#js_editor_insertProfile span, #js_editor_insertProfile';
export const PROFILE_DIALOG_SELECTOR = '.profile_dialog';

export const RUIDUOBAO_TARGET_DATA_ID = 'MzAwODU3NDc2Nw==';
export const RUIDUOBAO_TARGET_NICKNAME = '锐多宝';
export const RUIDUOBAO_DESC_KEYWORD = '原名:遥感之家';
export const EXCLUDED_NICKNAMES = ['锐多宝的地理空间'];

export interface EditorSession {
  cdp: {
    send: <T = any>(
      method: string,
      params?: Record<string, any>,
      options?: { sessionId?: string }
    ) => Promise<T>;
  };
  sessionId: string;
  targetId?: string;
}

export interface CdpEvaluateResult<T = any> {
  result?: {
    type?: string;
    value?: T;
    description?: string;
  };
  exceptionDetails?: {
    exceptionId?: number;
    text?: string;
    lineNumber?: number;
    columnNumber?: number;
    scriptId?: string;
    url?: string;
    stackTrace?: any;
    exception?: {
      type?: string;
      value?: any;
      description?: string;
    };
  };
}

export interface EnsureH1Options {
  timeoutMs?: number;
  forceUpdate?: boolean;
  customStyle?: string;
}

export interface EnsureH1Result {
  ok: boolean;
  alreadyExisted: boolean;
  inserted: boolean;
  updated: boolean;
  title: string;
  h1Text?: string;
  isFirstElement?: boolean;
  h1Html?: string;
  inEditorVerified: boolean;
  details: string;
  error?: string;
}

export interface SetCoverOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  coverFilePath?: string;
}

export interface SetCoverResult {
  ok: boolean;
  coverUrl?: string;
  pickerOpened: boolean;
  itemSelected: boolean;
  cropConfirmed: boolean;
  verified: boolean;
  details: string;
  error?: string;
}

export interface InsertCardOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  targetNickname?: string;
  targetDataId?: string;
  descKeyword?: string;
  excludedNicknames?: string[];
  nativeCardHtml?: string;
  nativeCardTemplateHtml?: string;
  preferNativeTemplate?: boolean;
}

export interface CardEvidence {
  tagName: string;
  dataId: string | null;
  dataNickname: string | null;
  isAtEnd: boolean;
  isRealMpCommonProfile: boolean;
  outerHtmlSnippet: string;
}

export interface InsertCardResult {
  ok: boolean;
  dialogOpened: boolean;
  cardFound: boolean;
  cardSelected: boolean;
  insertClicked: boolean;
  verified: boolean;
  cardEvidence?: CardEvidence;
  details: string;
  error?: string;
}

export interface EditorFeaturesInspection {
  editorExists: boolean;
  titleH1: {
    exists: boolean;
    count: number;
    text: string | null;
    isFirstElement: boolean;
    outerHtmlSnippet?: string;
  };
  cover: {
    hasCover: boolean;
    coverUrl: string | null;
    outerHtmlSnippet?: string;
  };
  profileCard: {
    exists: boolean;
    tagName: string | null;
    dataId: string | null;
    dataNickname: string | null;
    isRealMpCommonProfile: boolean;
    isAtEnd: boolean;
    outerHtmlSnippet?: string;
  };
  rawEditorTextSnippet: string;
}

/**
 * 异步睡眠
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * HTML 转义，安全处理 < > & " ' 符号
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * evaluatePage
 * 通过 CDP Runtime.evaluate 执行脚本，严格捕获并抛出 exceptionDetails
 */
export async function evaluatePage<T = any>(
  session: EditorSession,
  expressionOrFn: string | ((...args: any[]) => T),
  args?: any
): Promise<T> {
  const expression =
    typeof expressionOrFn === 'function'
      ? `(${expressionOrFn.toString()})(${args !== undefined ? JSON.stringify(args) : ''})`
      : expressionOrFn;

  const sendOptions = session.sessionId ? { sessionId: session.sessionId } : undefined;

  const res = await session.cdp.send<CdpEvaluateResult<T>>(
    'Runtime.evaluate',
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
    },
    sendOptions
  );

  if (res?.exceptionDetails) {
    const ex = res.exceptionDetails;
    const desc = ex.exception?.description || ex.text || 'Unknown script evaluation error';
    const err = new Error(`[evaluatePage] Execution exception: ${desc}`);
    (err as any).exceptionDetails = ex;
    throw err;
  }

  return res?.result?.value as T;
}

/**
 * 严格轮询：只读等待条件达成，绝不在此内掺杂带副作用的点击/修改。
 * 允许返回 0 或空字符串等有效值，仅在为 null、false 或 undefined 时判定为未满足。
 */
export async function pollUntil<T>(
  fn: () => Promise<T | null | false | undefined>,
  timeoutMs: number,
  intervalMs = 300,
  actionName = 'condition'
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fn();
    if (res !== null && res !== false && res !== undefined) return res;
    await sleep(intervalMs);
  }
  throw new Error(`Timeout after ${timeoutMs}ms waiting for: ${actionName}`);
}

/**
 * 深度判断节点是否真正位于编辑器末尾的共享纯逻辑 (统一供 preCheck, verifyResult, inspect 注入使用)
 * 1. 利用 Range 从 node 结束检测到 editor 结尾，检查文本与非装饰性多媒体标签。
 * 2. 沿 DOM 树向上遍历所有祖先直至 editor，穿透任意嵌套 section/div/wrapper，检查后续兄弟节点。
 * 3. 忽略 ProseMirror-separator 装饰占位与空白换行段落。
 */
export const IS_NODE_AT_EDITOR_END_JS = `
function isNodeAtEditorEnd(editor, node) {
  if (!editor || !node) return false;
  if (typeof editor.contains === 'function' && !editor.contains(node)) return false;

  // 1. 尝试 Range 检测：从 node 结束到 editor 结尾
  try {
    if (typeof document.createRange === 'function') {
      const range = document.createRange();
      range.setStartAfter(node);
      const endOffset = editor.childNodes ? editor.childNodes.length : (editor.children ? editor.children.length : 0);
      range.setEnd(editor, endOffset);
      const text = (range.toString() || '').replace(/[\\s\\u00A0\\r\\n]+/g, '');
      if (text.length > 0) return false;

      if (typeof range.cloneContents === 'function') {
        const frag = range.cloneContents();
        if (frag && typeof frag.querySelectorAll === 'function') {
          const media = Array.from(frag.querySelectorAll('img, mp-common-profile, table, video, audio, iframe'))
            .filter(m => !m.classList || !m.classList.contains('ProseMirror-separator'));
          if (media.length > 0) return false;
        }
      }
    }
  } catch (e) {
    // Range 异常时进入祖先逐层回溯
  }

  // 2. 沿 DOM 树从 node 向上遍历所有祖先直至 editor，检查每一层其后的后续兄弟节点
  let curr = node;
  while (curr && curr !== editor) {
    let sibling = curr.nextSibling || curr.nextElementSibling;
    while (sibling) {
      // 忽略 ProseMirror 分隔符
      if (sibling.classList && sibling.classList.contains('ProseMirror-separator')) {
        sibling = sibling.nextSibling || sibling.nextElementSibling;
        continue;
      }

      // 文本节点
      if (sibling.nodeType === 3) {
        const t = (sibling.textContent || '').replace(/[\\s\\u00A0\\r\\n]+/g, '');
        if (t.length > 0) return false;
      } else {
        // 元素节点
        const elemText = (sibling.textContent || '').replace(/[\\s\\u00A0\\r\\n]+/g, '');
        if (elemText.length > 0) return false;
        if (typeof sibling.querySelectorAll === 'function') {
          const media = Array.from(sibling.querySelectorAll('img, mp-common-profile, table, video, audio, iframe'))
            .filter(m => !m.classList || !m.classList.contains('ProseMirror-separator'));
          if (media.length > 0) return false;
        }
      }
      sibling = sibling.nextSibling || sibling.nextElementSibling;
    }
    curr = curr.parentNode;
  }

  return true;
}
`;

/**
 * 获取当前活动、可见且具有布局尺寸的 .profile_dialog，杜绝选取到隐藏或历史残留对话框
 */
export const GET_ACTIVE_PROFILE_DIALOG_JS = `
function getActiveProfileDialog() {
  const dlgs = Array.from(document.querySelectorAll(${JSON.stringify(PROFILE_DIALOG_SELECTOR)}));
  return dlgs.find(d => {
    const s = window.getComputedStyle(d);
    const visible = s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    const hasBox = (d.offsetWidth > 0 && d.offsetHeight > 0) || (d.getClientRects && d.getClientRects().length > 0);
    return visible && hasBox;
  }) || (dlgs.length > 0 ? dlgs[dlgs.length - 1] : null);
}
`;

/**
 * 获取当前活动、可见且标题为“选择图片”的对话框，杜绝选取到隐藏或历史残留对话框
 */
export const GET_VISIBLE_SELECT_IMAGE_DIALOG_JS = `
function getVisibleSelectImageDialog() {
  const dlgs = Array.from(document.querySelectorAll('.weui-desktop-dialog'));
  return dlgs.find(d => {
    const s = window.getComputedStyle(d);
    const visible = s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    const hasBox = (d.offsetWidth > 0 && d.offsetHeight > 0) || (d.getClientRects && d.getClientRects().length > 0);
    const title = d.querySelector('.weui-desktop-dialog__hd')?.textContent || d.textContent || '';
    return visible && hasBox && title.includes('选择图片');
  }) || null;
}
`;

/**
 * 1. ensureOriginalTitleH1
 * 正文开头保留完整原标题，一级标题样式，无损更新。
 * - 转义特殊符号，仅保留唯一的顶部原标题 H1。
 * - 保护正文原有内容，不破坏段落与内联图片。
 * - 明确标明属于编辑态校验，最终持久化由后续保存草稿保证。
 */
export async function ensureOriginalTitleH1(
  session: EditorSession,
  originalTitle: string,
  options: EnsureH1Options = {}
): Promise<EnsureH1Result> {
  const title = originalTitle.trim();
  const failed = (details: string, error = details): EnsureH1Result => ({ ok: false, alreadyExisted: false, inserted: false, updated: false, title, inEditorVerified: false, details, error });
  if (!title) return failed('Original title is empty', 'Empty title provided');
  try {
    const readTitle = () => evaluatePage<{ exists: boolean; count: number; text: string; first: boolean; nestedBlocks: boolean }>(session, `(() => {
      const editor = document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)});
      if (!editor) return { exists: false, count: 0, text: '', first: false, nestedBlocks: false };
      const first = editor.firstElementChild;
      return { exists: true, count: editor.querySelectorAll('h1').length, text: first?.textContent.trim() || '',
        first: first?.tagName === 'H1', nestedBlocks: !!first?.querySelector('section,div,p,h2,img,mp-common-profile') };
    })()`);
    const before = await readTitle();
    if (!before.exists) return failed(`Editor not found at ${BODY_EDITOR_SELECTOR}`, 'Editor missing');
    if (before.count > 1 || (before.first && before.nestedBlocks)) return failed('needs-content-refresh: 标题结构异常，请在原草稿上按源文完整重建，保留正文');
    const matched = before.first && before.count === 1 && before.text === title;
    const style = options.customStyle || 'font-size:22px;font-weight:bold;line-height:1.45;color:#1a1a1a;margin:0 0 24px;padding-bottom:12px;border-bottom:1px solid #ebebeb;text-align:left;';
    const h1Html = `<h1 class="article_title" style="${escapeHtml(style)}">${escapeHtml(title)}</h1>`;
    if (!matched || options.forceUpdate) {
      if (before.first) {
        if (session.targetId) await session.cdp.send('Target.activateTarget', { targetId: session.targetId });
        await evaluatePage(session, `(() => {
          const editor = document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)});
          editor.focus(); const range = document.createRange(); range.selectNodeContents(editor.firstElementChild);
          const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        })()`);
        await sleep(150);
        await session.cdp.send('Input.insertText', { text: title }, { sessionId: session.sessionId });
        await sleep(150);
      } else {
        await pasteHtmlNatively(session, h1Html, 'title');
      }
    }
    const after = await readTitle();
    const ok = after.first && after.count === 1 && after.text === title;
    return { ok, alreadyExisted: matched && !options.forceUpdate, inserted: !before.first, updated: before.first && (!matched || !!options.forceUpdate),
      title, h1Text: after.text, isFirstElement: after.first, h1Html, inEditorVerified: ok,
      details: ok ? '[In-Editor Verified] Complete title is the unique first H1; requires save and independent reopen' : `H1 native paste did not produce the expected title (count=${after.count}, first=${after.first}, titleMatches=${after.text === title})`,
      error: ok ? undefined : 'H1 verification failed after native paste' };
  } catch (error: any) {
    return failed(`Exception while ensuring H1: ${error.message}`, error.message);
  }
}

/**
 * 2. setCoverFromFirstImage
 * 从正文首图提取并完成封面裁剪设置。
 * - 在可见活动裁剪对话框内利用 getClientRects / offsetParent 查找可见确认按钮，杜绝全局盲查。
 * - 严格验证 #js_cover_area .first_appmsg_cover 的实际非空有效图片 URL。
 */
export async function setCoverFromFirstImage(
  session: EditorSession,
  options: SetCoverOptions = {}
): Promise<SetCoverResult> {
  const timeoutMs = options.timeoutMs ?? 25_000;
  const pollInterval = options.pollIntervalMs ?? 400;

  let pickerOpened = false;
  let itemSelected = false;
  let cropConfirmed = false;
  let verified = false;
  let coverUrl: string | undefined;

  try {
    // 步骤 0：预检查 #js_cover_area 是否已存在合法非空背景图片，已有则直接复用
    const existingCover = await evaluatePage<{ hasCover: boolean; coverUrl?: string }>(
      session,
      `
      (function() {
        const area = document.querySelector(${JSON.stringify(COVER_AREA_SELECTOR)});
        if (!area) return { hasCover: false };
        const coverEl = area.querySelector('.first_appmsg_cover') ||
                        area.querySelector('[style*="background-image"]') ||
                        document.querySelector('.first_appmsg_cover');
        if (!coverEl) return { hasCover: false };
        const style = window.getComputedStyle(coverEl);
        const bg = style.backgroundImage || coverEl.style.backgroundImage || '';
        const match = bg.match(/url\\(["']?([^"')]+)["']?\\)/i);
        const url = match ? match[1].trim() : '';
        if (url && url !== 'none' && !url.startsWith('data:image/svg') && url.length > 5) {
          return { hasCover: true, coverUrl: url };
        }
        return { hasCover: false };
      })()
    `
    );

    if (existingCover.hasCover && existingCover.coverUrl) {
      return {
        ok: true,
        coverUrl: existingCover.coverUrl,
        pickerOpened: false,
        itemSelected: false,
        cropConfirmed: false,
        verified: true,
        details: `Valid cover already present at #js_cover_area: ${existingCover.coverUrl}`,
      };
    }

    // 若指定了本地封面图片文件路径（针对正文无内嵌图片的文稿），直接调度本地文件上传
    if (options.coverFilePath) {
      return await setCoverFromFile(session, options.coverFilePath, options);
    }

    // 步骤 1：打开“从正文选择”弹窗（单次点击）
    const openRes = await evaluatePage<{ opened: boolean }>(
      session,
      `
      (function() {
        const btn = document.querySelector(${JSON.stringify(COVER_SELECT_BUTTON_SELECTOR)}) ||
                    document.querySelector('#js_cover_area .js_selectCoverFromContent') ||
                    document.querySelector('#js_cover_area .js_cover_btn_area') ||
                    document.querySelector('.js_cover_btn_area');
        if (!btn) return { opened: false };
        btn.scrollIntoView({ block: 'center' });
        btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return { opened: true };
      })()
    `
    );

    if (!openRes.opened) {
      return {
        ok: false,
        pickerOpened: false,
        itemSelected: false,
        cropConfirmed: false,
        verified: false,
        details: 'Cover selection button not found in page',
        error: 'Cover button missing',
      };
    }

    // 步骤 2：只读等待图片选择弹窗 .weui-desktop-dialog_img-picker 可见
    await pollUntil(
      async () => {
        return await evaluatePage<boolean>(
          session,
          `
          (function() {
            const picker = document.querySelector(${JSON.stringify(COVER_PICKER_DIALOG_SELECTOR)});
            if (!picker) return false;
            const style = window.getComputedStyle(picker);
            const visible = style.display !== 'none' && style.visibility !== 'hidden';
            const rects = picker.getClientRects ? picker.getClientRects().length : 1;
            return visible && rects > 0;
          })()
        `
        );
      },
      timeoutMs / 3,
      pollInterval,
      'Image picker dialog opening'
    );
    pickerOpened = true;

    // 步骤 3：只读等待图片列表加载出至少 1 个包含有效图片或 mask 的条目 (避免列表未加载立即失败)
    try {
      await pollUntil<{ itemCount: number }>(
        async () => {
          return await evaluatePage<{ itemCount: number } | null>(
            session,
            `
            (function() {
              const pickers = Array.from(document.querySelectorAll(${JSON.stringify(COVER_PICKER_DIALOG_SELECTOR)}));
              const picker = pickers.find(p => {
                const s = window.getComputedStyle(p);
                return s.display !== 'none' && s.visibility !== 'hidden';
              });
              if (!picker) return null;

              const items = Array.from(picker.querySelectorAll('li.appmsg_content_img_item, .appmsg_content_img_item, .weui-desktop-img-picker__item'));
              if (items.length === 0) return null;

              const first = items[0];
              const mask = first.querySelector('.apmsg_content_img_mask, [class*="mask"]') || first;
              const img = first.querySelector('img') || first;
              const src = (img.getAttribute && img.getAttribute('src')) || img.style?.backgroundImage || window.getComputedStyle(img).backgroundImage || '';

              if (mask || (src && src !== 'none')) {
                return { itemCount: items.length };
              }
              return null;
            })()
          `
          );
        },
        timeoutMs / 3,
        pollInterval,
        'Image picker list loaded with >= 1 items'
      );
    } catch (pollErr: any) {
      const diag = await evaluatePage<{ itemCount: number; modalSnippet: string; isVisible: boolean }>(
        session,
        `
        (function() {
          const picker = document.querySelector(${JSON.stringify(COVER_PICKER_DIALOG_SELECTOR)});
          if (!picker) return { itemCount: 0, modalSnippet: 'Picker node missing', isVisible: false };
          const s = window.getComputedStyle(picker);
          const isVisible = s.display !== 'none' && s.visibility !== 'hidden';
          const items = picker.querySelectorAll('li.appmsg_content_img_item, .appmsg_content_img_item, .weui-desktop-img-picker__item');
          return {
            itemCount: items.length,
            modalSnippet: (picker.innerText || '').slice(0, 200).replace(/\\s+/g, ' '),
            isVisible: isVisible
          };
        })()
      `
      );
      return {
        ok: false,
        pickerOpened: true,
        itemSelected: false,
        cropConfirmed: false,
        verified: false,
        details: `Image picker items failed to load (timeout). Diagnostic: itemCount=${diag.itemCount}, visible=${diag.isVisible}, modalText="${diag.modalSnippet}"`,
        error: `Image picker list empty: ${pollErr?.message || pollErr}`,
      };
    }

    // 单次点击当前可见 picker 内的首图 mask
    const maskClickRes = await evaluatePage<{ maskFound: boolean; details?: string }>(
      session,
      `
      (function() {
        const pickers = Array.from(document.querySelectorAll(${JSON.stringify(COVER_PICKER_DIALOG_SELECTOR)}));
        const picker = pickers.find(p => {
          const s = window.getComputedStyle(p);
          return s.display !== 'none' && s.visibility !== 'hidden';
        });
        if (!picker) return { maskFound: false, details: 'Visible picker missing' };

        const mask = picker.querySelector('.apmsg_content_img_mask') ||
                     picker.querySelector('li.appmsg_content_img_item .apmsg_content_img_mask') ||
                     picker.querySelector('li.appmsg_content_img_item');
        if (!mask) return { maskFound: false, details: 'Mask not found inside visible picker' };

        mask.scrollIntoView({ block: 'nearest' });
        if (typeof mask.click === 'function') {
          mask.click();
        } else {
          mask.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
        return { maskFound: true };
      })()
    `
    );

    if (!maskClickRes.maskFound) {
      return {
        ok: false,
        pickerOpened: true,
        itemSelected: false,
        cropConfirmed: false,
        verified: false,
        details: `Failed to find image mask inside picker: ${maskClickRes.details}`,
        error: 'Image mask missing',
      };
    }

    // 步骤 4：只读等待选中态出现且“下一步”按钮启用
    await pollUntil(
      async () => {
        return await evaluatePage<boolean>(
          session,
          `
          (function() {
            const picker = document.querySelector(${JSON.stringify(COVER_PICKER_DIALOG_SELECTOR)});
            if (!picker) return false;

            const selectedItem = picker.querySelector('li.appmsg_content_img_item.selected, .appmsg_content_img_item.selected');
            if (!selectedItem) return false;

            const buttons = Array.from(picker.querySelectorAll('button, a'));
            const nextBtn = buttons.find(b => b.textContent.trim() === '下一步');
            if (!nextBtn) return false;

            const isDisabled = nextBtn.disabled ||
              nextBtn.classList.contains('is-disabled') ||
              nextBtn.classList.contains('weui-desktop-btn_disabled') ||
              nextBtn.getAttribute('aria-disabled') === 'true';

            return !isDisabled;
          })()
        `
        );
      },
      timeoutMs / 3,
      pollInterval,
      'Image item selected & next button enabled'
    );
    itemSelected = true;

    // 步骤 5：单次点击“下一步”
    const nextClicked = await evaluatePage<boolean>(
      session,
      `
      (function() {
        const picker = document.querySelector(${JSON.stringify(COVER_PICKER_DIALOG_SELECTOR)});
        if (!picker) return false;
        const buttons = Array.from(picker.querySelectorAll('button, a'));
        const nextBtn = buttons.find(b => b.textContent.trim() === '下一步');
        if (!nextBtn) return false;

        nextBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        nextBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        nextBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return true;
      })()
    `
    );

    if (!nextClicked) {
      return {
        ok: false,
        pickerOpened: true,
        itemSelected: true,
        cropConfirmed: false,
        verified: false,
        details: 'Failed to click next button in picker',
        error: 'Next button click failed',
      };
    }

    // 步骤 6：等待活动裁剪对话框并单次点击可见确认按钮
    await sleep(600);
    const cropConfirmResult = await pollUntil<{ confirmed: boolean; text?: string }>(
      async () => {
        return await evaluatePage<{ confirmed: boolean; text?: string } | null>(
          session,
          `
          (function() {
            // 定位当前活动可见的裁剪类对话框，严格排除 profile_dialog 与隐藏祖先，绝不回退 document.body
            const dialogs = Array.from(document.querySelectorAll('.weui-desktop-dialog, .weui-desktop-dialog_img-picker, .cropper-dialog, [role="dialog"], .dialog'));
            const activeCropDialogs = dialogs.filter(d => {
              if (d.classList.contains('profile_dialog') || d.querySelector('#js_editor_insertProfile')) return false;
              const s = window.getComputedStyle(d);
              const visible = s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
              const hasBox = (d.offsetWidth > 0 && d.offsetHeight > 0) || (d.getClientRects && d.getClientRects().length > 0);
              return visible && hasBox;
            });

            if (activeCropDialogs.length === 0) return null;

            // 在活动裁剪对话框内查找可见完成/确认按钮并去重
            const candidateBtns = [];
            for (const container of activeCropDialogs) {
              const btns = Array.from(container.querySelectorAll('button, a.weui-desktop-btn, .weui-desktop-btn'));
              for (const b of btns) {
                const t = b.textContent.trim();
                if (t !== '完成' && t !== '确认' && t !== '确定') continue;
                const s = window.getComputedStyle(b);
                if (s.display === 'none' || s.visibility === 'hidden') continue;
                if (b.disabled || b.classList.contains('is-disabled') || b.classList.contains('weui-desktop-btn_disabled')) continue;
                const hasBox = (b.offsetWidth > 0) || (b.getClientRects && b.getClientRects().length > 0);
                if (hasBox && !candidateBtns.includes(b)) {
                  candidateBtns.push({ btn: b, container });
                }
              }
            }

            if (candidateBtns.length === 0) return null;
            if (candidateBtns.length > 1) {
              // 多个歧义按钮时优先最顶层容器内按钮，若同容器有多按钮则报歧义
              const topContainer = activeCropDialogs[activeCropDialogs.length - 1];
              const topBtns = candidateBtns.filter(c => c.container === topContainer);
              if (topBtns.length !== 1) return null;
              candidateBtns.splice(0, candidateBtns.length, topBtns[0]);
            }

            const target = candidateBtns[0].btn;
            target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
            target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return { confirmed: true, text: target.textContent.trim() };
          })()
        `
        );
      },
      timeoutMs / 3,
      pollInterval,
      'Active visible crop confirmation dialog and button'
    );
    cropConfirmed = cropConfirmResult.confirmed;

    // 步骤 7：只读验证封面背景图片 URL，必须非空且有效
    const coverVerify = await pollUntil<{ verified: boolean; bgUrl: string; outerHtmlSnippet: string }>(
      async () => {
        return await evaluatePage<{ verified: boolean; bgUrl: string; outerHtmlSnippet: string } | null>(
          session,
          `
          (function() {
            const area = document.querySelector(${JSON.stringify(COVER_AREA_SELECTOR)});
            if (!area) return null;

            const coverEl = area.querySelector('.first_appmsg_cover') ||
                            area.querySelector('[style*="background-image"]') ||
                            document.querySelector('.first_appmsg_cover');
            if (!coverEl) return null;

            const style = window.getComputedStyle(coverEl);
            const bg = style.backgroundImage || coverEl.style.backgroundImage || '';

            const match = bg.match(/url\\(["']?([^"')]+)["']?\\)/i);
            const url = match ? match[1].trim() : '';

            if (url && url !== 'none' && !url.startsWith('data:image/svg') && url.length > 5) {
              return {
                verified: true,
                bgUrl: url,
                outerHtmlSnippet: coverEl.outerHTML.slice(0, 150)
              };
            }
            return null;
          })()
        `
        );
      },
      8_000,
      pollInterval,
      'Cover background image URL populated'
    );

    verified = coverVerify.verified;
    coverUrl = coverVerify.bgUrl;

    return {
      ok: true,
      coverUrl,
      pickerOpened,
      itemSelected,
      cropConfirmed,
      verified,
      details: `Cover set successfully from first image. Background URL: ${coverUrl}`,
    };
  } catch (err: any) {
    return {
      ok: false,
      coverUrl,
      pickerOpened,
      itemSelected,
      cropConfirmed,
      verified,
      details: `Failed setting cover: ${err?.message || err}`,
      error: String(err?.message || err),
    };
  }
}

/**
 * 2b. setCoverFromFile
 * 从本地文件直接上传设置文章封面（针对无内嵌图片的文稿）。
 * 基于 J 实测 574 验证成功的完整 UI 链实现：
 * 1. 本地图片文件预检 (exists + non-empty) 与已有合法封面直通；
 * 2. 点击 #js_cover_area .js_imagedialog 打开“选择图片”弹窗；
 * 3. 限定在可见标题“选择图片”的对话框内定位 input[type="file"] 并通过 CDP setFileInputFiles 注入文件；
 * 4. 只读等待新图 .weui-desktop-img-picker__item 出现且具有 .selected，同时底部“下一步”按钮 enabled；
 * 5. 单次点击“下一步”；
 * 6. 只读等待标题“编辑封面”的裁剪对话框出现，定位 primary 按钮“确认”并单次点击；
 * 7. 严格验证 #js_cover_area .first_appmsg_cover 非空 CDN 背景 URL。
 */
export async function setCoverFromFile(
  session: EditorSession,
  coverFilePath: string,
  options: SetCoverOptions = {}
): Promise<SetCoverResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollInterval = options.pollIntervalMs ?? 400;

  const coverBaseName = path.basename(coverFilePath);
  const coverRawName = path.parse(coverFilePath).name;

  let pickerOpened = false;
  let itemSelected = false;
  let cropConfirmed = false;
  let verified = false;
  let coverUrl: string | undefined;

  try {
    // 步骤 0a：本地图片文件预检
    if (!coverFilePath || !fs.existsSync(coverFilePath)) {
      throw new Error(`Cover file not found on disk: "${coverFilePath}"`);
    }
    const stat = fs.statSync(coverFilePath);
    if (stat.size === 0) {
      throw new Error(`Cover file is empty (0 bytes): "${coverFilePath}"`);
    }

    // 步骤 0b：预检查 #js_cover_area 是否已存在合法非空背景图片，已有则直接复用
    const existingCover = await evaluatePage<{ hasCover: boolean; coverUrl?: string }>(
      session,
      `
      (function() {
        const area = document.querySelector(${JSON.stringify(COVER_AREA_SELECTOR)});
        if (!area) return { hasCover: false };
        const coverEl = area.querySelector('.first_appmsg_cover') ||
                        area.querySelector('[style*="background-image"]') ||
                        document.querySelector('.first_appmsg_cover');
        if (!coverEl) return { hasCover: false };
        const style = window.getComputedStyle(coverEl);
        const bg = style.backgroundImage || coverEl.style.backgroundImage || '';
        const match = bg.match(/url\\(["']?([^"')]+)["']?\\)/i);
        const url = match ? match[1].trim() : '';
        if (url && url !== 'none' && !url.startsWith('data:image/svg') && url.length > 5) {
          return { hasCover: true, coverUrl: url };
        }
        return { hasCover: false };
      })()
    `
    );

    if (existingCover.hasCover && existingCover.coverUrl) {
      return {
        ok: true,
        coverUrl: existingCover.coverUrl,
        pickerOpened: false,
        itemSelected: false,
        cropConfirmed: false,
        verified: true,
        details: `Valid cover already present at #js_cover_area: ${existingCover.coverUrl}`,
      };
    }

    // 步骤 1：打开“选择图片”弹窗
    const openRes = await evaluatePage<{ opened: boolean }>(
      session,
      `
      (function() {
        const btn = document.querySelector(${JSON.stringify(COVER_UPLOAD_BUTTON_SELECTOR)}) ||
                    document.querySelector('#js_cover_area .js_imagedialog') ||
                    document.querySelector('#js_cover_area button');
        if (!btn) return { opened: false };
        btn.scrollIntoView({ block: 'center' });
        if (typeof btn.click === 'function') {
          btn.click();
        } else {
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
        return { opened: true };
      })()
    `
    );

    if (!openRes.opened) {
      return {
        ok: false,
        pickerOpened: false,
        itemSelected: false,
        cropConfirmed: false,
        verified: false,
        details: 'Cover upload dialog trigger (#js_cover_area .js_imagedialog) not found',
        error: 'Cover upload button missing',
      };
    }

    // 步骤 2：只读等待可见“选择图片”对话框（严格通过 getClientRects + offsetWidth 校验）
    await pollUntil(
      async () => {
        return await evaluatePage<boolean>(
          session,
          `
          (function() {
            ${GET_VISIBLE_SELECT_IMAGE_DIALOG_JS}
            return !!getVisibleSelectImageDialog();
          })()
        `
        );
      },
      timeoutMs / 3,
      pollInterval,
      'Image upload dialog with title “选择图片” visible'
    );
    pickerOpened = true;

    // 步骤 3：在当前可见“选择图片”对话框内定位 input[type=”file”] 并通过 CDP DOM.setFileInputFiles 上传（绝不使用全局 document 兜底）
    const sendOptions = session.sessionId ? { sessionId: session.sessionId } : undefined;

    const beforeSnapshot = await evaluatePage<{ beforeCount: number; initialAssetIds: string[] }>(
      session,
      `
      (function() {
        ${GET_VISIBLE_SELECT_IMAGE_DIALOG_JS}
        const dlg = getVisibleSelectImageDialog();
        if (!dlg) return { beforeCount: 0, initialAssetIds: [] };
        const items = Array.from(dlg.querySelectorAll('li.weui-desktop-img-picker__item, .weui-desktop-img-picker__item'));
        const ids = items.map(it => it.getAttribute('data-id') || it.getAttribute('data-fileid') || it.querySelector('img')?.getAttribute('src') || '').filter(Boolean);
        return { beforeCount: items.length, initialAssetIds: ids };
      })()
    `
    );

    const fileInputObj = await session.cdp.send<{ result?: { objectId?: string }; exceptionDetails?: any }>(
      'Runtime.evaluate',
      {
        expression: `
          (function() {
            ${GET_VISIBLE_SELECT_IMAGE_DIALOG_JS}
            const dlg = getVisibleSelectImageDialog();
            if (!dlg) return null;

            const input = dlg.querySelector('a.single_upload_btn_container input[type="file"]') ||
                          dlg.querySelector('.webuploader-pick input[type="file"]') ||
                          dlg.querySelector('input[type="file"][accept*="image"]') ||
                          dlg.querySelector('input[type="file"]');
            if (!input) return null;
            const tag = (input.nodeName || input.tagName || '').toUpperCase();
            if (tag !== 'INPUT') return null;
            return input;
          })()
        `,
        returnByValue: false,
      },
      sendOptions
    );

    if (fileInputObj?.exceptionDetails) {
      throw new Error(`File input evaluation exception: ${fileInputObj.exceptionDetails.text || JSON.stringify(fileInputObj.exceptionDetails)}`);
    }

    if (!fileInputObj?.result?.objectId) {
      throw new Error('Upload input[type="file"] not found inside visible "选择图片" dialog');
    }

    await session.cdp.send(
      'DOM.setFileInputFiles',
      {
        objectId: fileInputObj.result.objectId,
        files: [coverFilePath],
      },
      sendOptions
    );

    // 步骤 4：只读等待新上传图片条目出现并处于 .selected 态，且弹窗底部“下一步”按钮处于启用状态
    await pollUntil(
      async () => {
        return await evaluatePage<boolean>(
          session,
          `
          (function() {
            ${GET_VISIBLE_SELECT_IMAGE_DIALOG_JS}
            const dlg = getVisibleSelectImageDialog();
            if (!dlg) return false;

            const items = Array.from(dlg.querySelectorAll('li.weui-desktop-img-picker__item, .weui-desktop-img-picker__item'));
            if (items.length === 0) return false;

            // 定位当前处于 selected 态的条目（微信上传或去重命中后会自动赋予 selected）
            const selectedItems = Array.from(dlg.querySelectorAll('li.weui-desktop-img-picker__item.selected, .weui-desktop-img-picker__item.selected'));
            if (selectedItems.length === 0) return false;
            const targetItem = selectedItems[0];

            // 严格验证当前 selected 身份是否确属本次上传文件：
            // 路径 A: 基于真实 DOM 证据的精确文件名全等匹配（支持同图去重复用）
            const expectedBase = ${JSON.stringify(coverBaseName)};
            const expectedRaw = ${JSON.stringify(coverRawName)};

            const nameEl = targetItem.querySelector('.weui-desktop-img-picker__name, [class*="name"], .title');
            const nameText = (nameEl ? nameEl.textContent : targetItem.textContent || '').trim();
            const itemTitle = (targetItem.getAttribute('title') || targetItem.getAttribute('data-name') || targetItem.getAttribute('data-filename') || '').trim();

            const isNameMatched = (nameText === expectedBase || nameText === expectedRaw) ||
                                  (itemTitle === expectedBase || itemTitle === expectedRaw) ||
                                  targetItem.textContent.trim() === expectedBase;

            // 路径 B: 确实新增了资产 ID 或条目总数增加
            const curAssetId = targetItem.getAttribute('data-id') || targetItem.getAttribute('data-fileid') || '';
            const initialIds = ${JSON.stringify(beforeSnapshot.initialAssetIds)};
            const isNewAsset = (curAssetId && !initialIds.includes(curAssetId)) || (items.length > ${beforeSnapshot.beforeCount});

            // 必须满足当前选中文档身份是本文件，杜绝选中无关旧图
            if (!isNameMatched && !isNewAsset) return false;

            // 检查缩略图就绪 (真实结构为 <i role="img" class="weui-desktop-img-picker__img-thumb" style="background-image:url(...)"> 或 img)
            const thumb = targetItem.querySelector('i.weui-desktop-img-picker__img-thumb, .weui-desktop-img-picker__img-thumb, [role="img"], img');
            let isReady = false;
            if (thumb) {
              const bg = thumb.style?.backgroundImage || window.getComputedStyle(thumb).backgroundImage || '';
              if (bg && bg !== 'none' && bg.includes('url(')) {
                isReady = true;
              } else if (thumb.tagName === 'IMG') {
                const src = thumb.src || thumb.getAttribute('src') || '';
                if (src && src !== 'none') isReady = true;
              }
            }
            if (!isReady) {
              const bgSelf = window.getComputedStyle(targetItem).backgroundImage || targetItem.style?.backgroundImage || '';
              if (bgSelf && bgSelf !== 'none' && bgSelf.includes('url(')) isReady = true;
            }
            if (!isReady) return false;

            // 检查底部“下一步”按钮是否处于启用状态
            const buttons = Array.from(dlg.querySelectorAll('button, a'));
            const nextBtn = buttons.find(b => b.textContent.trim() === '下一步');
            if (!nextBtn) return false;

            const isDisabled = nextBtn.disabled ||
              nextBtn.classList.contains('is-disabled') ||
              nextBtn.classList.contains('weui-desktop-btn_disabled') ||
              nextBtn.getAttribute('aria-disabled') === 'true';

            return !isDisabled;
          })()
        `
        );
      },
      timeoutMs / 2,
      pollInterval,
      'Uploaded image item selected and footer “下一步” button enabled'
    );
    itemSelected = true;

    // 单次点击“下一步”
    const nextClicked = await evaluatePage<boolean>(
      session,
      `
      (function() {
        ${GET_VISIBLE_SELECT_IMAGE_DIALOG_JS}
        const dlg = getVisibleSelectImageDialog();
        if (!dlg) return false;
        const buttons = Array.from(dlg.querySelectorAll('button, a'));
        const nextBtn = buttons.find(b => b.textContent.trim() === '下一步');
        if (!nextBtn) return false;
        if (typeof nextBtn.click === 'function') {
          nextBtn.click();
        } else {
          nextBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
        return true;
      })()
    `
    );

    if (!nextClicked) {
      throw new Error('Failed to click "下一步" button after image selection');
    }

    // 步骤 5：等待可见的“编辑封面”裁剪对话框，查找未禁用的 primary“确认”按钮并触发 mousedown -> mouseup -> click 序列
    await sleep(600);
    const cropConfirmResult = await pollUntil<{ confirmed: boolean; text?: string }>(
      async () => {
        return await evaluatePage<{ confirmed: boolean; text?: string } | null>(
          session,
          `
          (function() {
            const dialogs = Array.from(document.querySelectorAll('.weui-desktop-dialog, .cropper-dialog, [role="dialog"], .dialog'));
            const cropDlg = dialogs.find(d => {
              if (d.classList.contains('profile_dialog')) return false;
              const s = window.getComputedStyle(d);
              const visible = s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
              const hasBox = (d.offsetWidth > 0 && d.offsetHeight > 0) || (d.getClientRects && d.getClientRects().length > 0);
              const title = d.querySelector('.weui-desktop-dialog__hd, .dialog_hd, h3, h4')?.textContent || d.textContent || '';
              return visible && hasBox && (title.includes('编辑封面') || title.includes('裁剪') || d.classList.contains('cropper-dialog'));
            });

            if (!cropDlg) return null;

            // 查找可见且已启用的确认按钮（严格检查 aria-disabled，优先锁定 .weui-desktop-btn_primary）
            const btns = Array.from(cropDlg.querySelectorAll('button, a.weui-desktop-btn, .weui-desktop-btn'));
            const enabledBtns = btns.filter(b => {
              const t = b.textContent.trim();
              if (t !== '确认' && t !== '完成' && t !== '确定') return false;
              const s = window.getComputedStyle(b);
              const visible = (b.offsetParent !== null || b.offsetWidth > 0 || (b.getClientRects && b.getClientRects().length > 0)) &&
                              s.display !== 'none' && s.visibility !== 'hidden';
              const isAriaDisabled = b.getAttribute('aria-disabled') === 'true';
              const isDisabled = b.disabled || b.classList.contains('is-disabled') || b.classList.contains('weui-desktop-btn_disabled') || isAriaDisabled;
              return visible && !isDisabled;
            });

            if (enabledBtns.length === 0) return null;

            // 锁定唯一的 primary 按钮
            const confirmBtn = enabledBtns.find(b => b.classList.contains('weui-desktop-btn_primary') || b.classList.contains('btn_primary')) ||
                               enabledBtns[enabledBtns.length - 1];

            // 按照 J 实测严格单次派发 mousedown -> mouseup -> click 序列（绝不再调用二次 .click()）
            confirmBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            confirmBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
            confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return { confirmed: true, text: confirmBtn.textContent.trim() };
          })()
        `
        );
      },
      timeoutMs / 2,
      pollInterval,
      'Crop confirmation dialog "编辑封面" with primary button "确认"'
    );
    cropConfirmed = cropConfirmResult.confirmed;

    // 只读等待裁剪对话框真正关闭并提交
    await pollUntil(
      async () => {
        return await evaluatePage<boolean>(
          session,
          `
          (function() {
            const dialogs = Array.from(document.querySelectorAll('.weui-desktop-dialog, .cropper-dialog, [role="dialog"], .dialog'));
            const openCrop = dialogs.find(d => {
              if (d.classList.contains('profile_dialog')) return false;
              const s = window.getComputedStyle(d);
              const visible = s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
              const hasBox = (d.offsetWidth > 0 && d.offsetHeight > 0) || (d.getClientRects && d.getClientRects().length > 0);
              const title = d.querySelector('.weui-desktop-dialog__hd, .dialog_hd, h3, h4')?.textContent || d.textContent || '';
              return visible && hasBox && (title.includes('编辑封面') || title.includes('裁剪') || d.classList.contains('cropper-dialog'));
            });
            return !openCrop;
          })()
        `
        );
      },
      timeoutMs / 3,
      pollInterval,
      'Crop dialog closed after confirm'
    );

    // 步骤 6：只读验证封面背景图片 URL，必须非空且有效
    const coverVerify = await pollUntil<{ verified: boolean; bgUrl: string; outerHtmlSnippet: string }>(
      async () => {
        return await evaluatePage<{ verified: boolean; bgUrl: string; outerHtmlSnippet: string } | null>(
          session,
          `
          (function() {
            const area = document.querySelector(${JSON.stringify(COVER_AREA_SELECTOR)});
            if (!area) return null;

            const coverEl = area.querySelector('.first_appmsg_cover') ||
                            area.querySelector('[style*="background-image"]') ||
                            document.querySelector('.first_appmsg_cover');
            if (!coverEl) return null;

            const style = window.getComputedStyle(coverEl);
            const bg = style.backgroundImage || coverEl.style.backgroundImage || '';

            const match = bg.match(/url\\(["']?([^"')]+)["']?\\)/i);
            const url = match ? match[1].trim() : '';

            if (url && url !== 'none' && !url.startsWith('data:image/svg') && url.length > 5) {
              return {
                verified: true,
                bgUrl: url,
                outerHtmlSnippet: coverEl.outerHTML.slice(0, 150)
              };
            }
            return null;
          })()
        `
        );
      },
      20_000,
      pollInterval,
      'Cover background image URL populated after file upload'
    );

    verified = coverVerify.verified;
    coverUrl = coverVerify.bgUrl;

    return {
      ok: true,
      coverUrl,
      pickerOpened,
      itemSelected,
      cropConfirmed,
      verified,
      details: `Cover uploaded and set successfully from file: ${coverFilePath}. Background URL: ${coverUrl}`,
    };
  } catch (err: any) {
    return {
      ok: false,
      coverUrl,
      pickerOpened,
      itemSelected,
      cropConfirmed,
      verified,
      details: `Failed setting cover from file: ${err?.message || err}`,
      error: String(err?.message || err),
    };
  }
}

/**
 * 3. insertNativeRuiduobaoCard
 * 核心：调用微信官方原生“账号名片”组件插入【锐多宝】名片。
 * 关键重构与防御机制：
 * - 流程严格拆分为：单次触发搜索 -> 只读等待精准候选 -> 单次点击候选卡片 -> 只读等待选中与底部按钮启用 -> 单次点击插入 -> 严格末尾只读校验。
 * - 候选卡片匹配：对独立提取的 nickname 进行 === "锐多宝" 严格匹配，排除迁移旧号；desc 匹配 "原名:遥感之家"。
 * - 正文末尾判定 (isAtEnd)：检查 card 之后是否存在实质文本或多媒体标签，只允许空占位。
 * - 验证：必须为真实的 mp-common-profile data-id=MzAwODU3NDc2Nw== data-nickname=锐多宝。
 */
export async function insertNativeRuiduobaoCard(
  session: EditorSession,
  options: InsertCardOptions = {}
): Promise<InsertCardResult> {
  const timeoutMs = options.timeoutMs ?? 25_000;
  const pollInterval = options.pollIntervalMs ?? 400;
  const targetNickname = options.targetNickname ?? RUIDUOBAO_TARGET_NICKNAME;
  const targetDataId = options.targetDataId ?? RUIDUOBAO_TARGET_DATA_ID;
  const descKeyword = options.descKeyword ?? RUIDUOBAO_DESC_KEYWORD;
  const excludedNicknames = options.excludedNicknames ?? EXCLUDED_NICKNAMES;
  const nativeHtml = options.nativeCardHtml || options.nativeCardTemplateHtml;

  let dialogOpened = false;
  let cardFound = false;
  let cardSelected = false;
  let insertClicked = false;
  let verified = false;
  let cardEvidence: CardEvidence | undefined;

  // 严格校验并执行原生模板注入
  const applyNativeTemplateFallback = async (contextMsg: string): Promise<InsertCardResult | null> => {
    if (!nativeHtml) return null;
    const tpl = nativeHtml.trim();

    // 1. 通过页面上下文解析 DOM 树进行精确结构与属性验证（允许已观察外层 section wrapper，恰好包含 1 个合法 mp-common-profile）
    const parseRes = await evaluatePage<{
      valid: boolean;
      cardCount: number;
      actualId?: string;
      actualNickname?: string;
      reason?: string;
    }>(
      session,
      `
      (function() {
        const tpl = ${JSON.stringify(tpl)};
        const temp = document.createElement('template');
        temp.innerHTML = tpl;
        const container = temp.content || temp;

        // 严禁 script 标签
        if (container.querySelector('script')) {
          return { valid: false, cardCount: 0, reason: 'Contains forbidden script tag' };
        }

        // 恰好必须包含 1 个 mp-common-profile 原生名片节点（支持外层 section wrapper）
        const cards = Array.from(container.querySelectorAll('mp-common-profile'));
        if (cards.length !== 1) {
          return {
            valid: false,
            cardCount: cards.length,
            reason: 'Expected exactly 1 mp-common-profile element, found ' + cards.length
          };
        }

        const card = cards[0];
        const actualId = card.getAttribute('data-id');
        const actualNickname = card.getAttribute('data-nickname');

        if (actualId !== ${JSON.stringify(targetDataId)} || actualNickname !== ${JSON.stringify(targetNickname)}) {
          return {
            valid: false,
            cardCount: 1,
            actualId: actualId,
            actualNickname: actualNickname,
            reason: 'Attribute mismatch: data-id=' + actualId + ' data-nickname=' + actualNickname
          };
        }

        return { valid: true, cardCount: 1, actualId: actualId, actualNickname: actualNickname };
      })()
    `
    );

    if (!parseRes.valid) {
      throw new Error(`Provided nativeCardHtml rejected: ${parseRes.reason}`);
    }

    // 2. 将选区折叠至正文末尾，执行 ProseMirror 原生 execCommand('insertHTML') 事务，杜绝 appendChild 假成功
    const inserted = await evaluatePage<{ ok: boolean; reason?: string }>(
      session,
      `
      (function() {
        const editor = document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)});
        if (!editor) return { ok: false, reason: 'Editor missing' };
        editor.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(range);
        }

        let cmdOk = false;
        try {
          cmdOk = document.execCommand('insertHTML', false, ${JSON.stringify(tpl)});
        } catch(e) {
          cmdOk = false;
        }

        if (!cmdOk) {
          return { ok: false, reason: 'document.execCommand insertHTML returned false' };
        }

        editor.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          inputType: 'insertHTML',
          data: ${JSON.stringify(tpl)}
        }));

        return { ok: true };
      })()
    `
    );

    if (!inserted.ok) {
      throw new Error(`execCommand insertHTML failed: ${inserted.reason}`);
    }

    const evidence = await evaluatePage<CardEvidence | null>(
      session,
      `
      (function() {
        const editor = document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)});
        if (!editor) return null;
        const cards = Array.from(editor.querySelectorAll('mp-common-profile'));
        if (cards.length === 0) return null;
        const card = cards[cards.length - 1];
        if (card.getAttribute('data-id') !== ${JSON.stringify(targetDataId)}) return null;
        if (card.getAttribute('data-nickname') !== ${JSON.stringify(targetNickname)}) return null;

        ${IS_NODE_AT_EDITOR_END_JS}
        const isAtEnd = isNodeAtEditorEnd(editor, card);
        if (!isAtEnd) return null;

        return {
          tagName: card.tagName,
          dataId: card.getAttribute('data-id'),
          dataNickname: card.getAttribute('data-nickname'),
          isAtEnd: isAtEnd,
          isRealMpCommonProfile: card.tagName.toLowerCase() === 'mp-common-profile',
          outerHtmlSnippet: card.outerHTML.slice(0, 150)
        };
      })()
    `
    );

    if (evidence && evidence.dataId === targetDataId && evidence.isAtEnd) {
      return {
        ok: true,
        dialogOpened,
        cardFound: true,
        cardSelected: true,
        insertClicked: true,
        verified: true,
        cardEvidence: evidence,
        details: `${contextMsg}: Verified native mp-common-profile successfully inserted at editor end`,
      };
    }
    return null;
  };

  try {
    // 步骤 0：预检查正文结尾是否已合法存在目标名片
    const preCheck = await evaluatePage<{
      hasCard: boolean;
      evidence?: CardEvidence;
    }>(
      session,
      `
      (function() {
        const editor = document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)});
        if (!editor) return { hasCard: false };

        const targetDataId = ${JSON.stringify(targetDataId)};
        const targetNickname = ${JSON.stringify(targetNickname)};

        const cards = Array.from(editor.querySelectorAll('mp-common-profile'));
        if (cards.length === 0) return { hasCard: false };

        // 仅检验末尾的 card
        const card = cards[cards.length - 1];
        const dataId = card.getAttribute('data-id');
        const dataNickname = card.getAttribute('data-nickname');
        if (dataId !== targetDataId || dataNickname !== targetNickname) {
          return { hasCard: false };
        }

        ${IS_NODE_AT_EDITOR_END_JS}
        const isAtEnd = isNodeAtEditorEnd(editor, card);

        return {
          hasCard: isAtEnd,
          evidence: {
            tagName: card.tagName,
            dataId: dataId,
            dataNickname: dataNickname,
            isAtEnd: isAtEnd,
            isRealMpCommonProfile: card.tagName.toLowerCase() === 'mp-common-profile',
            outerHtmlSnippet: card.outerHTML.slice(0, 150)
          }
        };
      })()
    `
    );

    if (preCheck.hasCard && preCheck.evidence?.isRealMpCommonProfile) {
      return {
        ok: true,
        dialogOpened: false,
        cardFound: true,
        cardSelected: true,
        insertClicked: false,
        verified: true,
        cardEvidence: preCheck.evidence,
        details: `Native profile card already present and verified at editor end with data-id=${targetDataId}`,
      };
    }

    // 若显式指定 preferNativeTemplate 且存在有效模板，直接执行已证实的原生注入路径（批量省去弹窗等待）
    if (options.preferNativeTemplate && nativeHtml) {
      const directRes = await applyNativeTemplateFallback('PreferNativeTemplate mode');
      if (directRes) return directRes;
    }

    // 步骤 1：光标移至正文末尾（单次执行）
    await evaluatePage(
      session,
      `
      (function() {
        const editor = document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)});
        if (!editor) return;
        editor.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(range);
        }
      })()
    `
    );

    // 步骤 2：单次点击顶栏“账号名片”打开弹窗
    const openRes = await evaluatePage<{ opened: boolean }>(
      session,
      `
      (function() {
        const btn = document.querySelector(${JSON.stringify(PROFILE_TOOLBAR_BUTTON_SELECTOR)}) ||
                    document.querySelector('#js_editor_insertProfile');
        if (!btn) return { opened: false };
        btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return { opened: true };
      })()
    `
    );

    if (!openRes.opened) {
      if (nativeHtml) {
        const fbRes = await applyNativeTemplateFallback('Toolbar missing, fallback to native template');
        if (fbRes) return fbRes;
      }
      return {
        ok: false,
        dialogOpened: false,
        cardFound: false,
        cardSelected: false,
        insertClicked: false,
        verified: false,
        details: 'Toolbar profile button (#js_editor_insertProfile) not found',
        error: 'Profile toolbar button missing',
      };
    }

    // 步骤 3：只读等待活动可见的 .profile_dialog
    await pollUntil(
      async () => {
        return await evaluatePage<boolean>(
          session,
          `
          (function() {
            ${GET_ACTIVE_PROFILE_DIALOG_JS}
            const dlg = getActiveProfileDialog();
            if (!dlg) return false;
            const style = window.getComputedStyle(dlg);
            return style.display !== 'none' && style.visibility !== 'hidden';
          })()
        `
        );
      },
      timeoutMs / 3,
      pollInterval,
      'Active visible profile dialog'
    );
    dialogOpened = true;

    // 步骤 4：单次触发显式搜索（使用原生 setter 赋值并点击当前 dialog 唯一可见搜索按钮，不依赖 history 避免分支短路）
    await evaluatePage(
      session,
      `
      (function() {
        ${GET_ACTIVE_PROFILE_DIALOG_JS}
        const dlg = getActiveProfileDialog();
        if (!dlg) return;

        const targetNickname = ${JSON.stringify(targetNickname)};

        const searchInput = dlg.querySelector('input[type="text"], input[type="search"], .weui-desktop-form__input, input');
        if (searchInput) {
          searchInput.focus();
          const nativeSetter = (window.HTMLInputElement && Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set) ||
                               Object.getOwnPropertyDescriptor(Object.getPrototypeOf(searchInput) || {}, 'value')?.set;
          if (nativeSetter) {
            nativeSetter.call(searchInput, targetNickname);
          } else {
            searchInput.value = targetNickname;
          }
          searchInput.dispatchEvent(new Event('input', { bubbles: true }));
          searchInput.dispatchEvent(new Event('change', { bubbles: true }));

          // 严格只用当前活动可见 dialog 内唯一的 .weui-desktop-search__btn 搜索按钮
          const searchBtns = Array.from(dlg.querySelectorAll('.weui-desktop-search__btn')).filter(b => {
            const s = window.getComputedStyle(b);
            return s.display !== 'none' && s.visibility !== 'hidden';
          });
          const searchBtn = searchBtns.length === 1 ? searchBtns[0] : null;

          if (searchBtn) {
            if (typeof searchBtn.click === 'function') {
              searchBtn.click();
            } else {
              searchBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            }
          } else {
            // 辅以 Enter 键盘事件
            searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            searchInput.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            searchInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          }
        }
      })()
    `
    );

    // 步骤 5：只读等待目标候选卡片加载就绪并定位其索引
    const candidateIndex = await pollUntil<number>(
      async () => {
        return await evaluatePage<number | null>(
          session,
          `
          (function() {
            ${GET_ACTIVE_PROFILE_DIALOG_JS}
            const dlg = getActiveProfileDialog();
            if (!dlg) return null;

            const targetNickname = ${JSON.stringify(targetNickname)};
            const descKeyword = ${JSON.stringify(descKeyword)};
            const excludedList = ${JSON.stringify(excludedNicknames)};

            const cards = Array.from(dlg.querySelectorAll('.appmsg_card_context.wx_profile_card, .wx_profile_card, .profile_item'));
            if (cards.length === 0) return null;

            for (let i = 0; i < cards.length; i++) {
              const card = cards[i];

              // 独立提取 nickname 节点文本
              const nicknameEl = card.querySelector('.nickname, .wx_profile_nickname, .title') || card;
              const nicknameText = (nicknameEl.textContent || '').trim();

              // 严格比对：nickname 必须严格等于 targetNickname ('锐多宝')，绝不能使用 startsWith
              if (nicknameText !== targetNickname) continue;

              // 排除名单检查：针对 nickname 进行排除（防止命中 '锐多宝的地理空间'）
              if (excludedList.includes(nicknameText)) continue;

              // 提取 desc 并归一化全角冒号与空格比对（如 '原名:遥感之家'）
              const descEl = card.querySelector('.desc, .wx_profile_desc, p') || card;
              const descText = (descEl.textContent || card.textContent || '').trim();
              const normDesc = descText.replace(/：/g, ':').replace(/\\s+/g, '');
              const normKeyword = descKeyword ? descKeyword.replace(/：/g, ':').replace(/\\s+/g, '') : '';
              if (normKeyword && !normDesc.includes(normKeyword)) continue;

              return i; // 找到目标卡片的索引
            }

            return null;
          })()
        `
        );
      },
      timeoutMs / 2,
      pollInterval,
      'Exact Ruiduobao candidate card loaded'
    );
    cardFound = true;

    // 步骤 6：单次点击目标卡片以激活选中态
    await evaluatePage(
      session,
      `
      (function() {
        ${GET_ACTIVE_PROFILE_DIALOG_JS}
        const dlg = getActiveProfileDialog();
        if (!dlg) return;
        const cards = Array.from(dlg.querySelectorAll('.appmsg_card_context.wx_profile_card, .wx_profile_card, .profile_item'));
        const target = cards[${candidateIndex}];
        if (target) {
          target.scrollIntoView({ block: 'nearest' });
          if (typeof target.click === 'function') {
            target.click();
          } else {
            target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          }
        }
      })()
    `
    );

    // 步骤 7：只读等待目标卡片具备 selected 类且弹窗底部的“插入”按钮处于启用状态
    await pollUntil(
      async () => {
        return await evaluatePage<boolean>(
          session,
          `
          (function() {
            ${GET_ACTIVE_PROFILE_DIALOG_JS}
            const dlg = getActiveProfileDialog();
            if (!dlg) return false;

            const cards = Array.from(dlg.querySelectorAll('.appmsg_card_context.wx_profile_card, .wx_profile_card, .profile_item'));
            const target = cards[${candidateIndex}];
            if (!target) return false;

            const isSelected = target.classList.contains('wx_profile_card_selected') ||
                              target.classList.contains('selected') ||
                              !!target.querySelector('.selected');
            if (!isSelected) return false;

            const ft = dlg.querySelector('.weui-desktop-dialog__ft') || dlg;
            const insertBtn = Array.from(ft.querySelectorAll('button, a')).find(b => {
              const t = b.textContent.trim();
              return t === '插入' || t === '确定';
            });
            if (!insertBtn) return false;

            const isDisabled = insertBtn.disabled ||
              insertBtn.classList.contains('is-disabled') ||
              insertBtn.classList.contains('weui-desktop-btn_disabled') ||
              insertBtn.getAttribute('aria-disabled') === 'true';

            return !isDisabled;
          })()
        `
        );
      },
      8_000,
      pollInterval,
      'Card selected and footer insert button enabled'
    );
    cardSelected = true;

    // 步骤 8：单次点击弹窗底部“插入”按钮
    const insertClickRes = await evaluatePage<boolean>(
      session,
      `
      (function() {
        ${GET_ACTIVE_PROFILE_DIALOG_JS}
        const dlg = getActiveProfileDialog();
        if (!dlg) return false;

        const ft = dlg.querySelector('.weui-desktop-dialog__ft') || dlg;
        const insertBtn = Array.from(ft.querySelectorAll('button, a')).find(b => {
          const t = b.textContent.trim();
          return t === '插入' || t === '确定';
        });
        if (!insertBtn) return false;

        if (typeof insertBtn.click === 'function') {
          insertBtn.click();
        } else {
          insertBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
        return true;
      })()
    `
    );
    insertClicked = insertClickRes;

    // 步骤 9：只读严格验证正文末尾已存在真正的 mp-common-profile[data-id="MzAwODU3NDc2Nw=="][data-nickname="锐多宝"]
    const verifyResult = await pollUntil<CardEvidence>(
      async () => {
        return await evaluatePage<CardEvidence | null>(
          session,
          `
          (function() {
            const editor = document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)});
            if (!editor) return null;

            const targetDataId = ${JSON.stringify(targetDataId)};
            const targetNickname = ${JSON.stringify(targetNickname)};

            const cards = Array.from(editor.querySelectorAll('mp-common-profile'));
            if (cards.length === 0) return null;

            // 取正文中最新插入的尾部 card
            const profileNode = cards[cards.length - 1];
            const dataId = profileNode.getAttribute('data-id');
            const dataNickname = profileNode.getAttribute('data-nickname');

            if (dataId !== targetDataId || dataNickname !== targetNickname) {
              return null;
            }

            ${IS_NODE_AT_EDITOR_END_JS}
            const isAtEnd = isNodeAtEditorEnd(editor, profileNode);
            if (!isAtEnd) return null;

            return {
              tagName: profileNode.tagName,
              dataId: dataId,
              dataNickname: dataNickname,
              isAtEnd: isAtEnd,
              isRealMpCommonProfile: profileNode.tagName.toLowerCase() === 'mp-common-profile',
              outerHtmlSnippet: profileNode.outerHTML.slice(0, 150)
            };
          })()
        `
        );
      },
      8_000,
      pollInterval,
      'Real mp-common-profile verified at editor end'
    );

    verified = verifyResult.isRealMpCommonProfile && verifyResult.dataId === targetDataId && verifyResult.isAtEnd;
    cardEvidence = verifyResult;

    return {
      ok: verified,
      dialogOpened,
      cardFound,
      cardSelected,
      insertClicked,
      verified,
      cardEvidence,
      details: `Native profile card inserted and strictly verified: data-id=${targetDataId}, nickname=${targetNickname}`,
    };
  } catch (err: any) {
    // 若此前打开过弹窗，在回退前尝试关闭当前活动弹窗
    if (dialogOpened) {
      await evaluatePage(
        session,
        `
        (function() {
          ${GET_ACTIVE_PROFILE_DIALOG_JS}
          const dlg = getActiveProfileDialog();
          if (!dlg) return;
          const closeBtn = dlg.querySelector('button.weui-desktop-icon-btn_close, .weui-desktop-icon-btn[title="关闭"], button.weui-desktop-icon-btn, .weui-desktop-dialog__close-btn');
          if (closeBtn && typeof closeBtn.click === 'function') closeBtn.click();
        })()
      `
      ).catch(() => {});
    }

    // 授权备选回退：使用经过严格校验的原生模板进行高保真无损注入
    if (nativeHtml) {
      try {
        const fbRes = await applyNativeTemplateFallback('Toolbar flow failed, fallback to native template');
        if (fbRes) return fbRes;
      } catch (fbErr: any) {
        return {
          ok: false,
          dialogOpened,
          cardFound: false,
          cardSelected: false,
          insertClicked: false,
          verified: false,
          cardEvidence,
          details: `Toolbar failed (${err?.message || err}) and fallback template rejected: ${fbErr?.message || fbErr}`,
          error: String(fbErr?.message || fbErr),
        };
      }
    }

    return {
      ok: false,
      dialogOpened,
      cardFound,
      cardSelected,
      insertClicked,
      verified,
      cardEvidence,
      details: `Failed to insert native profile card: ${err?.message || err}`,
      error: String(err?.message || err),
    };
  }
}

/**
 * 4. inspectEditorFeatures
 * 诊断并输出当前编辑器完整特征证据，供巡检与集成审核
 */
export async function inspectEditorFeatures(
  session: EditorSession
): Promise<EditorFeaturesInspection> {
  return await evaluatePage<EditorFeaturesInspection>(
    session,
    `
    (function() {
      const editor = document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)});
      if (!editor) {
        return {
          editorExists: false,
          titleH1: { exists: false, count: 0, text: null, isFirstElement: false },
          cover: { hasCover: false, coverUrl: null },
          profileCard: {
            exists: false,
            tagName: null,
            dataId: null,
            dataNickname: null,
            isRealMpCommonProfile: false,
            isAtEnd: false
          },
          rawEditorTextSnippet: ''
        };
      }

      // 1. H1 检查
      const h1List = Array.from(editor.querySelectorAll('h1'));
      const firstChild = editor.firstElementChild;
      const isFirstElement = !!(firstChild && firstChild.tagName === 'H1');
      const topH1 = h1List[0];

      // 2. 封面检查
      const area = document.querySelector('#js_cover_area');
      const coverEl = area ? (area.querySelector('.first_appmsg_cover') || area.querySelector('[style*="background-image"]')) : null;
      let coverUrl = null;
      if (coverEl) {
        const bg = window.getComputedStyle(coverEl).backgroundImage || coverEl.style.backgroundImage || '';
        const m = bg.match(/url\\(["']?([^"')]+)["']?\\)/i);
        if (m && m[1] && m[1] !== 'none') coverUrl = m[1];
      }

      // 3. 名片检查
      const card = editor.querySelector('mp-common-profile');
      ${IS_NODE_AT_EDITOR_END_JS}
      let isAtEnd = false;
      if (card) {
        isAtEnd = isNodeAtEditorEnd(editor, card);
      }

      return {
        editorExists: true,
        titleH1: {
          exists: h1List.length > 0,
          count: h1List.length,
          text: topH1 ? topH1.textContent.trim() : null,
          isFirstElement: isFirstElement,
          outerHtmlSnippet: topH1 ? topH1.outerHTML.slice(0, 150) : undefined
        },
        cover: {
          hasCover: !!coverUrl,
          coverUrl: coverUrl,
          outerHtmlSnippet: coverEl ? coverEl.outerHTML.slice(0, 150) : undefined
        },
        profileCard: {
          exists: !!card,
          tagName: card ? card.tagName : null,
          dataId: card ? card.getAttribute('data-id') : null,
          dataNickname: card ? card.getAttribute('data-nickname') : null,
          isRealMpCommonProfile: !!(card && card.tagName.toLowerCase() === 'mp-common-profile'),
          isAtEnd: isAtEnd,
          outerHtmlSnippet: card ? card.outerHTML.slice(0, 150) : undefined
        },
        rawEditorTextSnippet: (editor.innerText || '').slice(0, 100)
      };
    })()
  `
  );
}
