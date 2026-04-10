import net from 'net';
import readline from 'readline';
import { DateTime } from 'luxon';

const SERVER_PORT = 8100;
const SERVER_HOST = '0.0.0.0';
const RESPONSE_TIMEOUT_MS = 3000;

const DEV_X = 0x9C;
const DEV_Y = 0x9D;

function ts() {
  return DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss');
}

function formatHex(buf) {
  return [...buf].map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

// SLMP 3E Batch Read Bits request
function buildReadBits(deviceCode, startAddr, numPoints) {
  const buf = Buffer.alloc(21);
  let i = 0;
  buf.writeUInt16LE(0x0050, i); i += 2;
  buf[i++] = 0x00;
  buf[i++] = 0xFF;
  buf.writeUInt16LE(0x03FF, i); i += 2;
  buf[i++] = 0x00;
  buf.writeUInt16LE(0x000C, i); i += 2;  // data length = 12
  buf.writeUInt16LE(0x0010, i); i += 2;
  buf.writeUInt16LE(0x0401, i); i += 2;  // Read command
  buf.writeUInt16LE(0x0001, i); i += 2;  // Bit unit
  buf[i++] = startAddr & 0xFF;
  buf[i++] = (startAddr >> 8) & 0xFF;
  buf[i++] = (startAddr >> 16) & 0xFF;
  buf[i++] = deviceCode;
  buf.writeUInt16LE(numPoints, i);
  return buf;
}

// SLMP 3E Batch Write Bits request
function buildWriteBits(deviceCode, startAddr, bits) {
  const numPoints = bits.length;
  const dataBytes = Math.ceil(numPoints / 2);
  // data length = timer(2) + cmd(2) + subcmd(2) + head(3) + devcode(1) + numpoints(2) + data
  const dataLen = 2 + 2 + 2 + 3 + 1 + 2 + dataBytes;
  const buf = Buffer.alloc(9 + dataLen);
  let i = 0;
  buf.writeUInt16LE(0x0050, i); i += 2;
  buf[i++] = 0x00;
  buf[i++] = 0xFF;
  buf.writeUInt16LE(0x03FF, i); i += 2;
  buf[i++] = 0x00;
  buf.writeUInt16LE(dataLen, i); i += 2;
  buf.writeUInt16LE(0x0010, i); i += 2;
  buf.writeUInt16LE(0x1401, i); i += 2;  // Write command
  buf.writeUInt16LE(0x0001, i); i += 2;  // Bit unit
  buf[i++] = startAddr & 0xFF;
  buf[i++] = (startAddr >> 8) & 0xFF;
  buf[i++] = (startAddr >> 16) & 0xFF;
  buf[i++] = deviceCode;
  buf.writeUInt16LE(numPoints, i); i += 2;
  // 兩個 bit 打包成一個 byte：高 nibble = 第一個，低 nibble = 第二個
  for (let j = 0; j < dataBytes; j++) {
    const hi = bits[j * 2] ? 0x01 : 0x00;
    const lo = (j * 2 + 1 < bits.length) ? (bits[j * 2 + 1] ? 0x01 : 0x00) : 0x00;
    buf[i++] = (hi << 4) | lo;
  }
  return buf;
}

function parseReadBitsResponse(buf, numPoints) {
  if (buf.length < 12) throw new Error('回應資料不完整');
  if (buf[0] !== 0xD0 || buf[1] !== 0x00)
    throw new Error(`非 SLMP 回應，Subheader: ${formatHex(buf.slice(0, 2))}`);
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
    throw new Error(`非 SLMP 回應，Subheader: ${formatHex(buf.slice(0, 2))}`);
  const endCode = buf.readUInt16LE(9);
  if (endCode !== 0x0000)
    throw new Error(`SLMP 錯誤碼: 0x${endCode.toString(16).padStart(4, '0')}`);
}

// ── 狀態 ──────────────────────────────────────────────
let currentSocket = null;
let rxBuf = Buffer.alloc(0);
let pendingCmd = null;   // { type, device, addr, points }
let responseTimer = null;

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
      const bits = parseReadBitsResponse(buf, cmd.points);
      for (let i = 0; i < cmd.points; i++) {
        const addrHex = (cmd.addr + i).toString(16).toUpperCase().padStart(2, '0');
        console.log(`[${ts()}] ${cmd.device}${addrHex} = ${bits[i]} (${bits[i] ? 'ON' : 'OFF'})`);
      }
    } else {
      parseWriteResponse(buf);
      const addrHex = cmd.addr.toString(16).toUpperCase().padStart(2, '0');
      const label = cmd.points === 1
        ? `Y${addrHex}`
        : `Y${addrHex}~Y${(cmd.addr + cmd.points - 1).toString(16).toUpperCase().padStart(2, '0')}`;
      console.log(`[${ts()}] ${label} 寫入成功`);
    }
  } catch (e) {
    console.error(`[${ts()}] 解析錯誤: ${e.message}`);
    console.log(`  RAW: ${formatHex(buf)}`);
  }
  rl.prompt();
}

// ── TCP Server ────────────────────────────────────────
const server = net.createServer((socket) => {
  const clientAddr = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`\n[${ts()}] PLC 已連線: ${clientAddr}`);

  socket.setKeepAlive(true, 10000);
  socket.setNoDelay(true);

  currentSocket = socket;
  rxBuf = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    rxBuf = Buffer.concat([rxBuf, chunk]);

    if (pendingCmd) {
      const minLen = pendingCmd.type === 'read' ? 12 : 11;
      if (rxBuf.length >= minLen) handleResponse(rxBuf);
    } else {
      console.log(`[${ts()}] 收到未預期資料: ${formatHex(rxBuf)}`);
      rxBuf = Buffer.alloc(0);
      rl.prompt();
    }
  });

  socket.on('error', (err) => {
    console.error(`[${ts()}] 連線錯誤: ${err.message}`);
  });

  socket.on('close', () => {
    clearResponseTimer();
    pendingCmd = null;
    rxBuf = Buffer.alloc(0);
    if (currentSocket === socket) currentSocket = null;
    console.warn(`[${ts()}] PLC 連線已關閉: ${clientAddr}`);
    rl.prompt();
  });
});

server.on('error', (err) => {
  console.error(`[${ts()}] Server 錯誤: ${err.message}`);
});

server.listen(SERVER_PORT, SERVER_HOST, () => {
  console.log(`[${ts()}] TCP Server 啟動，監聽 ${SERVER_HOST}:${SERVER_PORT}`);
  console.log('  等待 PLC 連線...\n');
  printHelp();
});

// ── 互動式指令介面 ────────────────────────────────────
function printHelp() {
  console.log('┌─ 可用指令 (X/Y 位址為 16 進位) ──────────────────────┐');
  console.log('│  read X <addr>           讀取 X 裝置位元 (唯讀)       │');
  console.log('│  read Y <addr>           讀取 Y 裝置位元              │');
  console.log('│  read X <addr> <points>  連續讀取多個 X 位元          │');
  console.log('│  read Y <addr> <points>  連續讀取多個 Y 位元          │');
  console.log('│  set Y <addr> <0|1>      設置 Y 裝置 OFF/ON           │');
  console.log('│  help                    顯示此說明                   │');
  console.log('│                                                        │');
  console.log('│  範例: read X 20        讀取 X20                      │');
  console.log('│        read Y 30 4      讀取 Y30~Y33                  │');
  console.log('│        set Y 30 1       設置 Y30 = ON                 │');
  console.log('└────────────────────────────────────────────────────────┘');
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '> ',
});

rl.prompt();

rl.on('line', (line) => {
  const parts = line.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  if (!cmd) { rl.prompt(); return; }

  if (cmd === 'help') {
    printHelp();
    rl.prompt();
    return;
  }

  if (!currentSocket || currentSocket.destroyed) {
    console.warn('尚未有 PLC 連線');
    rl.prompt();
    return;
  }

  if (pendingCmd) {
    console.warn('等待上一筆回應中，請稍後再試');
    rl.prompt();
    return;
  }

  if (cmd === 'read') {
    const dev = parts[1]?.toUpperCase();
    const addr = parseInt(parts[2], 16);
    const points = parts[3] ? parseInt(parts[3]) : 1;

    if (!['X', 'Y'].includes(dev) || isNaN(addr) || isNaN(points) || points < 1) {
      console.log('用法: read X|Y <addr_hex> [points]');
      rl.prompt();
      return;
    }

    const deviceCode = dev === 'X' ? DEV_X : DEV_Y;
    pendingCmd = { type: 'read', device: dev, addr, points };
    currentSocket.write(buildReadBits(deviceCode, addr, points));

    responseTimer = setTimeout(() => {
      pendingCmd = null;
      rxBuf = Buffer.alloc(0);
      console.error(`[${ts()}] PLC 無回應，逾時 ${RESPONSE_TIMEOUT_MS}ms`);
      rl.prompt();
    }, RESPONSE_TIMEOUT_MS);

  } else if (cmd === 'set') {
    const dev    = parts[1]?.toUpperCase();
    const addr   = parseInt(parts[2], 16);
    const valStr = parts[3];

    if (dev !== 'Y' || isNaN(addr) || !valStr) {
      console.log('用法: set Y <addr_hex> <0|1|hex>   (X 為唯讀裝置，無法設置)');
      rl.prompt();
      return;
    }

    let bits;
    if (valStr === '0' || valStr === '1') {
      bits = [parseInt(valStr)];
    } else {
      const num = parseInt(valStr, 16);
      if (isNaN(num) || num < 0 || num > 0xFFFF) {
        console.log('  [錯誤] 16 位元值請輸入 0000~FFFF 的 16 進位數字');
        rl.prompt();
        return;
      }
      bits = Array.from({ length: 16 }, (_, i) => (num >> i) & 1);
      const endHex = (addr + 15).toString(16).toUpperCase().padStart(2, '0');
      console.log(`  設置 Y${parts[2].toUpperCase()}~Y${endHex} = 0x${num.toString(16).toUpperCase().padStart(4, '0')}`);
    }

    pendingCmd = { type: 'write', device: 'Y', addr, points: bits.length };
    currentSocket.write(buildWriteBits(DEV_Y, addr, bits));

    responseTimer = setTimeout(() => {
      pendingCmd = null;
      rxBuf = Buffer.alloc(0);
      console.error(`[${ts()}] PLC 無回應，逾時 ${RESPONSE_TIMEOUT_MS}ms`);
      rl.prompt();
    }, RESPONSE_TIMEOUT_MS);

  } else {
    console.log(`未知指令: ${cmd}。輸入 help 查看可用指令`);
    rl.prompt();
  }
});

process.on('SIGINT', () => {
  console.log('\n正在關閉 Server...');
  server.close(() => {
    console.log('Server 已關閉');
    process.exit(0);
  });
});
