@echo off
setlocal EnableExtensions
cd /d "%~dp0"

title Fetchr installer build
echo [Fetchr] NSIS installer build
echo.

set "FETCHR_UI_REDESIGN=true"
set "VITE_FETCHR_UI_REDESIGN=true"
set "FETCHR_TG_BETA_BOT=fetchr_beta_bot"
set "FETCHR_VPS_API_URL=https://fetchr.fun/api"
set "TAURI_DEV_HOST=127.0.0.1"

rem --- Build-time secrets live in build.env (git-ignored). See build.env.example.
if exist "build.env" (
    for /f "usebackq eol=# tokens=1,* delims==" %%A in ("build.env") do set "%%A=%%B"
) else (
    echo [WARN] build.env not found. See build.env.example.
)

rem --- Release preflight. These are checked BEFORE the ~15 minute build, and the
rem     two update-signing ones are hard errors: an installer shipped without a
rem     matching key pair can never install another update, and there is no way
rem     to fix that remotely afterwards.
if not defined FETCHR_UPDATE_PUBKEY (
    echo [ERROR] FETCHR_UPDATE_PUBKEY is not set.
    echo         A build without it refuses every future update, permanently.
    echo         Put the public key in build.env - see build.env.example.
    goto :error
)
if not defined FETCHR_UPDATE_PRIVATE_KEY (
    echo [ERROR] FETCHR_UPDATE_PRIVATE_KEY is not set.
    echo         Step 5 signs the update manifest and would fail after the whole
    echo         build. Export it, or put it in build.env on ONE line with \n
    echo         instead of real line breaks.
    goto :error
)

rem --- Runtime would reject a plaintext recorder URL, so catch it here instead.
if defined FETCHR_VPS_BASE_URL (
    if /i not "%FETCHR_VPS_BASE_URL:~0,8%"=="https://" (
        echo [ERROR] FETCHR_VPS_BASE_URL must start with https:// - the API token
        echo         travels in the X-Token header on every request.
        echo         Current value: %FETCHR_VPS_BASE_URL%
        goto :error
    )
) else (
    echo [WARN] FETCHR_VPS_BASE_URL is empty - VPS recorder disabled in this build.
)
if not defined FETCHR_VPS_TOKEN echo [WARN] FETCHR_VPS_TOKEN is empty - VPS recorder disabled in this build.
if not defined FETCHR_TWITCH_RESOLVER echo [WARN] FETCHR_TWITCH_RESOLVER is empty - no 1440p/2K unlock for Twitch.

set "PKG=npm"
where pnpm.cmd >nul 2>nul
if not errorlevel 1 set "PKG=pnpm"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found in PATH. Install Node.js 18+.
    goto :error
)

where cargo >nul 2>nul
if errorlevel 1 (
    echo [ERROR] cargo not found in PATH. Install Rust.
    goto :error
)

echo [0/5] Reading Fetchr version from package.json...
set "APP_VERSION="
for /f "usebackq delims=" %%V in (`node scripts/sync-build-version.mjs`) do set "APP_VERSION=%%V"
if not defined APP_VERSION (
    echo [ERROR] Could not read the application version. Set it with release.bat.
    goto :error
)
set "FETCHR_INSTALLER_NAME=Fetchr-Setup-v%APP_VERSION%.exe"
set "FETCHR_INSTALLER_DIR=dist\installer"
set "FETCHR_INSTALLER_PATH=%FETCHR_INSTALLER_DIR%\%FETCHR_INSTALLER_NAME%"

echo Package manager: %PKG%
echo Version: %APP_VERSION%
echo Output installer: %FETCHR_INSTALLER_PATH%
echo.

if not exist "node_modules\" (
    echo [1/5] Installing frontend dependencies...
    if "%PKG%"=="pnpm" (
        call pnpm install --frozen-lockfile || goto :error
    ) else (
        call npm install || goto :error
    )
) else (
    echo [1/5] Frontend dependencies found.
)

echo [2/5] Cleaning old Fetchr installer and stale Rust artifacts...
if exist "dist\" rmdir /s /q "dist" || goto :error
if exist "src-tauri\target\release\bundle\" rmdir /s /q "src-tauri\target\release\bundle" || goto :error
where cargo-sweep >nul 2>nul
if not errorlevel 1 (
    cargo sweep --time 7 src-tauri >nul 2>nul
    cargo sweep --maxsize 6GB src-tauri >nul 2>nul
    cargo sweep --time 7 setup >nul 2>nul
    cargo sweep --maxsize 1GB setup >nul 2>nul
)

rem --- The installer is our own setup.exe (setup\): WebView2 window with the
rem     launch intro, zstd payload, and the same /S /R /UPDATE switches the
rem     in-app updater passes. Tauri only builds the app EXE, no NSIS bundle.
echo [3/5] Building Fetchr app EXE...
if "%PKG%"=="pnpm" (
    call pnpm tauri build --no-bundle --ci || goto :error
) else (
    call npx tauri build --no-bundle --ci || goto :error
)
if not exist "src-tauri\target\release\fetchr.exe" (
    echo [ERROR] Release EXE was not created.
    goto :error
)

echo [4/5] Building and packing Fetchr installer...
cargo build --release --manifest-path setup\Cargo.toml || goto :error
if not exist "%FETCHR_INSTALLER_DIR%\" mkdir "%FETCHR_INSTALLER_DIR%" || goto :error
rem The file list lives in setup\payload.txt (shared with CI).
setup\target\release\fetchr-pack.exe --stub setup\target\release\fetchr-setup.exe ^
    --out "%FETCHR_INSTALLER_PATH%" --version %APP_VERSION% --list setup\payload.txt || goto :error
set "TAURI_INSTALLER_PATH=%FETCHR_INSTALLER_PATH%"

echo [5/5] Preparing installer aliases and update manifest...
copy /y "%FETCHR_INSTALLER_PATH%" "Fetchr-Setup-v%APP_VERSION%.exe" >nul || goto :error
copy /y "%FETCHR_INSTALLER_PATH%" "Fetchr-Setup-latest.exe" >nul || goto :error
rem `for /f` swallows the exit code, so an empty result is the only signal that
rem the manifest step failed. Without this check the build reports [OK] while
rem leaving no manifest at all - the failure would surface as users never
rem receiving the update.
set "FETCHR_INSTALLER_SHA256="
for /f "usebackq delims=" %%H in (`node scripts/write-latest-update-manifest.mjs "%APP_VERSION%" "%FETCHR_INSTALLER_PATH%"`) do set "FETCHR_INSTALLER_SHA256=%%H"
if not defined FETCHR_INSTALLER_SHA256 (
    echo [ERROR] Update manifest was not generated. The installer exists but has
    echo         no signed manifest, so nobody would receive this release.
    echo         Scroll up for the error from write-latest-update-manifest.mjs.
    goto :error
)

echo.
echo [OK] Fetchr installer build finished.
echo Installer: %FETCHR_INSTALLER_PATH%
echo Latest alias: Fetchr-Setup-latest.exe
echo SHA256: %FETCHR_INSTALLER_SHA256%
echo Source: %TAURI_INSTALLER_PATH%
echo.
goto :done

:error
echo.
echo [FAILED] Fetchr installer build failed. Scroll up for the first error.
echo If Fetchr is running, close it and run BuildInstaller.bat again.
echo.
if /i not "%CI%"=="true" pause
exit /b 1

:done
if /i not "%CI%"=="true" pause
exit /b 0
