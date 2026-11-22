#!/bin/bash
# Read-only: what keeps personal data on this server outside /var/lib/fetchr.
# Prints names and settings, never file contents or the env file.
echo "== Services"; systemctl is-active fetchr-api fetchr-telegram-bot 2>&1 | paste -sd' '
systemctl cat fetchr-api 2>/dev/null | grep -E '^(User|WorkingDirectory|ExecStart)='
echo "== Node"; node --version
echo "== Data paths"; { cat /etc/fetchr-services.env; systemctl cat fetchr-api fetchr-telegram-bot; } 2>/dev/null | grep -oE 'FETCHR_(VPS_DATA_DIR|BETA_BOT_LOG|BOT_DATA_DIR|BOT_ORDERS)=[^" ]*' | sort -u
echo "== Data files"; ls -la /var/lib/fetchr 2>/dev/null
echo "== Scheduled jobs"; crontab -l 2>/dev/null | grep -v '^#'; ls /etc/cron.d /etc/cron.daily 2>/dev/null
systemctl list-timers --all --no-pager 2>/dev/null | grep -iE 'fetchr|backup|rsync|restic|borg|dump'
echo "== Backup tools and folders"; command -v restic borg rclone duplicity rsnapshot 2>/dev/null
ls -d /root/*backup* /root/*bak* /var/backups/*fetchr* /srv/*backup* /backup* /var/lib/fetchr*.bak* /var/lib/fetchr-privacy-backup-* 2>/dev/null
echo "== nginx access logs"; grep -hE '^\s*access_log' /etc/nginx/nginx.conf /etc/nginx/sites-enabled/* 2>/dev/null | sort -u
grep -E '^\s*(rotate|daily|weekly)' /etc/logrotate.d/nginx 2>/dev/null | paste -sd' '
echo "== journald"; grep -E '^(SystemMaxUse|MaxRetentionSec)=' /etc/systemd/journald.conf 2>/dev/null; journalctl --disk-usage 2>/dev/null
