import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Jimp } from 'jimp';
import { locatePlaceholderAndSetAnchor, verifyReopenedImagesMatch } from './article-content.ts';
import type { EditorSession } from './editor-features.ts';
import { mergeShortTitles } from './set-titles.ts';

async function solidPngBuffer(rgbaHex: number): Promise<Buffer> {
  const img = new Jimp({ width: 16, height: 16, color: rgbaHex });
  return await img.getBuffer('image/png');
}

test('verifyReopenedImagesMatch: URL 去重变更时像素一致按顺序通过，错图或乱序拦截失败', async () => {
  const redBuf = await solidPngBuffer(0xff0000ff);
  const blueBuf = await solidPngBuffer(0x0000ffff);
  const greenBuf = await solidPngBuffer(0x00ff00ff);

  const mockMap: Record<string, Buffer> = {
    'https://mmbiz.qpic.cn/mmbiz_png/temp1/0': redBuf,
    'https://mmbiz.qpic.cn/mmbiz_png/temp2/0': blueBuf,
    'https://mmbiz.qpic.cn/sz_mmbiz_jpg/dedup1/640': redBuf,
    'https://mmbiz.qpic.cn/sz_mmbiz_jpg/dedup2/640': blueBuf,
    'https://mmbiz.qpic.cn/sz_mmbiz_jpg/wrong/640': greenBuf,
  };
  const fetcher = async (url: string) => ({ buffer: mockMap[url]!, contentType: 'image/png' });

  // 1. 去重导致 URL 变化但像素与顺序一致 -> pixel-mae 通过
  const okRes = await verifyReopenedImagesMatch(
    ['https://mmbiz.qpic.cn/mmbiz_png/temp1/0', 'https://mmbiz.qpic.cn/mmbiz_png/temp2/0'],
    ['https://mmbiz.qpic.cn/sz_mmbiz_jpg/dedup1/640', 'https://mmbiz.qpic.cn/sz_mmbiz_jpg/dedup2/640'],
    { fetchUrlBuffer: fetcher }
  );
  expect(okRes.matched).toBe(true);
  expect(okRes.method).toBe('pixel-mae');

  // 2. 两张图顺序颠倒 -> 严格拦截失败
  const swapRes = await verifyReopenedImagesMatch(
    ['https://mmbiz.qpic.cn/mmbiz_png/temp1/0', 'https://mmbiz.qpic.cn/mmbiz_png/temp2/0'],
    ['https://mmbiz.qpic.cn/sz_mmbiz_jpg/dedup2/640', 'https://mmbiz.qpic.cn/sz_mmbiz_jpg/dedup1/640'],
    { fetchUrlBuffer: fetcher }
  );
  expect(swapRes.matched).toBe(false);

  // 3. 图片内容被替换 -> 严格拦截失败
  const wrongRes = await verifyReopenedImagesMatch(
    ['https://mmbiz.qpic.cn/mmbiz_png/temp1/0', 'https://mmbiz.qpic.cn/mmbiz_png/temp2/0'],
    ['https://mmbiz.qpic.cn/sz_mmbiz_jpg/dedup1/640', 'https://mmbiz.qpic.cn/sz_mmbiz_jpg/wrong/640'],
    { fetchUrlBuffer: fetcher }
  );
  expect(wrongRes.matched).toBe(false);

  // 4. 非微信 CDN 域名 -> 直接拒绝
  const fakeDomainRes = await verifyReopenedImagesMatch(
    ['https://mmbiz.qpic.cn/mmbiz_png/temp1/0'],
    ['https://fake-qpic.cn/dedup1/640'],
    { fetchUrlBuffer: fetcher }
  );
  expect(fakeDomainRes.matched).toBe(false);
});

test('locatePlaceholderAndSetAnchor: 首轮选区抖动时重试一次成功，仍严禁直接修改DOM', async () => {
  let text = '正文前置 WECHATIMGPH_3 结束';
  let range: { start: number; end: number } | undefined;
  let selectionChecks = 0;
  const inputs: string[] = [];

  const node: any = { parentElement: { scrollIntoView() {} } };
  Object.defineProperty(node, 'textContent', {
    get: () => text,
    set: () => { throw new Error('Direct DOM mutation forbidden'); },
  });
  const selection: any = {
    anchorNode: node,
    focusNode: node,
    removeAllRanges() { range = undefined; },
    addRange(r: any) { range = r; },
    toString: () => {
      selectionChecks++;
      if (selectionChecks === 1) return ''; // 模拟第 1 次选区抖动丢失
      return range ? text.slice(range.start, range.end) : '';
    },
  };
  const editor: any = {
    focus() { document.activeElement = editor; },
    contains: (v: any) => v === node,
    querySelectorAll: () => [],
  };
  Object.defineProperty(editor, 'textContent', {
    get: () => text,
    set: () => { throw new Error('Direct editor mutation forbidden'); },
  });
  const document: any = {
    activeElement: null,
    querySelector: () => editor,
    createTreeWalker: () => {
      let read = false;
      return { nextNode: () => (read ? null : ((read = true), node)) };
    },
    createRange: () => {
      const value = {
        start: 0,
        end: 0,
        setStart(_n: any, o: number) { value.start = o; },
        setEnd(_n: any, o: number) { value.end = o; },
      };
      return value;
    },
  };
  const context = vm.createContext({ document, window: {}, NodeFilter: { SHOW_TEXT: 4 }, getSelection: () => selection });
  const session: EditorSession = {
    sessionId: 'body',
    targetId: 'tab-1',
    cdp: {
      async send(method, params): Promise<any> {
        if (method === 'Runtime.evaluate') return { result: { value: vm.runInContext(params?.expression, context) } };
        if (method === 'Input.insertText') {
          inputs.push(params?.text);
          text = text.slice(0, range!.start) + params?.text + text.slice(range!.end);
        }
        return {};
      },
    },
  };

  expect(await locatePlaceholderAndSetAnchor(session, 'WECHATIMGPH_3', 'anchor-retry')).toBe(true);
  expect(selectionChecks).toBe(2);
  expect(inputs).toEqual(['⟦anchor-retry⟧']);
  expect(text).toBe('正文前置 ⟦anchor-retry⟧ 结束');
});

test('CLI --search / --latest / 不存在ID / --title-override 门禁均按预期执行', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-cli-opt-'));
  try {
    const local = path.join(root, 'local');
    const muse = path.join(root, 'muse');
    const b1 = path.join(muse, '20261110_0700');
    const b2 = path.join(muse, '20261113_1105');
    fs.mkdirSync(b1, { recursive: true });
    fs.mkdirSync(b2, { recursive: true });
    fs.mkdirSync(local, { recursive: true });

    const f1 = path.join(b1, '01_旧文章.md');
    const f2 = path.join(b2, '01_GEM15高程模型_本地版.md');
    fs.writeFileSync(f1, '# 旧文章短题\n\n第一篇正文内容');
    fs.writeFileSync(f2, '# 谷歌把全球高程模型做到了 15 米：GEM-15 在 Earth Engine 免费开放\n\n这是 GEM-15 近全球高程数据集介绍');

    const state = path.join(root, 'state');
    const baseline = path.join(root, 'baseline.json');
    fs.writeFileSync(baseline, '[]');

    const env = {
      ...process.env,
      WECHAT_BUN_PATH: process.execPath,
      WECHAT_LOCAL_ROOT: local,
      WECHAT_MUSE_ROOT: muse,
      WECHAT_HISTORY_FILE: path.join(state, 'history.json'),
      WECHAT_BASELINE_FILE: baseline,
      WECHAT_LOCK_FILE: path.join(state, 'publisher.lock'),
      WECHAT_STATE_CACHE_DIR: path.join(state, 'cache'),
    };
    const launcher = fileURLToPath(new URL('../bin/launch-publisher.mjs', import.meta.url));

    // 1. --check --search 按关键词命中 GEM-15
    const searchRes = spawnSync('node', [launcher, '--check', '--search', 'GEM-15'], { encoding: 'utf8', env });
    expect(searchRes.status).toBe(0);
    expect(searchRes.stdout).toContain('muse:20261113_1105:01');
    expect(searchRes.stdout).not.toContain('muse:20261110_0700:01');

    // 2. --check --latest 1 只命中最新一篇
    const latestRes = spawnSync('node', [launcher, '--check', '--latest'], { encoding: 'utf8', env });
    expect(latestRes.status).toBe(0);
    expect(latestRes.stdout).toContain('muse:20261113_1105:01');
    expect(latestRes.stdout).not.toContain('muse:20261110_0700:01');

    // 3. 指定不存在的 --id 返回退出码 1 并提示未找到
    const missingIdRes = spawnSync('node', [launcher, '--check', '--id', 'muse:20990101_0000:99'], { encoding: 'utf8', env });
    expect(missingIdRes.status).toBe(1);
    expect(missingIdRes.stderr).toContain('未找到指定文章 ID');

    // 4. --title-override 不带 --id / --latest 1 时直接被门禁拦截退出码 2
    const overrideErrRes = spawnSync('node', [launcher, '--check', '--title-override', '单篇标题'], { encoding: 'utf8', env });
    expect(overrideErrRes.status).toBe(2);
    expect(overrideErrRes.stderr).toContain('--title-override 仅限单篇模式');

    expect(fs.existsSync(state)).toBe(false); // 只读预检零磁盘副作用
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('set-titles 合并工具严格校验 15 字上限并 fail-closed 保护损坏 JSON', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-titles-'));
  try {
    const file = path.join(root, 'titles.json');
    const r1 = mergeShortTitles({ 'muse:20261113_1105:01': 'GEM-15全球15米高程模型' }, file);
    expect(r1.total).toBe(1);

    // 合并第二条，不丢失第一条
    const r2 = mergeShortTitles({ 'muse:20261113_1105:02': '短标题测试' }, file);
    expect(r2.total).toBe(2);
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(saved['muse:20261113_1105:01']).toBe('GEM-15全球15米高程模型');

    // 超 15 字拒绝写入
    expect(() => mergeShortTitles({ 'muse:20261113_1105:03': '这是一个绝对超过十五个字符的超长外显标题' }, file)).toThrow('超过 15 字上限');

    // 损坏 JSON fail-closed 拒绝覆盖
    const badFile = path.join(root, 'bad.json');
    fs.writeFileSync(badFile, '{ bad json');
    expect(() => mergeShortTitles({ 'muse:20261113_1105:03': '合法短标题' }, badFile)).toThrow('FATAL');
    expect(fs.readFileSync(badFile, 'utf-8')).toBe('{ bad json');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
