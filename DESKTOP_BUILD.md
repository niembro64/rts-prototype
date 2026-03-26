# Desktop Build Guide

Budget Annihilation uses [Tauri v2](https://v2.tauri.app) to package the web game as a native desktop application. Tauri uses the OS's built-in webview (WebView2 on Windows, WebKit on macOS) so installers are small (~5-10 MB) compared to Electron.

## Prerequisites

All platforms need:

- **Node.js** (v18+) and **npm**
- **Rust** (v1.77.2+) — install via [rustup](https://rustup.rs)
- **wasm-pack** — `cargo install wasm-pack` (for the physics WASM module)

### Windows

- [Microsoft Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) — install the "Desktop development with C++" workload
- [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) — pre-installed on Windows 10 (1803+) and Windows 11. The Tauri installer bundles it as a fallback.

### macOS

- Xcode Command Line Tools — `xcode-select --install`
- CLang and macOS development dependencies are included with Xcode.

### Linux

- System dependencies vary by distro. See [Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux).
- Ubuntu/Debian example:
  ```bash
  sudo apt update
  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
  ```

## Scripts

| Command | Description |
| --- | --- |
| `npm run tauri:dev` | Launch the app in development mode (hot-reload via Vite) |
| `npm run tauri:build` | Build the production installer for your current OS |

## Development

```bash
npm install
npm run tauri:dev
```

This starts the Vite dev server and opens the game in a native window. Code changes hot-reload as usual.

## Production Build

```bash
npm install
npm run tauri:build
```

The build compiles the WASM physics module, type-checks, bundles the frontend with Vite, then compiles the Tauri Rust shell and packages everything into an installer.

### Output locations

All build artifacts land inside `src-tauri/target/release/`:

| Platform | Installer path | Format |
| --- | --- | --- |
| **Windows** | `src-tauri/target/release/bundle/nsis/Budget Annihilation_0.0.1_x64-setup.exe` | NSIS installer (.exe) |
| **Windows** | `src-tauri/target/release/bundle/msi/Budget Annihilation_0.0.1_x64_en-US.msi` | MSI installer |
| **macOS** | `src-tauri/target/release/bundle/dmg/Budget Annihilation_0.0.1_aarch64.dmg` | Disk image (.dmg) |
| **macOS** | `src-tauri/target/release/bundle/macos/Budget Annihilation.app` | App bundle |
| **Linux** | `src-tauri/target/release/bundle/deb/budget-annihilation_0.0.1_amd64.deb` | Debian package |
| **Linux** | `src-tauri/target/release/bundle/appimage/budget-annihilation_0.0.1_amd64.AppImage` | AppImage |

The standalone executable (without installer) is at:
- Windows: `src-tauri/target/release/budget-annihilation.exe`
- macOS/Linux: `src-tauri/target/release/budget-annihilation`

### Cross-compilation

Tauri does **not** support cross-compilation. You must build on the target OS:
- Build `.exe` / `.msi` on Windows
- Build `.dmg` / `.app` on macOS
- Build `.deb` / `.AppImage` on Linux

For CI, use GitHub Actions with a matrix of `windows-latest`, `macos-latest`, and `ubuntu-latest`. See [Tauri GitHub Action](https://github.com/tauri-apps/tauri-action) for a ready-made workflow.

## App Icons

Default placeholder icons are in `src-tauri/icons/`. Replace them with your own artwork. Tauri expects these files:

- `32x32.png`
- `128x128.png`
- `128x128@2x.png`
- `icon.icns` (macOS)
- `icon.ico` (Windows)

You can generate all sizes from a single 1024x1024 PNG:

```bash
npx tauri icon path/to/icon-1024x1024.png
```

## Web vs Desktop

The same codebase serves both web and desktop. Vite automatically detects whether it's running inside Tauri (via the `TAURI_ENV_PLATFORM` env var) and adjusts the base path:

- **Web deploy:** base path is `/budget-annihilation/`
- **Tauri (desktop):** base path is `/`

No code changes are needed to switch between the two.

## Updating the version

Update the version in both:
1. `package.json` — `"version"`
2. `src-tauri/tauri.conf.json` — `"version"`
3. `src-tauri/Cargo.toml` — `version`
