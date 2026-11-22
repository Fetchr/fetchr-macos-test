@echo off
set PATH=C:\Windows\System32;C:\Windows;%USERPROFILE%\.cargo\bin;C:\Users\h3r0n\AppData\Roaming\kimi-desktop\daimon-share\daimon\runtime\python\.venv\Scripts
cd /d C:\Users\h3r0n\Documents\yt-dlp\stream-cutter\src-tauri
cargo test --lib jobs:: --no-run > test-out.txt 2>&1
if errorlevel 1 (echo BUILD_FAILED >> test-out.txt & exit /b 1)
for /f "delims=" %%F in ('dir /b /o-d target\debug\deps\fetchr_lib-*.exe') do set TESTEXE=%%F & goto :found
:found
python embed_cc6_manifest.py "target\debug\deps\%TESTEXE%" >> test-out.txt 2>&1
target\debug\deps\%TESTEXE% jobs:: >> test-out.txt 2>&1
echo EXIT=%ERRORLEVEL% >> test-out.txt
