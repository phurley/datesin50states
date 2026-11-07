#!/usr/bin/env bash
# One-time (idempotent) server setup. Run from your laptop:
#   ./deploy/provision.sh                 # apex domain only
#   WITH_WWW=1 ./deploy/provision.sh      # also www.datesin50states.com (needs a DNS A record first)
# Then fill in /etc/datesin50states.env if needed and run ./deploy/deploy.sh.
set -euo pipefail
HOST="${DEPLOY_HOST:-root@datesin50states.com}"
DOMAIN="${DOMAIN:-datesin50states.com}"
NAMES="$DOMAIN"; CERT_ARGS="-d $DOMAIN"
if [[ "${WITH_WWW:-0}" == 1 ]]; then NAMES="$DOMAIN www.$DOMAIN"; CERT_ARGS="$CERT_ARGS -d www.$DOMAIN"; fi
HERE="$(cd "$(dirname "$0")" && pwd)"

scp -q "$HERE/datesin50states.service" "$HOST:/etc/systemd/system/datesin50states.service"
sed "s/__SERVER_NAMES__/$NAMES/" "$HERE/nginx.conf" | ssh "$HOST" 'cat > /tmp/d50-nginx.conf'
scp -q "$HERE/backup.cron" "$HOST:/etc/cron.d/datesin50states-backup"

ssh "$HOST" DOMAIN="$DOMAIN" CERT_ARGS="'$CERT_ARGS'" bash -s <<'REMOTE'
set -euo pipefail
id dates &>/dev/null || useradd --system --home /opt/datesin50states --shell /usr/sbin/nologin dates
install -d -o dates -g dates -m 755 /opt/datesin50states /opt/datesin50states/releases
install -d -o dates -g dates -m 755 /var/lib/datesin50states /var/lib/datesin50states/media
install -d -o dates -g dates -m 750 /var/lib/datesin50states/backups

if [[ ! -f /etc/datesin50states.env ]]; then
  cat > /etc/datesin50states.env <<ENV
NODE_ENV=production
PORT=3050
SITE_URL=https://$DOMAIN
DATA_DIR=/var/lib/datesin50states
APPLE_CLIENT_ID=com.datesin50states.signin
AUTHOR_EMAILS=phurley@gmail.com:Patrick,sue.hurley@gmail.com:Susan
ENV
  chmod 640 /etc/datesin50states.env; chgrp dates /etc/datesin50states.env
fi

# nginx vhost: only install our template the first time; afterwards certbot owns the ssl edits.
if [[ ! -f /etc/nginx/sites-available/datesin50states.conf ]]; then
  mv /tmp/d50-nginx.conf /etc/nginx/sites-available/datesin50states.conf
  ln -sf /etc/nginx/sites-available/datesin50states.conf /etc/nginx/sites-enabled/datesin50states.conf
else
  rm -f /tmp/d50-nginx.conf
fi
nginx -t && systemctl reload nginx

if [[ ! -d /etc/letsencrypt/live/$DOMAIN ]]; then
  certbot --nginx $CERT_ARGS --redirect --non-interactive --agree-tos
fi

systemctl daemon-reload
systemctl enable datesin50states >/dev/null
echo "provisioned: $(hostname)"
REMOTE
