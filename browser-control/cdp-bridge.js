#!/data/user/0/com.deepseek.harness/files/payload/runtime/bin/node
/**
 * cdp-bridge —— 把 Chrome 的 localabstract:chrome_devtools_remote 桥接到本地 TCP 端口。
 *
 * 原理：adb 协议支持 OPEN `localabstract:<name>` 服务（adbd 会连到该抽象 socket）。
 * 本服务监听 127.0.0.1:<port>，每个进来的 TCP 连接：
 *   1. 直连 adbd 并认证（CNXN/AUTH）
 *   2. OPEN localabstract:chrome_devtools_remote
 *   3. 双向管道：TCP <-> adb WRTE/OKAY/CLSE
 *
 * 用法：
 *   node cdp-bridge.js [port]           默认 9222
 * 环境变量：
 *   DSH_ADB_KEY / DSH_ADB_TCP_PORT / DSH_ADB_TIMEOUT
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
const ADB_PORT = detectPort();
const KEYPATH = process.env.DSH_ADB_KEY || '/data/user/0/com.deepseek.harness/files/tools/adbkey';
const TIMEOUT = parseInt(process.env.DSH_ADB_TIMEOUT || '30000', 10);
const SERVICE = process.env.DSH_CDP_SERVICE || 'localabstract:chrome_devtools_remote';
const DEBUG = !!process.env.DEBUG_BRIDGE;

const A_CNXN = 0x4e584e43;
const A_AUTH = 0x48545541;
const A_OPEN = 0x4e45504f;
const A_OKAY = 0x59414b4f;
const A_CLSE = 0x45534c43;
const A_WRTE = 0x45545257;
const A_STLS = 0x534c5453;
const A_VERSION = 0x01000001;
const MAXDATA = 256 * 1024;

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

/**
 * 建立 adb 连接并认证。
 * @param {(cmd:number,a0:number,a1:number,data:Buffer)=>void} onPacket 认证后所有协议包（同步分发，不丢包）
 * @returns {Promise<{sock:import('node:net').Socket, send:Function}>}
 */
function adbConnect(onPacket) {
  return new Promise((resolve, reject) => {
    let key;
    try { key = loadKey(); } catch (e) { return reject(new Error(`读不了 adb 私钥 ${KEYPATH}: ${e.message}`)); }
    const sock = net.connect(ADB_PORT, HOST);
    let buf = Buffer.alloc(0);
    let authed = false;
    let authTries = 0;
    let pubSent = false;
    let pubBlob = null;
    try { pubBlob = loadPubBlob(); } catch {}
    const send = (cmd, a0, a1, data) => { try { sock.write(packMsg(cmd, a0, a1, data)); } catch (e) { reject(e); } };
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
            } else if (authTries > 8) reject(new Error('adb 认证失败'));
            else send(A_AUTH, 2, 0, signToken(key, data));
          } else if (a0 === 3) reject(new Error('adbd 要求公钥但客户端未准备'));
          continue;
        }
        if (cmd === A_CNXN) {
          if (!authed) { authed = true; resolve({ sock, send }); }
          continue;
        }
        if (cmd === A_STLS) { reject(new Error('adbd 要求 TLS（STLS），当前实现不支持')); continue; }
        // 认证后的协议包：同步交给调用方（避免 microtask 间隙丢包）
        onPacket(cmd, a0, a1, data);
      }
    });
    sock.on('error', (e) => reject(new Error(`连接 adbd ${HOST}:${ADB_PORT} 失败: ${e.code || e.message}`)));
    sock.setTimeout(TIMEOUT, () => reject(new Error(`adb 连接超时 ${TIMEOUT}ms`)));
  });
}

/** 处理一个来自本地客户端的 TCP 连接。 */
function handleClient(clientSock) {
  let adbSock = null;
  let remoteId = 0;
  let opened = false;
  let closed = false;
  const pendingChunks = []; // OPEN 完成前收到的客户端数据（避免连接初期丢包）

  const closeAll = () => {
    if (closed) return;
    closed = true;
    try { clientSock.destroy(); } catch {}
    try { adbSock && adbSock.destroy(); } catch {}
  };

  clientSock.on('error', () => closeAll());
  clientSock.on('close', () => {
    if (DEBUG) console.error(`[bridge] client closed (opened=${opened})`);
    if (adbSock && opened) {
      try { adbSock.write(packMsg(A_CLSE, 1, remoteId)); } catch {}
    }
    closeAll();
  });

  adbConnect((cmd, a0, a1, data) => {
    if (DEBUG) console.error(`[bridge] pkt cmd=0x${cmd.toString(16)} a0=${a0} a1=${a1} len=${data.length}`);
    if (cmd === A_OKAY) {
      if (!opened) {
        opened = true;
        remoteId = a0;
        if (DEBUG) console.error(`[bridge] OPEN OK remoteId=${remoteId}, flushing ${pendingChunks.length} chunk(s)`);
        // OPEN 完成：重放此前缓存的客户端数据
        while (pendingChunks.length && adbSock && !adbSock.destroyed) {
          const c = pendingChunks.shift();
          try { adbSock.write(packMsg(A_WRTE, 1, remoteId, c)); } catch {}
        }
      }
    } else if (cmd === A_WRTE) {
      if (!clientSock.destroyed) clientSock.write(data);
      try { adbSock && adbSock.write(packMsg(A_OKAY, 1, remoteId || a0)); } catch {}
    } else if (cmd === A_CLSE) {
      if (DEBUG) console.error(`[bridge] CLSE from chrome`);
      // 优雅关闭：回 CLSE 完成握手，避免 Chrome 侧连接残留
      try { adbSock && adbSock.write(packMsg(A_CLSE, 1, remoteId || a0)); } catch {}
      closeAll();
    }
  }).then(({ sock, send }) => {
    adbSock = sock;
    sock.on('error', () => closeAll());
    sock.on('close', () => closeAll());
    const svc = Buffer.from(SERVICE + '\0', 'utf8');
    send(A_OPEN, 1, 0, svc);
  }).catch((err) => {
    console.error(`[bridge] 连接 adbd 失败: ${err.message}`);
    closeAll();
  });

  // 客户端发来的数据 → 通过 WRTE 发给 Chrome（OPEN 完成前先缓存）
  clientSock.on('data', (chunk) => {
    if (DEBUG) console.error(`[bridge] client data len=${chunk.length} head=${chunk.toString('utf8').slice(0, 60).replace(/\n/g, '\\n')}`);
    if (adbSock && opened && !adbSock.destroyed) {
      try { adbSock.write(packMsg(A_WRTE, 1, remoteId, chunk)); } catch {}
    } else {
      pendingChunks.push(chunk);
    }
  });
}

const PORT = parseInt(process.argv[2] || '9222', 10);
const server = net.createServer(handleClient);
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[bridge] CDP 桥接服务已启动: 127.0.0.1:${PORT} -> ${SERVICE}`);
});
server.on('error', (e) => {
  console.error(`[bridge] 监听失败: ${e.message}`);
  process.exit(1);
});