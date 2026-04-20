import { Worker } from 'worker_threads';
import readline from 'readline';
import http from 'http';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));

const WEB_PORT = parseInt(process.env.WEB_PORT ?? '4000', 10);

// ── SSE 廣播 ──────────────────────────────────────────
const sseClients = new Set();

function broadcastVoltage(voltage) {
  const data = `data: ${JSON.stringify({ voltage, ts: new Date().toISOString() })}\n\n`;
  for (const res of sseClients) res.write(data);
}

// ── HTML 頁面 ──────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ME96SS 電壓監控</title>
<script src="/chart.js"></script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0f172a; color: #e2e8f0; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; padding: 24px; }
  h1 { font-size: 1.2rem; margin-bottom: 8px; color: #94a3b8; }
  #current { font-size: 3rem; font-weight: bold; color: #38bdf8; margin-bottom: 8px; }
  #status { font-size: 0.85rem; color: #64748b; margin-bottom: 12px; }
  #ranges { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; justify-content: center; }
  #ranges button {
    background: #1e293b; color: #94a3b8; border: 1px solid #334155;
    border-radius: 6px; padding: 5px 14px; cursor: pointer; font-size: 0.85rem;
    transition: background 0.15s, color 0.15s;
  }
  #ranges button:hover { background: #334155; color: #e2e8f0; }
  #ranges button.active { background: #0369a1; color: #fff; border-color: #0369a1; }
  canvas { max-width: 960px; width: 100%; }
</style>
</head>
<body>
<h1>ME96SS 3-1 Voltage (Inst.)</h1>
<div id="current">-- V</div>
<div id="status">載入歷史資料中...</div>
<div id="ranges">
  <button data-min="15">15 分鐘</button>
  <button data-min="30">30 分鐘</button>
  <button data-min="60" class="active">1 小時</button>
  <button data-min="180">3 小時</button>
  <button data-min="360">6 小時</button>
  <button data-min="1440">24 小時</button>
</div>
<canvas id="chart"></canvas>
<script>
let windowMs = 60 * 60 * 1000;
let currentMinutes = 60;
const timestamps = [], labels = [], data = [];

const chart = new Chart(document.getElementById('chart'), {
  type: 'line',
  data: {
    labels,
    datasets: [{
      label: '電壓 (V)',
      data,
      borderColor: '#38bdf8',
      backgroundColor: 'rgba(56,189,248,0.08)',
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.2,
      fill: true,
    }]
  },
  options: {
    animation: false,
    scales: {
      x: { ticks: { color: '#64748b', maxTicksLimit: 8, maxRotation: 0 }, grid: { color: '#1e293b' } },
      y: { ticks: { color: '#64748b' }, grid: { color: '#1e293b' } }
    },
    plugins: { legend: { labels: { color: '#94a3b8' } } }
  }
});

function makeLabel(d) {
  if (currentMinutes <= 60) return d.toLocaleTimeString();
  if (currentMinutes <= 360) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (d.getMonth()+1) + '/' + d.getDate() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function trimOld() {
  const cutoff = Date.now() - windowMs;
  while (timestamps.length && timestamps[0] < cutoff) {
    timestamps.shift(); labels.shift(); data.shift();
  }
}

function addPoint(voltage, ts) {
  const d = new Date(ts);
  timestamps.push(d.getTime());
  labels.push(makeLabel(d));
  data.push(voltage);
  trimOld();
}

async function loadHistory(minutes) {
  currentMinutes = minutes;
  windowMs = minutes * 60 * 1000;
  timestamps.length = 0; labels.length = 0; data.length = 0;
  document.getElementById('status').textContent = '載入歷史資料中...';
  try {
    const rows = await fetch('/history?minutes=' + minutes).then(r => r.json());
    for (const row of rows) addPoint(row.voltage, row.ts);
    if (data.length) document.getElementById('current').textContent = data[data.length - 1] + ' V';
    chart.update();
    document.getElementById('status').textContent = '已載入 ' + data.length + ' 筆，SSE 連線中...';
  } catch {
    document.getElementById('status').textContent = '歷史資料載入失敗，等待即時資料...';
  }
}

// 時間範圍切換
document.querySelectorAll('#ranges button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#ranges button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadHistory(parseInt(btn.dataset.min));
  });
});

// 初始載入
loadHistory(60);

// 即時 SSE
const es = new EventSource('/events');
es.onopen = () => {
  const el = document.getElementById('status');
  if (!el.textContent.includes('已載入')) el.textContent = 'SSE 已連線';
};
es.onmessage = (e) => {
  const { voltage, ts } = JSON.parse(e.data);
  addPoint(voltage, ts);
  document.getElementById('current').textContent = voltage + ' V';
  document.getElementById('status').textContent = '即時更新中，視窗內 ' + data.length + ' 筆';
  chart.update();
};
es.onerror = () => { document.getElementById('status').textContent = 'SSE 連線中斷，重連中...'; };
</script>
</body>
</html>`;

const CHARTJS_PATH = join(__dirname, 'node_modules/chart.js/dist/chart.umd.js');

// ── HTTP Server ────────────────────────────────────────
http.createServer(async (req, res) => {
  if (req.url.startsWith('/history')) {
    try {
      const qs = new URL(req.url, 'http://localhost').searchParams;
      const raw = parseInt(qs.get('minutes') ?? '60', 10);
      const minutes = (!isNaN(raw) && raw >= 1) ? Math.min(raw, 10080) : 60;
      const result = await pool.query(
        `SELECT voltage, date AS ts FROM me96ss WHERE date > NOW() - INTERVAL '${minutes} minutes' ORDER BY date ASC`
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.rows));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    });
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (req.url === '/chart.js') {
    const stream = fs.createReadStream(CHARTJS_PATH);
    stream.on('error', () => {
      res.writeHead(404);
      res.end('chart.js not found — run npm install');
    });
    stream.on('open', () => {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      stream.pipe(res);
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(HTML);
}).listen(WEB_PORT, () => {
  console.log(`[Web] 電壓趨勢圖：http://localhost:${WEB_PORT}`);
});

// ── PostgreSQL 連線池 ─────────────────────────────────
const pool = new Pool({
  host:     process.env.PG_HOST     ?? 'localhost',
  port:     parseInt(process.env.PG_PORT     ?? '5439', 10),
  user:     process.env.PG_USER     ?? 'postgres',
  password: process.env.PG_PASSWORD ?? 'postgres',
  database: process.env.PG_DATABASE ?? 'plc',
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS me96ss (
      voltage REAL,
      date    TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  console.log('[DB] 資料表 me96ss 已就緒');
}

async function insertVoltage(voltage) {
  const v = Math.round(voltage * 10) / 10;
  await pool.query('INSERT INTO me96ss (voltage, date) VALUES ($1, NOW())', [v]);
}

// ── 啟動背景執行緒 ────────────────────────────────────
const worker = new Worker(join(__dirname, 'monitor-worker.js'));

let plcConnected    = false;
let waitingResponse = false;
let voltageValue    = null;

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

    case 'voltage_result':
      voltageValue = msg.voltage;
      rl.setPrompt(`plc-monitor [3-1V=${voltageValue}V]> `);
      rl.prompt(true);
      broadcastVoltage(msg.voltage);
      insertVoltage(msg.voltage).catch((err) => {
        process.stdout.write(`\r[DB 錯誤] ${err.message}\n`);
        rl.prompt(true);
      });
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

// ── 裝置資訊表 ────────────────────────────────────────
const DEVICE_INFO = {
  X:  { type: 'bit',  addrBase: 16, writable: false, desc: '輸入繼電器（唯讀）' },
  Y:  { type: 'bit',  addrBase: 16, writable: true,  desc: '輸出繼電器' },
  B:  { type: 'bit',  addrBase: 16, writable: true,  desc: '鏈接繼電器' },
  SB: { type: 'bit',  addrBase: 16, writable: true,  desc: '連結特殊繼電器' },
  DX: { type: 'bit',  addrBase: 16, writable: false, desc: '直接訪問輸入（唯讀）' },
  DY: { type: 'bit',  addrBase: 16, writable: true,  desc: '直接訪問輸出' },
  M:  { type: 'bit',  addrBase: 10, writable: true,  desc: '內部繼電器' },
  SM: { type: 'bit',  addrBase: 10, writable: false, desc: '特殊繼電器（唯讀）' },
  L:  { type: 'bit',  addrBase: 10, writable: true,  desc: '鎖存繼電器' },
  F:  { type: 'bit',  addrBase: 10, writable: false, desc: '警報繼電器' },
  V:  { type: 'bit',  addrBase: 10, writable: true,  desc: '變址繼電器' },
  TS: { type: 'bit',  addrBase: 10, writable: false, desc: '計時器觸點（唯讀）' },
  TC: { type: 'bit',  addrBase: 10, writable: true,  desc: '計時器線圈' },
  STS:{ type: 'bit',  addrBase: 10, writable: false, desc: '累計計時器觸點（唯讀）' },
  STC:{ type: 'bit',  addrBase: 10, writable: true,  desc: '累計計時器線圈' },
  CS: { type: 'bit',  addrBase: 10, writable: false, desc: '計數器觸點（唯讀）' },
  CC: { type: 'bit',  addrBase: 10, writable: true,  desc: '計數器線圈' },
  W:  { type: 'word', addrBase: 16, writable: true,  desc: '鏈接暫存器' },
  SW: { type: 'word', addrBase: 16, writable: true,  desc: '連結特殊暫存器' },
  ZR: { type: 'word', addrBase: 16, writable: true,  desc: '文件暫存器（連號訪問）' },
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
  console.log('  讀取裝置：');
  console.log('    <裝置>           讀取單點，例如: x20  d100  m50');
  console.log('    <裝置> <點數>    連續讀取（僅位元裝置），例如: x20 4');
  console.log('');
  console.log('  設置裝置：');
  console.log('    <裝置> on        位元裝置 ON');
  console.log('    <裝置> off       位元裝置 OFF');
  console.log('    <裝置> <數值>    字元裝置寫入，例如: d100 250');
  console.log('');
  console.log('  其他:');
  console.log('    help   顯示此說明');
  console.log('    exit   離開程式');
  console.log('');
  console.log('  自動記錄：每隔 POLL_INTERVAL_MS 毫秒讀取 ME96SS 3-1 Voltage');
  console.log('            並寫入 PostgreSQL me96ss 資料表');
  console.log('');
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'plc-monitor> ',
});

console.log('=== PLC Monitor — ME96SS 3-1 Voltage Logger ===');
console.log('背景執行緒啟動中，連線到 PLC...');
printHelp();

initDb().catch((err) => {
  console.error(`[DB 初始化失敗] ${err.message}`);
  console.error('程式將繼續執行，但電壓資料將無法寫入資料庫');
});

rl.on('line', (line) => {
  const parts = line.trim().split(/\s+/);
  if (!parts[0]) { rl.prompt(); return; }

  const cmd = parts[0].toLowerCase();
  if (cmd === 'help') { printHelp(); rl.prompt(); return; }
  if (cmd === 'exit') {
    worker.terminate();
    pool.end();
    process.exit(0);
  }

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
      waitingResponse = true;
      worker.postMessage({
        type: 'set', device: parsed.device, addr: parsed.addr,
        bits: [second === 'on' ? 1 : 0], subtype: 'bit',
      });
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
  pool.end();
  process.exit(0);
});
