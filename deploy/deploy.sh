#!/usr/bin/env bash
# Ship the current commit to the server and restart. Usage: ./deploy/deploy.sh
#   ROLLBACK=1 ./deploy/deploy.sh   -> point `current` back at the previous release
set -euo pipefail
HOST="${DEPLOY_HOST:-root@datesin50states.com}"
APP=/opt/datesin50states
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ "${ROLLBACK:-0}" == 1 ]]; then
  ssh "$HOST" bash -s <<REMOTE
set -euo pipefail
cd $APP/releases
prev=\$(ls -1t | sed -n 2p)
[[ -n "\$prev" ]] || { echo "no previous release"; exit 1; }
ln -sfn $APP/releases/\$prev $APP/current
systemctl restart datesin50states
echo "rolled back to \$prev"
REMOTE
  exit 0
fi

if [[ -n "$(git status --porcelain)" && "${ALLOW_DIRTY:-0}" != 1 ]]; then
  echo "Working tree has uncommitted changes; commit first (or ALLOW_DIRTY=1)." >&2
  exit 1
fi
REL="$(date -u +%Y%m%d%H%M%S)-$(git rev-parse --short HEAD)"
echo "==> deploying $REL"

git archive --format=tar HEAD | ssh "$HOST" "mkdir -p $APP/releases/$REL && tar -x -C $APP/releases/$REL"

ssh "$HOST" bash -s <<REMOTE
set -euo pipefail
cd $APP/releases/$REL
chown -R dates:dates .
sudo -u dates -H env HOME=$APP npm ci --omit=dev --no-audit --no-fund --loglevel=error
ln -sfn $APP/releases/$REL $APP/current
systemctl restart datesin50states
for i in \$(seq 1 20); do
  curl -fsS http://127.0.0.1:3050/healthz >/dev/null && break
  sleep 1
done
curl -fsS http://127.0.0.1:3050/healthz >/dev/null || { journalctl -u datesin50states -n 40 --no-pager; exit 1; }
# keep the five newest releases
ls -1t $APP/releases | tail -n +6 | xargs -r -I{} rm -rf $APP/releases/{}
echo "==> live: $REL"
REMOTE
