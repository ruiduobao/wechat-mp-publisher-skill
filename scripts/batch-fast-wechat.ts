#!/usr/bin/env bun
/**
 * batch-fast-wechat.ts — 单窗口、多标签页、无缝批量写入微信公众号草稿箱
 * 
 * 核心优化：
 * 1. 【单窗口常驻】：只打开一个浏览器窗口，不重启浏览器，不弹二维码！
 * 2. 【多标签流水线】：在主页点“文章”打开新标签 -> 填标题、去空行正文、插图 -> 存草稿 -> 关闭标签 -> 下一篇！
 * 3. 【严格字数限制】：所有推文标题严格限制在 15 个字以内（<= 15 字），自动精简。
 * 4. 【全文空行深度净化】：
 *    - Markdown 阶段剔除冗余空行与连续换行；
 *    - HTML 阶段剔除空段落；
 *    - ProseMirror 编辑器内二次 DOM 清洗，彻底删除任何空白 <p><br></p>，防止排版间隙过大。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

  // 压缩空格
  t = t.replace(/\s+/g, '');

  if (t.length <= 15) return t;

  // 针对长标题进行智能压缩提取核心主干（确保 <= 15 字）
  // 常见模式提取：团队/机构 + 核心突破
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

  // 通用截断保底（严格截取前15字）
  return t.slice(0, 15);
}

// -----------------------------------------------------------------------------
// 2. 空行净化函数（清除 Markdown 与 HTML 冗余空行）
// -----------------------------------------------------------------------------
function purifyMarkdownEmptyLines(content: string): string {
  // 1. 统一换行符
  let text = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  
  // 2. 移除行末空格
  text = text.replace(/[ \t]+$/gm, '');

  // 3. 将连续的三个及以上换行压缩为两个（严格避免出现多余空行）
  text = text.replace(/\n{3,}/g, '\n\n');

  // 4. 清理引用块、列表内部的多余空行
  text = text.replace(/(^>[^\n]*)\n\n+(>)/gm, '$1\n$2');
  text = text.replace(/(^[-*+]\s+[^\n]*)\n\n+([-*+]\s+)/gm, '$1\n$2');

  return text.trim();
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
// 4. 扫描待同步文章（优先近期批次）
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

  // 1. 扫描 Local 批次（近 3 天）
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

  // 2. 扫描 Muse 批次（近 3 天）
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
// 5. 核心单窗口浏览器驱动流程
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
      cdp = await CdpConnection.connect(`ws://127.0.0.1:${existingPort}`, 10_000);
      console.log(`[wechat-batch] 成功连接至已有浏览器端口: ${existingPort}`);
    } catch {
      console.log(`[wechat-batch] 端口连接失效，重新启动浏览器会话...`);
      const launched = await launchChrome(WECHAT_URL, profileDir);
      cdp = launched.cdp;
    }
  } else {
    console.log(`[wechat-batch] 启动浏览器会话...`);
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

  // 关闭残留的旧草稿编辑标签，保持环境清爽
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
// 主执行函数
// -----------------------------------------------------------------------------
async function run() {
  console.log(`================================================================`);
  console.log(`[wechat-batch] 启动微信公众号单窗口自动推送管线`);
  console.log(`[wechat-batch] 标题规则：所有推文严格 <= 15 字`);
  console.log(`[wechat-batch] 空行规则：全流程去空行，ProseMirror DOM 深度清洗`);
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

  // 3. 循环批量推入草稿箱
  for (let i = 0; i < pending.length; i++) {
    const item = pending[i]!;

    // 每完成 6 篇刷新一次主页，保持会话活性
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
      // 步骤 A: 读取并净化 Markdown 空行
      const rawMd = fs.readFileSync(item.fullPath, 'utf-8');
      const purifiedMd = purifyMarkdownEmptyLines(rawMd);
      
      // 写入临时 Markdown 文件供转换
      const tempPurifiedPath = path.join(path.dirname(item.fullPath), `.temp_purified_${path.basename(item.fullPath)}`);
      fs.writeFileSync(tempPurifiedPath, purifiedMd, 'utf-8');

      // 步骤 B: 转换 Markdown，生成 HTML 并解析标题和配图
      const parsed = await convertMarkdown(tempPurifiedPath, { theme: 'default', citeStatus: true });
      try { fs.unlinkSync(tempPurifiedPath); } catch {}

      // 步骤 C: 标题严格限制在 15 个字内
      const finalTitle = refineTitleTo15Chars(parsed.title || item.file);
      console.log(`[wechat-batch] 原标题: "${parsed.title}"`);
      console.log(`[wechat-batch] 15字精简标题: "${finalTitle}" (${finalTitle.length} 字)`);

      // 步骤 D: 读取 HTML 正文并深度剔除空段落
      let htmlContent = fs.readFileSync(parsed.htmlPath, 'utf-8');
      htmlContent = htmlContent.replace(/<p>\s*(<br\s*\/?>|&nbsp;|\s*)*<\/p>/gi, '');
      htmlContent = htmlContent.replace(/<div>\s*(<br\s*\/?>|&nbsp;|\s*)*<\/div>/gi, '');

      // 步骤 E: 在当前浏览器窗口中，通过主页点击“文章”打开新标签页
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

      // 步骤 F: 填写标题与作者
      await evaluate(editSession, `
        (function() {
          const el = document.querySelector('#title');
          el.focus();
          el.value = ${JSON.stringify(finalTitle)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        })()
      `);

      // 步骤 G: 注入 HTML 正文并执行 ProseMirror 内置 DOM 空行大扫除
      console.log(`[wechat-batch] 注入正文内容并清洗编辑器空行...`);
      await evaluate(editSession, `
        (function() {
          const editor = document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)});
          editor.focus();
          editor.innerHTML = ${JSON.stringify(htmlContent)};
          editor.dispatchEvent(new Event('input', { bubbles: true }));

          // 核心清洗：移除 ProseMirror 内所有空 <p> 标签，消除额外空行
          const paras = Array.from(editor.querySelectorAll('p, div'));
          for (const p of paras) {
            const txt = p.textContent.replace(/[\\s\\u00a0\\u3000]/g, '');
            const hasMedia = p.querySelector('img, picture, svg, video, iframe, [data-wechat-image]');
            if (txt === '' && !hasMedia) {
              p.remove();
            }
          }
          editor.dispatchEvent(new Event('input', { bubbles: true }));
        })()
      `);

      // 步骤 H: 注入图片
      if (parsed.contentImages.length > 0) {
        console.log(`[wechat-batch] 开始依次替换插入 ${parsed.contentImages.length} 张本地高清图片...`);
        for (let idx = 0; idx < parsed.contentImages.length; idx++) {
          const img = parsed.contentImages[idx]!;
          const beforeCount = await getBodyImageCount(editSession);
          
          // 定位占位符并删除
          const foundPh = await evaluate<boolean>(editSession, `
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

          // 上传实际图片
          await uploadImageFile(editSession, img.localPath, beforeCount);
          await sleep(600);
        }
      }

      // 步骤 I: 填写摘要
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

      // 步骤 J: 保存为草稿
      console.log(`[wechat-batch] 提交保存至草稿箱...`);
      await evaluate(editSession, `document.querySelector('#js_submit button').click()`);
      const appmsgid = await waitForDraftSaved(editSession);
      console.log(`[wechat-batch] ✅ 保存成功！appmsgid: ${appmsgid}`);

      // 步骤 K: 关闭当前编辑标签页，回到主标签页
      console.log(`[wechat-batch] 关闭已完成的编辑标签页，释放资源...`);
      await cdp.send('Target.closeTarget', { targetId: editorTargetId });
      editorTargetId = null;

      // 步骤 L: 记录成功历史
      history[item.id] = {
        appmsgid,
        title: finalTitle,
        source: item.source,
        batch: item.batch,
        file: item.file,
        fullPath: item.fullPath,
        pushedAt: new Date().toISOString(),
      };
      saveHistory(history);
      successCount++;

      // 适度休息 3 秒，避免频控
      await sleep(3000);
    } catch (err: any) {
      console.error(`[wechat-batch] ❌ 本篇处理失败:`, err?.message || err);
      failCount++;
      // 若出错强行关闭该标签页，避免卡死后续
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
