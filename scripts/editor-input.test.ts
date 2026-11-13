import { test, expect } from 'bun:test';
import vm from 'node:vm';
import { pasteHtmlNatively } from './editor-input.ts';
import { locatePlaceholderAndSetAnchor, waitForTargetImageLoaded, wechatImageIdentity } from './article-content.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

test('首次预检列出缺标题及后续文章，退出成功且不创建状态或锁', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-preflight-'));
  try {
    const local = path.join(root, 'local');
    const muse = path.join(root, 'muse');
    const batch = path.join(local, '20261231_0700');
    fs.mkdirSync(batch, { recursive: true }); fs.mkdirSync(muse);
    const files = [['01_first.md', '# 这是一个需要按语义提炼外题的完整长文章标题\n\n第一篇正文'], ['02_second.md', '# 第二篇短标题\n\n第二篇正文']];
    for (const [name, content] of files) {
      const file = path.join(batch, name!); fs.writeFileSync(file, content!);
      const earlier = new Date(Date.now() - 10_000); fs.utimesSync(file, earlier, earlier);
    }
    const state = path.join(root, 'private');
    const baseline = path.join(root, 'baseline.json'); fs.writeFileSync(baseline, '[]');
    const result = spawnSync('node', [fileURLToPath(new URL('../bin/launch-publisher.mjs', import.meta.url)), '--check'], {
      encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, WECHAT_BUN_PATH: process.execPath, WECHAT_LOCAL_ROOT: local, WECHAT_MUSE_ROOT: muse,
        WECHAT_HISTORY_FILE: path.join(state, 'history.json'), WECHAT_BASELINE_FILE: baseline,
        WECHAT_LOCK_FILE: path.join(state, 'publisher.lock'), WECHAT_STATE_CACHE_DIR: path.join(state, 'cache') },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[needs-title]');
    expect(result.stdout).toContain('02_second.md');
    expect(result.stdout).toContain('DRY-RUN 完成');
    expect(fs.existsSync(state)).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function placeholderSession(initial: string, behavior: 'replace' | 'retain' | 'drift' = 'replace') {
  let text = initial;
  let range: { start: number; end: number } | undefined;
  const inputs: string[] = [];
  const node: any = { parentElement: { scrollIntoView() {} } };
  Object.defineProperty(node, 'textContent', { get: () => text, set: () => { throw new Error('Direct text mutation is forbidden'); } });
  const selection: any = {
    anchorNode: node, focusNode: node,
    removeAllRanges() { range = undefined; }, addRange(value: any) { range = value; },
    toString: () => behavior === 'drift' ? '' : (range ? text.slice(range.start, range.end) : ''),
  };
  const editor: any = { focus() { document.activeElement = editor; }, contains: (value: any) => value === node, querySelectorAll: () => [] };
  Object.defineProperty(editor, 'textContent', { get: () => text, set: () => { throw new Error('Direct editor mutation is forbidden'); } });
  const document: any = { activeElement: null, querySelector: () => editor,
    createTreeWalker: () => { let read = false; return { nextNode: () => read ? null : (read = true, node) }; },
    createRange: () => { const value = { start: 0, end: 0, setStart(_node: any, offset: number) { value.start = offset; }, setEnd(_node: any, offset: number) { value.end = offset; } }; return value; },
  };
  const context = vm.createContext({ document, window: {}, NodeFilter: { SHOW_TEXT: 4 }, getSelection: () => selection });
  const session: EditorSession = { sessionId: 'body', cdp: { async send(method, params): Promise<any> {
    if (method === 'Runtime.evaluate') return { result: { value: vm.runInContext(params?.expression, context) } };
    if (method === 'Input.insertText') {
      inputs.push(params?.text);
      if (!range) throw new Error('Missing input range');
      const end = behavior === 'retain' ? range.start : range.end;
      text = text.slice(0, range.start) + params?.text + text.slice(end);
    }
    return {};
  } } };
  return { session, inputs, text: () => text };
}

test('占位符原生替换必须只覆盖准确token，保留10号token及周围正文', async () => {
  const mock = placeholderSession('前WECHATIMGPH_10中WECHATIMGPH_1后');
  expect(await locatePlaceholderAndSetAnchor(mock.session, 'WECHATIMGPH_1', 'anchor-one')).toBe(true);
  expect(mock.text()).toBe('前WECHATIMGPH_10中⟦anchor-one⟧后');
  expect(mock.inputs).toEqual(['⟦anchor-one⟧']);
});

test('原生输入只插入标记而旧占位符仍在时失败，不能直接改文本清理', async () => {
  const mock = placeholderSession('前WECHATIMGPH_1后', 'retain');
  await expect(locatePlaceholderAndSetAnchor(mock.session, 'WECHATIMGPH_1', 'anchor-one')).rejects.toThrow('未被原生输入准确替换');
  expect(mock.text()).toContain('WECHATIMGPH_1');
});

test('选区漂移或占位符重复时不发送替换输入', async () => {
  const drift = placeholderSession('WECHATIMGPH_1', 'drift');
  expect(await locatePlaceholderAndSetAnchor(drift.session, 'WECHATIMGPH_1', 'anchor-one')).toBe(false);
  expect(drift.inputs).toHaveLength(0);
  const duplicate = placeholderSession('WECHATIMGPH_1和WECHATIMGPH_1');
  expect(await locatePlaceholderAndSetAnchor(duplicate.session, 'WECHATIMGPH_1', 'anchor-one')).toBe(false);
  expect(duplicate.inputs).toHaveLength(0);
});

function pasteSession(trusted = true, htmlAvailable = true, staleFirst = false) {
  const calls: Array<{ method: string; params: any; session?: string }> = [];
  let reads = 0;
  const session: EditorSession = { sessionId: 'body', targetId: 'article', cdp: { async send(method, params, options): Promise<any> {
    calls.push({ method, params, session: options?.sessionId });
    if (method === 'Target.createTarget') return { targetId: 'copy-tab' };
    if (method === 'Target.attachToTarget') return { sessionId: 'copy-session' };
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'copy-frame' } } };
    if (method === 'Runtime.evaluate') {
      const expr = params?.expression || '';
      let value: any = true;
      if (expr.includes('return output.textContent')) value = '完整标题正文';
      if (expr.includes('actualText: editor?.textContent')) {
        reads++;
        const actualText = staleFirst && reads === 1 ? '旧正文尚未被粘贴替换' : '完整标题正文';
        value = { trusted, htmlAvailable, actualText };
      }
      return { result: { value } };
    }
    return {};
  } } };
  return { session, calls };
}

test('原生粘贴只在复制标签复制、在正文标签粘贴，并关闭复制页，且等待旧正文替换完成', async () => {
  const { session, calls } = pasteSession(true, true, true);
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
