import { describe, it, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyContentCorrections,
  loadContentCorrections,
  type LoadedContentCorrections,
} from './batch-fast-wechat.ts';

const originalEnv = process.env.WECHAT_CONTENT_CORRECTIONS_FILE;

afterEach(() => {
  if (originalEnv === undefined) delete process.env.WECHAT_CONTENT_CORRECTIONS_FILE;
  else process.env.WECHAT_CONTENT_CORRECTIONS_FILE = originalEnv;
});

describe('私有内容修正映射 (content-corrections)', () => {
  it('applyContentCorrections 按规则逐字替换并记录日志，无规则时原样返回', () => {
    const corrections: LoadedContentCorrections = {
      path: 'test.json',
      map: {
        'muse:X:01': [{ find: '10.57780/esa-564caf065', replaceWith: '10.57780/esa-564caf0', note: '官方核实修正' }],
      },
    };

    const md = '数据集见 https://doi.org/10.57780/esa-564caf065 与裸 DOI 10.57780/esa-564caf065。';
    const corrected = applyContentCorrections(md, 'muse:X:01', corrections);
    expect(corrected).toBe('数据集见 https://doi.org/10.57780/esa-564caf0 与裸 DOI 10.57780/esa-564caf0。');
    expect(corrected).not.toContain('564caf065');

    // 无映射 ID：原样返回
    expect(applyContentCorrections(md, 'muse:OTHER:01', corrections)).toBe(md);
  });

  it('loadContentCorrections 支持环境变量路径、缺省返回空映射、坏 JSON fail-closed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-corrections-'));
    try {
      // 缺省文件不存在 → 空映射
      process.env.WECHAT_CONTENT_CORRECTIONS_FILE = path.join(root, 'missing.json');
      const empty = loadContentCorrections();
      expect(Object.keys(empty.map).length).toBe(0);

      // 正常文件
      const file = path.join(root, 'corrections.json');
      fs.writeFileSync(file, JSON.stringify({
        'local:20261115_0700:01': [{ find: 'old-doi', replaceWith: 'new-doi' }],
      }));
      process.env.WECHAT_CONTENT_CORRECTIONS_FILE = file;
      const loaded = loadContentCorrections();
      expect(loaded.map['local:20261115_0700:01']?.[0]?.replaceWith).toBe('new-doi');

      // 坏 JSON fail-closed
      const bad = path.join(root, 'bad.json');
      fs.writeFileSync(bad, '{ bad json');
      process.env.WECHAT_CONTENT_CORRECTIONS_FILE = bad;
      expect(() => loadContentCorrections()).toThrow('FATAL');

      // 非法规则 fail-closed
      const invalid = path.join(root, 'invalid.json');
      fs.writeFileSync(invalid, JSON.stringify({ 'a:1': [{ find: '', replaceWith: 'x' }] }));
      process.env.WECHAT_CONTENT_CORRECTIONS_FILE = invalid;
      expect(() => loadContentCorrections()).toThrow('FATAL');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
