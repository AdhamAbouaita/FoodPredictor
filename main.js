const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const { spawn } = require('child_process');

// -------------------------
// Constants / Paths
// -------------------------
const DATA_DIR = path.join(os.homedir(), '.food-predictor');
const DATA_CSV = path.join(DATA_DIR, 'data.csv');
const RESOURCES_DIR = app.isPackaged ? process.resourcesPath : __dirname;
const PY_DIR = path.join(RESOURCES_DIR, 'python');
const PY_SCRIPT = path.join(PY_DIR, 'forecast.py');
const VENV_DIR = path.join(DATA_DIR, 'venv');

// -------------------------
// Utility helpers
// -------------------------
function clampToScale(value) {
  const v = Math.max(1, Math.min(10, Number(value)));
  return Number.isFinite(v) ? v : 1;
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch (_) {
    return false;
  }
}

async function ensureDataDirAndFile() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const exists = await fileExists(DATA_CSV);
  if (!exists) {
    await fsp.writeFile(DATA_CSV, 'date,rating\n', 'utf8');
  }
}

function sortByDateAsc(a, b) {
  if (a.date < b.date) return -1;
  if (a.date > b.date) return 1;
  return 0;
}

async function loadCsv() {
  const exists = await fileExists(DATA_CSV);
  if (!exists) return [];
  const raw = await fsp.readFile(DATA_CSV, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (i === 0) continue; // header
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length < 2) continue;
    const date = parts[0];
    const rating = clampToScale(parseFloat(parts[1]));
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(rating)) {
      out.push({ date, rating });
    }
  }
  out.sort(sortByDateAsc);
  return out;
}

async function saveCsv(rows) {
  const sorted = [...rows].sort(sortByDateAsc);
  const body = sorted.map(r => `${r.date},${clampToScale(r.rating)}`).join('\n');
  const content = `date,rating\n${body}${body ? '\n' : ''}`;
  await fsp.writeFile(DATA_CSV, content, 'utf8');
}

async function upsertRow(date, rating) {
  const rows = await loadCsv();
  const idx = rows.findIndex(r => r.date === date);
  const clamped = clampToScale(rating);
  if (idx >= 0) rows[idx].rating = clamped; else rows.push({ date, rating: clamped });
  await saveCsv(rows);
  return rows;
}

// -------------------------
// EMA Forecast (JS)
// -------------------------
function calculateEMA(values, span = 10) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const alpha = 2 / (span + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = alpha * values[i] + (1 - alpha) * ema;
  }
  return clampToScale(ema);
}

// -------------------------
// Python / Prophet integration
// -------------------------
function getVenvPythonPath() {
  if (process.platform === 'win32') {
    return path.join(VENV_DIR, 'Scripts', 'python.exe');
  }
  return path.join(VENV_DIR, 'bin', 'python');
}

function getVenvPipPath() {
  if (process.platform === 'win32') {
    return path.join(VENV_DIR, 'Scripts', 'pip.exe');
  }
  return path.join(VENV_DIR, 'bin', 'pip');
}

async function isVenvReady() {
  const py = getVenvPythonPath();
  return fileExists(py);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function createVenv() {
  const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const result = await runCommand(pyCmd, ['-m', 'venv', VENV_DIR]);
  if (result.code !== 0) {
    throw new Error(`venv failed: ${result.stderr || result.stdout}`);
  }
}

async function installPythonDeps() {
  const pip = getVenvPipPath();
  const upgrade = await runCommand(pip, ['install', '--upgrade', 'pip', 'setuptools', 'wheel']);
  if (upgrade.code !== 0) throw new Error(`pip upgrade failed: ${upgrade.stderr}`);

  // Prophet stack — may take several minutes
  const deps = ['numpy', 'pandas', 'cmdstanpy', 'prophet'];
  const install = await runCommand(pip, ['install', ...deps]);
  if (install.code !== 0) throw new Error(`pip install failed: ${install.stderr}`);
}

async function ensurePythonEnv() {
  if (await isVenvReady()) return { ready: true };
  await createVenv();
  await installPythonDeps();
  return { ready: true };
}

let pythonSetupInProgress = false;
async function ensurePythonEnvOnce() {
  if (await isVenvReady()) return { ready: true, inProgress: false };
  if (pythonSetupInProgress) return { ready: false, inProgress: true };
  pythonSetupInProgress = true;
  try {
    await ensurePythonEnv();
  } catch (e) {
    // swallow; renderer can display fallback/notice
  } finally {
    pythonSetupInProgress = false;
  }
  return { ready: await isVenvReady(), inProgress: false };
}

async function runProphetForecast() {
  const ready = await isVenvReady();
  if (!ready) return { ok: false, error: 'venv-not-ready' };
  const py = getVenvPythonPath();
  const { stdout, stderr, code } = await runCommand(py, [PY_SCRIPT, '--csv', DATA_CSV], { cwd: RESOURCES_DIR });
  if (code !== 0) {
    return { ok: false, error: stderr || stdout || `exit ${code}` };
  }
  try {
    const parsed = JSON.parse(stdout.trim());
    if (parsed && typeof parsed.yhat === 'number') {
      return { ok: true, yhat: clampToScale(parsed.yhat) };
    }
    return { ok: false, error: 'invalid-json' };
  } catch (e) {
    return { ok: false, error: 'json-parse-failed' };
  }
}

async function computeForecast() {
  const rows = await loadCsv();
  const count = rows.length;
  const values = rows.map(r => Number(r.rating));
  const ema = calculateEMA(values, 10);

  if (count < 30) {
    return { count, ema, predicted: ema, source: 'ema' };
  }

  let prophetVal = null;
  let source = 'blend';
  const ready = await isVenvReady();
  if (ready) {
    const res = await runProphetForecast();
    if (res.ok) prophetVal = res.yhat;
  }

  if (count > 60 && prophetVal != null) {
    return { count, ema, prophet: prophetVal, predicted: prophetVal, source: 'prophet' };
  }

  if (prophetVal == null) {
    // Prophet unavailable or failed — EMA fallback
    return { count, ema, predicted: ema, source: 'ema-fallback' };
  }

  const blended = clampToScale(0.3 * prophetVal + 0.7 * ema);
  return { count, ema, prophet: prophetVal, predicted: blended, source };
}

// -------------------------
// Window / App lifecycle
// -------------------------
function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(async () => {
  await ensureDataDirAndFile();
  // Kick off Prophet setup in the background automatically (first run may take time)
  ensurePythonEnvOnce();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// -------------------------
// IPC Handlers
// -------------------------
ipcMain.handle('data:list', async () => {
  await ensureDataDirAndFile();
  return loadCsv();
});

ipcMain.handle('data:save', async (_evt, payload) => {
  const date = (payload && payload.date) || '';
  const rating = Number(payload && payload.rating);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('invalid-date');
  if (!Number.isFinite(rating)) throw new Error('invalid-rating');
  await ensureDataDirAndFile();
  return upsertRow(date, rating);
});

ipcMain.handle('forecast:next', async () => {
  await ensureDataDirAndFile();
  return computeForecast();
});

ipcMain.handle('env:status', async () => {
  const ready = await isVenvReady();
  return { ready, inProgress: pythonSetupInProgress, pyScript: PY_SCRIPT, resourcesDir: RESOURCES_DIR };
});

ipcMain.handle('env:setup', async () => {
  try {
    const status = await ensurePythonEnvOnce();
    return { ok: status.ready, ...status };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});
