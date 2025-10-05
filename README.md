## Food Predictor (Electron + EMA + Prophet)

A cross‑platform Electron desktop app that lets you log how much you liked dinner (1–10) and predicts tomorrow’s rating using a blend of an Exponential Moving Average (EMA) and Facebook/Meta Prophet (run locally via Python).

### Highlights
- One‑page, responsive UI with a live chart and tomorrow’s prediction
- Consistent, durable data storage in your home directory for both development and packaged apps
- Forecasting strategy:
  - < 30 data points: EMA only
  - 30–60 data points: 70% EMA + 30% Prophet
  - > 60 data points: Prophet only
- Prophet runs locally in an isolated Python virtual environment created on first use


## Table of Contents
- [Architecture](#architecture)
  - [Processes](#processes)
  - [Data Storage](#data-storage)
  - [Forecasting Pipeline](#forecasting-pipeline)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Getting Started (Development)](#getting-started-development)
- [Packaging/Distribution](#packagingdistribution)
  - [macOS](#macos)
  - [Windows](#windows)
  - [Linux](#linux)
- [Configuration](#configuration)
  - [Icons](#icons)
  - [Build Configuration](#build-configuration)
- [How the App Works (In Depth)](#how-the-app-works-in-depth)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)


## Architecture

### Processes
- Main process (`main.js`):
  - Creates the application window
  - Manages CSV storage in the user’s home directory
  - Exposes IPC endpoints for: listing/saving data and computing forecasts
  - Manages Python venv creation and dependency installation (Prophet stack)
  - Spawns the Python script (`python/forecast.py`) to compute 1‑day Prophet forecasts

- Renderer (`index.html`):
  - Renders a responsive UI: date/rating form, forecast card, live chart
  - Calls main process via `ipcRenderer.invoke(...)`
  - Uses Chart.js for visualization

### Data Storage
- Location is the same in development and packaged builds: a folder inside the user’s home directory.
  - macOS/Linux: `~/.food-predictor/data.csv`
  - Windows: `%USERPROFILE%\.food-predictor\data.csv`
- The app ensures the directory and CSV file exist on first run.
- CSV format:
  - Header: `date,rating`
  - Example:
    ```
    date,rating
    2025-10-01,8
    2025-10-02,6
    ```
- Deleting the app will NOT delete your data. Remove the `~/.food-predictor` (or `%USERPROFILE%\.food-predictor`) folder if you wish to reset.

### Forecasting Pipeline
1. Renderer asks main process for a forecast (`forecast:next`).
2. Main loads CSV, computes EMA in JS, and conditionally calls Prophet via Python.
3. Blending rules:
   - Count < 30 → EMA only
   - 30 ≤ Count ≤ 60 → 0.7 × EMA + 0.3 × Prophet
   - Count > 60 → Prophet only
4. All predictions are clamped to the 1–10 scale.
5. If Prophet is unavailable (e.g., not installed yet), the app falls back to EMA and continues to work.


## Project Structure
```
FoodPredictor/
├─ main.js                # Electron main process: IPC, CSV, EMA, Python bridge
├─ index.html             # Renderer: UI, Chart.js, IPC calls
├─ python/
│  └─ forecast.py         # Reads CSV, fits Prophet, prints JSON { yhat }
├─ build/
│  ├─ icon.icns           # macOS app icon (generated from logo.png)
│  └─ icon.png            # Windows/Linux icon
├─ package.json           # Scripts + electron-builder config
└─ README.md
```


## Prerequisites
- Node.js 16+ (18+ recommended) and npm
- Internet access on first build (Electron and Python packages download)
- For Prophet (first‑time setup is automatic, but requires platform tools):
  - macOS: Xcode Command Line Tools (usually preinstalled)
  - Windows: Visual C++ Build Tools (from Visual Studio Build Tools)
  - Linux: `build-essential`, Python 3, and standard dev toolchain


## Getting Started (Development)
1. Install dependencies:
   ```bash
   npm install
   ```
2. Run the app in development mode:
   ```bash
   npm start
   ```
   - Prophet environment setup runs automatically in the background on first launch. You can use the app immediately; EMA forecasts work while Prophet is preparing.
3. Use the form to log a rating for any date (defaults to today). The chart and prediction update live.


## Packaging/Distribution
Electron packaging is powered by `electron-builder` and is configured in `package.json` under the `build` field. Icons are wired for each platform.

Common commands:
```bash
npm run build        # Package for the current OS
npm run build:clean  # Remove previous dist/ then package
```

After a successful build, artifacts are placed in `dist/` (e.g., `.app` and `.dmg` on macOS, `.exe`/NSIS on Windows, `.AppImage` on Linux).

Note: To distribute for another OS, build on that OS or set up CI with cross‑platform builds. macOS code signing and notarization require Apple Developer credentials.

### macOS
- Output: `Food Predictor.app` and `Food Predictor-<version>-arm64.dmg`
- Code signing/notarization (optional, but recommended for distribution): configure `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and related `electron-builder` options. Without signing, Gatekeeper may show warnings.

### Windows
- Output: NSIS installer (`.exe`) by default.
- Building on Windows is recommended for best compatibility. Ensure Visual C++ Build Tools are installed.

### Linux
- Output: `AppImage` (default). You can add other targets if desired.


## Configuration

### Icons
- App icons are already generated and referenced by `electron-builder`:
  - macOS: `build/icon.icns`
  - Windows/Linux: `build/icon.png`
- If you want to change the icon, replace these two files and rebuild. The original `logo.png` used to generate icons is not required by the build.

### Build Configuration
`package.json` (excerpt):
```json
{
  "build": {
    "files": ["main.js", "index.html", "package.json", "python/**/*"],
    "extraResources": [{ "from": "python", "to": "python" }],
    "asarUnpack": ["python/**"],
    "mac": { "target": "dmg", "icon": "build/icon.icns" },
    "win": { "target": "nsis", "icon": "build/icon.png" },
    "linux": { "target": "AppImage", "icon": "build/icon.png" }
  }
}
```


## How the App Works (In Depth)
1. On launch, the main process ensures `~/.food-predictor/data.csv` exists and triggers a background task to set up a Python virtual environment inside `~/.food-predictor/venv` (one‑time).
2. The renderer loads existing data and requests a forecast. The main process:
   - Loads and validates CSV rows
   - Computes EMA (JS) with a default span of 10
   - If thresholds require Prophet and the Python env is ready, spawns `python/forecast.py` via the venv’s python interpreter to compute `yhat` for tomorrow
   - Blends EMA and Prophet predictions per the rules and clamps to 1–10
3. The renderer updates the forecast card and chart. The next‑day point is shown with a dashed line for clarity.


## Troubleshooting
- Prophet setup is slow on first run
  - Installing `cmdstanpy` and building its backend can take several minutes. This happens once and is cached in the venv.
- macOS: Gatekeeper warnings when launching packaged app
  - You may need to right‑click → Open on first run, or sign/notarize the app for distribution.
- Windows: Build failures related to native tooling
  - Install Visual C++ Build Tools; ensure Python 3 is available.
- Linux: Missing toolchain
  - Install `build-essential` and Python 3 dev headers via your package manager.
- Resetting app data
  - Quit the app and delete `~/.food-predictor` (macOS/Linux) or `%USERPROFILE%\.food-predictor` (Windows).
- Clearing and rebuilding
  - `rm -rf dist` then `npm run build` (or use `npm run build:clean`).


## FAQ
**Where is my data stored?**
In your home directory under `.food-predictor/data.csv` (same path for dev and packaged builds).

**Do I need Python installed?**
Yes, a local Python 3 is required the first time; the app creates a private venv and installs Prophet/pandas/numpy/cmdstanpy automatically.

**Can I run without Prophet?**
Yes. EMA forecasts work immediately. Prophet is used automatically once its environment is ready and you have enough data points.

**How do I change the icon?**
Replace `build/icon.icns` (macOS) and `build/icon.png` (Windows/Linux), then rebuild.

**How do I build for another OS?**
Build on that OS or configure CI to produce cross‑platform artifacts. Some targets require platform‑specific tooling and certificates.


