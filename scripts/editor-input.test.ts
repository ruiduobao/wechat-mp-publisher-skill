import { test, expect } from 'bun:test';
import vm from 'node:vm';
import { pasteHtmlNatively } from './editor-input.ts';
import { waitForTargetImageLoaded, wechatImageIdentity } from './article-content.ts';
import type { EditorSession } from './editor-features.ts';
import { resolveOuterTitle, type BatchCliOptions } from './batch-fast-wechat.ts';
import type { DraftStateRecord } from './draft-state.ts';

test('新外题超长要明确停止，旧题保留，显式短题准确采用', () => {
  const item = { id: 'test:batch:01', title: '这是一个超过十五个字的完整学术原标题', outerTitle: '' } as DraftStateRecord;
  const options: BatchCliOptions = { dryRun: false, repair: false, refreshContent: false, source: 'all' };
  expect(() => resolveOuterTitle(item, '', options)).toThrow('needs-title');
  expect(resolveOuterTitle({ ...item, appmsgid: '123' }, item.title, options)).toBe(item.title);
  expect(resolveOuterTitle(item, '', { ...options, titleOverride: '准确短标题' })).toBe('准确短标题');
  expect(() => resolveOuterTitle(item, '', { ...options, titleOverride: item.title })).toThrow('needs-title');
});

function pasteSession(trusted = true, htmlAvailable = true) {
  const calls: Array<{ method: string; params: any; session?: string }> = [];
  const session: EditorSession = { sessionId: 'body', targetId: 'article', cdp: { async send(method, params, options): Promise<any> {
    calls.push({ method, params, session: options?.sessionId });
    if (method === 'Target.createTarget') return { targetId: 'copy-tab' };
    if (method === 'Target.attachToTarget') return { sessionId: 'copy-session' };
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'copy-frame' } } };
    if (method === 'Runtime.evaluate') {
      const expr = params?.expression || '';
      let value: any = true;
      if (expr.includes('return output.textContent')) value = '完整标题正文';
      if (expr.includes('actualText: editor?.textContent')) value = { trusted, htmlAvailable, actualText: '完整标题正文' };
      return { result: { value } };
    }
    return {};
  } } };
  return { session, calls };
}

test('原生粘贴只在复制标签复制、在正文标签粘贴，并关闭复制页', async () => {
  const { session, calls } = pasteSession();
  const result = await pasteHtmlNatively(session, '<h1>完整标题</h1><p>正文</p>');
  expect(result.trusted).toBe(true);
  expect(result.actualText).toBe(result.expectedText);
  const keyCalls = calls.filter(x => x.method === 'Input.dispatchKeyEvent' && x.params.type === 'keyDown');
  expect(keyCalls.map(x => [x.params.key, x.session])).toEqual([['c', 'copy-session'], ['v', 'body']]);
  expect(calls.filter(x => x.method === 'Target.closeTarget').map(x => x.params.targetId)).toEqual(['copy-tab']);
});

for (const [trusted, html] of [[false, true], [true, false]]) {
  test(`缺少可信 HTML 粘贴证据就失败 (${trusted}, ${html})`, async () => {
    const { session, calls } = pasteSession(trusted, html);
    await expect(pasteHtmlNatively(session, '<p>正文</p>')).rejects.toThrow('trusted HTML paste');
    expect(calls.some(x => x.method === 'Target.closeTarget' && x.params.targetId === 'copy-tab')).toBe(true);
  });
}

test('只规范化同一微信素材的0与640尺寸，保留素材身份和其它域名', () => {
  const a = 'https://mmbiz.qpic.cn/mmbiz_jpg/material-a/0?wx_fmt=jpeg';
  expect(wechatImageIdentity(a)).toBe(wechatImageIdentity(a.replace('/0?', '/640?')));
  expect(wechatImageIdentity(a)).not.toBe(wechatImageIdentity(a.replace('material-a', 'material-b')));
  expect(wechatImageIdentity('https://fake-qpic.cn/p/0')).toBe('https://fake-qpic.cn/p/0');
  expect(wechatImageIdentity(a)).not.toBe(wechatImageIdentity(a.replace('jpeg', 'png')));
});

function imageSession(adjacent: boolean, old: boolean, markerDeleted = true): EditorSession {
  const marker = { textContent: '⟦image-anchor⟧', parentElement: null as any };
  const image = { complete: true, naturalWidth: 100, naturalHeight: 100, getAttribute: () => 'https://mmbiz.qpic.cn/images/new/0' };
  const imageBlock = { textContent: '', querySelectorAll: () => [image] };
  const paragraph = { querySelectorAll: () => [], nextElementSibling: adjacent ? imageBlock : { textContent: '其它正文', querySelectorAll: () => [] } };
  marker.parentElement = { closest: () => paragraph };
  const editor = { textContent: marker.textContent, focus() {} };
  const context = vm.createContext({
    window: { 'image-anchor': { oldImages: new Set(old ? [image] : []) } },
    NodeFilter: { SHOW_TEXT: 4 }, URL,
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    document: {
      querySelector: () => editor,
      createTreeWalker: () => { let read = false; return { nextNode: () => read ? null : (read = true, marker) }; },
      createRange: () => ({ setStart() {}, setEnd() {} }),
    },
  });
  return { sessionId: 'body', cdp: { async send(method, params): Promise<any> {
    if (method === 'Runtime.evaluate') return { result: { value: vm.runInContext(params?.expression, context) } };
    if (method === 'Input.dispatchKeyEvent' && params?.type === 'keyDown' && markerDeleted) editor.textContent = '';
    return {};
  } } };
}

test('真实检测逻辑接受相邻独立图片块并验证原生删除定位标记', async () => {
  const result = await waitForTargetImageLoaded(imageSession(true, false), 'image-anchor', 1000);
  expect(result.ok).toBe(true);
});

test('真实检测逻辑拒绝旧图和隔着正文的其它图片', async () => {
  expect((await waitForTargetImageLoaded(imageSession(true, true), 'image-anchor', 10)).ok).toBe(false);
  expect((await waitForTargetImageLoaded(imageSession(false, false), 'image-anchor', 10)).ok).toBe(false);
});

test('标记没有被模型删除时禁止返回上传成功', async () => {
  await expect(waitForTargetImageLoaded(imageSession(true, false, false), 'image-anchor', 1000)).rejects.toThrow('未被编辑器删除');
});
