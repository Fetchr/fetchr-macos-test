# Fetchr

Десктоп-приложение (Tauri 2 + React) для загрузки и обработки видео/аудио со стримов:
скачивание (yt-dlp / N_m3u8DL-RE / ffmpeg-fallback), запись live-эфиров, поиск m3u8,
рендер чата, удаление вокала и «Fetchr Mute» (заглушка мата по таймингам).

## Стек

- Фронтенд: React 18, TypeScript, Vite, TanStack Router, Zustand, Tailwind, i18next.
- Бэкенд: Rust (`src-tauri`), Tauri 2.
- Внешние бинарники (в корне, в `.gitignore`): `ffmpeg.exe`, `ffprobe.exe`, `ffplay.exe`,
  `yt-dlp.exe`, `N_m3u8DL-RE.exe`.

## Сборка

```bat
npm install
npm run tauri:dev      :: dev (Vite + Tauri)

Build.bat              :: релизная сборка
BuildInstaller.bat     :: + установщик (setup/: окно с интро, zstd-пакет)
```

Версия приложения берётся из `package.json` и подставляется в UI при сборке через
Vite-define `__APP_VERSION__` (`vite.config.ts`). Бамп: `node scripts/bump-build-version.mjs`.

## Кроссплатформенность (Windows / macOS / Linux)

Сборки под все три ОС собирает `.github/workflows/build.yml` (GitHub Actions,
`workflow_dispatch` или тег `v*`): Windows → свой установщик `setup/`, macOS → universal `.dmg`,
Linux → `.deb` + `.AppImage`. CLI-бинарники (yt-dlp, ffmpeg, N_m3u8DL-RE)
в `.gitignore`, поэтому CI скачивает их per-OS перед `tauri build`.

Конфиги Tauri разделены и мерджатся по RFC 7396: базовый `tauri.conf.json` +
`tauri.windows/macos/linux.conf.json` (ресурсы-бинарники и targets по ОС).

Бэкенды по платформам:

- ASR (Fetchr Mute): GigaAM v3 RNN-T INT8 через sherpa-onnx, одна модель на оба режима.
  По умолчанию greedy. `FETCHR_ASR_BEAM=on` включает modified_beam_search с бустингом словаря мата
  (+30% времени, выигрыш в полноте не подтверждён замером); `FETCHR_ASR_HOTWORDS_SCORE` меняет силу
  бустинга, потолок 2.5.
- HW-энкодер (Auto): Windows → QSV/NVENC/AMF, macOS → VideoToolbox, Linux → libx264.
  Во всех случаях есть fallback на CPU (libx264).
- HWID лицензии: Windows → WMI, macOS → IOPlatformUUID, Linux → `/etc/machine-id`.

### macOS

- ffmpeg/ffprobe НЕ бандлятся (нет надёжной статичной universal-сборки). Нужен
  Homebrew: `brew install ffmpeg`. Приложение ищет его в `/opt/homebrew/bin` и
  `/usr/local/bin` (GUI-приложения из Finder не наследуют shell `PATH`).
- Сборка не подписана. При первом запуске снять карантин Gatekeeper:

  ```sh
  xattr -dr com.apple.quarantine /Applications/Fetchr.app
  ```

### Linux

Зависимости сборки (Ubuntu): `libwebkit2gtk-4.1-dev libappindicator3-dev
librsvg2-dev patchelf`. ffmpeg/yt-dlp/N_m3u8DL-RE бандлятся в пакет.

## Структура

```
src/                 фронтенд
  ui/redesign/       актуальный UI
  stores/            Zustand-сторы
  lib/               ipc, утилиты, notify
  i18n/              ru/en словари
src-tauri/src/       Rust-бэкенд (jobs, modules, chat_overlay)
scripts/             сборка и вспомогательные скрипты
```
