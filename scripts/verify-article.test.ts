import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractArticleClaims,
  computeTitleSimilarity,
  verifySingleDoi,
  verifySingleArxiv,
  verifySingleUrl,
  verifyArticleTruth,
} from './verify-article.ts';
import {
  computeStateCatalog,
  loadHistoryDatabase,
  recordUnsupportedDraft,
  recordVerifiedDraft,
} from './draft-state.ts';
import { planArticleAction, type BatchCliOptions } from './batch-fast-wechat.ts';

test('extractArticleClaims 准确提取 DOI、arXiv、论文标题并剔除尾部标点与代码', () => {
  const md = `# 遥感前沿长文标题

> 导语摘要。

- **标题：** UniFlow-RS: Unified Generative Prediction for Heterogeneous Remote-Sensing Tasks
- **期刊：** arXiv 预印本
- **作者：** Test Author

正文见 \`DOI: 10.9999/fake-in-code\`（行内代码不提取）。
论文 DOI：https://doi.org/10.1038/s43247-026-04153-z），以及 arXiv:2611.13776。
项目代码：https://github.com/example/uniflow-rs）。
图例：![图1](https://mmbiz.qpic.cn/mmbiz_png/abc/0)
`;
  const claims = extractArticleClaims(md);
  expect(claims.articleTitle).toBe('遥感前沿长文标题');
  expect(claims.paperTitle).toBe('UniFlow-RS: Unified Generative Prediction for Heterogeneous Remote-Sensing Tasks');
  expect(claims.dois).toEqual(['10.1038/s43247-026-04153-z']);
  expect(claims.arxivIds).toEqual(['2611.13776']);
  expect(claims.urls).toEqual(['https://github.com/example/uniflow-rs']);
});

test('computeTitleSimilarity 区分真实同论文与张冠李戴标题', () => {
  expect(computeTitleSimilarity(
    'High-resolution mapping reveals trade-offs among tea production',
    'High-resolution mapping reveals trade-offs among tea production'
  )).toBe(1);
  expect(computeTitleSimilarity(
    'UniFlow-RS: Unified Generative Prediction for Heterogeneous Remote-Sensing Tasks',
    'A completely unrelated medical study on human liver cells'
  )).toBeLessThan(0.15);
});

test('verifySingleDoi 拦截 404 假 DOI 和张冠李戴 DOI，放行真实 Crossref 与 Handle DOI', async () => {
  const mockFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('10.1038%2Freal-doi')) {
      return new Response(JSON.stringify({ message: { title: ['Real Remote Sensing Study on Global Lakes'] } }), { status: 200 });
    }
    if (url.includes('10.1038%2Fwrong-doi')) {
      return new Response(JSON.stringify({ message: { title: ['Unrelated Quantum Physics Paper'] } }), { status: 200 });
    }
    if (url.includes('api.crossref.org/works/10.6084%2Ffigshare.1')) {
      return new Response('Not found', { status: 404 });
    }
    if (url.includes('doi.org/api/handles/10.6084%2Ffigshare.1')) {
      return new Response(JSON.stringify({ responseCode: 1 }), { status: 200 });
    }
    if (url.includes('doi.org/api/handles/10.9999%2Ffake-404')) {
      return new Response(JSON.stringify({ responseCode: 100 }), { status: 200 });
    }
    return new Response('Not found', { status: 404 });
  }) as typeof fetch;

  const ok = await verifySingleDoi('10.1038/real-doi', 'Real Remote Sensing Study on Global Lakes', { fetchFn: mockFetch });
  expect(ok.valid).toBe(true);
  expect(ok.status).toBe('verified');

  const mismatch = await verifySingleDoi('10.1038/wrong-doi', 'Real Remote Sensing Study on Global Lakes', { fetchFn: mockFetch });
  expect(mismatch.valid).toBe(false);
  expect(mismatch.status).toBe('title-mismatch');

  const handleOk = await verifySingleDoi('10.6084/figshare.1', undefined, { fetchFn: mockFetch });
  expect(handleOk.valid).toBe(true);
  expect(handleOk.status).toBe('verified');

  const fake = await verifySingleDoi('10.9999/fake-404', undefined, { fetchFn: mockFetch });
  expect(fake.valid).toBe(false);
  expect(fake.status).toBe('not-found');
});

test('verifySingleArxiv 拦截不存在编号与标题不匹配，放行一致论文', async () => {
  const mockFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('id_list=2611.13776')) {
      return new Response('<feed><entry><title>DisasterAgent: An Evidence-Driven Agent</title></entry></feed>', { status: 200 });
    }
    return new Response('<feed><entry></entry></feed>', { status: 200 });
  }) as typeof fetch;

  const ok = await verifySingleArxiv('2611.13776', 'DisasterAgent: An Evidence-Driven Agent', { fetchFn: mockFetch });
  expect(ok.valid).toBe(true);
  expect(ok.status).toBe('verified');

  const mismatch = await verifySingleArxiv('2611.13776', 'Totally Different Ocean Paper', { fetchFn: mockFetch });
  expect(mismatch.valid).toBe(false);
  expect(mismatch.status).toBe('title-mismatch');

  const notFound = await verifySingleArxiv('9999.99999', undefined, { fetchFn: mockFetch });
  expect(notFound.valid).toBe(false);
  expect(notFound.status).toBe('not-found');
});

test('verifyArticleTruth 阻断缺图、0字节图、占位符与假DOI，允许正常文章与提示403站方限制', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-verify-'));
  try {
    const goodImg = path.join(root, 'good.png');
    const emptyImg = path.join(root, 'empty.png');
    fs.writeFileSync(goodImg, Buffer.from([1, 2, 3, 4]));
    const earlier = new Date(Date.now() - 10_000);
    fs.utimesSync(goodImg, earlier, earlier);
    fs.writeFileSync(emptyImg, Buffer.alloc(0));
    fs.utimesSync(emptyImg, earlier, earlier);

    const longBody = '这是一段严谨的遥感研究正文内容。'.repeat(20);
    const badMd = path.join(root, 'bad.md');
    fs.writeFileSync(badMd, `# 异常文章\n\n- **标题：** Real Study\n- **DOI：** 10.9999/fake-404\n\n[TODO] 待补充\n![图1](./empty.png)\n${longBody}`);

    const mockFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('api.crossref.org/works/10.1038%2Fgood')) {
        return new Response(JSON.stringify({ message: { title: ['Real Remote Sensing Study'] } }), { status: 200 });
      }
      if (url.includes('doi.org/api/handles/10.9999%2Ffake-404')) {
        return new Response(JSON.stringify({ responseCode: 100 }), { status: 200 });
      }
      if (url.includes('https://example.com/blocked')) {
        return new Response('Forbidden', { status: 403 });
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    const badRep = await verifyArticleTruth(badMd, { fetchFn: mockFetch });
    expect(badRep.status).toBe('fail');
    expect(badRep.emptyImages.length).toBe(1);
    expect(badRep.errors.some(e => e.includes('TODO'))).toBe(true);
    expect(badRep.errors.some(e => e.includes('不存在') || e.includes('DOI 无效'))).toBe(true);

    const goodMd = path.join(root, 'good.md');
    fs.writeFileSync(goodMd, `# 正常文章\n\n- **标题：** Real Remote Sensing Study\n- **DOI：** 10.1038/good\n\n![图1](./good.png)\n${longBody}`);
    const goodRep = await verifyArticleTruth(goodMd, { fetchFn: mockFetch });
    expect(goodRep.status).toBe('pass');
    expect(goodRep.errors).toHaveLength(0);

    const url403 = await verifySingleUrl('https://example.com/blocked', { fetchFn: mockFetch });
    expect(url403.status).toBe('blocked');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recordUnsupportedDraft 记录非普通长文后默认批量跳过，显式 --id 仍可重检，普通长文通过后清除标记', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-unsup-'));
  try {
    const localRoot = path.join(root, 'local');
    const museRoot = path.join(root, 'muse');
    const batch = path.join(localRoot, '20261109_0700');
    fs.mkdirSync(batch, { recursive: true });
    fs.mkdirSync(museRoot, { recursive: true });
    fs.writeFileSync(path.join(batch, '01_gallery.md'), '# 图片轮播测试\n\n正文内容');

    const paths = {
      historyFile: path.join(root, 'history.json'),
      baselineFile: path.join(root, 'baseline.json'),
      localRoot,
      museRoot,
    };
    fs.writeFileSync(paths.baselineFile, '["local:20261109_0700:01"]');
    computeStateCatalog({ persist: true, paths });

    const id = 'local:20261109_0700:01';
    recordUnsupportedDraft(id, '100021206', 'unsupported-message-type: 当前草稿为图片消息', paths);
    computeStateCatalog({ persist: true, paths });

    const item = loadHistoryDatabase(paths)[id]!;
    expect(item.appmsgid).toBe('100021206');
    expect(item.unsupportedMessageType).toContain('unsupported-message-type');

    const batchOpts: BatchCliOptions = { dryRun: false, repair: false, refreshContent: false, source: 'all' };
    expect(planArticleAction(item, batchOpts, new Set([id])).action).toBe('skip');
    // 显式指定 --id 仍放行检测
    expect(planArticleAction(item, { ...batchOpts, id }, new Set([id])).action).toBe('repair');

    // 若后续在普通长文验收通过，清除 unsupportedMessageType 标记
    recordVerifiedDraft(id, '100021206', { verified: true }, { mode: 'full-content', paths });
    expect(loadHistoryDatabase(paths)[id]!.unsupportedMessageType).toBeUndefined();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
