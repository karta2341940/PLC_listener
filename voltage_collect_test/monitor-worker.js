import net from 'net';
import { parentPort } from 'worker_threads';
import { DateTime } from 'luxon';

const PLC_IP              = process.env.PLC_IP            ?? '192.168.0.10';
const PLC_PORT            = parseInt(process.env.PLC_PORT  ?? '5007', 10);
const POLL_INTERVAL_MS    = parseInt(process.env.POLL_INTERVAL_MS ?? '1000', 10);
const RESPONSE_TIMEOUT_MS = 3000;

// ME96SS 3-1 Voltage (Inst.)
// D513: b15~b8=Index number（決定倍率）, b7~b0=00h
// D514: Low data（32-bit 有號數低 16 位元）
// D515: High data（32-bit 有號數高 16 位元）
const VOLTAGE_DEVICE = 'D';
const VOLTAGE_ADDR   = 513;
const VOLTAGE_POINTS = 3;   // D513, D514, D515

// ── 裝置代碼表 ────────────────────────────────────────
const DEVICES = {
  X:  { code: 0x9C, type: 'bit',  addrBase: 16 },
  Y:  { code: 0x9D, type: 'bit',  addrBase: 16 },
  B:  { code: 0xA0, type: 'bit',  addrBase: 16 },
  SB: { code: 0xA1, type: 'bit',  addrBase: 16 },
  DX: { code: 0xA2, type: 'bit',  addrBase: 16 },
  DY: { code: 0xA3, type: 'bit',  addrBase: 16 },
  M:  { code: 0x90, type: 'bit',  addrBase: 10 },
  SM: { code: 0x91, type: 'bit',  addrBase: 10 },
  L:  { code: 0x92, type: 'bit',  addrBase: 10 },
  F:  { code: 0x93, type: 'bit',  addrBase: 10 },
  V:  { code: 0x94, type: 'bit',  addrBase: 10 },
  TS: { code: 0xC1, type: 'bit',  addrBase: 10 },
  TC: { code: 0xC0, type: 'bit',  addrBase: 10 },
  STS:{ code: 0xC7, type: 'bit',  addrBase: 10 },
  STC:{ code: 0xC6, type: 'bit',  addrBase: 10 },
  CS: { code: 0xC4, type: 'bit',  addrBase: 10 },
  CC: { code: 0xC3, type: 'bit',  addrBase: 10 },
  W:  { code: 0xB4, type: 'word', addrBase: 16 },
  SW: { code: 0xB5, type: 'word', addrBase: 16 },
  ZR: { code: 0xB0, type: 'word', addrBase: 16 },
  D:  { code: 0xA8, type: 'word', addrBase: 10 },
  SD: { code: 0xA9, type: 'word', addrBase: 10 },
  R:  { code: 0xAF, type: 'word', addrBase: 10 },
  TN: { code: 0xC2, type: 'word', addrBase: 10 },
  STN:{ code: 0xC8, type: 'word', addrBase: 10 },
  CN: { code: 0xC5, type: 'word', addrBase: 10 },
  Z:  { code: 0xCC, type: 'word', addrBase: 10 },
};

function ts() { return DateTime.now().toFormat('HH:mm:ss'); }
function formatHex(buf) {
  return [...buf].map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}
function fmtAddr(device, addr) {
  return DEVICES[device]?.addrBase === 16
    ? addr.toString(16).toUpperCase().padStart(2, '0')
    : String(addr);
}

// ── SLMP E4 (4E frame) ────────────────────────────────
let serialNo = 1;
function nextSerial() { const s = serialNo; serialNo = (serialNo + 1) & 0xFFFF; return s; }

function writeE4Header(buf, dataLen) {
  let i = 0;
  buf.writeUInt16LE(0x0054, i); i += 2;
  buf.writeUInt16LE(nextSerial(), i); i += 2;
  buf.writeUInt16LE(0x0000, i); i += 2;
  buf[i++] = 0x00; buf[i++] = 0xFF;
  buf.writeUInt16LE(0x03FF, i); i += 2;
  buf[i++] = 0x00;
  buf.writeUInt16LE(dataLen, i);
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

// Index number → 倍率對應表（ME96SS Monitoring by Pattern P08）
const GROUP1_FACTORS = {
  0x02: 100, 0x01: 10, 0x00: 1,
  0xFF: 0.1, 0xFE: 0.01, 0xFD: 0.001, 0xFC: 0.0001,
};

function parseVoltage(words) {
  // words[0] = D513: 高 byte 為 Index number
  const indexNum = (words[0] >> 8) & 0xFF;
  // words[1] = D514 Low, words[2] = D515 High → 組合 32-bit 有號整數
  const b = Buffer.alloc(4);
  b.writeUInt16LE(words[1], 0);
  b.writeUInt16LE(words[2], 2);
  const raw = b.readInt32LE(0);
  const factor = GROUP1_FACTORS[indexNum] ?? 1;
  return Math.round(raw * factor * 10) / 10;
}

// ── 狀態 ─────────────────────────────────────────────
let socket        = null;
let rxBuf         = Buffer.alloc(0);
let pendingCmd    = null;
let responseTimer = null;
let pollTimer     = null;
let userCmdQueue  = null;  // poll 期間到來的使用者指令，等 poll 結束後執行

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
        if (cmd.poll) {
          send({ type: 'voltage_result', voltage: parseVoltage(words) });
        } else {
          const results = Array.from({ length: cmd.points }, (_, i) => ({
            label: `${cmd.device}${fmtAddr(cmd.device, cmd.addr + i)}`,
            value: words[i],
          }));
          send({ type: 'read_result', results });
        }
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
    if (cmd.poll) {
      send({ type: 'log', level: 'warn', ts: ts(), message: `[Poll 錯誤] ${e.message}` });
    } else {
      send({ type: 'cmd_error', message: e.message });
    }
  }

  if (cmd.poll) {
    schedulePoll();
    // poll 完成後立刻補發排隊中的使用者指令
    if (userCmdQueue && socket && !socket.destroyed) {
      const queued = userCmdQueue;
      userCmdQueue = null;
      executeUserCmd(queued);
    }
  }
}

// ── 3-1 Voltage 輪詢 ──────────────────────────────────
function doPoll() {
  if (!socket || socket.destroyed || pendingCmd) { schedulePoll(); return; }
  pendingCmd = {
    type: 'read', device: VOLTAGE_DEVICE, addr: VOLTAGE_ADDR,
    points: VOLTAGE_POINTS, subtype: 'word', poll: true,
  };
  socket.write(buildReadWords(DEVICES[VOLTAGE_DEVICE].code, VOLTAGE_ADDR, VOLTAGE_POINTS));
  responseTimer = setTimeout(() => {
    pendingCmd = null;
    rxBuf = Buffer.alloc(0);
    send({ type: 'log', level: 'warn', ts: ts(), message: `[Poll 逾時] D${VOLTAGE_ADDR} 無回應` });
    schedulePoll();
    // 逾時也補發排隊中的使用者指令
    if (userCmdQueue && socket && !socket.destroyed) {
      const queued = userCmdQueue;
      userCmdQueue = null;
      executeUserCmd(queued);
    }
  }, RESPONSE_TIMEOUT_MS);
}

function schedulePoll() { pollTimer = setTimeout(doPoll, POLL_INTERVAL_MS); }
function startPolling()  { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } schedulePoll(); }
function stopPolling()   { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }

// ── TCP Client ────────────────────────────────────────
function connect() {
  socket = new net.Socket();
  rxBuf  = Buffer.alloc(0);
  socket.setKeepAlive(true, 10000);
  socket.setNoDelay(true);

  socket.connect({ host: PLC_IP, port: PLC_PORT }, () => {
    send({ type: 'plc_status', connected: true });
    send({ type: 'log', level: 'info', ts: ts(), message: `已連線到 PLC ${PLC_IP}:${PLC_PORT}` });
    startPolling();
  });

  socket.on('data', (chunk) => {
    rxBuf = Buffer.concat([rxBuf, chunk]);
    if (!pendingCmd) {
      send({ type: 'log', level: 'warn', ts: ts(), message: `收到未預期資料: ${formatHex(rxBuf)}` });
      rxBuf = Buffer.alloc(0);
      return;
    }
    const minLen = pendingCmd.type === 'read' ? 16 : 15;
    if (rxBuf.length >= minLen) handleResponse(rxBuf);
  });

  socket.on('error', (err) => {
    send({ type: 'log', level: 'error', ts: ts(), message: `連線錯誤: ${err.message}` });
  });

  socket.on('close', () => {
    stopPolling();
    clearResponseTimer();
    if (pendingCmd) {
      if (!pendingCmd.poll) send({ type: 'cmd_error', message: 'PLC 連線中斷' });
      pendingCmd = null;
    }
    send({ type: 'plc_status', connected: false });
    send({ type: 'log', level: 'warn', ts: ts(), message: '連線已關閉，5 秒後重連...' });
    setTimeout(connect, 5000);
  });
}

// ── 執行使用者指令（可由 queue 延遲呼叫）────────────────
function executeUserCmd(msg) {
  const devInfo = DEVICES[msg.device];
  if (!devInfo) {
    send({ type: 'cmd_error', message: `未知裝置: ${msg.device}` });
    return;
  }

  if (msg.type === 'read') {
    pendingCmd = {
      type: 'read', device: msg.device, addr: msg.addr,
      points: msg.points, subtype: devInfo.type === 'word' ? 'word' : 'bit',
    };
    socket.write(devInfo.type === 'word'
      ? buildReadWords(devInfo.code, msg.addr, msg.points)
      : buildReadBits(devInfo.code, msg.addr, msg.points));
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
}

// ── 接收主執行緒指令 ──────────────────────────────────
parentPort.on('message', (msg) => {
  if (!socket || socket.destroyed) {
    send({ type: 'cmd_error', message: '尚未連線到 PLC' });
    return;
  }
  // poll 進行中：排隊，等 poll 回應後立刻補發（不搶佔，避免重複請求）
  if (pendingCmd && pendingCmd.poll) {
    userCmdQueue = msg;
    return;
  }
  if (pendingCmd) {
    send({ type: 'cmd_error', message: '等待上一筆回應中，請稍後再試' });
    return;
  }
  executeUserCmd(msg);
});

// ── 啟動 ─────────────────────────────────────────────
send({ type: 'ready' });
connect();
