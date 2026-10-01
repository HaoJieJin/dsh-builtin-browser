#!/data/user/0/com.deepseek.harness/files/payload/runtime/bin/node
/**
 * browser.js —— 通过 CDP 完全控制虚拟屏 Chrome（直接使用 ws 库，轻量可靠）。
 *
 * 用法:
 *   node browser.js list                                  列出所有标签页
 *   node browser.js open <url> [--tab <id>]              新建标签页并导航（或指定 tab 导航）
 *   node browser.js navigate <url> [--tab <id>]          当前/指定标签页导航
 *   node browser.js click <selector> [--tab <id>]          真实鼠标事件点击 CSS 选择器元素
 *   node browser.js type <selector> <text> [--tab <id>]   聚焦元素并输入文本
 *   node browser.js screenshot [path] [--tab <id>]       截图保存 PNG
 *   node browser.js back|forward|reload [--tab <id>]
 *   node browser.js eval <js> [--tab <id>]               执行任意 JS（支持 await）
 *   node browser.js text [--tab <id>]                    读取页面标题与可见文本
 *   node browser.js new_tab <url>                         新建标签页
 *   node browser.js close_tab <tabId>                     关闭标签页
 *
 * 输出：JSON。环境变量：CDP_PORT（默认 9222）
 */
'use strict';
const WebSocket = require('ws');
const http = require('node:http');
const fs = require('node:fs');

const PORT = parseInt(process.env.CDP_PORT || '9222', 10);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;

/* ---------- HTTP 辅助 ---------- */
function httpJson(method, url) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(`JSON解析失败: ${d.slice(0,100)}`)); } });
    });
    req.on('error', reject);
    req.end();
  });
}
const getTargets = () => httpJson('GET', `${BASE}/json`);
const getVersion = () => httpJson('GET', `${BASE}/json/version`);
const createTabHttp = (url) => httpJson('PUT', `${BASE}/json/new?${encodeURIComponent(url)}`);
const closeTab = (id) => httpJson('PUT', `${BASE}/json/close/${id}`);

/* ---------- CDP 连接（ws 直连） ---------- */
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.seq = 0;
    this.pending = new Map();
    this.ws.on('message', (d) => {
      let msg;
      try { msg = JSON.parse(d.toString()); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    });
  }
  open() {
    return new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', rej);
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { this.pending.delete(id); reject(e); }
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function connect(tabId) {
  const targets = await getTargets();
  let target;
  if (tabId) {
    // 允许指定任意 target（含 iframe，如登录 iframe）
    target = targets.find((t) => String(t.id) === String(tabId));
  } else {
    const pages = targets.filter((t) => t.type === 'page');
    target = pages.find((t) => t.url && t.url !== 'about:blank') || pages[0];
  }
  if (!target) throw new Error('没有可用的页面 target');
  const c = new CDP(target.webSocketDebuggerUrl);
  await c.open();
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  return { c, target };
}

/** 创建新标签页：优先 HTTP /json/new，失败则用浏览器级 Target.createTarget（Android Chrome 更可靠）。 */
async function createNewTab(url) {
  try {
    const t = await createTabHttp(url);
    if (t && t.id) return t;
  } catch (e) { /* 回退到 CDP */ }
  const ver = await getVersion();
  if (!ver.webSocketDebuggerUrl) throw new Error('无法获取浏览器级调试端点');
  const c = new CDP(ver.webSocketDebuggerUrl);
  await c.open();
  try {
    const r = await c.send('Target.createTarget', { url });
    const tid = r.targetId;
    await new Promise((res) => setTimeout(res, 600));
    return { id: tid, url, title: '' };
  } finally { c.close(); }
}

/* ---------- 输出 ---------- */
function out(obj) { console.log(JSON.stringify(obj)); }

/* ---------- 命令实现 ---------- */
async function cmdList() {
  const targets = await getTargets();
  const pages = targets.filter((t) => t.type === 'page').map((t) => ({ id: t.id, title: t.title, url: t.url }));
  out({ ok: true, tabs: pages, count: pages.length });
}

async function cmdOpen(url, tabId) {
  if (!tabId) {
    const created = await createNewTab(url);
    out({ ok: true, tab: { id: created.id, title: created.title || '', url: created.url }, action: 'new_tab' });
    return;
  }
  const { c, target } = await connect(tabId);
  try { await c.send('Page.navigate', { url }); out({ ok: true, tab: { id: target.id, url }, action: 'navigate' }); }
  finally { c.close(); }
}

async function cmdNavigate(url, tabId) {
  const { c, target } = await connect(tabId);
  try { await c.send('Page.navigate', { url }); out({ ok: true, tab: { id: target.id, url }, action: 'navigate' }); }
  finally { c.close(); }
}

async function cmdEval(js, tabId) {
  const { c, target } = await connect(tabId);
  try {
    const expr = `(async()=>{${js}})()`;
    const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      out({ ok: false, error: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text });
    } else {
      out({ ok: true, result: r.result ? r.result.value : undefined });
    }
  } finally { c.close(); }
}

async function cmdClick(selector, tabId) {
  const { c } = await connect(tabId);
  try {
    const r = await c.send('Runtime.evaluate', {
      expression: `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;
        const b=el.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2,text:(el.innerText||el.textContent||'').slice(0,200)};})()`,
      returnByValue: true,
    });
    const pos = r.result ? r.result.value : null;
    if (!pos) { out({ ok: false, error: `找不到元素: ${selector}` }); return; }
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
    out({ ok: true, clicked: selector, at: { x: Math.round(pos.x), y: Math.round(pos.y) }, text: pos.text });
  } finally { c.close(); }
}

async function cmdType(selector, text, tabId) {
  const { c } = await connect(tabId);
  try {
    const r = await c.send('Runtime.evaluate', {
      expression: `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;
        el.focus(); if(el.select) el.select(); return true;})()`,
      returnByValue: true,
    });
    if (!(r.result && r.result.value)) { out({ ok: false, error: `找不到输入框: ${selector}` }); return; }
    await c.send('Input.insertText', { text });
    out({ ok: true, typed: text, into: selector });
  } finally { c.close(); }
}

async function cmdScreenshot(savePath, tabId) {
  const { c, target } = await connect(tabId);
  try {
    const shot = await c.send('Page.captureScreenshot', { format: 'png' });
    const p = savePath || `/sdcard/DSH浏览器截图_${Date.now()}.png`;
    fs.writeFileSync(p, Buffer.from(shot.data, 'base64'));
    out({ ok: true, path: p, tab: { id: target.id, title: target.title, url: target.url } });
  } finally { c.close(); }
}

async function cmdNav(action, tabId) {
  const { c } = await connect(tabId);
  try {
    if (action === 'back') await c.send('Page.navigate', { url: 'javascript:history.back()' }).catch(() => {});
    else if (action === 'forward') await c.send('Page.navigate', { url: 'javascript:history.forward()' }).catch(() => {});
    else await c.send('Page.reload');
    await new Promise((r) => setTimeout(r, 1500));
    out({ ok: true, action });
  } finally { c.close(); }
}

async function cmdText(tabId) {
  const { c, target } = await connect(tabId);
  try {
    const r = await c.send('Runtime.evaluate', {
      expression: `(()=>{const t=document.body?document.body.innerText:'';return {title:document.title,text:t.slice(0,8000)};})()`,
      returnByValue: true,
    });
    const v = r.result ? r.result.value : { title: '', text: '' };
    out({ ok: true, title: v.title, text: v.text });
  } finally { c.close(); }
}

/* ---------- 主入口 ---------- */
(async () => {
  const [, , sub, ...rest] = process.argv;
  const tabIdx = rest.indexOf('--tab');
  const tabId = tabIdx >= 0 ? rest[tabIdx + 1] : undefined;
  const args = rest.filter((a, i) => a !== '--tab' && !(rest[i - 1] === '--tab'));

  try {
    switch (sub) {
      case 'list': return await cmdList();
      case 'open': return await cmdOpen(args[0], tabId);
      case 'navigate': return await cmdNavigate(args[0], tabId);
      case 'click': return await cmdClick(args[0], tabId);
      case 'type': return await cmdType(args[0], args[1], tabId);
      case 'screenshot': return await cmdScreenshot(args[0], tabId);
      case 'back': case 'forward': case 'reload': return await cmdNav(sub, tabId);
      case 'eval': return await cmdEval(args.join(' '), tabId);
      case 'text': return await cmdText(tabId);
      case 'new_tab': {
        const created = await createNewTab(args[0]);
        return out({ ok: true, tab: { id: created.id, title: created.title || '', url: created.url }, action: 'new_tab' });
      }
      case 'close_tab': {
        const r = await closeTab(args[0]);
        return out({ ok: true, closed: args[0], detail: r });
      }
      default:
        out({ ok: false, error: '未知命令', usage: 'list|open|navigate|click|type|screenshot|back|forward|reload|eval|text|new_tab|close_tab' });
    }
  } catch (e) {
    out({ ok: false, error: e.message });
  }
})();