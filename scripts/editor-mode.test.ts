import { expect, test } from 'bun:test';
import { assertArticleEditor, evaluateEditorMessageType, type EditorTypeSnapshot } from './editor-mode.ts';
import type { EditorSession } from './editor-features.ts';

const ordinary: EditorTypeSnapshot = { itemShowType: 0, hasHiddenHolder: false, hasGalleryContainer: false, isProseMirrorVisible: true, isEditable: true };

function sessionFor(snapshots: EditorTypeSnapshot[]) {
  const calls: string[] = [];
  let index = 0;
  const session: EditorSession = {
    sessionId: 'test-session',
    cdp: { send: async <T>(method: string): Promise<T> => {
      calls.push(method);
      return { result: { value: snapshots[Math.min(index++, snapshots.length - 1)] } } as T;
    } },
  };
  return { session, calls };
}

test('普通长文可见且可编辑时通过', async () => {
  const { session, calls } = sessionFor([ordinary]);
  expect(await assertArticleEditor(session, 0)).toEqual(ordinary);
  expect(calls).toEqual(['Runtime.evaluate']);
});

test('图片消息即使有隐藏的 ProseMirror 也拒绝，检查不执行写入', async () => {
  const { session, calls } = sessionFor([{ ...ordinary, itemShowType: 8, hasHiddenHolder: true, isProseMirrorVisible: false }]);
  await expect(assertArticleEditor(session, 0)).rejects.toThrow('unsupported-message-type');
  expect(calls).toEqual(['Runtime.evaluate']);
});

test('URL 未指明类型但正文祖先隐藏时保留原稿', async () => {
  const hidden = { ...ordinary, itemShowType: null, hasHiddenHolder: true, isProseMirrorVisible: false };
  expect(evaluateEditorMessageType(hidden).supported).toBe(false);
  await expect(assertArticleEditor(sessionFor([hidden]).session, 0)).rejects.toThrow('unsupported-message-type');
});

test('等待异步初始化完成，而不是把尚未可编辑的节点当成正文', async () => {
  const { session, calls } = sessionFor([{ ...ordinary, isEditable: false }, ordinary]);
  await expect(assertArticleEditor(session, 1000)).resolves.toEqual(ordinary);
  expect(calls.length).toBe(2);
});
