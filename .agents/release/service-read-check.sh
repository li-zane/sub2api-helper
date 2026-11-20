#!/usr/bin/env bash
# Ask the existing service manager to run a fixed, read-only probe as the
# service UID. The socket worker does not need CAP_SETUID, sudo, or PAM.
set -euo pipefail
[[ $# == 2 && $1 == /* && $2 == /* ]]
exec systemd-run --quiet --wait --collect \
  --property=User=tosub2 --property=NoNewPrivileges=yes \
  --property=PrivateTmp=yes --property=ProtectSystem=strict \
  /bin/sh -ec '/usr/bin/test -r "$1" && /usr/bin/test -r "$2"' helper-read "$1" "$2"
