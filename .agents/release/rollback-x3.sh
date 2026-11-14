#!/usr/bin/env bash
set -Eeuo pipefail
backup=${1:?Pass deployment backup directory}
app=$(cat "$backup/app-path.txt")
before=$(cat "$backup/previous-commit.txt")
service=$(cat "$backup/service-name.txt")
[[ $before =~ ^[0-9a-f]{40}$ ]]
[[ -d "$app/.git" && -f "$backup/account-bindings-before.json" ]]
systemctl stop "$service"
# Switching to main again would leave HEAD at the failed release. Restore the SHA.
(umask 022; git -C "$app" switch --detach "$before")
if [[ -d "$backup/dist-before" ]]; then
  if [[ -e "$app/web/dist" ]]; then mv "$app/web/dist" "$backup/dist-failed-$(date +%s%N)"; fi
  cp -a "$backup/dist-before" "$app/web/dist"
elif [[ -f "$backup/dist-was-absent" && -e "$app/web/dist" ]]; then
  mv "$app/web/dist" "$backup/dist-failed-$(date +%s%N)"
fi
if [[ -d "$backup/node_modules-before" ]]; then
  if [[ -e "$app/node_modules" ]]; then mv "$app/node_modules" "$backup/node_modules-failed-$(date +%s%N)"; fi
  cp -a "$backup/node_modules-before" "$app/node_modules"
elif [[ -f "$backup/deps-were-absent" && -e "$app/node_modules" ]]; then
  mv "$app/node_modules" "$backup/node_modules-failed-$(date +%s%N)"
fi
systemctl start "$service"
ready=0
for ((attempt=0; attempt<30; attempt++)); do
  if curl --fail --silent http://127.0.0.1:4399/api/bootstrap >/dev/null; then ready=1; break; fi
  sleep 1
done
[[ $ready == 1 ]]
systemctl is-active --quiet "$service"
[[ $(git -C "$app" rev-parse HEAD) == "$before" ]]
python3 "$backup/state-check.py" verify "$backup" --app "$app"
printf 'ROLLBACK_PASS revision=%s service=active data=preserved\n' "$before"
