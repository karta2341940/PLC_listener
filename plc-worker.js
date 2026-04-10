import net from 'net';
import { parentPort } from 'worker_threads';
import { DateTime } from 'luxon';

const PLC_PORT = 8100;
const RESPONSE_TIMEOUT_MS = 3000;

// ── 裝置代碼表 ────────────────────────────────────────
const DEVICES = {
  X:  { code: 0x9C, type: 'bit',  addrBase: 16 },
  Y:  { code: 0x9D, type: 'bit',  addrBase: 16 },
  M:  { code: 0x90, type: 'bit',  addrBase: 10 },
  L:  { code: 0x92, type: 'bit',  addrBase: 10 },
  F:  { code: 0x93, type: 'bit',  addrBase: 10 },
  B:  { code: 0xA0, type: 'bit',  addrBase: 16 },
  SM: { code: 0x91, type: 'bit',  addrBase: 10 },
  TC: { code: 0xC0, type: 'bit',  addrBase: 10 },
  CC: { code: 0xC3, type: 'bit',  addrBase: 10 },
  D:  { code: 0xA8, type: 'word', addrBase: 10 },
  R:  { code: 0xAF, type: 'word', addrBase: 10 },
  W:  { code: 0xB4, type: 'word', addrBase: 16 },
  TN: { code: 0xC2, type: 'word', addrBase: 10 },
  CN: { code: 0xC5, type: 'word', addrBase: 10 },
  SD: { code: 0xA9, type: 'word', addrBase: 10 },
};

function ts() {
  return DateTime.now().toFormat('HH:mm:ss');
}
function formatHex(buf) {
  return [...buf].map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}
function fmtAddr(device, addr) {
  return DEVICES[device]?.addrBase === 16
    ? addr.toString(16).toUpperCase().padStart(2, '0')
    : String(addr);
}

// ── SLMP ────────────────────────────────────────────
function buildReadBits(deviceCode, startAddr, numPoints) {
  const buf = Buffer.alloc(21);
  let i = 0;
  buf.writeUInt16LE(0x0050, i); i += 2;
  buf[i++] = 0x00; buf[i++] = 0xFF;
  buf.writeUInt16LE(0x03FF, i); i += 2;
  buf[i++] = 0x00;
  buf.writeUInt16LE(0x000C, i); i += 2;
  buf.writeUInt16LE(0x0010, i); i += 2;
  buf.writeUInt16LE(0x0401, i); i += 2;
  buf.writeUInt16LE(0x0001, i); i += 2;
  buf[i++] = startAddr & 0xFF;
  buf[i++] = (startAddr >> 8) & 0xFF;
  buf[i++] = (startAddr >> 16) & 0xFF;
  buf[i++] = deviceCode;
  buf.writeUInt16LE(numPoints, i);
  return buf;
}

function buildReadWords(deviceCode, startAddr, numPoints) {
  const buf = Buffer.alloc(21);
  let i = 0;
  buf.writeUInt16LE(0x0050, i); i += 2;
  buf[i++] = 0x00; buf[i++] = 0xFF;
  buf.writeUInt16LE(0x03FF, i); i += 2;
  buf[i++] = 0x00;
  buf.writeUInt16LE(0x000C, i); i += 2;
  buf.writeUInt16LE(0x0010, i); i += 2;
  buf.writeUInt16LE(0x0401, i); i += 2;
  buf.writeUInt16LE(0x0000, i); i += 2;
  buf[i++] = startAddr & 0xFF;
  buf[i++] = (startAddr >> 8) & 0xFF;
  buf[i++] = (startAddr >> 16) & 0xFF;
  buf[i++] = deviceCode;
  buf.writeUInt16LE(numPoints, i);
  return buf;
}

function buildWriteBits(deviceCode, startAddr, bits) {
  const numPoints = bits.length;
  const dataBytes = Math.ceil(numPoints / 2);
  const dataLen = 2 + 2 + 2 + 3 + 1 + 2 + dataBytes;
  const buf = Buffer.alloc(9 + dataLen);
  let i = 0;
  buf.writeUInt16LE(0x0050, i); i += 2;
  buf[i++] = 0x00; buf[i++] = 0xFF;
  buf.writeUInt16LE(0x03FF, i); i += 2;
  buf[i++] = 0x00;
  buf.writeUInt16LE(dataLen, i); i += 2;
  buf.writeUInt16LE(0x0010, i); i += 2;
  buf.writeUInt16LE(0x1401, i); i += 2;
  buf.writeUInt16LE(0x0001, i); i += 2;
  buf[i++] = startAddr & 0xFF;
  buf[i++] = (startAddr >> 8) & 0xFF;
  buf[i++] = (startAddr >> 16) & 0xFF;
  buf[i++] = deviceCode;
  buf.writeUInt16LE(numPoints, i); i += 2;
  for (let j = 0; j < dataBytes; j++) {
    const hi = bits[j * 2] ? 0x01 : 0x00;
    const lo = (j * 2 + 1 < bits.length) ? (bits[j * 2 + 1] ? 0x01 : 0x00) : 0x00;
    buf[i++] = (hi << 4) | lo;
  }
  return buf;
}

function buildWriteWords(deviceCode, startAddr, values) {
  const numPoints = values.length;
  const dataLen = 2 + 2 + 2 + 3 + 1 + 2 + numPoints * 2;
  const buf = Buffer.alloc(9 + dataLen);
  let i = 0;
  buf.writeUInt16LE(0x0050, i); i += 2;
  buf[i++] = 0x00; buf[i++] = 0xFF;
  buf.writeUInt16LE(0x03FF, i); i += 2;
  buf[i++] = 0x00;
  buf.writeUInt16LE(dataLen, i); i += 2;
  buf.writeUInt16LE(0x0010, i); i += 2;
  buf.writeUInt16LE(0x1401, i); i += 2;
  buf.writeUInt16LE(0x0000, i); i += 2;
  buf[i++] = startAddr & 0xFF;
  buf[i++] = (startAddr >> 8) & 0xFF;
  buf[i++] = (startAddr >> 16) & 0xFF;
  buf[i++] = deviceCode;
  buf.writeUInt16LE(numPoints, i); i += 2;
  for (const v of values) {
    buf.writeUInt16LE(v & 0xFFFF, i); i += 2;
  }
  return buf;
}

function parseReadBitsResponse(buf, numPoints) {
  if (buf.length < 12) throw new Error('回應資料不完整');
  if (buf[0] !== 0xD0 || buf[1] !== 0x00)
    throw new Error(`非 SLMP 回應 Subheader: ${formatHex(buf.slice(0, 2))}`);
  const endCode = buf.readUInt16LE(9);
  if (endCode !== 0x0000)
    throw new Error(`SLMP 錯誤碼: 0x${endCode.toString(16).padStart(4, '0')}`);
  const bits = [];
  for (let i = 11; i < buf.length && bits.length < numPoints; i++) {
    bits.push((buf[i] >> 4) & 0x0F);
    bits.push(buf[i] & 0x0F);
  }
  return bits.slice(0, numPoints);
}

function parseReadWordsResponse(buf, numPoints) {
  if (buf.length < 12) throw new Error('回應資料不完整');
  if (buf[0] !== 0xD0 || buf[1] !== 0x00)
    throw new Error(`非 SLMP 回應 Subheader: ${formatHex(buf.slice(0, 2))}`);
  const endCode = buf.readUInt16LE(9);
  if (endCode !== 0x0000)
    throw new Error(`SLMP 錯誤碼: 0x${endCode.toString(16).padStart(4, '0')}`);
  const words = [];
  for (let i = 11; i + 1 < buf.length && words.length < numPoints; i += 2)
    words.push(buf.readUInt16LE(i));
  return words;
}

function parseWriteResponse(buf) {
  if (buf.length < 11) throw new Error('回應資料不完整');
  if (buf[0] !== 0xD0 || buf[1] !== 0x00)
    throw new Error(`非 SLMP 回應 Subheader: ${formatHex(buf.slice(0, 2))}`);
  const endCode = buf.readUInt16LE(9);
  if (endCode !== 0x0000)
    throw new Error(`SLMP 錯誤碼: 0x${endCode.toString(16).padStart(4, '0')}`);
}

// ── 狀態 ────────────────────────────────────────────
let plcSocket    = null;
let rxBuf        = Buffer.alloc(0);
let pendingCmd   = null;
let responseTimer = null;

function send(msg) { parentPort.postMessage(msg); }

function log(level, message) {
  console.log(`[${ts()}] ${message}`);
  send({ type: 'log', level, ts: ts(), message });
}

function clearResponseTimer() {
  if (responseTimer) { clearTimeout(responseTimer); responseTimer = null; }
}

function handlePlcResponse(buf) {
  clearResponseTimer();
  const cmd = pendingCmd;
  pendingCmd = null;
  rxBuf = Buffer.alloc(0);

  try {
    if (cmd.type === 'read') {
      if (cmd.subtype === 'word') {
        const words = parseReadWordsResponse(buf, cmd.points);
        const results = Array.from({ length: cmd.points }, (_, i) => ({
          label: `${cmd.device}${fmtAddr(cmd.device, cmd.addr + i)}`,
          value: words[i],
        }));
        send({ type: 'read_result', results });
      } else {
        const bits = parseReadBitsResponse(buf, cmd.points);
        const results = Array.from({ length: cmd.points }, (_, i) => ({
          label: `${cmd.device}${fmtAddr(cmd.device, cmd.addr + i)}`,
          value: bits[i],
        }));
        send({ type: 'read_result', results });
      }
    } else {
      parseWriteResponse(buf);
      const addrStr = fmtAddr(cmd.device, cmd.addr);
      const label = cmd.subtype === 'word'
        ? `${cmd.device}${addrStr}`
        : (cmd.bits.length === 1
            ? `${cmd.device}${addrStr}`
            : `${cmd.device}${addrStr}~${cmd.device}${fmtAddr(cmd.device, cmd.addr + cmd.bits.length - 1)}`);
      send({ type: 'write_ok', device: label });
    }
  } catch (e) {
    log('error', `解析錯誤: ${e.message}  RAW: ${formatHex(buf)}`);
    send({ type: 'cmd_error', message: e.message });
  }
}

// ── TCP Server ───────────────────────────────────────
const server = net.createServer((socket) => {
  const addr = `${socket.remoteAddress}:${socket.remotePort}`;
  log('info', `PLC 已連線: ${addr}`);
  send({ type: 'plc_status', connected: true });

  socket.setKeepAlive(true, 10000);
  socket.setNoDelay(true);
  plcSocket = socket;
  rxBuf = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    rxBuf = Buffer.concat([rxBuf, chunk]);
    if (!pendingCmd) {
      log('warn', `收到未預期資料: ${formatHex(rxBuf)}`);
      rxBuf = Buffer.alloc(0);
      return;
    }
    const minLen = pendingCmd.type === 'read' ? 12 : 11;
    if (rxBuf.length >= minLen) handlePlcResponse(rxBuf);
  });

  socket.on('error', (err) => log('error', `PLC 連線錯誤: ${err.message}`));

  socket.on('close', () => {
    clearResponseTimer();
    pendingCmd = null;
    rxBuf = Buffer.alloc(0);
    if (plcSocket === socket) plcSocket = null;
    log('warn', `PLC 連線已關閉: ${addr}`);
    send({ type: 'plc_status', connected: false });
  });
});

server.on('error', (err) => log('error', `Server 錯誤: ${err.message}`));

server.listen(PLC_PORT, '0.0.0.0', () => {
  log('info', `PLC Listener 啟動，監聽 port ${PLC_PORT}`);
  send({ type: 'ready' });
});

// ── 接收主執行緒指令 ──────────────────────────────────
parentPort.on('message', (msg) => {
  if (!plcSocket || plcSocket.destroyed) {
    send({ type: 'cmd_error', message: '尚未有 PLC 連線' });
    return;
  }
  if (pendingCmd) {
    send({ type: 'cmd_error', message: '等待上一筆回應中，請稍後再試' });
    return;
  }

  const devInfo = DEVICES[msg.device];
  if (!devInfo) {
    send({ type: 'cmd_error', message: `未知裝置: ${msg.device}` });
    return;
  }

  if (msg.type === 'read') {
    pendingCmd = { type: 'read', device: msg.device, addr: msg.addr, points: msg.points, subtype: devInfo.type === 'word' ? 'word' : 'bit' };
    const req = devInfo.type === 'word'
      ? buildReadWords(devInfo.code, msg.addr, msg.points)
      : buildReadBits(devInfo.code, msg.addr, msg.points);
    plcSocket.write(req);

  } else if (msg.type === 'set') {
    if (msg.subtype === 'word') {
      pendingCmd = { type: 'set', device: msg.device, addr: msg.addr, subtype: 'word', bits: [] };
      plcSocket.write(buildWriteWords(devInfo.code, msg.addr, [msg.value]));
    } else {
      pendingCmd = { type: 'set', device: msg.device, addr: msg.addr, subtype: 'bit', bits: msg.bits };
      plcSocket.write(buildWriteBits(devInfo.code, msg.addr, msg.bits));
    }
  }

  responseTimer = setTimeout(() => {
    pendingCmd = null; rxBuf = Buffer.alloc(0);
    send({ type: 'cmd_error', message: 'PLC 無回應（逾時）' });
  }, RESPONSE_TIMEOUT_MS);
});
