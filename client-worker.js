import net from 'net';
import { parentPort } from 'worker_threads';
import { DateTime } from 'luxon';

const PLC_IP   = '192.168.0.32';
const PLC_PORT = 8088;
const RESPONSE_TIMEOUT_MS = 3000;

// ── 裝置代碼表 ────────────────────────────────────────
// addrBase: 16=16進位定址, 10=10進位定址
const DEVICES = {
  X:  { code: 0x9C, type: 'bit',  addrBase: 16 },  // 輸入繼電器（唯讀）
  Y:  { code: 0x9D, type: 'bit',  addrBase: 16 },  // 輸出繼電器
  M:  { code: 0x90, type: 'bit',  addrBase: 10 },  // 內部繼電器
  L:  { code: 0x92, type: 'bit',  addrBase: 10 },  // 鎖存繼電器
  F:  { code: 0x93, type: 'bit',  addrBase: 10 },  // 警報繼電器
  B:  { code: 0xA0, type: 'bit',  addrBase: 16 },  // 鏈接繼電器
  SM: { code: 0x91, type: 'bit',  addrBase: 10 },  // 特殊繼電器（唯讀）
  TC: { code: 0xC0, type: 'bit',  addrBase: 10 },  // 計時器接點（唯讀）
  CC: { code: 0xC3, type: 'bit',  addrBase: 10 },  // 計數器接點（唯讀）
  D:  { code: 0xA8, type: 'word', addrBase: 10 },  // 資料暫存器
  R:  { code: 0xAF, type: 'word', addrBase: 10 },  // 文件暫存器
  W:  { code: 0xB4, type: 'word', addrBase: 16 },  // 鏈接暫存器
  TN: { code: 0xC2, type: 'word', addrBase: 10 },  // 計時器現在值
  CN: { code: 0xC5, type: 'word', addrBase: 10 },  // 計數器現在值
  SD: { code: 0xA9, type: 'word', addrBase: 10 },  // 特殊暫存器（唯讀）
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

// ── SLMP 封包 ─────────────────────────────────────────
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

function parseWriteResponse(buf) {
  if (buf.length < 11) throw new Error('回應資料不完整');
  if (buf[0] !== 0xD0 || buf[1] !== 0x00)
    throw new Error(`非 SLMP 回應 Subheader: ${formatHex(buf.slice(0, 2))}`);
  const endCode = buf.readUInt16LE(9);
  if (endCode !== 0x0000)
    throw new Error(`SLMP 錯誤碼: 0x${endCode.toString(16).padStart(4, '0')}`);
}

// ── 狀態 ─────────────────────────────────────────────
let socket        = null;
let rxBuf         = Buffer.alloc(0);
let pendingCmd    = null;
let responseTimer = null;

function send(msg) { parentPort.postMessage(msg); }

function clearResponseTimer() {
  if (responseTimer) { clearTimeout(responseTimer); responseTimer = null; }
}

function handleResponse(buf) {
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
    send({ type: 'cmd_error', message: e.message });
  }
}

// ── TCP Client ────────────────────────────────────────
function connect() {
  socket = new net.Socket();
  rxBuf = Buffer.alloc(0);

  socket.setKeepAlive(true, 10000);
  socket.setNoDelay(true);

  socket.connect({ host: PLC_IP, port: PLC_PORT }, () => {
    send({ type: 'plc_status', connected: true });
    send({ type: 'log', level: 'info', ts: ts(), message: `已連線到 PLC ${PLC_IP}:${PLC_PORT}` });
  });

  socket.on('data', (chunk) => {
    rxBuf = Buffer.concat([rxBuf, chunk]);
    if (!pendingCmd) {
      send({ type: 'log', level: 'warn', ts: ts(), message: `收到未預期資料: ${formatHex(rxBuf)}` });
      rxBuf = Buffer.alloc(0);
      return;
    }
    const minLen = pendingCmd.type === 'read' ? 12 : 11;
    if (rxBuf.length >= minLen) handleResponse(rxBuf);
  });

  socket.on('error', (err) => {
    send({ type: 'log', level: 'error', ts: ts(), message: `連線錯誤: ${err.message}` });
  });

  socket.on('close', () => {
    clearResponseTimer();
    if (pendingCmd) {
      send({ type: 'cmd_error', message: 'PLC 連線中斷' });
      pendingCmd = null;
    }
    send({ type: 'plc_status', connected: false });
    send({ type: 'log', level: 'warn', ts: ts(), message: '連線已關閉，5 秒後重連...' });
    setTimeout(connect, 5000);
  });
}

// ── 接收主執行緒指令 ──────────────────────────────────
parentPort.on('message', (msg) => {
  if (!socket || socket.destroyed) {
    send({ type: 'cmd_error', message: '尚未連線到 PLC' });
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
    socket.write(req);

  } else if (msg.type === 'set') {
    if (msg.subtype === 'word') {
      pendingCmd = { type: 'set', device: msg.device, addr: msg.addr, subtype: 'word', bits: [] };
      socket.write(buildWriteWords(devInfo.code, msg.addr, [msg.value]));
    } else {
      pendingCmd = { type: 'set', device: msg.device, addr: msg.addr, subtype: 'bit', bits: msg.bits };
      socket.write(buildWriteBits(devInfo.code, msg.addr, msg.bits));
    }
  }

  responseTimer = setTimeout(() => {
    pendingCmd = null;
    rxBuf = Buffer.alloc(0);
    send({ type: 'cmd_error', message: 'PLC 無回應（逾時）' });
  }, RESPONSE_TIMEOUT_MS);
});

// ── 啟動 ─────────────────────────────────────────────
send({ type: 'ready' });
connect();
