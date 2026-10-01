#!/data/user/0/com.deepseek.harness/files/payload/runtime/bin/node
/**
 * adb-forward —— 直连本机 adbd，执行 `adb forward tcp:<local> <remote>`。
 * 用途：把 Chrome 的 localabstract:chrome_devtools_remote 转发到 tcp:9222，
 *      让本机 Node 控制层通过 CDP 连接浏览器。
 * 协议实现复用 dsh-adb2 的思路（CNXN/AUTH/OPEN/WRTE/CLSE + RSA-SHA1 签名）。
 *
 * 用法:
 *   node adb-forward.js [localPort] [remote]  默认 9222 localabstract:chrome_devtools_remote
 * 例:
 *   node adb-forward.js 9222 localabstract:chrome_devtools_remote
 */
'use strict';
const net = require('node:net');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const HOST = process.env.DSH_ADB_HOST || '127.0.0.1';
function detectPort() {
  if (process.env.DSH_ADB_TCP_PORT) return parseInt(process.env.DSH_ADB_TCP_PORT, 10);
  try {
    const o = execFileSync('/system/bin/getprop', ['service.adb.tcp.port'], { timeout: 3000 }).toString().trim();
    if (/^\d+$/.test(o) && +o > 0) return +o;
  } catch {}
  return 5555;
}
const PORT = detectPort();
const KEYPATH = process.env.DSH_ADB_KEY || '/data/user/0/com.deepseek.harness/files/tools/adbkey';
const TIMEOUT = parseInt(process.env.DSH_ADB_TIMEOUT || '30000', 10);

const A_CNXN = 0x4e584e43;
const A_AUTH = 0x48545541;
const A_OPEN = 0x4e45504f;
const A_OKAY = 0x59414b4f;
const A_CLSE = 0x45534c43;
const A_WRTE = 0x45545257;
const A_STLS = 0x534c5453;
const A_VERSION = 0x01000001;
const MAXDATA = 256 * 1024;

function checksum(buf) { let s = 0; for (let i = 0; i < buf.length; i++) s = (s + buf[i]) >>> 0; return s >>> 0; }
function packMsg(cmd, arg0, arg1, data) {
  data = data || Buffer.alloc(0);
  const h = Buffer.alloc(24);
  h.writeUInt32LE(cmd >>> 0, 0);
  h.writeUInt32LE(arg0 >>> 0, 4);
  h.writeUInt32LE(arg1 >>> 0, 8);
  h.writeUInt32LE(data.length >>> 0, 12);
  h.writeUInt32LE(0, 16);
  h.writeUInt32LE((cmd ^ 0xffffffff) >>> 0, 20);
  return Buffer.concat([h, data]);
}

let _key = null;
function loadKey() {
  if (_key) return _key;
  const text = fs.readFileSync(KEYPATH, 'utf8');
  const der = Buffer.from(text.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
  try { _key = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }); }
  catch { _key = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs1' }); }
  return _key;
}
const SHA1_DIGESTINFO = Buffer.from('3021300906052b0e03021a05000414', 'hex');
function signToken(key, token) {
  return crypto.privateEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.concat([SHA1_DIGESTINFO, token]));
}
function loadPubBlob() {
  const p = KEYPATH + '.pub';
  const txt = fs.readFileSync(p, 'utf8').trim();
  return Buffer.from(txt.split(/\s+/)[0], 'base64');
}

function dial(onReady, onPacket, onError) {
  let key;
  try { key = loadKey(); }
  catch (e) { return onError(`读不了 adb 私钥 ${KEYPATH}: ${e.message}`); }
  const sock = net.connect(PORT, HOST);
  let buf = Buffer.alloc(0);
  let authed = false;
  let authTries = 0;
  let pubSent = false;
  let pubBlob = null;
  try { pubBlob = loadPubBlob(); } catch {}
  const send = (cmd, a0, a1, data) => {
    try { sock.write(packMsg(cmd, a0, a1, data)); } catch (e) { onError('写入失败: ' + e.message); }
  };
  sock.on('connect', () => {
    send(A_CNXN, A_VERSION, MAXDATA, Buffer.from('host::features=shell_v2,cmd,stat_v2\0', 'utf8'));
  });
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 24) {
      const cmd = buf.readUInt32LE(0);
      const a0 = buf.readUInt32LE(4);
      const a1 = buf.readUInt32LE(8);
      const len = buf.readUInt32LE(12);
      if (buf.length < 24 + len) break;
      const data = Buffer.from(buf.subarray(24, 24 + len));
      buf = buf.subarray(24 + len);
      if (cmd === A_AUTH) {
        if (a0 === 0 || a0 === 1) {
          authTries++;
          if (authTries === 1) send(A_AUTH, 2, 0, signToken(key, data));
          else if (authTries === 2 && !pubSent) {
            pubSent = true;
            send(A_AUTH, 3, 0, pubBlob);
          } else if (authTries > 8) onError('认证失败');
          else send(A_AUTH, 2, 0, signToken(key, data));
        } else if (a0 === 3) onError('adbd 要求公钥，但客户端未准备。');
        continue;
      }
      if (cmd === A_CNXN) { if (!authed) { authed = true; onReady(sock, send); } continue; }
      if (cmd === A_STLS) { onError('adbd 要求 TLS（STLS），当前实现不支持。'); continue; }
      onPacket(cmd, a0, a1, data);
    }
  });
  sock.on('error', (e) => onError(`连接 ${HOST}:${PORT} 失败: ${e.code || e.message}`));
  sock.setTimeout(TIMEOUT, () => onError(`超时 ${TIMEOUT}ms`));
  return sock;
}

/** 执行 adb forward。 */
function forward(localPort, remoteSpec) {
  return new Promise((resolve) => {
    const LOCAL = 1;
    let remote = 0;
    let opened = false;
    let done = false;
    const chunks = [];
    let sock;
    const finish = (err, extra) => {
      if (done) return;
      done = true;
      clearTimeout(hardTimer);
      try { sock && sock.destroy(); } catch {}
      if (err) resolve({ ok: false, error: err });
      else resolve({ ok: true, message: chunks.join(''), ...extra });
    };
    const hardTimer = setTimeout(() => finish(`forward 超时 ${TIMEOUT}ms`), TIMEOUT);
    const svc = Buffer.from(`host:forward:tcp:${localPort};${remoteSpec}\0`, 'utf8');
    sock = dial(
      (_s, send) => { send(A_OPEN, LOCAL, 0, svc); },
      (cmdId, a0, a1, data) => {
        if (cmdId === A_OKAY) {
          if (!opened) { opened = true; remote = a0; }
        } else if (cmdId === A_WRTE) {
          chunks.push(data.toString());
          try { sock.write(packMsg(A_OKAY, LOCAL, remote || a0)); } catch {}
        } else if (cmdId === A_CLSE) {
          finish(null, { message: chunks.join('') });
        }
      },
      (err) => finish(err)
    );
    sock.on('close', () => { if (!done) finish('连接提前关闭'); });
  });
}

(async () => {
  const localPort = process.argv[2] || '9222';
  const remoteSpec = process.argv[3] || 'localabstract:chrome_devtools_remote';
  const r = await forward(localPort, remoteSpec);
  if (r.ok) {
    console.log(`OK forward tcp:${localPort} -> ${remoteSpec}`);
    if (r.message) console.log('adbd:', r.message.trim());
    process.exit(0);
  } else {
    console.error('FAIL ' + r.error);
    process.exit(1);
  }
})();