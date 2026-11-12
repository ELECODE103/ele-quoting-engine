#!/bin/sh
# Start-up wrapper for the container.
#
# Railway mounts a volume owned by root, and this image runs the server as the
# unprivileged "node" user. So the container starts as root for one job only —
# make the data folder (the volume, /app/data) writable by "node" — and then
# hands over to the server as "node" for good. The server itself never runs as
# root.
#
# Railway's own documented fix for "volume is root-owned, image is not" is to
# run the whole process as root (RAILWAY_RUN_UID=0). That setting is NOT needed
# with this file and should be left unset; if it is set, the result is the
# same: start as root, fix ownership, drop to "node".
#
#   SE_DATA_DIR   the data folder (default /app/data)
#   SE_RUN_USER   the user the server runs as (default node)
set -eu

DATA_DIR="${SE_DATA_DIR:-/app/data}"
RUN_USER="${SE_RUN_USER:-node}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  want="$(id -u "$RUN_USER"):$(id -g "$RUN_USER")"
  # Only when something is not ours already: a recursive chown of a full volume on every start would be slow.
  if [ "$(stat -c '%u:%g' "$DATA_DIR")" != "$want" ] || [ -n "$(find "$DATA_DIR" -mindepth 1 -maxdepth 2 ! -user "$RUN_USER" -print -quit 2>/dev/null)" ]; then
    echo "entrypoint: making $DATA_DIR writable by $RUN_USER (volume mounted as root)"
    chown -R "$want" "$DATA_DIR"
  fi
  # exec: the server replaces this script, so it receives SIGTERM itself and can stop cleanly.
  exec setpriv --reuid="$(id -u "$RUN_USER")" --regid="$(id -g "$RUN_USER")" --init-groups "$@"
fi

# Not root (the platform chose the user). The data folder must already be writable.
if [ ! -w "$DATA_DIR" ]; then
  echo "FATAL: $DATA_DIR is not writable by uid $(id -u). The volume is mounted as root and this container was not started as root, so the ownership cannot be fixed here. In Railway, remove any RAILWAY_RUN_UID variable other than 0 and redeploy." >&2
  exit 1
fi
exec "$@"
