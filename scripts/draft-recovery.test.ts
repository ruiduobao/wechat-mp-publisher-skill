import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { atomicSaveHistory, loadHistoryDatabase, recordDraftCandidate, recordVerifiedDraft, computeStateCatalog, type DraftStateRecord } from './draft-state.ts';
import { planArticleAction, type BatchCliOptions } from './batch-fast-wechat.ts';

const options: BatchCliOptions = { dryRun: false, repair: false, refreshContent: false, source: 'all' };

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-recovery-'));
  const localRoot = path.join(root, 'local'); const museRoot = path.join(root, 'muse');
  const batch = path.join(localRoot, '20261231_0700'); fs.mkdirSync(batch, { recursive: true }); fs.mkdirSync(museRoot);
  const fullPath = path.join(batch, '01_test.md'); fs.writeFileSync(fullPath, '# 测试文章\n\n合成正文');
  const paths = { historyFile: path.join(root, 'history.json'), baselineFile: path.join(root, 'baseline.json'), localRoot, museRoot };
  fs.writeFileSync(paths.baselineFile, '[]');
  computeStateCatalog({ persist: true, paths });
  const id = 'local:20261231_0700:01';
  return { root, paths, id, record: () => loadHistoryDatabase(paths)[id]!, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('完整内容失败标记跨落盘和扫描保留，默认重跑继续原ID完整更新', () => {
  const s = sandbox();
  try {
    recordVerifiedDraft(s.id, '100099999', { verified: false }, { mode: 'full-content', paths: s.paths });
    computeStateCatalog({ persist: true, paths: s.paths });
    const item = s.record();
    expect(item.appmsgid).toBe('100099999'); expect(item.pendingContentUpdate).toBe(true);
    expect(planArticleAction(item, options, new Set([s.id])).action).toBe('content-update');
    expect(planArticleAction(item, { ...options, repair: true }, new Set([s.id])).action).toBe('needs-reconcile');
  } finally { s.close(); }
});

test('元数据成功不能清除待完成正文；只有完整正文复验通过才推进指纹并幂等跳过', () => {
  const s = sandbox();
  try {
    recordVerifiedDraft(s.id, '100099999', { verified: false }, { mode: 'full-content', paths: s.paths });
    recordVerifiedDraft(s.id, '100099999', { verified: true }, { mode: 'metadata-repair', paths: s.paths });
    const metadataOnly = s.record();
    expect(metadataOnly.pendingContentUpdate).toBe(true); expect(metadataOnly.verification.verified).toBe(false);
    expect(metadataOnly.status).toBe('saved-unverified'); expect(metadataOnly.appliedFingerprint).toBeUndefined();
    expect(planArticleAction(metadataOnly, options, new Set()).action).toBe('content-update');
    recordVerifiedDraft(s.id, '100099999', { verified: true }, { mode: 'full-content', paths: s.paths });
    const completed = s.record(); expect(completed.pendingContentUpdate).toBe(false);
    expect(completed.appliedFingerprint?.compositeHash).toBe(completed.observedFingerprint?.compositeHash);
    expect(planArticleAction(completed, options, new Set()).action).toBe('skip');
  } finally { s.close(); }
});

test('旧版本已保存新稿没有应用指纹时，即使特性verified也不能降级为skip', () => {
  const s = sandbox();
  try {
    const item = s.record(); item.appmsgid = '100099999'; item.verification = { verified: true };
    item.featureVersion = 1; item.featureRepairObservedFingerprint = item.observedFingerprint?.compositeHash;
    expect(planArticleAction(item, options, new Set()).action).toBe('content-update');
    expect(planArticleAction(item, options, new Set([s.id])).action).toBe('skip');
  } finally { s.close(); }
});

test('身份核对失败前先保全候选ID，重扫仍待核对且禁止重复create', () => {
  const s = sandbox();
  try {
    recordDraftCandidate(s.id, '100099999', 'Autosaved ID observed; identity not yet confirmed', s.paths);
    recordDraftCandidate(s.id, '100099999', 'Repeated observation', s.paths);
    computeStateCatalog({ persist: true, paths: s.paths });
    const item = s.record(); expect(item.appmsgid).toBeNull(); expect(item.status).toBe('needs-reconcile');
    expect(item.candidateAppmsgids.map(x => x.appmsgid)).toEqual(['100099999']);
    expect(planArticleAction(item, options, new Set()).action).toBe('needs-reconcile');
    expect(() => recordDraftCandidate(s.id, 'invalid', 'bad', s.paths)).toThrow('格式错误');
  } finally { s.close(); }
});

test('新增候选不覆盖已有确证映射或历史候选', () => {
  const s = sandbox();
  try {
    const item: DraftStateRecord = { ...s.record(), appmsgid: '100088888', candidateAppmsgids: [{ appmsgid: '100077777', evidence: 'old evidence' }], status: 'active' };
    atomicSaveHistory({ [s.id]: item }, s.paths);
    recordDraftCandidate(s.id, '100099999', 'new observation', s.paths);
    expect(s.record().appmsgid).toBe('100088888');
    expect(s.record().candidateAppmsgids.map(x => x.appmsgid)).toEqual(['100077777', '100099999']);
  } finally { s.close(); }
});
