import { Worker } from 'worker_threads';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 啟動背景執行緒 ────────────────────────────────────
const worker = new Worker(join(__dirname, 'client-worker.js'));

let plcConnected   = false;
let waitingResponse = false;

worker.on('message', (msg) => {
  switch (msg.type) {
    case 'ready':
      rl.prompt();
      break;

    case 'plc_status':
      plcConnected = msg.connected;
      process.stdout.write(msg.connected
        ? `\n[+] 已連線到 PLC\n`
        : `\n[!] PLC 連線已斷開\n`
      );
      rl.prompt(true);
      break;

    case 'log':
      if (msg.level !== 'info') {
        process.stdout.write(`\r[${msg.ts}] ${msg.message}\n`);
        rl.prompt(true);
      }
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
// addrBase: 16=16進位定址, 10=10進位定址
const DEVICE_INFO = {
  X:  { type: 'bit',  addrBase: 16, writable: false, desc: '輸入繼電器（唯讀）' },
  Y:  { type: 'bit',  addrBase: 16, writable: true,  desc: '輸出繼電器' },
  M:  { type: 'bit',  addrBase: 10, writable: true,  desc: '內部繼電器' },
  L:  { type: 'bit',  addrBase: 10, writable: true,  desc: '鎖存繼電器' },
  F:  { type: 'bit',  addrBase: 10, writable: true,  desc: '警報繼電器' },
  B:  { type: 'bit',  addrBase: 16, writable: true,  desc: '鏈接繼電器' },
  SM: { type: 'bit',  addrBase: 10, writable: false, desc: '特殊繼電器（唯讀）' },
  TC: { type: 'bit',  addrBase: 10, writable: false, desc: '計時器接點（唯讀）' },
  CC: { type: 'bit',  addrBase: 10, writable: false, desc: '計數器接點（唯讀）' },
  D:  { type: 'word', addrBase: 10, writable: true,  desc: '資料暫存器' },
  R:  { type: 'word', addrBase: 10, writable: true,  desc: '文件暫存器' },
  W:  { type: 'word', addrBase: 16, writable: true,  desc: '鏈接暫存器' },
  TN: { type: 'word', addrBase: 10, writable: true,  desc: '計時器現在值' },
  CN: { type: 'word', addrBase: 10, writable: true,  desc: '計數器現在值' },
  SD: { type: 'word', addrBase: 10, writable: false, desc: '特殊暫存器（唯讀）' },
};

// ── 解析裝置字串，例如 x20、y30、m100、d300、tn5 ────────
function parseDevice(str) {
  const match = str?.match(/^(TN|TC|CN|CC|SM|SD|[XYMLFBDWR])([0-9a-fA-F]+)$/i);
  if (!match) return null;
  const device = match[1].toUpperCase();
  const info = DEVICE_INFO[device];
  if (!info) return null;
  const addr = parseInt(match[2], info.addrBase);
  if (isNaN(addr)) return null;
  return { device, addr, ...info };
}

// ── 顯示說明 ──────────────────────────────────────────
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
  console.log('    位元 (hex定址): X(唯讀)  Y  B');
  console.log('    位元 (dec定址): M  L  F  SM(唯讀)  TC(唯讀)  CC(唯讀)');
  console.log('    字元 (dec定址): D  R  TN  CN  SD(唯讀)');
  console.log('    字元 (hex定址): W');
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
  prompt: 'plc-client> ',
});

console.log('=== PLC Client ===');
console.log('背景執行緒啟動中，連線到 PLC...');
printHelp();

rl.on('line', (line) => {
  const parts = line.trim().split(/\s+/);
  if (!parts[0]) { rl.prompt(); return; }

  const cmd = parts[0].toLowerCase();
  if (cmd === 'help') { printHelp(); rl.prompt(); return; }
  if (cmd === 'exit') { worker.terminate(); process.exit(0); }

  if (!plcConnected) {
    console.log('  [!] 尚未連線到 PLC，請稍候...');
    rl.prompt();
    return;
  }

  if (waitingResponse) {
    console.log('  [!] 等待回應中，請稍後再試');
    rl.prompt();
    return;
  }

  // 解析第一個參數為裝置
  const parsed = parseDevice(parts[0]);
  if (!parsed) {
    console.log(`  未知裝置或指令: ${parts[0]}，輸入 help 查看說明`);
    rl.prompt();
    return;
  }

  const second = parts[1]?.toLowerCase();

  if (parsed.type === 'bit') {
    if (second === 'on' || second === 'off') {
      // 位元寫入
      if (!parsed.writable) {
        console.log(`  [錯誤] ${parsed.device} 為唯讀裝置，無法設置`);
        rl.prompt();
        return;
      }
      const bits = [second === 'on' ? 1 : 0];
      waitingResponse = true;
      worker.postMessage({ type: 'set', device: parsed.device, addr: parsed.addr, bits, subtype: 'bit' });

    } else {
      // 位元讀取（支援多點）
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
    // 字元裝置
    if (second !== undefined) {
      // 字元寫入
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
      // 字元讀取
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
