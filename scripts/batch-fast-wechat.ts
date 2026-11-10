#!/usr/bin/env bun
/**
 * batch-fast-wechat.ts — 单窗口、多标签页、无缝批量写入微信公众号草稿箱（全功能完美版）
 * 
 * 核心升级与要素：
 * 1. 【单窗口常驻多标签】：不重启浏览器，不弹二维码，主页常驻，开标签写完存草稿立即关标签，循环下一篇！
 * 2. 【推文标题严格限制】：所有标题严格 <= 15 个汉字（智能精简，杜绝冗长与折叠）。
 * 3. 【作者字段自动填充】：作者严格固定自动填写为 “锐多宝”。
 * 4. 【摘要与元数据精准分行】：彻底解决摘要/元数据挤成一团的问题，确保期刊、题目、作者、出处各自独立换行并带清晰间距。
 * 5. 【文章底部插入锐多宝名片】：文章末尾自动挂载锐多宝官方公众号名片组件与关注引导。
 * 6. 【文章自动设置封面预览图】：文章插入图片后，自动调用“从正文选择”截取首图设为 2.35:1 及 1:1 封面，草稿列表必带预览图。
 * 7. 【顶级科技排版主题】：全面采用 grace 优雅科技蓝主题，卡片药丸标题、圆角阴影，排版比肩专业科技杂志。
 * 8. 【全流程深度去空行】：源码、HTML 与 ProseMirror DOM 三重过滤，彻底消灭空白段落。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  CdpConnection,
  findChromeExecutable,
  findExistingChromeDebugPort,
  getDefaultProfileDir,
  launchChrome,
  sleep,
  type ChromeSession,
} from './cdp.ts';
import { convertMarkdown } from './md-to-wechat.ts';

const WECHAT_URL = 'https://mp.weixin.qq.com/';
const BODY_EDITOR_SELECTOR = '.rich_media_content .ProseMirror';
const HISTORY_FILE = 'C:\\Users\\Administrator\\.agents\\skills\\wechat-md-pipeline\\data\\wechat-draft-history.json';
const MUSE_ROOT = 'F:\\同步文件夹\\公众号\\每日推文';
const LOCAL_ROOT = 'Z:\\自媒体\\公众号\\每日推文';

// -----------------------------------------------------------------------------
// 1. 标题精炼函数（严格 <= 15 个字）
// -----------------------------------------------------------------------------
function refineTitleTo15Chars(raw: string): string {
  let t = raw
    .replace(/^#+\s*/, '')
    .replace(/^(\d{2}_)+/, '')
    .replace(/^【.*?】/, '')
    .replace(/^\[.*?\]/, '')
    .replace(/^(RSE|ISPRS|JAG|IEEE|ESSD|Nature)[^：:]*[：:]\s*/i, '')
    .replace(/[，,：:：、“”"''！!？?]/g, ' ')
    .trim();

  t = t.replace(/\s+/g, '');

  if (t.length <= 15) return t;

  // 针对长标题进行智能压缩提取核心主干（确保 <= 15 字）
  if (t.includes('PlanetScope') && t.includes('枯死木')) return '3米卫星探测森林枯死立木';
  if (t.includes('Mamba') && t.includes('遥感')) return 'Mamba多模态遥感融合分类';
  if (t.includes('ContrailStruct') || t.includes('凝结尾迹')) return '首个飞机凝结尾迹分割数据集';
  if (t.includes('神经网络') && t.includes('微波')) return '神经网络算子同化微波亮温';
  if (t.includes('哨兵') && t.includes('S3-NGT')) return '哨兵3号下一代地形测量卫星';
  if (t.includes('陈晋') && t.includes('LAI')) return '北师大3D辐射传输玉米LAI';
  if (t.includes('雷扬') && t.includes('InSAR')) return '双频双基地InSAR森林物候';
  if (t.includes('高显俊') && t.includes('厚云')) return '概率流扩散模型卫星厚云去除';
  if (t.includes('陈能成') && t.includes('LVOD')) return '物理约束降尺度中国LVOD制图';
  if (t.includes('TerraMesh') || t.includes('开放词汇')) return '遥感开放词表分割基准发布';
  if (t.includes('垃圾带') || t.includes('海水变色')) return '大西洋垃圾带海水变色监测';
  if (t.includes('瑞士') && t.includes('树种')) return '瑞士全国高精树种组成图发布';
  if (t.includes('CARM') || t.includes('超分辨率')) return 'CARM可信卫星超分辨率重构';
  if (t.includes('宏图一号') || t.includes('TomoSAR')) return '宏图一号雷达层析森林高精测高';
  if (t.includes('童小华') || t.includes('OESTR')) return '风云三号D星全天候地表温度';
  if (t.includes('郭庆华') || t.includes('GEDI')) return '无人机与星载GEDI全国林下穿透';
  if (t.includes('FGPMamba') || t.includes('建筑变化')) return '频域先验Mamba建筑变化检测';
  if (t.includes('风云四号') || t.includes('冬小麦')) return '风云四号遥感冬小麦干旱节律';
  if (t.includes('HPMoE') || t.includes('三维建筑')) return '高程提示专家模型3D建筑变检';
  if (t.includes('SOVSNet') || t.includes('雷达遥感')) return '空天院雷达遥感开放词表分割';
  if (t.includes('MetroInSAR') || t.includes('地铁')) return '城市地铁全线毫米级沉降诊断';
  if (t.includes('孙颖') || t.includes('荧光')) return '玉米冠层三维荧光垂直梯度解析';
  if (t.includes('关美宝') || t.includes('滑坡')) return '地球物理适配大模型跨域滑坡';
  if (t.includes('汤进') || t.includes('无人机')) return '残差感知无人机卫星跨视角定位';
  if (t.includes('WMoENet') || t.includes('舰船')) return '小波多模态雷达光学舰船检测';
  if (t.includes('OSIRIS') || t.includes('三维地形')) return 'OSIRIS浏览器切出三维地形';
  if (t.includes('CFDID') || t.includes('洪涝灾害')) return '中国洪涝灾害影响数据库发布';
  if (t.includes('沈焕锋') || t.includes('地表温度')) return '武大突破30米地表温度降尺度';
  if (t.includes('刁春源') || t.includes('玉米')) return 'UIUC刁春源团队少样本玉米估产';

  return t.slice(0, 15);
}

// -----------------------------------------------------------------------------
// 2. 空行净化与摘要/元数据分行格式化
// -----------------------------------------------------------------------------
function purifyMarkdown(content: string): string {
  let text = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 处理头部摘要与元数据块（> 引用块），确保每一行都有换行标签或双空格硬换行
  text = text.replace(/^>[\s\S]*?(?=\n\n|\n[^- >#])/m, (block) => {
    return block
      .split('\n')
      .map(line => {
        if (/^>\s*\*\*[^*]+\*\*：/.test(line)) {
          // 在每一项元数据（如论文期刊、论文题目）前加清晰分行
          return line.trimEnd() + '<br />';
        }
        return line.trimEnd();
      })
      .join('\n');
  });

  // 压缩连续多余空行（3个及以上换行压为2个）
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

function postProcessHtml(html: string): string {
  // 1. 深度确保 blockquote 内部的各项元数据分行独立展示
  html = html.replace(/<blockquote[\s\S]*?<\/blockquote>/gi, (bq) => {
    let b = bq.replace(/\\(\s*<\/p>|\s*<strong)/g, '<br />$1');
    // 针对被压缩进同一个 <p> 的多个 <strong> 项插入分行
    b = b.replace(/(<strong[^>]*>.*?<\/strong>)/gi, (m, tag, offset) => {
      if (offset > 60 && !b.slice(offset - 10, offset).includes('<br')) {
        return '<br style="line-height:2em;" />' + m;
      }
      return m;
    });
    return b;
  });

  // 2. 清除任何空白的空段落容器
  html = html.replace(/<p>\s*(<br\s*\/?>|&nbsp;|\s*)*<\/p>/gi, '');
  html = html.replace(/<div>\s*(<br\s*\/?>|&nbsp;|\s*)*<\/div>/gi, '');

  // 3. 末尾插入【锐多宝官方公众号名片】及关注引导组件
  const cardHtml = `
<section style="margin: 45px auto 25px auto; padding: 20px 10px; border-top: 1px dashed #dcdcdc; text-align: center;">
  <p style="color: #666; font-size: 14px; margin-bottom: 15px;">👇 关注【锐多宝】公众号，获取最新遥感科技资讯与论文速递：</p>
  <div class="wx_profile weui-flex"><div class="wx_profile_hd"><img src="http://mmbiz.qpic.cn/sz_mmbiz_png/vVd0EtPL5ImHdgCTYTNyqkveib6xpYMjwADzu95yj3FVle1mVWDD6CTUxvnJYI5aTU7mHffnqpVoGGDkibJaKK2UgH197gJhibbOLozg7w5iblQ/0?wx_fmt=png" alt="" class="wx_profile_avatar"></div> <div class="wx_profile_bd weui-flex weui-flex__item"><div class="weui-flex__item"><div class="wx_profile_nickname_wrp"><strong id="js_a11y_wx_profile_nickname" class="wx_profile_nickname">锐多宝</strong> <span class="wx_follow_verify"></span></div> <div id="js_a11y_wx_profile_desc" class="wx_profile_desc">锐多宝的地理空间   原名:遥感之家</div> <!----></div> <i class="weui-icon-arrow"></i></div></div>
</section>
  `.trim();

  return html + '\n' + cardHtml;
}

// -----------------------------------------------------------------------------
// 3. 历史记录管理
// -----------------------------------------------------------------------------
function loadHistory(): Record<string, any> {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

function saveHistory(hist: Record<string, any>) {
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(hist, null, 2), 'utf-8');
}

// -----------------------------------------------------------------------------
// 4. 扫描候选文章
// -----------------------------------------------------------------------------
interface Candidate {
  id: string;
  source: 'local' | 'muse';
  batch: string;
  file: string;
  fullPath: string;
}

function getCandidates(): Candidate[] {
  const list: Candidate[] = [];

  // Local
  if (fs.existsSync(LOCAL_ROOT)) {
    const batches = fs.readdirSync(LOCAL_ROOT).filter(d => /^\d{8}_\d{4}$/.test(d)).sort();
    for (const b of batches) {
      const bDir = path.join(LOCAL_ROOT, b);
      const files = fs.readdirSync(bDir).filter(f => /^\d{2}_.*\.md$/.test(f) && !f.startsWith('00_')).sort();
      for (const f of files) {
        list.push({
          id: `local:${b}:${f.slice(0, 2)}`,
          source: 'local',
          batch: b,
          file: f,
          fullPath: path.join(bDir, f),
        });
      }
    }
  }

  // Muse
  if (fs.existsSync(MUSE_ROOT)) {
    const batches = fs.readdirSync(MUSE_ROOT).filter(d => /^\d{8}_\d{4}$/.test(d)).sort();
    for (const b of batches) {
      const bDir = path.join(MUSE_ROOT, b);
      const files = fs.readdirSync(bDir).filter(f => f.endsWith('.md') && !f.startsWith('00_') && !f.includes('纯文本')).sort();
      const groups: Record<string, string[]> = {};
      for (const f of files) {
        const m = f.match(/^(\d{2})_/);
        if (m) {
          const p = m[1]!;
          groups[p] = groups[p] || [];
          groups[p]!.push(f);
        }
      }
      for (const p of Object.keys(groups).sort()) {
        const arr = groups[p]!;
        const chosen = arr.find(f => f.includes('本地版')) || arr[0]!;
        list.push({
          id: `muse:${b}:${p}`,
          source: 'muse',
          batch: b,
          file: chosen,
          fullPath: path.join(bDir, chosen),
        });
      }
    }
  }

  return list;
}

// -----------------------------------------------------------------------------
// 5. 浏览器控制与页面操作
// -----------------------------------------------------------------------------
async function evaluate<T>(session: ChromeSession, expression: string): Promise<T> {
  const result = await session.cdp.send<{ result: { value: T } }>('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, { sessionId: session.sessionId });
  return result.result.value;
}

async function waitForElement(session: ChromeSession, selector: string, timeoutMs = 15_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await evaluate<boolean>(session, `!!document.querySelector('${selector}')`);
    if (found) return true;
    await sleep(400);
  }
  return false;
}

async function waitForNewTab(cdp: CdpConnection, initialIds: Set<string>, urlPattern: string, timeoutMs = 25_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const targets = await cdp.send<{ targetInfos: Array<{ targetId: string; url: string; type: string }> }>('Target.getTargets');
    for (const t of targets.targetInfos) {
      if (t.type === 'page' && !initialIds.has(t.targetId) && t.url.includes(urlPattern)) {
        return t.targetId;
      }
    }
    await sleep(400);
  }
  throw new Error(`Timeout waiting for new tab: ${urlPattern}`);
}

async function getBodyImageCount(session: ChromeSession): Promise<number> {
  return await evaluate<number>(session, `
    (function() {
      const editor = document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)});
      if (!editor) return 0;
      return Array.from(editor.querySelectorAll('img')).filter((img) => !img.classList.contains('ProseMirror-separator')).length;
    })()
  `);
}

async function waitForBodyImageCount(session: ChromeSession, minimumCount: number, timeoutMs = 30_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const count = await getBodyImageCount(session);
    if (count >= minimumCount) return true;
    await sleep(400);
  }
  return false;
}

async function uploadImageFile(session: ChromeSession, absolutePath: string, beforeCount: number): Promise<void> {
  const doc = await session.cdp.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: -1, pierce: true }, { sessionId: session.sessionId });
  const input = await session.cdp.send<{ nodeId: number }>('DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector: 'input[type="file"][accept*="image"]',
  }, { sessionId: session.sessionId });

  if (!input.nodeId) throw new Error('File input element not found in WeChat editor');

  await session.cdp.send('DOM.setFileInputFiles', {
    nodeId: input.nodeId,
    files: [absolutePath],
  }, { sessionId: session.sessionId });

  const ok = await waitForBodyImageCount(session, beforeCount + 1);
  if (!ok) throw new Error(`Failed to insert image: ${path.basename(absolutePath)}`);
}

// 自动从正文选择首图作为 2.35:1 与 1:1 封面
async function setCoverFromFirstImage(session: ChromeSession): Promise<boolean> {
  try {
    // 1. 点击“从正文选择”
    const clicked = await evaluate<boolean>(session, `
      (function() {
        const btn = document.querySelector(".js_selectCoverFromContent") || document.querySelector(".js_cover_btn_area");
        if (btn) {
          btn.scrollIntoView({ block: "center" });
          btn.click();
          return true;
        }
        return false;
      })()
    `);
    if (!clicked) return false;
    await sleep(1500);

    // 2. 选择正文第一张图并点击“下一步”
    const step1 = await evaluate<boolean>(session, `
      (function() {
        const picker = document.querySelector(".weui-desktop-dialog_img-picker");
        if (!picker) return false;
        const firstImg = picker.querySelector(".img-picker__item, .weui-desktop-img-picker__item, li, img");
        if (firstImg) firstImg.click();
        const nextBtn = Array.from(picker.querySelectorAll("button, a")).find(b => b.textContent.trim() === "下一步");
        if (nextBtn) { nextBtn.click(); return true; }
        return false;
      })()
    `);
    if (!step1) return false;
    await sleep(1500);

    // 3. 确认裁剪对话框并点击“确认”
    const step2 = await evaluate<boolean>(session, `
      (function() {
        const confirmBtn = Array.from(document.querySelectorAll("button, a")).find(b => {
          const s = window.getComputedStyle(b);
          return s.display !== "none" && (b.textContent.trim() === "确认" || b.textContent.trim() === "完成");
        });
        if (confirmBtn) { confirmBtn.click(); return true; }
        return false;
      })()
    `);
    await sleep(1000);
    return step2;
  } catch (err) {
    console.warn(`[wechat-batch] 设置封面图警告:`, err);
    return false;
  }
}

async function waitForDraftSaved(session: ChromeSession, timeoutMs = 30_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await session.cdp.send<{ result: { value: { saved: boolean; appmsgid?: string } } }>('Runtime.evaluate', {
      expression: `
        (function() {
          const successToast = document.querySelector('.weui-desktop-toast_success, .toast-success, [class*="toast"]');
          const isSuccess = successToast && /保存|成功/.test(successToast.textContent || '');
          const match = window.location.href.match(/appmsgid=(\\d+)/);
          if (match) return { saved: true, appmsgid: match[1] };
          if (isSuccess) return { saved: true, appmsgid: 'saved_' + Date.now() };
          return { saved: false };
        })()
      `,
      returnByValue: true,
    }, { sessionId: session.sessionId });

    if (res.result.value?.saved) {
      return res.result.value.appmsgid || String(Date.now());
    }
    await sleep(800);
  }
  throw new Error('Timeout waiting for draft save confirmation');
}

async function ensureHomeSession(): Promise<{ cdp: CdpConnection; homeSession: ChromeSession }> {
  const profileDir = getDefaultProfileDir();
  let cdp: CdpConnection;
  const existingPort = await findExistingChromeDebugPort(profileDir);
  if (existingPort) {
    try {
      const version = await fetch(`http://127.0.0.1:${existingPort}/json/version`).then(r => r.json());
      cdp = await CdpConnection.connect(version.webSocketDebuggerUrl, 10_000);
      console.log(`[wechat-batch] 成功连接至已有浏览器端口: ${existingPort}`);
    } catch {
      console.log(`[wechat-batch] 端口失效，正在重置并启动浏览器会话...`);
      try {
        const { spawnSync } = await import('node:child_process');
        spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Stop-Process -Name msedge -Force -ErrorAction SilentlyContinue'], { stdio: 'ignore' });
        await sleep(1500);
      } catch {}
      const launched = await launchChrome(WECHAT_URL, profileDir);
      cdp = launched.cdp;
    }
  } else {
    console.log(`[wechat-batch] 启动全新浏览器会话...`);
    try {
      const { spawnSync } = await import('node:child_process');
      spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Stop-Process -Name msedge -Force -ErrorAction SilentlyContinue'], { stdio: 'ignore' });
      await sleep(1500);
    } catch {}
    const launched = await launchChrome(WECHAT_URL, profileDir);
    cdp = launched.cdp;
  }

  await sleep(3000);
  const targets = await cdp.send<{ targetInfos: Array<{ targetId: string; url: string; type: string }> }>('Target.getTargets');
  let homeTarget = targets.targetInfos.find(t => t.type === 'page' && t.url.includes('/cgi-bin/home'));

  if (!homeTarget) {
    const anyWechat = targets.targetInfos.find(t => t.type === 'page' && t.url.includes('mp.weixin.qq.com'));
    if (anyWechat) {
      homeTarget = anyWechat;
    } else {
      const created = await cdp.send<{ targetId: string }>('Target.createTarget', { url: WECHAT_URL });
      homeTarget = { targetId: created.targetId, url: WECHAT_URL, type: 'page' };
      await sleep(4000);
    }
  }

  // 关闭残留编辑页
  for (const t of targets.targetInfos) {
    if (t.type === 'page' && t.url.includes('appmsg_edit') && t.targetId !== homeTarget.targetId) {
      try { await cdp.send('Target.closeTarget', { targetId: t.targetId }); } catch {}
    }
  }

  const { sessionId: homeSid } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: homeTarget.targetId, flatten: true });
  const homeSession: ChromeSession = { cdp, sessionId: homeSid, targetId: homeTarget.targetId };

  const curUrl = await evaluate<string>(homeSession, 'window.location.href');
  if (!curUrl.includes('/cgi-bin/home')) {
    console.log(`[wechat-batch] 正在导航至公众号后台首页...`);
    await evaluate(homeSession, `window.location.href = '${WECHAT_URL}cgi-bin/home?t=home/index'`);
    await sleep(4000);
  }

  const menuOk = await waitForElement(homeSession, '.new-creation__menu', 30_000);
  if (!menuOk) throw new Error('公众号首页菜单加载超时，请检查登录态');
  return { cdp, homeSession };
}

// -----------------------------------------------------------------------------
// 6. 主执行流水线
// -----------------------------------------------------------------------------
async function run() {
  console.log(`================================================================`);
  console.log(`[wechat-batch] 启动微信公众号单窗口自动推送管线 (增强完善版)`);
  console.log(`[wechat-batch] 1. 标题要求：严格 <= 15 字`);
  console.log(`[wechat-batch] 2. 作者字段：统一填入“锐多宝”`);
  console.log(`[wechat-batch] 3. 摘要分行：元数据独立分行，杜绝挤成一团`);
  console.log(`[wechat-batch] 4. 名片组件：文末自动插入“锐多宝”官方名片`);
  console.log(`[wechat-batch] 5. 封面预览：自动从正文首图截取并确认 2.35:1 封面`);
  console.log(`[wechat-batch] 6. 视觉排版：全面采用 grace 优雅科技深蓝主题`);
  console.log(`================================================================`);

  const history = loadHistory();
  const allCandidates = getCandidates();
  const pending = allCandidates.filter(c => !history[c.id]);

  console.log(`[wechat-batch] 扫描到推文总数: ${allCandidates.length} 篇 | 已入草稿: ${allCandidates.length - pending.length} 篇 | 待入草稿: ${pending.length} 篇`);

  if (pending.length === 0) {
    console.log(`[wechat-batch] 所有推文均已保存在草稿箱中，无需重复操作。`);
    return;
  }

  let { cdp, homeSession } = await ensureHomeSession();
  console.log(`[wechat-batch] ✅ 公众号后台常驻主页就绪！开始单窗口多标签批量录入...`);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < pending.length; i++) {
    const item = pending[i]!;

    if (successCount > 0 && successCount % 6 === 0) {
      console.log(`[wechat-batch] 已连续完成 6 篇，轻量刷新一次主页保持会话活跃...`);
      try {
        await evaluate(homeSession, `window.location.reload()`);
        await sleep(3500);
        await waitForElement(homeSession, '.new-creation__menu', 25_000);
      } catch (reloadErr) {
        console.warn(`[wechat-batch] 刷新主页非致命警告:`, reloadErr);
      }
    }

    console.log(`\n----------------------------------------------------------------`);
    console.log(`[wechat-batch] 进度 [${i + 1}/${pending.length}] 处理: [${item.source.toUpperCase()}] ${item.batch} / ${item.file}`);

    let editorTargetId: string | null = null;
    try {
      // 步骤 A: 读取并净化 Markdown 空行，对摘要/元数据强制分行
      const rawMd = fs.readFileSync(item.fullPath, 'utf-8');
      const purifiedMd = purifyMarkdown(rawMd);
      
      const tempPurifiedPath = path.join(path.dirname(item.fullPath), `.temp_purified_${path.basename(item.fullPath)}`);
      fs.writeFileSync(tempPurifiedPath, purifiedMd, 'utf-8');

      // 步骤 B: 采用顶级科技风 grace + #0052ff 主题转换
      const parsed = await convertMarkdown(tempPurifiedPath, { theme: 'grace', color: '#0052ff', citeStatus: true });
      try { fs.unlinkSync(tempPurifiedPath); } catch {}

      // 步骤 C: 标题严格限制在 15 个字内
      const finalTitle = refineTitleTo15Chars(parsed.title || item.file);
      console.log(`[wechat-batch] 15字精简标题: "${finalTitle}" (${finalTitle.length} 字)`);

      // 步骤 D: 读取 HTML 并进行后处理：元数据换行、清空行、追加【锐多宝官方公众号名片】
      let rawHtml = fs.readFileSync(parsed.htmlPath, 'utf-8');
      const finalHtmlContent = postProcessHtml(rawHtml);

      // 步骤 E: 在常驻主页中点击“文章”唤起新编辑标签页
      const currentTargets = await cdp.send<{ targetInfos: Array<{ targetId: string; url: string; type: string }> }>('Target.getTargets');
      const beforeIds = new Set(currentTargets.targetInfos.map(t => t.targetId));

      console.log(`[wechat-batch] 点击主页“文章”菜单打开新编辑器标签...`);
      await evaluate(homeSession, `
        (function() {
          const items = document.querySelectorAll('.new-creation__menu .new-creation__menu-item');
          for (const item of items) {
            const title = item.querySelector('.new-creation__menu-title');
            if (title && title.textContent?.trim() === '文章') {
              item.click();
              return true;
            }
          }
          return false;
        })()
      `);

      editorTargetId = await waitForNewTab(cdp, beforeIds, 'mp.weixin.qq.com', 25_000);
      const { sessionId: editSid } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: editorTargetId, flatten: true });
      const editSession: ChromeSession = { cdp, sessionId: editSid, targetId: editorTargetId };

      await cdp.send('Page.enable', {}, { sessionId: editSid });
      await cdp.send('Runtime.enable', {}, { sessionId: editSid });
      await cdp.send('DOM.enable', {}, { sessionId: editSid });

      console.log(`[wechat-batch] 编辑器新标签已打开，等待界面加载...`);
      const titleReady = await waitForElement(editSession, '#title', 25_000);
      if (!titleReady) throw new Error('编辑器加载超时 (#title 未出现)');
      await waitForElement(editSession, BODY_EDITOR_SELECTOR, 15_000);

      // 步骤 F: 填写标题与作者（严格固定作者为：锐多宝）
      await evaluate(editSession, `
        (function() {
          // 标题
          const tEl = document.querySelector('#title');
          if (tEl) {
            tEl.focus();
            tEl.value = ${JSON.stringify(finalTitle)};
            tEl.dispatchEvent(new Event('input', { bubbles: true }));
            tEl.dispatchEvent(new Event('change', { bubbles: true }));
          }

          // 作者：锐多宝
          const aEl = document.querySelector('#author');
          if (aEl) {
            aEl.focus();
            aEl.value = '锐多宝';
            aEl.dispatchEvent(new Event('input', { bubbles: true }));
            aEl.dispatchEvent(new Event('change', { bubbles: true }));
          }
        })()
      `);

      // 步骤 G: 注入 HTML 正文并清洗 ProseMirror DOM 空行
      console.log(`[wechat-batch] 注入正文（含锐多宝名片）并清洗编辑器空行...`);
      await evaluate(editSession, `
        (function() {
          const editor = document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)});
          editor.focus();
          editor.innerHTML = ${JSON.stringify(finalHtmlContent)};
          editor.dispatchEvent(new Event('input', { bubbles: true }));

          // 核心清洗：移除 ProseMirror 内所有空白空行节点
          const paras = Array.from(editor.querySelectorAll('p, div'));
          for (const p of paras) {
            const txt = p.textContent.replace(/[\\s\\u00a0\\u3000]/g, '');
            const hasMedia = p.querySelector('img, picture, svg, video, iframe, [data-wechat-image], .wx_profile');
            if (txt === '' && !hasMedia) {
              p.remove();
            }
          }
          editor.dispatchEvent(new Event('input', { bubbles: true }));
        })()
      `);

      // 步骤 H: 替换注入图片
      if (parsed.contentImages.length > 0) {
        console.log(`[wechat-batch] 依次替换插入 ${parsed.contentImages.length} 张本地高清图片...`);
        for (let idx = 0; idx < parsed.contentImages.length; idx++) {
          const img = parsed.contentImages[idx]!;
          const beforeCount = await getBodyImageCount(editSession);
          
          await evaluate<boolean>(editSession, `
            (function() {
              const editor = document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)});
              const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
              while (walker.nextNode()) {
                const node = walker.currentNode;
                if (node.textContent && node.textContent.includes(${JSON.stringify(img.placeholder)})) {
                  const range = document.createRange();
                  range.selectNode(node);
                  const sel = window.getSelection();
                  sel.removeAllRanges();
                  sel.addRange(range);
                  document.execCommand('delete');
                  return true;
                }
              }
              return false;
            })()
          `);

          await uploadImageFile(editSession, img.localPath, beforeCount);
          await sleep(600);
        }

        // 步骤 I: 设置封面图（从正文第一张图直接自动选为封面）
        console.log(`[wechat-batch] 正在自动从正文选择首图作为文章封面预览图...`);
        const coverOk = await setCoverFromFirstImage(editSession);
        if (coverOk) {
          console.log(`[wechat-batch] ✅ 文章封面预览图设置成功！`);
        } else {
          console.warn(`[wechat-batch] ⚠️ 封面设置未完成，可能正文未提取出首图`);
        }
      }

      // 步骤 J: 填写摘要
      if (parsed.summary) {
        await evaluate(editSession, `
          (function() {
            const el = document.querySelector('#js_description');
            if (el) {
              el.focus();
              el.value = ${JSON.stringify(parsed.summary.slice(0, 115))};
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          })()
        `);
      }

      // 步骤 K: 提交保存草稿箱
      console.log(`[wechat-batch] 提交保存至草稿箱...`);
      await evaluate(editSession, `document.querySelector('#js_submit button').click()`);
      const appmsgid = await waitForDraftSaved(editSession);
      console.log(`[wechat-batch] ✅ 保存成功！appmsgid: ${appmsgid}`);

      // 步骤 L: 关闭当前编辑标签页，干净回到主标签页
      console.log(`[wechat-batch] 关闭已完成的编辑标签页，释放资源...`);
      await cdp.send('Target.closeTarget', { targetId: editorTargetId });
      editorTargetId = null;

      // 步骤 M: 记录成功历史
      history[item.id] = {
        appmsgid,
        title: finalTitle,
        source: item.source,
        batch: item.batch,
        file: item.file,
        fullPath: item.fullPath,
        author: '锐多宝',
        pushedAt: new Date().toISOString(),
      };
      saveHistory(history);
      successCount++;

      await sleep(3000);
    } catch (err: any) {
      console.error(`[wechat-batch] ❌ 本篇处理失败:`, err?.message || err);
      failCount++;
      if (editorTargetId && cdp) {
        try { await cdp.send('Target.closeTarget', { targetId: editorTargetId }); } catch {}
      }
      if (err?.message?.includes('CDP') || err?.message?.includes('WebSocket') || err?.message?.includes('Target') || err?.message?.includes('closed')) {
        console.log('[wechat-batch] 检测到 CDP 异常，等待 5 秒重新获取常驻会话...');
        await sleep(5000);
        try {
          const re = await ensureHomeSession();
          cdp = re.cdp;
          homeSession = re.homeSession;
          console.log('[wechat-batch] 重新连接成功，继续后续录入！');
        } catch (reErr) {
          console.error('[wechat-batch] 自动重连失败:', reErr);
        }
      }
      await sleep(3000);
    }
  }

  console.log(`\n================================================================`);
  console.log(`[wechat-batch] 批量推送完成！`);
  console.log(`  成功推入草稿箱: ${successCount} 篇`);
  console.log(`  失败:           ${failCount} 篇`);
  console.log(`  跳过已存在:     ${allCandidates.length - pending.length} 篇`);
  console.log(`================================================================`);
}

await run().catch(err => {
  console.error('[wechat-batch] 致命错误:', err);
  process.exit(1);
});
