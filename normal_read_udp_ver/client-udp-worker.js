import dgram from 'dgram';
import { parentPort } from 'worker_threads';
import { DateTime } from 'luxon';

const PLC_IP   = '192.168.0.10';
const PLC_PORT = 5007;
const RESPONSE_TIMEOUT_MS = 3000;
const POLL_INTERVAL_MS = 1000;   // 固定讀取 D514 的間隔（毫秒）
const POLL_DEVICE = 'D';
const POLL_ADDR   = 514;

// ── 裝置代碼表 ────────────────────────────────────────
// addrBase: 16=16進位定址, 10=10進位定址
// 子陳述式 001/000（Q/L/iQ-R 相容模式，裝置代碼 1 byte）
const DEVICES = {
  // ── 位元裝置（16進位定址）────────────────────────────
  X:  { code: 0x9C, type: 'bit',  addrBase: 16 },  // 輸入繼電器（唯讀）
  Y:  { code: 0x9D, type: 'bit',  addrBase: 16 },  // 輸出繼電器
  B:  { code: 0xA0, type: 'bit',  addrBase: 16 },  // 鏈接繼電器
  SB: { code: 0xA1, type: 'bit',  addrBase: 16 },  // 連結特殊繼電器
  DX: { code: 0xA2, type: 'bit',  addrBase: 16 },  // 直接訪問輸入（唯讀）
  DY: { code: 0xA3, type: 'bit',  addrBase: 16 },  // 直接訪問輸出
  // ── 位元裝置（10進位定址）────────────────────────────
  M:  { code: 0x90, type: 'bit',  addrBase: 10 },  // 內部繼電器
  SM: { code: 0x91, type: 'bit',  addrBase: 10 },  // 特殊繼電器（唯讀）
  L:  { code: 0x92, type: 'bit',  addrBase: 10 },  // 鎖存繼電器
  F:  { code: 0x93, type: 'bit',  addrBase: 10 },  // 警報繼電器
  V:  { code: 0x94, type: 'bit',  addrBase: 10 },  // 變址繼電器
  TS: { code: 0xC1, type: 'bit',  addrBase: 10 },  // 計時器觸點（唯讀）
  TC: { code: 0xC0, type: 'bit',  addrBase: 10 },  // 計時器線圈
  STS:{ code: 0xC7, type: 'bit',  addrBase: 10 },  // 累計計時器觸點（唯讀）
  STC:{ code: 0xC6, type: 'bit',  addrBase: 10 },  // 累計計時器線圈
  CS: { code: 0xC4, type: 'bit',  addrBase: 10 },  // 計數器觸點（唯讀）
  CC: { code: 0xC3, type: 'bit',  addrBase: 10 },  // 計數器線圈
  // ── 字元裝置（16進位定址）────────────────────────────
  W:  { code: 0xB4, type: 'word', addrBase: 16 },  // 鏈接暫存器
  SW: { code: 0xB5, type: 'word', addrBase: 16 },  // 連結特殊暫存器
  ZR: { code: 0xB0, type: 'word', addrBase: 16 },  // 文件暫存器（連號訪問）
  // ── 字元裝置（10進位定址）────────────────────────────
  D:  { code: 0xA8, type: 'word', addrBase: 10 },  // 資料暫存器
  SD: { code: 0xA9, type: 'word', addrBase: 10 },  // 特殊暫存器（唯讀）
  R:  { code: 0xAF, type: 'word', addrBase: 10 },  // 文件暫存器（區塊切換）
  TN: { code: 0xC2, type: 'word', addrBase: 10 },  // 計時器現在值
  STN:{ code: 0xC8, type: 'word', addrBase: 10 },  // 累計計時器現在值
  CN: { code: 0xC5, type: 'word', addrBase: 10 },  // 計數器現在值
  Z:  { code: 0xCC, type: 'word', addrBase: 10 },  // 變址暫存器
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

// ── SLMP E4 (4E frame) 封包 ───────────────────────────
let serialNo = 1;
function nextSerial() { const s = serialNo; serialNo = (serialNo + 1) & 0xFFFF; return s; }

function writeE4Header(buf, dataLen) {
  let i = 0;
  buf.writeUInt16LE(0x0054, i); i += 2;           // Subheader 4E
  buf.writeUInt16LE(nextSerial(), i); i += 2;      // Serial No
  buf.writeUInt16LE(0x0000, i); i += 2;            // Reserved
  buf[i++] = 0x00; buf[i++] = 0xFF;               // Network / PC
  buf.writeUInt16LE(0x03FF, i); i += 2;            // IO
  buf[i++] = 0x00;                                 // Channel
  buf.writeUInt16LE(dataLen, i);                   // DataLen
  return 13;
}

function buildReadWords(deviceCode, startAddr, numPoints) {
  const dataLen = 0x000C;
  const buf = Buffer.alloc(13 + dataLen);
  const h = writeE4Header(buf, dataLen);
  let i = h;
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
  const dataLen = 0x000C;
  const buf = Buffer.alloc(13 + dataLen);
  const h = writeE4Header(buf, dataLen);
  let i = h;
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
  const buf = Buffer.alloc(13 + dataLen);
  const h = writeE4Header(buf, dataLen);
  let i = h;
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
  const buf = Buffer.alloc(13 + dataLen);
  const h = writeE4Header(buf, dataLen);
  let i = h;
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

// E4 回應：Subheader(2)+Serial(2)+Reserved(2)+Net(1)+PC(1)+IO(2)+Ch(1)+DataLen(2) = 13B
// End Code 在 offset 13，資料從 offset 15 開始
function parseReadWordsResponse(buf, numPoints) {
  if (buf.length < 16) throw new Error('回應資料不完整');
  if (buf[0] !== 0xD4 || buf[1] !== 0x00)
    throw new Error(`非 SLMP E4 回應 Subheader: ${formatHex(buf.slice(0, 2))}`);
  const endCode = buf.readUInt16LE(13);
  if (endCode !== 0x0000)
    throw new Error(`SLMP 錯誤碼: 0x${endCode.toString(16).padStart(4, '0')}`);
  const words = [];
  for (let i = 15; i + 1 < buf.length && words.length < numPoints; i += 2)
    words.push(buf.readUInt16LE(i));
  return words;
}

function parseReadBitsResponse(buf, numPoints) {
  if (buf.length < 16) throw new Error('回應資料不完整');
  if (buf[0] !== 0xD4 || buf[1] !== 0x00)
    throw new Error(`非 SLMP E4 回應 Subheader: ${formatHex(buf.slice(0, 2))}`);
  const endCode = buf.readUInt16LE(13);
  if (endCode !== 0x0000)
    throw new Error(`SLMP 錯誤碼: 0x${endCode.toString(16).padStart(4, '0')}`);
  const bits = [];
  for (let i = 15; i < buf.length && bits.length < numPoints; i++) {
    bits.push((buf[i] >> 4) & 0x0F);
    bits.push(buf[i] & 0x0F);
  }
  return bits.slice(0, numPoints);
}

function parseWriteResponse(buf) {
  if (buf.length < 15) throw new Error('回應資料不完整');
  if (buf[0] !== 0xD4 || buf[1] !== 0x00)
    throw new Error(`非 SLMP E4 回應 Subheader: ${formatHex(buf.slice(0, 2))}`);
  const endCode = buf.readUInt16LE(13);
  if (endCode !== 0x0000)
    throw new Error(`SLMP 錯誤碼: 0x${endCode.toString(16).padStart(4, '0')}`);
}

// ── 狀態 ─────────────────────────────────────────────
let pendingCmd    = null;
let responseTimer = null;
let pollTimer     = null;

function send(msg) { parentPort.postMessage(msg); }

function clearResponseTimer() {
  if (responseTimer) { clearTimeout(responseTimer); responseTimer = null; }
}

// ── UDP Socket ────────────────────────────────────────
const socket = dgram.createSocket('udp4');

function udpSend(buf) {
  socket.send(buf, 0, buf.length, PLC_PORT, PLC_IP, (err) => {
    if (err) {
      clearResponseTimer();
      const cmd = pendingCmd;
      pendingCmd = null;
      if (cmd && !cmd.poll)
        send({ type: 'cmd_error', message: `UDP 傳送失敗: ${err.message}` });
      if (cmd?.poll) schedulePoll();
    }
  });
}

socket.on('message', (buf) => {
  if (!pendingCmd) {
    send({ type: 'log', level: 'warn', ts: ts(), message: `收到未預期資料: ${formatHex(buf)}` });
    return;
  }
  clearResponseTimer();
  const cmd = pendingCmd;
  pendingCmd = null;

  try {
    if (cmd.type === 'read') {
      if (cmd.subtype === 'word') {
        const words = parseReadWordsResponse(buf, cmd.points);
        const results = Array.from({ length: cmd.points }, (_, i) => ({
          label: `${cmd.device}${fmtAddr(cmd.device, cmd.addr + i)}`,
          value: words[i],
        }));
        send(cmd.poll ? { type: 'poll_result', results } : { type: 'read_result', results });
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
    if (!cmd.poll)
      send({ type: 'cmd_error', message: e.message });
  }

  if (cmd.poll) schedulePoll();
});

socket.on('error', (err) => {
  send({ type: 'log', level: 'error', ts: ts(), message: `UDP Socket 錯誤: ${err.message}` });
});

socket.bind(() => {
  send({ type: 'ready' });
  send({ type: 'log', level: 'info', ts: ts(), message: `UDP Socket 已就緒，目標 ${PLC_IP}:${PLC_PORT}` });
  schedulePoll();
});

// ── D514 固定輪詢 ─────────────────────────────────────
function doPoll() {
  if (pendingCmd) { schedulePoll(); return; }
  const devInfo = DEVICES[POLL_DEVICE];
  pendingCmd = { type: 'read', device: POLL_DEVICE, addr: POLL_ADDR, points: 1, subtype: 'word', poll: true };
  udpSend(buildReadWords(devInfo.code, POLL_ADDR, 1));
  responseTimer = setTimeout(() => {
    pendingCmd = null;
    schedulePoll();
  }, RESPONSE_TIMEOUT_MS);
}

function schedulePoll() {
  pollTimer = setTimeout(doPoll, POLL_INTERVAL_MS);
}

// ── 接收主執行緒指令 ──────────────────────────────────
parentPort.on('message', (msg) => {
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
    udpSend(devInfo.type === 'word'
      ? buildReadWords(devInfo.code, msg.addr, msg.points)
      : buildReadBits(devInfo.code, msg.addr, msg.points));

  } else if (msg.type === 'set') {
    if (msg.subtype === 'word') {
      pendingCmd = { type: 'set', device: msg.device, addr: msg.addr, subtype: 'word', bits: [] };
      udpSend(buildWriteWords(devInfo.code, msg.addr, [msg.value]));
    } else {
      pendingCmd = { type: 'set', device: msg.device, addr: msg.addr, subtype: 'bit', bits: msg.bits };
      udpSend(buildWriteBits(devInfo.code, msg.addr, msg.bits));
    }
  }

  responseTimer = setTimeout(() => {
    pendingCmd = null;
    send({ type: 'cmd_error', message: 'PLC 無回應（逾時）' });
  }, RESPONSE_TIMEOUT_MS);
});
