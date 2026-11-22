@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

rem Папка с видео для чистки (аргумент 1, по умолчанию текущая)
set "TARGET=%~1"
if "%TARGET%"=="" set "TARGET=%CD%"

echo === Fetchr cache cleanup ===

rem 1. Временные файлы приложения
if exist "%LOCALAPPDATA%\Fetchr\temp" (
  echo [temp] %LOCALAPPDATA%\Fetchr\temp
  rd /s /q "%LOCALAPPDATA%\Fetchr\temp" 2>nul
)

rem 2. Кеш эмодзи/бейджей чата (перекачается автоматически)
if exist "%LOCALAPPDATA%\fetchr\chat-assets" (
  echo [chat-assets] %LOCALAPPDATA%\fetchr\chat-assets
  rd /s /q "%LOCALAPPDATA%\fetchr\chat-assets" 2>nul
)

rem 3. Промежуточные рабочие папки рядом с видео
echo [work dirs] *.chat_overlay в "%TARGET%"
for /d /r "%TARGET%" %%D in (*.chat_overlay) do (
  echo   rd "%%D"
  rd /s /q "%%D" 2>nul
)

rem 4. Промежуточные blur-файлы
echo [blur] *_blur.mp4 в "%TARGET%"
for /r "%TARGET%" %%F in (*_blur.mp4) do (
  echo   del "%%F"
  del /q "%%F" 2>nul
)

rem 5. Устаревшие артефакты сборки Rust (старше 7 дней + лимит размера target)
where cargo-sweep >nul 2>nul
if not errorlevel 1 (
  echo [rust] cargo sweep (--time 7, --maxsize 6GB)
  if exist "%~dp0src-tauri\Cargo.toml" (
    cargo sweep --time 7 "%~dp0src-tauri"
    cargo sweep --maxsize 6GB "%~dp0src-tauri"
  )
  if exist "%~dp0setup\Cargo.toml" (
    cargo sweep --time 7 "%~dp0setup"
    cargo sweep --maxsize 1GB "%~dp0setup"
  )
)

echo === Done ===
endlocal
