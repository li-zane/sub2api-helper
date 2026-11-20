#!/usr/bin/env bash
# Install only from the verified, root-owned production checkout.
set -euo pipefail
[[ $EUID == 0 ]]
src=/opt/tosub2/app/.agents/release
dest=/usr/local/lib/sub2api-helper-release
units=/etc/systemd/system
install -d -o root -g root -m 0755 "$dest"
for name in update-agent.py download.py bundle.py state-check.py deploy-x3.sh rollback-x3.sh; do
  if ! cmp -s "$src/$name" "$dest/$name"; then install -o root -g root -m 0644 "$src/$name" "$dest/$name"; fi
done
if ! cmp -s "$src/helper-update" /usr/local/sbin/helper-update; then install -o root -g root -m 0755 "$src/helper-update" /usr/local/sbin/helper-update; fi
for name in tosub2-update.socket tosub2-update@.service; do
  if ! cmp -s "$src/$name" "$units/$name"; then install -o root -g root -m 0644 "$src/$name" "$units/$name"; fi
done
systemctl daemon-reload
systemctl enable --now tosub2-update.socket
systemctl is-active --quiet tosub2-update.socket
test -S /run/tosub2-update.sock
printf 'UPDATE_BRIDGE_READY\n'
