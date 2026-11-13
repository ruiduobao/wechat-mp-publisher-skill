import { BODY_EDITOR_SELECTOR, evaluatePage, sleep, type EditorSession } from './editor-features.ts';

export interface EditorTypeSnapshot {
  itemShowType: number | null;
  hasHiddenHolder: boolean;
  hasGalleryContainer: boolean;
  isProseMirrorVisible: boolean;
  isEditable?: boolean;
}

export function evaluateEditorMessageType(snapshot: EditorTypeSnapshot): { supported: boolean; reason?: string } {
  if (snapshot.itemShowType === 8) {
    return { supported: false, reason: 'unsupported-message-type: 当前草稿为图片消息，不能使用普通长文编辑流程' };
  }
  if (snapshot.hasHiddenHolder && !snapshot.isProseMirrorVisible) {
    return { supported: false, reason: 'unsupported-message-type: 正文编辑容器被隐藏，保留原稿并检查消息类型' };
  }
  if (snapshot.hasGalleryContainer && !snapshot.isProseMirrorVisible) {
    return { supported: false, reason: 'unsupported-message-type: 图片轮播模式没有可见的普通长文编辑器' };
  }
  return { supported: true };
}

export async function assertArticleEditor(session: EditorSession, timeoutMs = 15_000): Promise<EditorTypeSnapshot> {
  const started = Date.now();
  let last: EditorTypeSnapshot | undefined;
  do {
    last = await evaluatePage<EditorTypeSnapshot>(session, `(() => {
      const editor = document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)});
      const holder = document.querySelector('#edui1_iframeholder');
      const rect = editor?.getBoundingClientRect();
      const style = editor ? getComputedStyle(editor) : null;
      const mode = new URL(location.href).searchParams.get('item_show_type');
      let hidden = !!holder && getComputedStyle(holder).display === 'none';
      for (let node = editor; node; node = node.parentElement) {
        const css = getComputedStyle(node);
        if (css.display === 'none' || css.visibility === 'hidden') hidden = true;
      }
      return {
        itemShowType: mode === null ? null : Number(mode),
        hasHiddenHolder: hidden,
        hasGalleryContainer: !!document.querySelector('.appmsg_image_editor, .weui-desktop-image-preview'),
        isProseMirrorVisible: !!editor && !hidden && style.display !== 'none' && !!rect && rect.width > 0 && rect.height > 0,
        isEditable: !!editor?.isContentEditable
      };
    })()`);
    const mode = evaluateEditorMessageType(last);
    if (last.itemShowType === 8 || (!mode.supported && last.hasGalleryContainer)) throw new Error(mode.reason);
    if (mode.supported && last.isProseMirrorVisible && last.isEditable) return last;
    if (Date.now() - started >= timeoutMs) break;
    await sleep(250);
  } while (true);
  const mode = last && evaluateEditorMessageType(last);
  throw new Error(mode && !mode.supported ? mode.reason : 'editor-not-ready: 普通长文正文尚未可见且可编辑，未修改草稿');
}
