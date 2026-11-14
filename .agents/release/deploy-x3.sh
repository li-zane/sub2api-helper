#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
release=${1:?Pass exact released main SHA}
before=${2:?Pass observed x3 HEAD SHA}
idle_limit=${3:-1200}
mode=${4:-apply}
[[ $release =~ ^[0-9a-f]{40}$ && $before =~ ^[0-9a-f]{40}$ ]]
[[ $idle_limit =~ ^[0-9]+$ && $idle_limit -le 86400 ]]
[[ $mode == apply || $mode == check ]]
app=/opt/tosub2/app
service=tosub2.service
scripts=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec 9>/opt/tosub2/.helper-release.lock
flock --nonblock 9
[[ $(uname -m) == x86_64 && $(node -p 'process.versions.node.split(".")[0]') == 22 ]]
[[ $(git -C "$app" remote get-url origin) == https://github.com/li-zane/sub2api-helper.git ]]
[[ $(git -C "$app" branch --show-current) == main ]]
[[ -z $(git -C "$app" status --porcelain) ]]
[[ $(git -C "$app" rev-parse HEAD) == "$before" ]]
systemctl is-active --quiet "$service"
git -C "$app" fetch origin refs/heads/main:refs/remotes/origin/main
git -C "$app" merge-base --is-ancestor "$release" origin/main
git -C "$app" merge-base --is-ancestor "$before" "$release"
backup=$(mktemp -d "/opt/tosub2/backups/artifact-${release:0:12}-$(date -u +%Y%m%dT%H%M%SZ)-XXXX")
keep_backup=0
cleanup() {
  if [[ $keep_backup == 0 && -d $backup ]]; then rm -rf -- "$backup"; fi
}
trap cleanup EXIT
cp "$scripts/state-check.py" "$backup/state-check.py"
cp "$scripts/rollback-x3.sh" "$backup/ROLLBACK.sh"
chmod 700 "$backup/ROLLBACK.sh"
printf '%s\n' "$app" >"$backup/app-path.txt"
printf '%s\n' "$service" >"$backup/service-name.txt"
printf '%s\n' "$before" >"$backup/previous-commit.txt"
python3 "$scripts/download.py" download "$release" --destination "$backup"
build="$backup/staging"
# Python remains an independent host runtime. Refuse a changed requirement before stopping anything.
cmp "$app/requirements.txt" "$build/requirements.txt"
/opt/tosub2/venv/bin/python -c 'import curl_cffi'
node --check "$build/src/console-server.mjs"
if [[ $mode == check ]]; then
  printf 'CHECK_PASS revision=%s bundle=verified build_on_x3=false service=unchanged\n' "$release"
  rm -rf -- "$backup"
  exit 0
fi
if [[ $release == "$before" ]]; then
  printf 'UPDATE_CURRENT revision=%s service=unchanged\n' "$release"
  rm -rf -- "$backup"
  exit 0
fi
deadline=$((SECONDS + idle_limit))
while true; do
  if python3 "$backup/state-check.py" snapshot "$backup"; then break; else
    code=$?
    [[ $code == 75 ]] || exit "$code"
  fi
  if ((SECONDS >= deadline)); then
    printf 'DEPLOY_DEFERRED active_tasks=true service=unchanged\n'
    rm -rf -- "$backup"
    exit 75
  fi
  sleep 15
done
[[ $(git -C "$app" rev-parse HEAD) == "$before" && -z $(git -C "$app" status --porcelain) ]]
stopped=0
recover() {
  failure=$?
  trap - ERR INT TERM
  if [[ $stopped == 1 ]]; then
    if bash "$backup/ROLLBACK.sh" "$backup"; then
      printf 'DEPLOY_FAILED rollback=verified backup=%s\n' "$backup"
    else
      printf 'DEPLOY_FAILED rollback=failed backup=%s\n' "$backup" >&2
    fi
  fi
  exit "$failure"
}
trap recover ERR
trap 'false' INT TERM
stopped=1
keep_backup=1
systemctl stop "$service"
tar -C /var/lib -czf "$backup/data-before.tar.gz" tosub2
cp "$(systemctl show "$service" -p FragmentPath --value)" "$backup/service-before"
(umask 022; git -C "$app" merge --ff-only "$release")
[[ $(git -C "$app" rev-parse HEAD) == "$release" ]]
if [[ -d "$app/node_modules" ]]; then mv "$app/node_modules" "$backup/node_modules-before"; else touch "$backup/deps-were-absent"; fi
cp -a "$build/node_modules" "$app/node_modules"
if [[ -d "$app/web/dist" ]]; then mv "$app/web/dist" "$backup/dist-before"; else touch "$backup/dist-was-absent"; fi
cp -a "$build/web/dist" "$app/web/dist"
runuser -u tosub2 -- test -r "$app/src/console-server.mjs"
runuser -u tosub2 -- test -r "$app/web/dist/index.html"
systemctl start "$service"
ready=0
for ((attempt=0; attempt<30; attempt++)); do
  if curl --fail --silent http://127.0.0.1:4399/api/bootstrap >/dev/null; then ready=1; break; fi
  sleep 1
done
[[ $ready == 1 ]]
systemctl is-active --quiet "$service"
[[ $(git -C "$app" rev-parse HEAD) == "$release" && $(git -C "$app" branch --show-current) == main ]]
[[ -z $(git -C "$app" status --porcelain) ]]
python3 "$backup/state-check.py" verify "$backup" --app "$app"
stopped=0
keep_backup=0
trap - ERR INT TERM
# Recovery copies exist only during an update. Successful updates leave no historical runtime directories.
rm -rf -- "$backup"
printf 'DEPLOY_PASS branch=main revision=%s service=active build_on_x3=false history=removed\n' "$release"
