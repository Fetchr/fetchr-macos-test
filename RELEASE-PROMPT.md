# Промт для Gemini — релиз Fetchr (установщики + уведомление)

Каждый релиз редактируй только блок **ВХОДНЫЕ ДАННЫЕ**, остальное не трогай.
Отправляй Gemini, запущенному в корне репозитория с доступом к shell, `gh` (GitHub CLI,
авторизован) и `ssh`/`scp` к VPS.

```text
Ты — релиз-инженер проекта Fetchr (Tauri 2 + React) в текущем репозитории.
Выполни релиз строго по шагам. Не меняй логику приложения. После каждого шага
пиши одну строку что сделал. Если шаг падает — остановись и покажи ошибку.

=== ВХОДНЫЕ ДАННЫЕ ===
VERSION: 0.4.2
NOTES_RU: |
  Fetchr v0.4.2 🚀
  - первый пункт
  - второй пункт
NOTES_EN: |            # необязательно; если пусто — возьми NOTES_RU для обоих языков
SSH: user@host          # ssh-цель VPS
SSH_PORT: 22
VPS_DOWNLOADS_DIR: /var/lib/fetchr/downloads      # каталог установщиков на VPS
VPS_MANIFEST_PATH: /var/lib/fetchr/latest-update.json   # путь манифеста на VPS
=======================

ШАГ 1 — Версия. Проставь ровно VERSION (без автобампа) во всех файлах:
- package.json → "version"
- src-tauri/Cargo.toml → [package] version = "VERSION"
- src-tauri/tauri.conf.json → "version" И app.windows[0].title = "Fetchr beta vVERSION"
- src-tauri/tauri.macos.conf.json → app.windows[0].title = "Fetchr beta vVERSION"
Убедись, что версии совпадают везде. Закоммить: git add -A && git commit -m "release vVERSION".

ШАГ 2 — Сборка всех ОС через GitHub Actions (Windows/macOS/Linux собираются там,
конфиг апдейтера уже вшит через env в .github/workflows/build.yml):
- git tag vVERSION && git push origin HEAD --tags
  (workflow build.yml триггерится на тег v*; альтернатива — gh workflow run build.yml)
- Дождись успешного прогона: gh run watch --exit-status
- Скачай артефакты:
  gh run download -n fetchr-windows        -D dist/win
  gh run download -n fetchr-macos-universal -D dist/mac
  gh run download -n fetchr-linux          -D dist/linux
- Проверь наличие: dist/win/*.exe, dist/mac/*.dmg, dist/linux/*.AppImage, dist/linux/*.deb.
  Запомни точные имена файлов (они попадут в ссылки — переименовывать нельзя).

ШАГ 3 — Манифест обновления с МОИМ текстом. Сгенерируй базовый манифест по
Windows-установщику (посчитает version/installer_url/installer_sha256/signature):
- В окружении должен быть FETCHR_UPDATE_PRIVATE_KEY (PKCS#8 ed25519 PEM). Без него
  скрипт упадёт: неподписанный манифест все клиенты отвергнут.
- WIN_EXE=$(ls dist/win/*.exe | head -n1)
- node scripts/write-latest-update-manifest.mjs VERSION "$WIN_EXE"
  (создаст dist/win/latest-update.json; installer_url = https://fetchr.fun/api/downloads/<имя exe>)
- Скрипт печатает в stderr публичный ключ. Он ОБЯЗАН совпадать с FETCHR_UPDATE_PUBKEY,
  с которым собран установщик, иначе обновление не поставится ни у кого.
- Скопируй его в dist/latest-update.json и ПЕРЕЗАПИШИ в нём поля notes и notes_i18n
  моим текстом:
    notes      = NOTES_RU
    notes_i18n = { "ru": NOTES_RU, "en": NOTES_EN || NOTES_RU }
- В конец notes (и ru, и en) добавь пустую строку и ссылки на установщики
  (подставь реальные имена файлов из ШАГ 2):
    Windows: https://fetchr.fun/api/downloads/<имя .exe>
    macOS:   https://fetchr.fun/api/downloads/<имя .dmg>
    Linux:   https://fetchr.fun/api/downloads/<имя .AppImage>
- installer_url НЕ меняй (остаётся Windows .exe: авто-установка в приложении рассчитана
  на Windows; macOS/Linux пользователи увидят уведомление и скачают по ссылкам из notes).
- signature НЕ трогай. Подпись покрывает version + installer_url + installer_sha256;
  если правишь любое из них вручную — перегенерируй манифест скриптом, иначе подпись
  перестанет сходиться. notes/notes_i18n подписью не покрыты, их править можно.

ШАГ 4 — Заливка на VPS:
- Установщики (сохраняя имена):
  scp -P SSH_PORT dist/win/*.exe dist/mac/*.dmg dist/linux/*.AppImage dist/linux/*.deb \
      SSH:VPS_DOWNLOADS_DIR/
- Манифест:
  scp -P SSH_PORT dist/latest-update.json SSH:VPS_MANIFEST_PATH

ШАГ 5 — Проверка (обязательно):
- curl -s "https://fetchr.fun/api/updates/latest?platform=windows&channel=beta&current_version=0.0.0" | jq
  Проверь: version == VERSION, notes == мой текст, поля installer_url/installer_sha256 на месте.
- Для каждой ссылки из notes: curl -I <url> должен вернуть 200.
- Отчитайся: версия, 4 залитых файла, что манифест отдаётся и ссылки живые.
```

## Разовая настройка (один раз, до первого релиза)

- В GitHub → Settings → Secrets задай (иначе резолвер и VPS-рекордер в сборках Actions
  будут выключены): `FETCHR_TWITCH_RESOLVER`, `FETCHR_VPS_BASE_URL`, `FETCHR_VPS_TOKEN`,
  `FETCHR_UPDATE_PUBKEY`. Локально те же значения берутся из `build.env`
  (см. `build.env.example`) — в репозитории их нет и быть не должно.
- Сгенерируй пару ключей подписи релизов один раз. Приватный (`FETCHR_UPDATE_PRIVATE_KEY`)
  держи только на своей машине, на VPS он не попадает никогда; публичный идёт в
  `FETCHR_UPDATE_PUBKEY` при сборке:
  ```sh
  node -e "const{generateKeyPairSync}=require('node:crypto');const{privateKey,publicKey}=generateKeyPairSync('ed25519');console.log(privateKey.export({type:'pkcs8',format:'pem'}));console.log('FETCHR_UPDATE_PUBKEY =',publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('base64'))"
  ```
  Менять пару нельзя без выпуска переходной версии: сборки со старым публичным ключом
  отвергнут манифест, подписанный новым, и потеряют обновления навсегда.
- `gh auth login` на машине, где работает Gemini.
- Проверь `VPS_DOWNLOADS_DIR` и `VPS_MANIFEST_PATH` — должны совпадать с `FETCHR_VPS_DOWNLOADS_DIR`
  и `FETCHR_UPDATE_JSON`, с которыми запущен `scripts/vps-api-server.mjs` на VPS.
