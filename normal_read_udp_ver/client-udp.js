import { Worker } from 'worker_threads';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 啟動背景執行緒 ────────────────────────────────────
const worker = new Worker(join(__dirname, 'client-udp-worker.js'));

let ready           = false;
let waitingResponse = false;
let d514Value       = null;

worker.on('message', (msg) => {
  switch (msg.type) {
    case 'ready':
      ready = true;
      rl.prompt();
      break;

    case 'log':
      if (msg.level !== 'info') {
        process.stdout.write(`\r[${msg.ts}] ${msg.message}\n`);
        rl.prompt(true);
      }
      break;

    case 'poll_result':
      d514Value = msg.results[0]?.value ?? null;
      rl.setPrompt(`plc-udp [D514=${d514Value}]> `);
      rl.prompt(true);
      break;

    case 'read_result':
      waitingResponse = false;
      for (const r of msg.results) {
        const val = r.value > 1
          ? r.value
          : `${r.value} (${r.value ? 'ON' : 'OFF'})`;
        console.log(`  ${r.label} = ${val}`);
      }
      rl.prompt();
      break;

    case 'write_ok':
      waitingResponse = false;
      console.log(`  ${msg.device} 寫入成功`);
      rl.prompt();
      break;

    case 'cmd_error':
      waitingResponse = false;
      console.error(`  [錯誤] ${msg.message}`);
      rl.prompt();
      break;
  }
});

worker.on('error', (err) => {
  console.error(`[Worker 錯誤] ${err.message}`);
});

// ── 裝置資訊表（用於指令解析） ────────────────────────
const DEVICE_INFO = {
  // ── 位元裝置（16進位定址）────────────────────────────
  X:  { type: 'bit',  addrBase: 16, writable: false, desc: '輸入繼電器（唯讀）' },
  Y:  { type: 'bit',  addrBase: 16, writable: true,  desc: '輸出繼電器' },
  B:  { type: 'bit',  addrBase: 16, writable: true,  desc: '鏈接繼電器' },
  SB: { type: 'bit',  addrBase: 16, writable: true,  desc: '連結特殊繼電器' },
  DX: { type: 'bit',  addrBase: 16, writable: false, desc: '直接訪問輸入（唯讀）' },
  DY: { type: 'bit',  addrBase: 16, writable: true,  desc: '直接訪問輸出' },
  // ── 位元裝置（10進位定址）────────────────────────────
  M:  { type: 'bit',  addrBase: 10, writable: true,  desc: '內部繼電器' },
  SM: { type: 'bit',  addrBase: 10, writable: false, desc: '特殊繼電器（唯讀）' },
  L:  { type: 'bit',  addrBase: 10, writable: true,  desc: '鎖存繼電器' },
  F:  { type: 'bit',  addrBase: 10, writable: true,  desc: '警報繼電器' },
  V:  { type: 'bit',  addrBase: 10, writable: true,  desc: '變址繼電器' },
  TS: { type: 'bit',  addrBase: 10, writable: false, desc: '計時器觸點（唯讀）' },
  TC: { type: 'bit',  addrBase: 10, writable: true,  desc: '計時器線圈' },
  STS:{ type: 'bit',  addrBase: 10, writable: false, desc: '累計計時器觸點（唯讀）' },
  STC:{ type: 'bit',  addrBase: 10, writable: true,  desc: '累計計時器線圈' },
  CS: { type: 'bit',  addrBase: 10, writable: false, desc: '計數器觸點（唯讀）' },
  CC: { type: 'bit',  addrBase: 10, writable: true,  desc: '計數器線圈' },
  // ── 字元裝置（16進位定址）────────────────────────────
  W:  { type: 'word', addrBase: 16, writable: true,  desc: '鏈接暫存器' },
  SW: { type: 'word', addrBase: 16, writable: true,  desc: '連結特殊暫存器' },
  ZR: { type: 'word', addrBase: 16, writable: true,  desc: '文件暫存器（連號訪問）' },
  // ── 字元裝置（10進位定址）────────────────────────────
  D:  { type: 'word', addrBase: 10, writable: true,  desc: '資料暫存器' },
  SD: { type: 'word', addrBase: 10, writable: false, desc: '特殊暫存器（唯讀）' },
  R:  { type: 'word', addrBase: 10, writable: true,  desc: '文件暫存器（區塊切換）' },
  TN: { type: 'word', addrBase: 10, writable: true,  desc: '計時器現在值' },
  STN:{ type: 'word', addrBase: 10, writable: true,  desc: '累計計時器現在值' },
  CN: { type: 'word', addrBase: 10, writable: true,  desc: '計數器現在值' },
  Z:  { type: 'word', addrBase: 10, writable: true,  desc: '變址暫存器' },
};

function parseDevice(str) {
  const match = str?.match(/^(STN|STS|STC|SB|SW|DX|DY|ZR|TN|TS|TC|CN|CS|CC|SM|SD|[XYMLFBDWRVZ])([0-9a-fA-F]+)$/i);
  if (!match) return null;
  const device = match[1].toUpperCase();
  const info = DEVICE_INFO[device];
  if (!info) return null;
  const addr = parseInt(match[2], info.addrBase);
  if (isNaN(addr)) return null;
  return { device, addr, ...info };
}

function printHelp() {
  console.log('');
  console.log('  讀取裝置：直接輸入裝置位址');
  console.log('    <裝置>           讀取單點，例如: x20  d100  m50');
  console.log('    <裝置> <點數>    連續讀取（僅位元裝置），例如: x20 4');
  console.log('');
  console.log('  設置裝置：');
  console.log('    <裝置> on        位元裝置 ON，例如: y30 on  m100 on');
  console.log('    <裝置> off       位元裝置 OFF，例如: y30 off  m100 off');
  console.log('    <裝置> <數值>    字元裝置寫入，例如: d100 250  tn1 5000');
  console.log('');
  console.log('  其他:');
  console.log('    help   顯示此說明');
  console.log('    exit   離開程式');
  console.log('');
  console.log('  可用裝置:');
  console.log('    位元 (hex定址): X(唯讀)  Y  B  SB  DX(唯讀)  DY');
  console.log('    位元 (dec定址): M  L  F  V  SM(唯讀)');
  console.log('                   TS(唯讀)  TC  STS(唯讀)  STC');
  console.log('                   CS(唯讀)  CC');
  console.log('    字元 (hex定址): W  SW  ZR');
  console.log('    字元 (dec定址): D  R  SD(唯讀)  TN  STN  CN  Z');
  console.log('');
  console.log('  範例:');
  console.log('    x20        → 讀取 X20');
  console.log('    x20 4      → 讀取 X20~X23');
  console.log('    y30 on     → Y30 = ON');
  console.log('    y30 off    → Y30 = OFF');
  console.log('    m100 on    → M100 = ON');
  console.log('    d100       → 讀取 D100');
  console.log('    d100 250   → D100 = 250');
  console.log('    tn1 5000   → TN1 = 5000');
  console.log('');
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'plc-udp> ',
});

console.log('=== PLC UDP Client ===');
console.log('背景執行緒啟動中...');
printHelp();

rl.on('line', (line) => {
  const parts = line.trim().split(/\s+/);
  if (!parts[0]) { rl.prompt(); return; }

  const cmd = parts[0].toLowerCase();
  if (cmd === 'help') { printHelp(); rl.prompt(); return; }
  if (cmd === 'exit') { worker.terminate(); process.exit(0); }

  if (!ready) {
    console.log('  [!] Socket 尚未就緒，請稍候...');
    rl.prompt();
    return;
  }

  if (waitingResponse) {
    console.log('  [!] 等待回應中，請稍後再試');
    rl.prompt();
    return;
  }

  const parsed = parseDevice(parts[0]);
  if (!parsed) {
    console.log(`  未知裝置或指令: ${parts[0]}，輸入 help 查看說明`);
    rl.prompt();
    return;
  }

  const second = parts[1]?.toLowerCase();

  if (parsed.type === 'bit') {
    if (second === 'on' || second === 'off') {
      if (!parsed.writable) {
        console.log(`  [錯誤] ${parsed.device} 為唯讀裝置，無法設置`);
        rl.prompt();
        return;
      }
      const bits = [second === 'on' ? 1 : 0];
      waitingResponse = true;
      worker.postMessage({ type: 'set', device: parsed.device, addr: parsed.addr, bits, subtype: 'bit' });
    } else {
      const points = second ? parseInt(second) : 1;
      if (isNaN(points) || points < 1) {
        console.log(`  用法: ${parts[0]} [點數]  或  ${parts[0]} on/off`);
        rl.prompt();
        return;
      }
      waitingResponse = true;
      worker.postMessage({ type: 'read', device: parsed.device, addr: parsed.addr, points });
    }
  } else {
    if (second !== undefined) {
      if (!parsed.writable) {
        console.log(`  [錯誤] ${parsed.device} 為唯讀裝置，無法設置`);
        rl.prompt();
        return;
      }
      const value = parseInt(second);
      if (isNaN(value)) {
        console.log(`  用法: ${parts[0]} <數值>`);
        rl.prompt();
        return;
      }
      waitingResponse = true;
      worker.postMessage({ type: 'set', device: parsed.device, addr: parsed.addr, value, subtype: 'word' });
    } else {
      waitingResponse = true;
      worker.postMessage({ type: 'read', device: parsed.device, addr: parsed.addr, points: 1 });
    }
  }
});

process.on('SIGINT', () => {
  console.log('\n正在關閉...');
  worker.terminate();
  process.exit(0);
});
