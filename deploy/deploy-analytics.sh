#!/usr/bin/env bash
# Выкладывает серверную часть без релиза приложения: fetchr-api (аналитика),
# Telegram-бота (напоминание об оплате, согласие, /winback) и сайт.
# Запуск из Git Bash: bash deploy/deploy-analytics.sh
set -euo pipefail

HOST="${FETCHR_VPS:-root@5.175.211.58}"
KEY="${FETCHR_VPS_KEY:-$HOME/.ssh/fetchr_archive_admin}"
SSH=(ssh -i "$KEY" -o BatchMode=yes)
ROOT="/var/www/fetchr"
APP="/opt/fetchr-services/scripts"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SITE="$HERE/../vps-site/var-www-fetchr"
STAMP=$(date +%Y%m%d-%H%M%S)

API_FILES="vps-api-server.mjs analytics-import-nginx.mjs churn-snapshot.mjs lib/admin-auth.mjs lib/error-telemetry.mjs lib/catalog-public.mjs lib/bot/catalog.mjs lib/account-subscription.mjs lib/archive-tenants.mjs lib/analytics/nginx-import.mjs lib/analytics/counters.mjs
  lib/analytics/site-hits.mjs lib/analytics/app-counters.mjs lib/analytics/report.mjs lib/analytics/ops-stats.mjs lib/analytics/server-stats.mjs lib/telemetry-events.mjs lib/telemetry-summary.mjs"
BOT_FILES="telegram-beta-bot.mjs vps-revoke-old-licenses.mjs lib/bot/bot.mjs lib/bot/shop.mjs lib/bot/shop-screens.mjs lib/bot/screens.mjs
  lib/bot/registration.mjs lib/bot/winback.mjs lib/bot/drip.mjs lib/bot/channel-stats.mjs"

# Windows checkout has CRLF; strip it on the server so shebangs and diffs stay clean.
push() {
  tar -C "$HERE/scripts" -cf - $1 | "${SSH[@]}" "$HOST" "tar -xf - -C $APP --no-same-owner && cd $APP && sed -i 's/\r\$//' $(echo $1)"
}

echo "== backup api + bot"
"${SSH[@]}" "$HOST" "cd $APP && tar -czf /root/fetchr-services-before-$STAMP.tgz *.mjs lib"

echo "== api"
push "$API_FILES"
"${SSH[@]}" "$HOST" "node --check $APP/vps-api-server.mjs && systemctl stop fetchr-api && (node $APP/analytics-import-nginx.mjs --before=2026-11-09 /var/lib/fetchr/analytics-counters.json /var/log/nginx/access.log* || true) && systemctl start fetchr-api && sleep 2 && systemctl is-active fetchr-api"

echo "== bot"
push "$BOT_FILES"
"${SSH[@]}" "$HOST" "node --check $APP/telegram-beta-bot.mjs && systemctl restart fetchr-telegram-bot && sleep 3 && systemctl is-active fetchr-telegram-bot && journalctl -u fetchr-telegram-bot -n 5 --no-pager -o cat"

echo "== site: backup + copy"
cd "$SITE"
PAGES=$(ls -d */index.html index.html)
"${SSH[@]}" "$HOST" "cd $ROOT && tar -czf /root/fetchr-site-before-$STAMP.tgz index.html robots.txt assets/guides/guides.js \$(ls -d */index.html)"
tar -cf - admin assets/a.js assets/not-windows.js assets/guides/guides.js robots.txt $PAGES \
  | "${SSH[@]}" "$HOST" "tar -xf - -C $ROOT --no-same-owner && chown -R www-data:www-data $ROOT/admin $ROOT/assets/a.js $ROOT/assets/not-windows.js $ROOT/assets/guides $ROOT/robots.txt $(printf "$ROOT/%s " $PAGES)"

echo "== check"
"${SSH[@]}" "$HOST" "curl -s -o /dev/null -w 'admin %{http_code} (403 = ok)\n' https://fetchr.fun/api/admin/analytics; curl -s -o /dev/null -w 'page %{http_code}\n' https://fetchr.fun/admin/; curl -s -o /dev/null -w 'not-windows.js %{http_code}\n' https://fetchr.fun/assets/not-windows.js"
echo "Откат: на сервере tar -xzf /root/fetchr-services-before-$STAMP.tgz -C $APP (и перезапуск fetchr-api, fetchr-telegram-bot); сайт — tar -xzf /root/fetchr-site-before-$STAMP.tgz -C $ROOT"
