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
import {
  classifyKeepaliveObservation,
  isOfficialHomeTargetUrl,
  observeKeepalivePage,
  runKeepaliveSession,
  sanitizeKeepaliveError,
} from './batch-fast-wechat.ts';

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

    // 5. --keepalive 与任何其它业务参数混用都必须在参数门禁直接退出 2。
    // 直接运行引擎以避免每个负例都重复触发 launcher 的 tsc（门禁与 launcher 无关）。
    const batchScript = fileURLToPath(new URL('./batch-fast-wechat.ts', import.meta.url));
    const runBatch = (...batchArgs: string[]) =>
      spawnSync(process.execPath, [batchScript, ...batchArgs], { encoding: 'utf8', env });

    for (const badArgs of [
      ['--dry-run', '--keepalive'],
      ['--keepalive', '--latest', '1'],
      ['--keepalive', '--source', 'all'],
      ['--keepalive', '--id', 'muse:20261113_1105:01'],
      ['--keepalive', '--verify'],
    ]) {
      const badRes = runBatch(...badArgs);
      expect(badRes.status).toBe(2);
      expect(badRes.stderr).toContain('--keepalive 必须单独使用');
    }

    // 6. --help / -h 出现在任意位置均帮助优先并退出 0
    const helpRes = spawnSync('node', [launcher, '--help'], { encoding: 'utf8', env });
    expect(helpRes.status).toBe(0);
    expect(helpRes.stdout).toContain('--keepalive');

    const keepaliveHelpRes = spawnSync('node', [launcher, '--keepalive', '--help'], { encoding: 'utf8', env });
    expect(keepaliveHelpRes.status).toBe(0);
    expect(keepaliveHelpRes.stdout).toContain('--keepalive');

    const keepaliveShortHelpRes = spawnSync('node', [launcher, '--keepalive', '-h'], { encoding: 'utf8', env });
    expect(keepaliveShortHelpRes.status).toBe(0);
    expect(keepaliveShortHelpRes.stdout).toContain('--keepalive');

    expect(fs.existsSync(state)).toBe(false); // 只读预检零磁盘副作用
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('keepalive 三态判定: healthy 需 2xx+token+后台菜单，明确登录页才 needs-qr，其余 unknown', () => {
  const syntheticToken = ['1234', '567'].join('');
  const homeUrl = `https://mp.weixin.qq.com/cgi-bin/home?t=home/index&lang=zh_CN&token=${syntheticToken}`;

  // healthy：不依赖 Cookie expiry 变化，也不要求任何 72h/30 天阈值
  expect(classifyKeepaliveObservation({
    httpStatus: 200,
    finalUrl: homeUrl,
    html: '<div class="new-creation__menu"></div>',
  })).toEqual({ status: 'healthy', reason: 'authenticated-home-page' });

  // 明确登录页（精确 loginpage 路径 / login_frame 结构化标记）才 needs-qr
  expect(classifyKeepaliveObservation({
    httpStatus: 200,
    finalUrl: 'https://mp.weixin.qq.com/cgi-bin/loginpage?t=wxm2-login&lang=zh_CN',
    html: '<iframe id="login_frame"></iframe>',
  }).status).toBe('needs-qr');
  expect(classifyKeepaliveObservation({
    httpStatus: 200,
    finalUrl: 'https://mp.weixin.qq.com/cgi-bin/home?t=home/index',
    html: '<iframe id="login_frame"></iframe>',
  }).status).toBe('needs-qr');
  expect(classifyKeepaliveObservation({
    httpStatus: 200,
    finalUrl: 'https://mp.weixin.qq.com/cgi-bin/loginpage?t=wxm2-login&lang=zh_CN',
    html: '',
  }).status).toBe('needs-qr');

  // loginpage path 必须优先于 healthy：即使 HTML 残留 home marker 且 URL 带 token，
  // 当前落在登录页也应提示扫码。
  expect(classifyKeepaliveObservation({
    httpStatus: 200,
    finalUrl: `https://mp.weixin.qq.com/cgi-bin/loginpage?token=${syntheticToken}`,
    html: '<div class="new-creation__menu"></div>',
  }).status).toBe('needs-qr');

  // 通用“请重新登录”或“扫码登录”文案可能来自维护/异常页，不能单独判 needs-qr。
  expect(classifyKeepaliveObservation({
    httpStatus: 200,
    finalUrl: 'https://mp.weixin.qq.com/cgi-bin/home?t=home/index',
    html: '<html><body>系统维护中，请重新登录后重试</body></html>',
  }).status).toBe('unknown');
  expect(classifyKeepaliveObservation({
    httpStatus: 200,
    finalUrl: 'https://mp.weixin.qq.com/cgi-bin/home?t=home/index',
    html: '<html><body>请扫码登录服务专区</body></html>',
  }).status).toBe('unknown');

  // 登录页标记来源必须是最终 URL path 或响应内 id=login_frame；
  // 仅出现在查询参数/近似 id 中不算登录页。
  expect(classifyKeepaliveObservation({
    httpStatus: 200,
    finalUrl: 'https://mp.weixin.qq.com/cgi-bin/home?t=home/index&next=/cgi-bin/loginpage',
    html: '<div>请重新登录</div>',
  }).status).toBe('unknown');
  expect(classifyKeepaliveObservation({
    httpStatus: 200,
    finalUrl: 'https://mp.weixin.qq.com/cgi-bin/home?t=home/index',
    html: '<iframe id="login_frame_extra"></iframe>',
  }).status).toBe('unknown');

  // home marker 是正向认证标记：与登录文案同时出现时 healthy 优先；
  // 若缺少 token 则保守 unknown，绝不判 needs-qr。
  expect(classifyKeepaliveObservation({
    httpStatus: 200,
    finalUrl: homeUrl,
    html: '<div class="new-creation__menu"></div><div>扫码登录</div><iframe id="login_frame"></iframe>',
  }).status).toBe('healthy');
  expect(classifyKeepaliveObservation({
    httpStatus: 200,
    finalUrl: 'https://mp.weixin.qq.com/cgi-bin/home?t=home/index',
    html: '<div class="new-creation__menu"></div><div>请重新登录</div>',
  }).status).toBe('unknown');

  // 网络/CDP 错误、5xx、429 均 unknown
  expect(classifyKeepaliveObservation({ error: 'Failed to fetch' }).status).toBe('unknown');
  expect(classifyKeepaliveObservation({ httpStatus: 503, finalUrl: homeUrl, html: '' }).status).toBe('unknown');
  expect(classifyKeepaliveObservation({ httpStatus: 429, finalUrl: homeUrl, html: '' }).status).toBe('unknown');

  // NaN / Infinity / 非整数状态码都不是合法 HTTP 响应，必须 unknown
  for (const badStatus of [NaN, Infinity, 200.5]) {
    expect(classifyKeepaliveObservation({ httpStatus: badStatus, finalUrl: homeUrl, html: '' }).status).toBe('unknown');
  }

  // 官方 host 必须 https、无自定义端口、pathname 精确为后台首页；
  // 任意非官方 host/子域/端口/近似 path 都不得判 healthy。
  for (const badUrl of [
    `http://mp.weixin.qq.com/cgi-bin/home?token=${syntheticToken}`,
    `https://mp.weixin.qq.com:8443/cgi-bin/home?token=${syntheticToken}`,
    `https://mp.weixin.qq.com.evil.com/cgi-bin/home?token=${syntheticToken}`,
    `https://evil.com/cgi-bin/home?token=${syntheticToken}`,
    `https://mp.weixin.qq.com/cgi-bin/homeevil?token=${syntheticToken}`,
  ]) {
    expect(classifyKeepaliveObservation({
      httpStatus: 200,
      finalUrl: badUrl,
      html: '<div class="new-creation__menu"></div>',
    }).status).toBe('unknown');
  }

  // 页面探针只返回脱敏 finalUrl + hasToken 布尔值，classifier 仍须据此判 healthy
  expect(classifyKeepaliveObservation({
    httpStatus: 200,
    finalUrl: 'https://mp.weixin.qq.com/cgi-bin/home',
    html: '<div class="new-creation__menu"></div>',
    hasToken: true,
  })).toEqual({ status: 'healthy', reason: 'authenticated-home-page' });

  // 200 但无页面标记、有菜单但无 token、302 等非 2xx 均 unknown
  expect(classifyKeepaliveObservation({
    httpStatus: 200,
    finalUrl: homeUrl,
    html: '<html><body>维护中</body></html>',
  }).status).toBe('unknown');
  expect(classifyKeepaliveObservation({
    httpStatus: 200,
    finalUrl: 'https://mp.weixin.qq.com/cgi-bin/home?t=home/index',
    html: '<div class="new-creation__menu"></div>',
  }).status).toBe('unknown');
  expect(classifyKeepaliveObservation({
    httpStatus: 302,
    finalUrl: homeUrl,
    html: '',
  }).status).toBe('unknown');
});

test('keepalive 运行态退出码 0/3/4，失败信息不含 token 且 unknown 不提示扫码', async () => {
  const runWith = async (observation: Parameters<typeof classifyKeepaliveObservation>[0]) => {
    const logs: string[] = [];
    const errors: string[] = [];
    const code = await runKeepaliveSession({
      connect: async () => ({ cdp: { close() {} } as any, homeSession: {} as any }),
      observe: async () => observation,
      log: message => logs.push(message),
      logError: message => errors.push(message),
    });
    return { code, output: [...logs, ...errors].join('\n') };
  };

  const healthy = await runWith({
    httpStatus: 200,
    finalUrl: `https://mp.weixin.qq.com/cgi-bin/home?t=home/index&token=${['1234', '5678'].join('')}`,
    html: '<div class="new-creation__menu"></div>',
  });
  expect(healthy.code).toBe(0);
  expect(healthy.output).toContain('keepalive-status=healthy');

  const login = await runWith({
    httpStatus: 200,
    finalUrl: 'https://mp.weixin.qq.com/cgi-bin/loginpage?t=wxm2-login',
    html: '<iframe id="login_frame"></iframe>',
  });
  expect(login.code).toBe(3);
  expect(login.output).toContain('keepalive-status=needs-qr');

  const syntheticNetworkToken = ['987', '6543'].join(''); // 动态合成 7 位 token
  const networkError = await runWith({
    error: `CDP failed at https://mp.weixin.qq.com/cgi-bin/home?token=${syntheticNetworkToken}&lang=zh_CN`,
  });
  expect(networkError.code).toBe(4);
  expect(networkError.output).toContain('keepalive-status=unknown');
  expect(networkError.output).not.toContain(syntheticNetworkToken);
  expect(networkError.output).not.toMatch(/token=[^\s*]/);
  expect(networkError.output).not.toContain('扫码');

  // connect 抛错：退出 4，且错误信息中的 token 不泄漏
  const connectToken = ['abc', 'DEF', '123'].join('');
  const connectOutput: string[] = [];
  const connectCode = await runKeepaliveSession({
    connect: async () => { throw new Error(`boom token=${connectToken}`); },
    log: message => connectOutput.push(message),
    logError: message => connectOutput.push(message),
  });
  expect(connectCode).toBe(4);
  expect(connectOutput.join('\n')).not.toContain(connectToken);
  expect(connectOutput.join('\n')).not.toMatch(/token=[^\s*]/);
  expect(connectOutput.join('\n')).not.toContain('扫码');

  // observe 抛错：退出 4，已连接的 CDP 必须 close，错误信息不含 token
  const observeToken = ['zyx', 'WVU', '987'].join('');
  const observeOutput: string[] = [];
  const closeCalls: number[] = [];
  const observeCode = await runKeepaliveSession({
    connect: async () => ({ cdp: { close() { closeCalls.push(1); } } as any, homeSession: {} as any }),
    observe: async () => { throw new Error(`observe failed token=${observeToken}`); },
    log: message => observeOutput.push(message),
    logError: message => observeOutput.push(message),
  });
  expect(observeCode).toBe(4);
  expect(closeCalls.length).toBe(1);
  expect(observeOutput.join('\n')).not.toContain(observeToken);
  expect(observeOutput.join('\n')).not.toMatch(/token=[^\s*]/);

  // 兜底消毒函数：裸 token= 开头、URL token、token%3D、字母 token 与 Cookie 值全部清除
  const bareSevenToken = ['987', '6543'].join('');
  const urlToken = ['123', '456', '7'].join('');
  const encodedToken = ['88', '99', '00'].join('');
  const alphaToken = ['Ab', 'cD', 'Ef', '123'].join('');
  const sanitized = sanitizeKeepaliveError(
    `token=${bareSevenToken} /cgi-bin/home?token=${urlToken}&x=1 token%3D${encodedToken} Cookie: slave_sid=${alphaToken}; uuid=${bareSevenToken}`
  );
  expect(sanitized).toContain('token=***');
  expect(sanitized).toContain('token%3D***');
  expect(sanitized).toContain('Cookie: ***');
  for (const secret of [bareSevenToken, urlToken, encodedToken, alphaToken]) {
    expect(sanitized).not.toContain(secret);
  }
});

test('keepalive 页面探针返回脱敏 finalUrl + hasToken，响应中不出现 token', async () => {
  const syntheticToken = ['246', '8135'].join('');
  let requestedUrl = '';
  const context = vm.createContext({
    location: { origin: 'https://mp.weixin.qq.com' },
    fetch: async (url: string) => {
      requestedUrl = url;
      return {
        status: 200,
        url: `https://mp.weixin.qq.com/cgi-bin/home?t=home/index&token=${syntheticToken}`,
        text: async () => '<div class="new-creation__menu"></div>',
      };
    },
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
  });
  const session: EditorSession = {
    sessionId: 'home',
    cdp: {
      async send(method, params): Promise<any> {
        if (method === 'Runtime.evaluate') {
          return { result: { value: await vm.runInContext(params?.expression, context) } };
        }
        return {};
      },
    },
  };

  const observation = await observeKeepalivePage(session);
  expect(observation.httpStatus).toBe(200);
  expect(observation.finalUrl).toBe('https://mp.weixin.qq.com/cgi-bin/home');
  expect(observation.hasToken).toBe(true);
  expect(JSON.stringify(observation)).not.toContain(syntheticToken);
  expect(observation.finalUrl).not.toContain('?');
  expect(requestedUrl).toBe('https://mp.weixin.qq.com/cgi-bin/home?t=home/index&lang=zh_CN');
  expect(classifyKeepaliveObservation(observation)).toEqual({
    status: 'healthy',
    reason: 'authenticated-home-page',
  });
});

test('官方后台首页标签过滤：拒绝非官方 host/端口/http/近似 path', () => {
  const syntheticToken = ['135', '7913'].join('');
  expect(isOfficialHomeTargetUrl(`https://mp.weixin.qq.com/cgi-bin/home?t=home/index&token=${syntheticToken}`)).toBe(true);
  expect(isOfficialHomeTargetUrl('https://mp.weixin.qq.com/cgi-bin/home/')).toBe(true);
  for (const badUrl of [
    'http://mp.weixin.qq.com/cgi-bin/home',
    'https://mp.weixin.qq.com:8443/cgi-bin/home',
    'https://mp.weixin.qq.com.evil.com/cgi-bin/home',
    'https://evil.com/cgi-bin/home',
    'https://mp.weixin.qq.com/cgi-bin/homeevil',
    'https://mp.weixin.qq.com/cgi-bin/loginpage',
  ]) {
    expect(isOfficialHomeTargetUrl(badUrl)).toBe(false);
  }
});

test('launcher 仅为单独 --keepalive 跳过 tsc，普通写入仍执行 tsc', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-launcher-'));
  try {
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'typescript', 'bin'), { recursive: true });
    const launcherSource = fileURLToPath(new URL('../bin/launch-publisher.mjs', import.meta.url));
    fs.copyFileSync(launcherSource, path.join(root, 'bin', 'launch-publisher.mjs'));
    fs.writeFileSync(path.join(root, 'scripts', 'batch-fast-wechat.ts'), "console.log('BATCH_RAN');\n");
    fs.writeFileSync(
      path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
      "console.log('TSC_RAN');\nprocess.exit(1);\n"
    );
    const env = { ...process.env, WECHAT_BUN_PATH: process.execPath };
    const tmpLauncher = path.join(root, 'bin', 'launch-publisher.mjs');

    // 单独 --keepalive：跳过 tsc，直接运行引擎
    const keepaliveOnly = spawnSync('node', [tmpLauncher, '--keepalive'], { encoding: 'utf8', env });
    expect(keepaliveOnly.status).toBe(0);
    expect(keepaliveOnly.stdout).toContain('BATCH_RAN');
    expect(keepaliveOnly.stdout).not.toContain('TSC_RAN');

    // --keepalive 混用其它参数：不再跳过 tsc（tsc 失败则不会运行引擎）
    const mixed = spawnSync('node', [tmpLauncher, '--keepalive', '--latest', '1'], { encoding: 'utf8', env });
    expect(mixed.status).toBe(1);
    expect(mixed.stdout).toContain('TSC_RAN');
    expect(mixed.stdout).not.toContain('BATCH_RAN');

    // 普通写入路径：同样必须在写入前运行 tsc
    const writePath = spawnSync(
      'node',
      [tmpLauncher, '--titles', path.join(root, 'missing-titles.json')],
      { encoding: 'utf8', env }
    );
    expect(writePath.status).toBe(1);
    expect(writePath.stdout).toContain('TSC_RAN');
    expect(writePath.stdout).not.toContain('BATCH_RAN');
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
