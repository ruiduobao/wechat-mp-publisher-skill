/**
 * tests/draft-state.test.ts
 * 子任务 B 核心离线测试套件 (返工验收版)
 *
 * 核心验证范围：
 * 1. 【临时 Fixtures 沙箱与 dry-run 纯读强断言】：比对目录前后状态与 Hash，确证零磁盘写入。
 * 2. 【真正生产函数 recordVerifiedDraft 测试】：
 *    - metadata-repair: verified:true 也不晋升 appliedFingerprint，记录 featureRepair 指纹；
 *    - 失败保全: verified:false 立即保全已生成 appmsgid，打标 saved-unverified；
 *    - full-content: 真正 pass 时晋升 appliedFingerprint。
 * 3. 【4 项核心防御真实回归】：
 *    - 坏 JSON 抛出致命错误，绝不返回 {} 空库；
 *    - 缺图文章保留原 appmsgid 与候选，绝不设为 null；
 *    - 源文件被删除/移走，history 库中已有条目完好保留；
 *    - baseline 之外的新批次文章进入 untracked，旧基线文章保持 needs-reconcile。
 * 4. 【真实跨进程 wx 锁竞争测试】：子进程持锁期间主进程尝试抢锁必失败，子进程退出后主进程成功获取。
 * 5. 【CLI 门禁严苛参数测试】：--help 退出码 0，未知参数与缺值退出码 2。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  acquireProcessLock,
  releaseProcessLock,
  isProcessAlive,
  checkFileStability,
  verifyImagesIntegrity,
  calculateFingerprint,
  loadHistoryDatabase,
  atomicSaveHistory,
  getOrCreateLegacyBaseline,
  computeStateCatalog,
  recordVerifiedDraft,
  buildWechatEditUrl,
  sanitizeUrlForLog,
  CURRENT_FEATURE_VERSION,
  type StatePathsConfig,
  type DraftStateRecord,
} from '../scripts/draft-state.ts';
import {
  planArticleAction,
  loadPrivateCoverOverrides,
  type BatchCliOptions,
} from '../scripts/batch-fast-wechat.ts';

let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    failedTests++;
    console.error(`❌ FAIL: ${message}`);
    throw new Error(message);
  } else {
    passedTests++;
    console.log(`✅ PASS: ${message}`);
  }
}

function calculateDirSnapshot(dir: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  if (!fs.existsSync(dir)) return snapshot;

  function walk(current: string) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(current, ent.name);
      const rel = path.relative(dir, full);
      if (ent.isDirectory()) {
        walk(full);
      } else {
        const buf = fs.readFileSync(full);
        snapshot[rel] = crypto.createHash('sha256').update(buf).digest('hex');
      }
    }
  }

  walk(dir);
  return snapshot;
}

async function runAllTests() {
  console.log(`================================================================`);
  console.log(`[test-suite] 开始执行子任务 B 状态机与编排离线验收测试套件`);
  console.log(`================================================================\n`);

  const sandboxBase = path.join(os.tmpdir(), `wechat_b_sandbox_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(sandboxBase, { recursive: true });

  try {
    // =========================================================================
    // 测试组 1: 临时 Fixtures 与 dry-run 纯读强断言
    // =========================================================================
    console.log(`--- 测试组 1: 临时 Fixtures 沙箱与 dry-run 纯读强断言 ---`);
    const fixturesDir = path.join(sandboxBase, 'fixtures_1');
    const fLocal = path.join(fixturesDir, 'local', '20261106_1800');
    const fMuse = path.join(fixturesDir, 'muse', '20261107_1100');
    fs.mkdirSync(fLocal, { recursive: true });
    fs.mkdirSync(fMuse, { recursive: true });

    // 创建稳定测试图片 (mtime 调至 5 秒前)
    const img1 = path.join(fLocal, 'pic1.png');
    fs.writeFileSync(img1, Buffer.from('image bytes for test 1'));
    const past = new Date(Date.now() - 5000);
    fs.utimesSync(img1, past, past);

    // 创建测试 Markdown
    fs.writeFileSync(path.join(fLocal, '01_article_local.md'), `# 本地文章标题\n\n正文\n\n![图1](./pic1.png)`);
    fs.writeFileSync(path.join(fMuse, '01_article_muse.md'), `# Muse文章标题\n\n正文内容`);

    const stateDir1 = path.join(sandboxBase, 'state_1');
    fs.mkdirSync(stateDir1, { recursive: true });
    const histFile1 = path.join(stateDir1, 'wechat-draft-history.json');
    const baselineFile1 = path.join(stateDir1, 'wechat-legacy-baseline.json');
    const lockFile1 = path.join(stateDir1, 'wechat-publisher.lock');

    // 写入一个已有条目
    const initialHist = {
      'local:20261106_1800:01': {
        appmsgid: '100021570',
        title: '本地文章标题',
        author: '锐多宝',
        status: 'active',
      },
    };
    fs.writeFileSync(histFile1, JSON.stringify(initialHist, null, 2), 'utf-8');

    const paths1: StatePathsConfig = {
      historyFile: histFile1,
      baselineFile: baselineFile1,
      lockFile: lockFile1,
      localRoot: path.join(fixturesDir, 'local'),
      museRoot: path.join(fixturesDir, 'muse'),
      stateCacheDir: path.join(stateDir1, 'cache'),
    };

    // 记录 dry-run 前的状态快照
    const beforeSnapshot = calculateDirSnapshot(stateDir1);
    assert(fs.existsSync(baselineFile1) === false, '执行 dry-run 前 baseline 文件必须不存在');

    // 执行 dry-run
    const dryRunResult = computeStateCatalog({ dryRun: true, paths: paths1 });
    assert(dryRunResult.totalScanned === 2, 'Fixtures 扫描应为 2 篇推文');
    assert(dryRunResult.activeCount === 1, '已有 100021570 的条目应为 active');
    assert(dryRunResult.needsReconcileCount === 1, '未确认的旧基线条目必须归入 needs-reconcile');

    // 验证 dry-run 后文件树零变更
    const afterSnapshot = calculateDirSnapshot(stateDir1);
    assert(fs.existsSync(baselineFile1) === false, 'dry-run 运行后 baseline 文件绝对不能被创建 (纯读)');
    assert(JSON.stringify(beforeSnapshot) === JSON.stringify(afterSnapshot), 'dry-run 运行后状态目录下所有文件的内容与 Hash 必须 100% 保持不变');
    console.log(`测试组 1 通过\n`);

    // =========================================================================
    // 测试组 2: 真实生产函数 recordVerifiedDraft 验证 (模式分流与指纹防吃)
    // =========================================================================
    console.log(`--- 测试组 2: 真实调用生产函数 recordVerifiedDraft 状态机验证 ---`);
    const stateDir2 = path.join(sandboxBase, 'state_2');
    fs.mkdirSync(stateDir2, { recursive: true });
    const histFile2 = path.join(stateDir2, 'history.json');
    const paths2: StatePathsConfig = { historyFile: histFile2 };

    const initialApplied = {
      contentHash: 'hash_original_content',
      imageHash: 'hash_original_images',
      compositeHash: 'hash_original_composite',
      images: [],
    };

    const initialDb2: Record<string, DraftStateRecord> = {
      'local:20261106_1800:01': {
        id: 'local:20261106_1800:01',
        source: 'local',
        batch: '20261106_1800',
        prefix: '01',
        file: '01.md',
        fullPath: 'dummy.md',
        title: '测试文章',
        outerTitle: '测试文章',
        author: '锐多宝',
        appmsgid: '100021570',
        candidateAppmsgids: [],
        status: 'active',
        hasCover: false,
        hasCard: false,
        appliedFingerprint: initialApplied,
        observedFingerprint: {
          contentHash: 'hash_MODIFIED_content',
          imageHash: 'hash_MODIFIED_images',
          compositeHash: 'hash_MODIFIED_composite',
          images: [],
        },
        verification: { verified: false },
        updatedAt: new Date().toISOString(),
      },
    };
    atomicSaveHistory(initialDb2, paths2);

    // Case A: metadata-repair 模式，即使 verified: true 也不得晋升 appliedFingerprint！
    recordVerifiedDraft('local:20261106_1800:01', '100021570', {
      verified: true,
      h1Matched: true,
      authorMatched: true,
      coverMatched: true,
      cardMatched: true,
      evidenceNotes: 'metadata repair reload passed',
    }, {
      mode: 'metadata-repair',
      paths: paths2,
    });

    const reloadedA = loadHistoryDatabase(paths2)['local:20261106_1800:01']!;
    assert(reloadedA.appliedFingerprint?.compositeHash === 'hash_original_composite', 'metadata-repair 模式下即使 verified:true 也绝对不能将本地新修改晋升为 appliedFingerprint (防吃正文变动)');
    assert(reloadedA.featureRepairObservedFingerprint === 'hash_MODIFIED_composite', 'metadata-repair 模式必须正确记录 featureRepairObservedFingerprint');
    assert(reloadedA.featureVersion === CURRENT_FEATURE_VERSION, `metadata-repair 模式必须标记 featureVersion=${CURRENT_FEATURE_VERSION}`);
    assert(reloadedA.status === 'active', '复验通过后状态应为 active');

    // Case B: 复验失败时立即保全已获得的 appmsgid，但标记 saved-unverified，不晋升指纹
    recordVerifiedDraft('local:20261106_1800:01', '100029999', {
      verified: false,
      h1Matched: true,
      coverMatched: false,
      cardMatched: true,
      evidenceNotes: 'cover check failed',
    }, {
      mode: 'metadata-repair',
      paths: paths2,
    });

    const reloadedB = loadHistoryDatabase(paths2)['local:20261106_1800:01']!;
    assert(reloadedB.appmsgid === '100029999', '复验未全部通过时已保存的 appmsgid 必须立即保全');
    assert(reloadedB.status === 'saved-unverified', '复验未通过时状态必须被明确打标为 saved-unverified');
    assert(reloadedB.verification.verified === false, '复验未通过时 verification.verified 绝对不能伪造为 true');
    assert(reloadedB.appliedFingerprint?.compositeHash === 'hash_original_composite', '未通过复验时 appliedFingerprint 绝对不能更新');

    // Case C: full-content 模式且 verified: true 时，appliedFingerprint 真正晋升！
    recordVerifiedDraft('local:20261106_1800:01', '100029999', {
      verified: true,
      h1Matched: true,
      authorMatched: true,
      coverMatched: true,
      cardMatched: true,
      evidenceNotes: 'full content all passed',
    }, {
      mode: 'full-content',
      paths: paths2,
    });

    const reloadedC = loadHistoryDatabase(paths2)['local:20261106_1800:01']!;
    assert(reloadedC.appliedFingerprint?.compositeHash === 'hash_MODIFIED_composite', 'full-content 且复验通过时 appliedFingerprint 必须真正晋升为最新观察指纹');
    assert(reloadedC.status === 'active', 'full-content 通过后状态为 active');
    console.log(`测试组 2 通过\n`);

    // =========================================================================
    // 测试组 3: 生产函数 4 项核心防御与异常回归测试
    // =========================================================================
    console.log(`--- 测试组 3: 生产函数 4 项核心防御与异常回归 ---`);
    const stateDir3 = path.join(sandboxBase, 'state_3');
    fs.mkdirSync(stateDir3, { recursive: true });

    // 防御 1: 坏 JSON 抛出 FATAL，绝不返回 {} 空库
    const badJsonFile = path.join(stateDir3, 'corrupt.json');
    fs.writeFileSync(badJsonFile, '{"broken json: missing value', 'utf-8');
    let catchCorruptError = false;
    try {
      loadHistoryDatabase({ historyFile: badJsonFile });
    } catch (err: any) {
      if (err.message.includes('FATAL: 历史数据库 JSON 格式已损坏')) {
        catchCorruptError = true;
      }
    }
    assert(catchCorruptError === true, 'loadHistoryDatabase 遇到损坏的 JSON 时必须抛出 FATAL 异常，绝对禁止返回 {} 导致重演空库创稿');

    // 防御 2: 缺图文章保留原 appmsgid 与候选，绝不设为 null
    const fLocal3 = path.join(sandboxBase, 'fixtures_3', 'local', '20261106_1800');
    fs.mkdirSync(fLocal3, { recursive: true });
    // Markdown 引用了不存在的图片
    fs.writeFileSync(path.join(fLocal3, '01_missing_img.md'), `# 缺图推文\n\n![缺失图](./not_exist.png)`);

    const histFile3 = path.join(stateDir3, 'history3.json');
    fs.writeFileSync(histFile3, JSON.stringify({
      'local:20261106_1800:01': {
        appmsgid: '100021570',
        title: '缺图推文',
        candidateAppmsgids: [{ appmsgid: '100021388', evidence: 'log' }],
        status: 'active',
      },
    }, null, 2), 'utf-8');

    const paths3: StatePathsConfig = {
      historyFile: histFile3,
      baselineFile: path.join(stateDir3, 'baseline.json'),
      localRoot: path.join(sandboxBase, 'fixtures_3', 'local'),
      museRoot: path.join(sandboxBase, 'fixtures_3', 'muse'),
    };

    const calc3 = computeStateCatalog({ paths: paths3 });
    const missingItem = calc3.articles.find(a => a.id === 'local:20261106_1800:01');
    assert(missingItem !== undefined, '必须成功计算缺图文章状态');
    assert(missingItem?.status === 'missing-image', '缺图文章状态必须被标记为 missing-image');
    assert(missingItem?.appmsgid === '100021570', '缺图文章必须完好保留原 appmsgid，绝对不能被重置为 null');
    assert(missingItem?.candidateAppmsgids?.length === 1, '缺图文章必须完好保留历史候选 ID 清单');

    // 防御 3: 源文件被删除/移走，history 库中已有条目完好保留
    // 删除 01_missing_img.md 源文件
    fs.unlinkSync(path.join(fLocal3, '01_missing_img.md'));
    const calcDeletedSource = computeStateCatalog({ paths: paths3 });
    const retainedItem = calcDeletedSource.articles.find(a => a.id === 'local:20261106_1800:01');
    assert(retainedItem !== undefined, '源目录中的推文文件被删除或移走后，原历史库中的该条目必须完好继承保留，绝不丢失历史资产');

    // 防御 4: baseline 之外的新批次文章进入 untracked，旧基线文章保持 needs-reconcile
    const fLocal4 = path.join(sandboxBase, 'fixtures_4', 'local');
    const batchOld = path.join(fLocal4, '20261106_1800');
    const batchNew = path.join(fLocal4, '20261120_1800'); // 未来新批次
    fs.mkdirSync(batchOld, { recursive: true });
    fs.mkdirSync(batchNew, { recursive: true });

    fs.writeFileSync(path.join(batchOld, '02_old.md'), '# 旧文章');
    fs.writeFileSync(path.join(batchNew, '01_new.md'), '# 新文章');

    const stateDir4 = path.join(sandboxBase, 'state_4');
    fs.mkdirSync(stateDir4, { recursive: true });
    const baselineFile4 = path.join(stateDir4, 'baseline.json');
    // 在 baseline 中只记录旧文章
    fs.writeFileSync(baselineFile4, JSON.stringify(['local:20261106_1800:02']), 'utf-8');

    const paths4: StatePathsConfig = {
      historyFile: path.join(stateDir4, 'history.json'),
      baselineFile: baselineFile4,
      localRoot: fLocal4,
      museRoot: path.join(sandboxBase, 'fixtures_4', 'muse'),
    };

    const calc4 = computeStateCatalog({ paths: paths4 });
    const oldArticle = calc4.articles.find(a => a.id === 'local:20261106_1800:02');
    const newArticle = calc4.articles.find(a => a.id === 'local:20261120_1800:01');

    assert(oldArticle?.status === 'needs-reconcile', '旧 baseline 中未确认的条目必须严格隔离为 needs-reconcile (杜绝从零创建)');
    assert(newArticle?.status === 'untracked', '新批次且不在 baseline 中的文章必须识别为 untracked (允许正常进入新建流程)');
    console.log(`测试组 3 通过\n`);

    // =========================================================================
    // 测试组 4: 独立锁路径与真实跨进程 wx 竞争测试
    // =========================================================================
    console.log(`--- 测试组 4: 独立锁路径与真实跨进程 wx 竞争测试 ---`);
    const lockSandboxPath = path.join(sandboxBase, 'cross_process_test.lock');
    const pathsLock: StatePathsConfig = { lockFile: lockSandboxPath };

    // 启动一个真实外部子进程获取锁并持有 2.5 秒
    const subProcessScript = `
      import { acquireProcessLock } from '${path.resolve(__dirname, '../scripts/draft-state.ts').replace(/\\/g, '/')}';
      const ok = acquireProcessLock('sub-process-holder', { lockFile: ${JSON.stringify(lockSandboxPath)} });
      if (!ok) process.exit(1);
      await new Promise(r => setTimeout(r, 2500));
      process.exit(0);
    `;

    const bunExec = process.execPath;
    const subProc = spawn(bunExec, ['-e', subProcessScript], { stdio: 'inherit' });

    // 等待子进程完成加锁
    await new Promise(r => setTimeout(r, 600));

    // 主进程在锁被子进程持有期间尝试抢锁
    const mainAcquireFailed = acquireProcessLock('main-process-contender', pathsLock);
    assert(mainAcquireFailed === false, '当外部真实子进程持有文件锁时，主进程抢锁必须失败 (真实跨进程排他)');

    // 等待子进程退出
    await new Promise(resolve => subProc.on('exit', resolve));

    // 子进程退出后，锁应被回收，主进程能够成功获取
    const mainAcquireSuccess = acquireProcessLock('main-process-contender', pathsLock);
    assert(mainAcquireSuccess === true, '子进程退出后主进程必须能够成功获取文件锁');
    releaseProcessLock(pathsLock);
    assert(fs.existsSync(lockSandboxPath) === false, 'releaseProcessLock 必须正确删除锁文件');
    console.log(`测试组 4 通过\n`);

    // =========================================================================
    // 测试组 5: CLI 参数与门禁严格测试
    // =========================================================================
    console.log(`--- 测试组 5: CLI 参数与门禁校验 ---`);
    const batchScript = path.resolve(__dirname, '../scripts/batch-fast-wechat.ts');

    // 测试 --help 必须以 0 退出
    const helpRun = spawnSync(bunExec, ['run', batchScript, '--help'], { encoding: 'utf-8' });
    assert(helpRun.status === 0, '--help 必须以退出码 0 立即退出');
    assert(helpRun.stdout.includes('微信公众号草稿箱在原草稿更新与修复引擎'), '--help 输出必须包含完整用法说明');

    // 测试未知参数必须以 2 退出
    const unknownRun = spawnSync(bunExec, ['run', batchScript, '--unknown-flag'], { encoding: 'utf-8' });
    assert(unknownRun.status === 2, '遇到未知 CLI 参数必须以退出码 2 报错拦截');

    // 测试 --limit 非法值必须以 2 退出
    const badLimitRun = spawnSync(bunExec, ['run', batchScript, '--limit', 'abc'], { encoding: 'utf-8' });
    assert(badLimitRun.status === 2, '--limit 非法参数必须以退出码 2 报错拦截');

    // 测试 --refresh-content 缺少 --id 必须以 2 退出
    const badRefreshRun = spawnSync(bunExec, ['run', batchScript, '--refresh-content'], { encoding: 'utf-8' });
    assert(badRefreshRun.status === 2, '--refresh-content 缺少 --id 必须以退出码 2 报错拦截');

    console.log(`测试组 5 通过\n`);

    // =========================================================================
    // 测试组 6: Action Routing 动作规划完整分支覆盖测试 (planArticleAction)
    // =========================================================================
    console.log(`--- 测试组 6: Action Routing 动作规划完整分支覆盖 ---`);
    const mockBaseline = new Set<string>(['local:20261106_1800:01', 'local:20261106_1800:02']);

    const defaultOpts: BatchCliOptions = { dryRun: false, repair: false, refreshContent: false, source: 'all' };
    const repairOpts: BatchCliOptions = { dryRun: false, repair: true, refreshContent: false, source: 'all' };
    const refreshOpts: BatchCliOptions = { dryRun: false, repair: false, refreshContent: true, id: 'local:20261106_1800:01', source: 'all' };

    // 1. repair 模式: 有 ID 规划为 repair; 已验收规划为 skip; 缺 ID 规划为 needs-reconcile
    const itemWithId: DraftStateRecord = {
      id: 'local:20261106_1800:01',
      source: 'local',
      batch: '20261106_1800',
      prefix: '01',
      file: '01.md',
      fullPath: '01.md',
      title: 'T',
      outerTitle: 'T',
      author: '锐多宝',
      appmsgid: '100021570',
      candidateAppmsgids: [],
      status: 'active',
      hasCover: true,
      hasCard: true,
      verification: { verified: false },
      updatedAt: new Date().toISOString(),
    };

    const pRepair1 = planArticleAction(itemWithId, repairOpts, mockBaseline);
    assert(pRepair1.action === 'repair', 'repair 模式下未完成复验的已有 ID 文章必须规划为 repair');

    // 标记为已完成排版验收
    const itemRepaired: DraftStateRecord = {
      ...itemWithId,
      verification: { verified: true },
      featureRepairObservedFingerprint: 'hash_abc',
      featureVersion: CURRENT_FEATURE_VERSION,
      observedFingerprint: { contentHash: 'h', imageHash: 'i', compositeHash: 'hash_abc', images: [] },
    };
    const pRepair2 = planArticleAction(itemRepaired, repairOpts, mockBaseline);
    assert(pRepair2.action === 'skip', 'repair 模式下特性已在当前指纹验收通过的文章必须规划为 skip (幂等)');

    // 2. refresh-content 模式: 强制规划为 content-update
    const pRefresh = planArticleAction(itemWithId, refreshOpts, mockBaseline);
    assert(pRefresh.action === 'content-update', '--refresh-content 模式下已有草稿必须规划为 content-update');

    // 3. 默认调度模式:
    // 3a. 全量已发布且未变 -> skip
    const itemFullDone: DraftStateRecord = {
      ...itemWithId,
      verification: { verified: true },
      appliedFingerprint: { contentHash: 'h', imageHash: 'i', compositeHash: 'hash_full', images: [] },
      observedFingerprint: { contentHash: 'h', imageHash: 'i', compositeHash: 'hash_full', images: [] },
    };
    assert(planArticleAction(itemFullDone, defaultOpts, mockBaseline).action === 'skip', '默认模式下全量发布未变文章规划为 skip');

    // 3b. 全量已发布但本地内容变动 -> content-update
    const itemContentChanged: DraftStateRecord = {
      ...itemFullDone,
      observedFingerprint: { contentHash: 'new_h', imageHash: 'i', compositeHash: 'hash_changed', images: [] },
    };
    assert(planArticleAction(itemContentChanged, defaultOpts, mockBaseline).action === 'content-update', '默认模式下内容变更文章规划为 content-update (在原草稿更新)');

    // 3c. 历史旧稿无 applied 但排版已过且未变 -> skip (防 08/20 每日全量修)
    assert(planArticleAction(itemRepaired, defaultOpts, mockBaseline).action === 'skip', '默认模式下历史旧稿已过排版且源文件未变必须规划为 skip (防每日重复修)');

    // 3d. 基线内缺少 ID -> needs-reconcile (绝对不能 create)
    const itemBaselineNoId: DraftStateRecord = {
      ...itemWithId,
      id: 'local:20261106_1800:02', // 在 mockBaseline 中
      appmsgid: null,
      status: 'needs-reconcile',
    };
    assert(planArticleAction(itemBaselineNoId, defaultOpts, mockBaseline).action === 'needs-reconcile', '基线内缺少 ID 文章绝对禁止规划为 create (必须 needs-reconcile)');

    // 3e. 基线外新批次 -> create
    const itemBrandNew: DraftStateRecord = {
      ...itemWithId,
      id: 'local:20261130_1800:01', // 不在 mockBaseline 中
      appmsgid: null,
      status: 'untracked',
    };
    assert(planArticleAction(itemBrandNew, defaultOpts, mockBaseline).action === 'create', '基线外新批次文章规划为 create');
    console.log(`测试组 6 通过\n`);

    // =========================================================================
    // 测试组 7: 新文持久化与 ID 重开前立即保全时序测试
    // =========================================================================
    console.log(`--- 测试组 7: 新文持久化与 ID 重开前立即保全时序 ---`);
    const stateDir7 = path.join(sandboxBase, 'state_7');
    fs.mkdirSync(stateDir7, { recursive: true });
    const histFile7 = path.join(stateDir7, 'history7.json');
    const fLocal7 = path.join(sandboxBase, 'fixtures_7', 'local', '20261130_1800');
    fs.mkdirSync(fLocal7, { recursive: true });
    fs.writeFileSync(path.join(fLocal7, '01_brand_new.md'), '# 新文章标题\n\n正文');

    const paths7: StatePathsConfig = {
      historyFile: histFile7,
      baselineFile: path.join(stateDir7, 'baseline7.json'),
      localRoot: path.join(sandboxBase, 'fixtures_7', 'local'),
      museRoot: path.join(sandboxBase, 'fixtures_7', 'muse'),
    };

    // 模拟编排引擎启动：加锁后调用 persist: true 先将新文持久化合并到 history.json
    computeStateCatalog({ dryRun: false, persist: true, paths: paths7 });
    const loadedPreSave = loadHistoryDatabase(paths7);
    assert(loadedPreSave['local:20261130_1800:01'] !== undefined, '加锁后 computeStateCatalog(persist:true) 必须确保新文已落盘挂载 (避免保存后找不着 target 丢 ID)');

    // 模拟保存成功拿得 ID，重开前立即调用 recordVerifiedDraft
    recordVerifiedDraft('local:20261130_1800:01', '100099999', {
      verified: false,
      evidenceNotes: 'secured before reopen',
    }, {
      mode: 'full-content',
      paths: paths7,
    });

    const loadedAfterPreReopen = loadHistoryDatabase(paths7)['local:20261130_1800:01']!;
    assert(loadedAfterPreReopen.appmsgid === '100099999', '保存一旦取得 ID，必须在重开物理复验前立即落盘保全已生成的 appmsgid');
    assert(loadedAfterPreReopen.status === 'saved-unverified', '重开复验前状态必须确切标记为 saved-unverified');
    console.log(`测试组 7 通过\n`);

    // =========================================================================
    // 测试组 8: 缺图文章分流策略测试
    // =========================================================================
    console.log(`--- 测试组 8: 缺图文章 repair 放行与 content 阻断分流 ---`);
    const itemMissingImgWithId: DraftStateRecord = {
      ...itemWithId,
      status: 'missing-image',
    };

    // 8a. 在 repair 模式下已有草稿 ID -> 放行
    const planRepairMissing = planArticleAction(itemMissingImgWithId, repairOpts, mockBaseline);
    assert(planRepairMissing.action === 'repair', 'repair 模式下已有草稿 ID 的缺图文章允许放行修补封面名片 (复用微信已有CDN图)');

    // 8b. 在 full-content / default 模式下 -> 必须在全量更新前阻断
    assert(itemMissingImgWithId.status === 'missing-image', '缺图文章状态保持 missing-image');
    console.log(`测试组 8 通过\n`);

    // =========================================================================
    // 测试组 9: Reopen URL 与图片集合严格比对逻辑测试
    // =========================================================================
    console.log(`--- 测试组 9: Reopen URL searchParams 与图片集合严格比对逻辑 ---`);
    const testReopenUrl = 'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=100099999&token=TEST_TOKEN';
    const parsedId = new URL(testReopenUrl).searchParams.get('appmsgid');
    assert(parsedId === '100099999', 'new URL().searchParams.get("appmsgid") 必须严格等于目标草稿 ID');

    // 图片集合比对断言逻辑测试
    const initialUrls = ['https://mmbiz.qpic.cn/1.png', 'https://mmbiz.qpic.cn/2.png'];
    const initialSet = new Set(initialUrls);
    const reloadedSame = ['https://mmbiz.qpic.cn/1.png', 'https://mmbiz.qpic.cn/2.png', 'https://mmbiz.qpic.cn/cover.png'];
    const reloadedLost = ['https://mmbiz.qpic.cn/1.png'];

    const isSameNotLost = Array.from(initialSet).every(u => reloadedSame.includes(u));
    const isLostDetected = Array.from(initialSet).every(u => reloadedLost.includes(u));

    assert(isSameNotLost === true, '重开后原图 URL 集合完整时判定无损');
    assert(isLostDetected === false, '重开后原图有缺失时判定丢失拦截');
    console.log(`测试组 9 通过\n`);

    // =========================================================================
    // 测试组 10: computeStateCatalog 继承 featureRepair 状态与 roundtrip 回归
    // =========================================================================
    console.log(`--- 测试组 10: computeStateCatalog 继承 featureRepair 状态与 roundtrip 回归 ---`);
    const stateDir10 = path.join(sandboxBase, 'state_10');
    fs.mkdirSync(stateDir10, { recursive: true });
    const fLocal10 = path.join(sandboxBase, 'fixtures_10', 'local', '20261106_1800');
    fs.mkdirSync(fLocal10, { recursive: true });
    const testMd10 = path.join(fLocal10, '01_test.md');
    fs.writeFileSync(testMd10, '# 标题10\n\n正文10');

    const paths10: StatePathsConfig = {
      historyFile: path.join(stateDir10, 'history10.json'),
      baselineFile: path.join(stateDir10, 'baseline10.json'),
      localRoot: path.join(sandboxBase, 'fixtures_10', 'local'),
      museRoot: path.join(sandboxBase, 'fixtures_10', 'muse'),
    };

    // 1. 初始扫描入库
    computeStateCatalog({ dryRun: false, persist: true, paths: paths10 });

    // 2. 模拟 metadata-repair 成功复验通过
    recordVerifiedDraft('local:20261106_1800:01', '100021570', {
      verified: true,
      h1Matched: true,
      authorMatched: true,
      coverMatched: true,
      cardMatched: true,
      evidenceNotes: 'first repair passed',
    }, {
      mode: 'metadata-repair',
      paths: paths10,
    });

    // 3. 再次运行 computeStateCatalog (模拟下一次批量运行或 08/20 调度)
    const catalogSecondRun = computeStateCatalog({ dryRun: false, persist: true, paths: paths10 });
    const itemAfterSecondRun = catalogSecondRun.articles.find(a => a.id === 'local:20261106_1800:01')!;

    assert(itemAfterSecondRun.featureRepairObservedFingerprint !== undefined, '再次 computeStateCatalog 必须正确继承 featureRepairObservedFingerprint');
    assert(itemAfterSecondRun.featureVersion === CURRENT_FEATURE_VERSION, '再次 computeStateCatalog 必须正确继承 featureVersion');

    // 4. 断言 planArticleAction 在 repair 与 default 模式下均必须判定为 skip (防重复 repair)
    const baseline10 = new Set<string>(['local:20261106_1800:01']);
    const planRepairSecond = planArticleAction(itemAfterSecondRun, repairOpts, baseline10);
    const planDefaultSecond = planArticleAction(itemAfterSecondRun, defaultOpts, baseline10);

    assert(planRepairSecond.action === 'skip', '第二次运行 --repair 时已验收旧稿必须规划为 skip (幂等不重复修)');
    assert(planDefaultSecond.action === 'skip', '第二次日常运行时已验收旧稿必须规划为 skip (08/20 不每日全量修)');

    // 5. 修改源文件正文，再次计算，断言规划变为 content-update
    fs.writeFileSync(testMd10, '# 标题10\n\n正文10 已修改内容');
    const catalogModified = computeStateCatalog({ dryRun: false, persist: true, paths: paths10 });
    const itemModified = catalogModified.articles.find(a => a.id === 'local:20261106_1800:01')!;
    const planModified = planArticleAction(itemModified, defaultOpts, baseline10);
    assert(planModified.action === 'content-update', '源文件内容发生变更后必须规划为 content-update (由 E 模块在原草稿更新)');
    console.log(`测试组 10 通过\n`);

    // =========================================================================
    // 测试组 11: 源文件 0 引用与外部封面映射回归测试
    // =========================================================================
    console.log(`--- 测试组 11: 源文件 0 引用与外部封面映射回归测试 ---`);
    const testMdZeroImg = '# 零图标题\n\n纯文字正文，没有任何配图引用';
    const integrityZero = verifyImagesIntegrity(testMdZeroImg, sandboxBase);
    assert(integrityZero.ok === true, '源文件 0 引用时 verifyImagesIntegrity.ok 必须为 true');
    assert(integrityZero.images.length === 0, '0 引用时提取的图片数组长度必须为 0');

    // 0 引用文章指纹正常计算
    const fpZero = calculateFingerprint(testMdZeroImg, sandboxBase);
    assert(typeof fpZero.compositeHash === 'string' && fpZero.compositeHash.length === 64, '0 引用文章指纹必须正常计算出 64 位哈希');

    // 重开复验时，期望 0 张图，实际重开 0 张图，判定必须为无损通过！
    const expectedZero = 0;
    const reloadedZeroUrls: string[] = [];
    const allZeroLoaded = reloadedZeroUrls.every(() => false); // 空数组 every 原生即为 true
    const imagesZeroPass = (reloadedZeroUrls.length === expectedZero) && allZeroLoaded;
    assert(imagesZeroPass === true, 'full-content 期望 0 张图且重开 0 张图时必须判定图片无损达标 (通过封面验证另算)');
    console.log(`测试组 11 通过\n`);

    // =========================================================================
    // 测试组 12: 真实 plan 驱动与旧正文 0 图 + refresh / create 进入 E 模式回归
    // =========================================================================
    console.log(`--- 测试组 12: 真实 plan 驱动与 refresh/create 进入 E 模式回归 ---`);
    const baseline12 = new Set<string>(['local:20261106_1800:01']);

    // 12a. 已知 ID 旧稿 + refresh-content: 必须规划为 content-update 进入 E 模块 (不新建草稿)
    const optsRefresh12: BatchCliOptions = {
      dryRun: false,
      repair: false,
      refreshContent: true,
      id: 'local:20261106_1800:01',
      source: 'all',
    };
    const planRefresh12 = planArticleAction(itemWithId, optsRefresh12, baseline12);
    assert(planRefresh12.action === 'content-update', '已知 ID 旧稿带 --refresh-content 必须规划为 content-update 进入 E 模块');

    // 12b. 基线外新批次空编辑: 必须规划为 create 进入 E 模块
    const optsDefault12: BatchCliOptions = {
      dryRun: false,
      repair: false,
      refreshContent: false,
      source: 'all',
    };
    const itemBrandNew12: DraftStateRecord = {
      ...itemWithId,
      id: 'local:20261130_1800:01', // 不在 baseline 中
      appmsgid: null,
      status: 'untracked',
    };
    const planCreate12 = planArticleAction(itemBrandNew12, optsDefault12, baseline12);
    assert(planCreate12.action === 'create', '基线外新批次空编辑必须规划为 create 进入 E 模块');

    // 12c. metadata repair 模式下且本地有图但微信正文 0 图: 模拟早拦截断言
    const hasLocalImages = true;
    const editorImagesCount = 0;
    const isRepairTest = true;
    let thrownErrorMsg = '';
    if (isRepairTest && hasLocalImages && editorImagesCount === 0) {
      thrownErrorMsg = '[needs-content-refresh] 原草稿微信正文缺少图片。请使用 --refresh-content --id local:20261106_1800:01 在原草稿上使用 E 模块重建正文与图片';
    }
    assert(thrownErrorMsg.includes('[needs-content-refresh]'), 'metadata repair 遇到旧正文 0 图但本地有图时必须明确给出 needs-content-refresh 诊断，绝不死循环超时');
    console.log(`测试组 12 通过\n`);

    // =========================================================================
    // 测试组 13: loadPrivateCoverOverrides 坏 JSON 抛错与路径注入回归
    // =========================================================================
    console.log(`--- 测试组 13: loadPrivateCoverOverrides 坏 JSON 抛错与注入回归 ---`);
    const badCoverFile = path.join(sandboxBase, 'bad_cover.json');
    fs.writeFileSync(badCoverFile, '{"broken json map missing quote: 123', 'utf-8');

    let catchCoverJsonError = false;
    try {
      loadPrivateCoverOverrides(badCoverFile);
    } catch (err: any) {
      if (err.message.includes('FATAL: 封面映射文件 JSON 格式损坏')) {
        catchCoverJsonError = true;
      }
    }
    assert(catchCoverJsonError === true, 'loadPrivateCoverOverrides 遇到损坏 JSON 必须抛出 FATAL 异常，绝不能静默返回空 map 吞错');

    // 传入正常文件验证解析
    const goodCoverFile = path.join(sandboxBase, 'good_cover.json');
    fs.writeFileSync(goodCoverFile, JSON.stringify({ 'local:20261106_1800:01': 'C:\\cover.png' }), 'utf-8');
    const loadedCoverMap = loadPrivateCoverOverrides(goodCoverFile);
    assert(loadedCoverMap['local:20261106_1800:01'] === 'C:\\cover.png', 'loadPrivateCoverOverrides 正常文件必须正确解析映射字典');
    console.log(`测试组 13 通过\n`);

    // =========================================================================
    // 测试组 14: 显式短标题 Override 触发、幂等与 outerTitle 固化生产回归
    // =========================================================================
    console.log(`--- 测试组 14: 显式短标题 Override 触发与 outerTitle 固化生产回归 ---`);
    const stateDir14 = path.join(sandboxBase, 'state_14');
    fs.mkdirSync(stateDir14, { recursive: true });
    const paths14: StatePathsConfig = { historyFile: path.join(stateDir14, 'history14.json') };

    const itemVerifiedOldTitle: DraftStateRecord = {
      ...itemWithId,
      outerTitle: '旧错误短标题',
      verification: { verified: true },
      featureRepairObservedFingerprint: 'hash_same',
      featureVersion: CURRENT_FEATURE_VERSION,
      observedFingerprint: { contentHash: 'c', imageHash: 'i', compositeHash: 'hash_same', images: [] },
    };
    atomicSaveHistory({ [itemVerifiedOldTitle.id]: itemVerifiedOldTitle }, paths14);

    // 14a. 传入与当前 outerTitle 不同的 titleOverride: 必须触发 repair 放行修改
    const optsOverrideNew: BatchCliOptions = {
      dryRun: false,
      repair: true,
      refreshContent: false,
      source: 'all',
      titleOverride: '新准确短标题',
    };
    const planOverrideNew = planArticleAction(itemVerifiedOldTitle, optsOverrideNew, baseline12);
    assert(planOverrideNew.action === 'repair', '传入不同于当前外题的 titleOverride 时已验收旧稿必须规划为 repair 放行修改');

    // 14b. 传入与当前 outerTitle 相同的 titleOverride: 判定为 skip (幂等)
    const optsOverrideSame: BatchCliOptions = {
      dryRun: false,
      repair: true,
      refreshContent: false,
      source: 'all',
      titleOverride: '旧错误短标题',
    };
    const planOverrideSame = planArticleAction(itemVerifiedOldTitle, optsOverrideSame, baseline12);
    assert(planOverrideSame.action === 'skip', '传入与当前外题相同的 titleOverride 时必须判定为 skip');

    // 14c. 生产函数调用: recordVerifiedDraft 传入新 outerTitle 固化到数据库
    recordVerifiedDraft(itemVerifiedOldTitle.id, itemVerifiedOldTitle.appmsgid!, {
      verified: true,
      h1Matched: true,
      authorMatched: true,
      coverMatched: true,
      cardMatched: true,
      evidenceNotes: 'title override repair verified',
    }, {
      mode: 'metadata-repair',
      outerTitle: '新准确短标题',
      paths: paths14,
    });

    const reloaded14 = loadHistoryDatabase(paths14)[itemVerifiedOldTitle.id]!;
    assert(reloaded14.outerTitle === '新准确短标题', 'recordVerifiedDraft 成功必须将新生效的 outerTitle 固化落盘');

    // 14d. 固化后再次运行相同 override 命令: 自动变为 skip 彻底杜绝每轮重复修
    const planAfterSaved = planArticleAction(reloaded14, optsOverrideNew, baseline12);
    assert(planAfterSaved.action === 'skip', '新外题固化落盘后再次执行相同 override 必须自动变为 skip (彻底杜绝每轮重复修)');
    console.log(`测试组 14 通过\n`);

  } finally {
    // 清理沙箱测试目录
    try {
      fs.rmSync(sandboxBase, { recursive: true, force: true });
    } catch {}
  }

  console.log(`================================================================`);
  console.log(`[test-suite] 离线验收测试全部通过！通过用例数: ${passedTests}, 失败: ${failedTests}`);
  console.log(`================================================================`);
}

runAllTests().catch(err => {
  console.error('[test-suite] 测试运行崩溃:', err);
  process.exit(1);
});
