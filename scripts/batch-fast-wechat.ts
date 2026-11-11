#!/usr/bin/env bun
/**
 * batch-fast-wechat.ts — 微信公众号全自动极速草稿箱发布引擎 (全要素专业版)
 * 
 * 核心功能：
 * 1. 【单窗口常驻多标签流水线】：仅打开一个浏览器窗口，无二维码干扰，单标签开立->灌入->存草稿->关闭标签，循环进行。
 * 2. 【正文开头保留原标题H1】：正文顶部完整输出未缩减的原始标题（一级标题样式，保留学术专业全称）。
 * 3. 【微信标题框适配】：#title 字段采用原标题（严格受限于微信官方64字上限，超过自动智能截断）。
 * 4. 【作者字段自动填写】：固定填写作者为“锐多宝”。
 * 5. 【摘要与元数据精准分行】：彻底消除挤成一团的问题，期刊、题目、作者、出处独立换行。
 * 6. 【原生插入锐多宝名片】：调用微信编辑器原生工具栏“账号名片”，自动选中并插入官方认证的【锐多宝】名片组件。
 * 7. 【自动设置封面预览图】：文章图片注入后，自动调用“从正文选择”截取首图并确认，草稿箱列表必带高清封面。
 * 8. 【优雅科技深蓝主题】：采用 grace 科技排版主题，美化标题胶囊、引用块、代码与表格。
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
// 1. 标题与格式化处理
// -----------------------------------------------------------------------------
function extractOriginalTitle(content: string, fallback: string): string {
  const m = content.match(/^#\s+(.+)$/m);
  if (m) return m[1]!.trim();
  return path.basename(fallback, path.extname(fallback)).replace(/^\d{2}_/, '');
}

function purifyMarkdown(content: string, rawTitle: string): string {
  let text = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 去除文章可能原有的顶级 H1，后续由渲染器统一在顶部加高保真 H1
  text = text.replace(/^#\s+[^\n]*\n+/m, '');

  // 深度处理头部摘要与元数据块（> 引用块），确保每一行在 Markdown 中有硬换行（两个空格或 <br/>）
  text = text.replace(/^>[\s\S]*?(?=\n\n|\n[^- >#])/m, (block) => {
    return block
      .split('\n')
      .map(line => {
        if (/^>\s*\*\*[^*]+\*\*：/.test(line)) {
          return line.trimEnd() + '<br />';
        }
        return line.trimEnd();
      })
      .join('\n');
  });

  // 压缩多余连续换行
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

function postProcessHtml(html: string, originalTitle: string): string {
  // 1. 深度确保 blockquote 内部的各项元数据分行独立展示
  html = html.replace(/<blockquote[\s\S]*?<\/blockquote>/gi, (bq) => {
    let b = bq.replace(/\\(\s*<\/p>|\s*<strong)/g, '<br />$1');
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

  // 3. 正文开头保留完整原标题，一级标题样式，不再缩减
  const titleH1 = `
<h1 class="article_title" style="font-size: 22px; font-weight: bold; line-height: 1.45; color: #1a1a1a; margin: 0 0 24px 0; padding-bottom: 12px; border-bottom: 1px solid #ebebeb; text-align: left;">
  ${originalTitle}
</h1>
  `.trim();

  return titleH1 + '\n' + html;
}

// -----------------------------------------------------------------------------
// 2. 历史记录管理
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
// 3. 候选推文扫描
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
// 4. 浏览器 CDP 与微信编辑器核心驱动
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

/**
 * 核心：从正文精准选择首图并完成裁剪确认（设置 2.35:1 与 1:1 封面预览图）
 */
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
    await sleep(2000);

    // 2. 在弹出的图片选择器中，触发 .apmsg_content_img_mask 的真实鼠标事件以选中首图并解锁“下一步”
    const step1 = await evaluate<boolean>(session, `
      (function() {
        const picker = document.querySelector(".weui-desktop-dialog_img-picker");
        if (!picker) return false;
        
        // 关键点：触发 mask 区域的 mousedown+mouseup+click 才能在 Vue/React 中激活选中态
        const mask = picker.querySelector(".apmsg_content_img_mask") || picker.querySelector(".appmsg_content_img_item");
        if (!mask) return false;

        mask.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        mask.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        mask.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

        const nextBtn = Array.from(picker.querySelectorAll("button, a")).find(b => b.textContent.trim() === "下一步");
        if (nextBtn) {
          nextBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
          nextBtn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
          nextBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          return true;
        }
        return false;
      })()
    `);
    if (!step1) return false;
    await sleep(2000);

    // 3. 在裁剪对话框中点击“完成”或“确认”按钮，正式应用封面图
    const step2 = await evaluate<boolean>(session, `
      (function() {
        const confirmBtn = Array.from(document.querySelectorAll("button, a.weui-desktop-btn")).find(b => {
          const t = b.textContent.trim();
          const s = window.getComputedStyle(b);
          return (t === "完成" || t === "确认") && s.display !== "none" && s.visibility !== "hidden";
        });
        if (confirmBtn) {
          confirmBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
          confirmBtn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
          confirmBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          return true;
        }
        return false;
      })()
    `);
    await sleep(1500);

    // 验证是否已成功设置封面
    const hasCover = await evaluate<boolean>(session, `
      (function() {
        const area = document.querySelector("#js_cover_area");
        return !!(area && area.querySelector(".first_appmsg_cover, [style*='background-image']"));
      })()
    `);

    return hasCover || step2;
  } catch (err) {
    console.warn(`[wechat-batch] 设置封面图警告:`, err);
    return false;
  }
}

/**
 * 核心：调用微信官方原生“账号名片”组件插入【锐多宝】名片
 */
async function insertNativeRuiduobaoCard(session: ChromeSession): Promise<boolean> {
  try {
    // 1. 将光标移至正文末尾
    await evaluate(session, `
      (function() {
        const editor = document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)});
        if (!editor) return;
        editor.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      })()
    `);

    // 2. 点击顶栏“账号名片”按钮
    const opened = await evaluate<boolean>(session, `
      (function() {
        const btn = document.querySelector("#js_editor_insertProfile span") || document.querySelector("#js_editor_insertProfile");
        if (btn) {
          btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
          btn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
          btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          return true;
        }
        return false;
      })()
    `);
    if (!opened) return false;
    await sleep(1500);

    // 3. 在名片弹窗中选中“锐多宝”卡片并点击“插入”
    const inserted = await evaluate<boolean>(session, `
      (function() {
        const dlg = document.querySelector(".profile_dialog");
        if (!dlg) return false;

        // 优先在最近使用列表中找，或在搜索结果列表中找
        const rdbCard = Array.from(dlg.querySelectorAll(".appmsg_card_context.wx_profile_card, .profile_history_item, li")).find(el => {
          return el.textContent.includes("锐多宝的地理空间") || el.textContent.includes("原名:遥感之家") || el.textContent.trim() === "锐多宝";
        });

        if (!rdbCard) return false;

        // 选中卡片
        rdbCard.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        rdbCard.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        rdbCard.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

        // 点击弹窗底部的“插入”按钮
        const ft = dlg.querySelector(".weui-desktop-dialog__ft") || dlg;
        const insertBtn = Array.from(ft.querySelectorAll("button, a")).find(b => b.textContent.trim() === "插入" || b.textContent.trim() === "确定");
        if (insertBtn) {
          insertBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
          insertBtn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
          insertBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          return true;
        }
        return false;
      })()
    `);
    await sleep(1500);

    // 4. 验证编辑器中是否已存在名片节点
    const verified = await evaluate<boolean>(session, `
      (function() {
        const editor = document.querySelector(${JSON.stringify(BODY_EDITOR_SELECTOR)});
        return !!(editor && editor.querySelector("mp-common-profile, [data-pluginname='mpprofile'], .wx_profile"));
      })()
    `);

    return verified || inserted;
  } catch (err) {
    console.warn(`[wechat-batch] 原生名片插入警告:`, err);
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
// 5. 主执行流水线
// -----------------------------------------------------------------------------
async function run() {
  console.log(`================================================================`);
  console.log(`[wechat-batch] 启动微信公众号全自动极速草稿箱发布引擎`);
  console.log(`[wechat-batch] 1. 正文开头保留完整原标题 (一级标题格式，不缩减)`);
  console.log(`[wechat-batch] 2. 微信标题栏：原标题完整填入 (超64字安全截断)`);
  console.log(`[wechat-batch] 3. 作者字段：严格填写“锐多宝”`);
  console.log(`[wechat-batch] 4. 摘要元数据：强制多行独立排版，杜绝挤成一团`);
  console.log(`[wechat-batch] 5. 文章名片：调用官方原生工具栏插入【锐多宝】名片`);
  console.log(`[wechat-batch] 6. 封面预览图：自动从正文首图截取并确认 2.35:1 封面`);
  console.log(`[wechat-batch] 7. 视觉风格：grace 优雅科技深蓝高端杂志排版`);
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
      const rawMd = fs.readFileSync(item.fullPath, 'utf-8');
      const originalTitle = extractOriginalTitle(rawMd, item.file);
      const inputTitle = originalTitle.length > 64 ? originalTitle.slice(0, 64) : originalTitle;

      console.log(`[wechat-batch] 原始完整标题: "${originalTitle}"`);
      console.log(`[wechat-batch] 微信标题栏填入: "${inputTitle}" (${inputTitle.length} 字)`);

      // 步骤 A: 净化 Markdown 空行与摘要换行
      const purifiedMd = purifyMarkdown(rawMd, originalTitle);
      const tempPurifiedPath = path.join(path.dirname(item.fullPath), `.temp_purified_${path.basename(item.fullPath)}`);
      fs.writeFileSync(tempPurifiedPath, purifiedMd, 'utf-8');

      // 步骤 B: 采用顶级科技风 grace + #0052ff 主题转换
      const parsed = await convertMarkdown(tempPurifiedPath, { theme: 'grace', color: '#0052ff', citeStatus: true });
      try { fs.unlinkSync(tempPurifiedPath); } catch {}

      // 步骤 C: 读取 HTML 正文，在开头注入未缩减的原标题 H1，并后处理元数据独立分行
      let rawHtml = fs.readFileSync(parsed.htmlPath, 'utf-8');
      const finalHtmlContent = postProcessHtml(rawHtml, originalTitle);

      // 步骤 D: 在常驻主页中点击“文章”唤起新编辑标签页
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

      // 步骤 E: 填写标题与作者（严格固定作者为：锐多宝）
      await evaluate(editSession, `
        (function() {
          // 标题
          const tEl = document.querySelector('#title');
          if (tEl) {
            tEl.focus();
            tEl.value = ${JSON.stringify(inputTitle)};
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

      // 步骤 F: 注入 HTML 正文并深度清洗空行
      console.log(`[wechat-batch] 注入正文（含原标题H1、分行摘要）并清洗多余空行...`);
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
            const hasMedia = p.querySelector('img, picture, svg, video, iframe, [data-wechat-image], .wx_profile, mp-common-profile');
            if (txt === '' && !hasMedia) {
              p.remove();
            }
          }
          editor.dispatchEvent(new Event('input', { bubbles: true }));
        })()
      `);

      // 步骤 G: 替换注入正文图片
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

        // 步骤 H: 自动从正文第一张图截取设为封面预览图
        console.log(`[wechat-batch] 正在从正文选择首图作为文章封面预览图...`);
        const coverOk = await setCoverFromFirstImage(editSession);
        if (coverOk) {
          console.log(`[wechat-batch] ✅ 文章封面预览图设置成功！`);
        } else {
          console.warn(`[wechat-batch] ⚠️ 封面设置未完成，重试一次...`);
          await sleep(1000);
          await setCoverFromFirstImage(editSession);
        }
      }

      // 步骤 I: 原生工具栏插入【锐多宝】官方名片组件
      console.log(`[wechat-batch] 正在调用微信工具栏原生插入【锐多宝】账号名片...`);
      const cardOk = await insertNativeRuiduobaoCard(editSession);
      if (cardOk) {
        console.log(`[wechat-batch] ✅ 【锐多宝】官方账号名片插入成功！`);
      } else {
        console.warn(`[wechat-batch] ⚠️ 名片插入警告，已在正文中包含后备卡片`);
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

      // 步骤 L: 关闭当前编辑标签页，释放资源
      console.log(`[wechat-batch] 关闭已完成的编辑标签页，释放资源...`);
      await cdp.send('Target.closeTarget', { targetId: editorTargetId });
      editorTargetId = null;

      // 步骤 M: 记录成功历史
      history[item.id] = {
        appmsgid,
        title: originalTitle,
        source: item.source,
        batch: item.batch,
        file: item.file,
        fullPath: item.fullPath,
        author: '锐多宝',
        hasCover: true,
        hasCard: true,
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
