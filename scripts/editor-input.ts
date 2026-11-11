import { BODY_EDITOR_SELECTOR, evaluatePage, sleep, type EditorSession } from './editor-features.ts';

export interface NativePasteResult {
  trusted: boolean;
  htmlAvailable: boolean;
  expectedText: string;
  actualText: string;
}

async function shortcut(session: EditorSession, key: string): Promise<void> {
  const code = key.toUpperCase().charCodeAt(0);
  const params = { key, code: `Key${key.toUpperCase()}`, modifiers: process.platform === 'darwin' ? 4 : 2, windowsVirtualKeyCode: code };
  await session.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...params }, { sessionId: session.sessionId });
  await session.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params }, { sessionId: session.sessionId });
}

/** Copy only the supplied HTML in a task-owned tab, then use the editor's native paste handler. */
export async function pasteHtmlNatively(session: EditorSession, html: string, selectionMode: 'all' | 'title' = 'all'): Promise<NativePasteResult> {
  let clipboardTarget: string | undefined;
  const evidenceKey = `__wechatPaste_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  try {
    const created = await session.cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    clipboardTarget = created.targetId;
    const attached = await session.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: clipboardTarget, flatten: true });
    const clipboardSession = { cdp: session.cdp, sessionId: attached.sessionId, targetId: clipboardTarget };
    await session.cdp.send('Page.enable', {}, { sessionId: attached.sessionId });
    const tree = await session.cdp.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree', {}, { sessionId: attached.sessionId });
    await session.cdp.send('Page.setDocumentContent', {
      frameId: tree.frameTree.frame.id,
      html: `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="clipboard-content">${html}</div></body></html>`,
    }, { sessionId: attached.sessionId });
    await session.cdp.send('Target.activateTarget', { targetId: clipboardTarget });
    const expectedText = await evaluatePage<string>(clipboardSession, `(() => {
      const output = document.querySelector('#clipboard-content');
      const range = document.createRange();
      range.selectNodeContents(output);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      return output.textContent || '';
    })()`);
    await shortcut(clipboardSession, 'c');
    await sleep(200);
    await session.cdp.send('Target.closeTarget', { targetId: clipboardTarget });
    clipboardTarget = undefined;
    if (session.targetId) await session.cdp.send('Target.activateTarget', { targetId: session.targetId });
    await session.cdp.send('Page.bringToFront', {}, { sessionId: session.sessionId });
    const ready = await evaluatePage<boolean>(session, `(() => {
      const editor = document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)});
      if (!editor?.isContentEditable || !editor.getClientRects().length) return false;
      editor.focus();
      const selection = getSelection(); const range = document.createRange();
      if (${JSON.stringify(selectionMode)} === 'all') range.selectNodeContents(editor);
      else if (editor.firstElementChild?.tagName === 'H1') range.selectNode(editor.firstElementChild);
      else { range.setStart(editor, 0); range.collapse(true); }
      selection.removeAllRanges(); selection.addRange(range);
      const key = ${JSON.stringify(evidenceKey)};
      const listener = event => { window[key].trusted = event.isTrusted; window[key].htmlAvailable = !!event.clipboardData?.getData('text/html'); };
      window[key] = { trusted: false, htmlAvailable: false, listener };
      editor.addEventListener('paste', listener, { capture: true, once: true });
      return document.activeElement === editor && editor.contains(selection.anchorNode) && editor.contains(selection.focusNode);
    })()`);
    if (!ready) throw new Error('native-paste: body selection is not ready');
    await sleep(150);
    await shortcut(session, 'v');
    await sleep(500);
    const result = await evaluatePage<NativePasteResult>(session, `(() => {
      const editor = document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)});
      const evidence = window[${JSON.stringify(evidenceKey)}];
      return { trusted: !!evidence?.trusted, htmlAvailable: !!evidence?.htmlAvailable, actualText: editor?.textContent || '' };
    })()`);
    if (!result.trusted || !result.htmlAvailable) throw new Error('native-paste: editor did not receive a trusted HTML paste');
    return { ...result, expectedText };
  } finally {
    if (clipboardTarget) await session.cdp.send('Target.closeTarget', { targetId: clipboardTarget });
    await evaluatePage(session, `(() => {
      const key = ${JSON.stringify(evidenceKey)};
      const evidence = window[key];
      if (evidence) document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)})?.removeEventListener('paste', evidence.listener, true);
      delete window[key];
    })()`);
  }
}
