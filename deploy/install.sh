#!/usr/bin/env bash
# Deploy the built web client to games.niemo.io.
#
# Idempotent: safe to re-run for every update. Run it from a checkout on your
# machine after `npm run build`; it mirrors `dist/` into the game's folder and
# verifies the result before exiting.
#
#   ./deploy/install.sh [ssh-target] [--dry-run]
#
# The default target matches the `games` alias (Tailscale MagicDNS). Pass
# ubuntu@<public-ip> to deploy with Tailscale down.
#
# games.niemo.io hosts ~25 games side by side under one document root, served
# by a single nginx regex location (`^/([^/]+)/` -> /var/www/games.niemo.io/$1).
# Publishing is therefore just "replace one folder", and the guards below exist
# so a mistake stays inside that folder: the remote path is rebuilt from a
# hard-coded root plus the folder name, `--delete` is never pointed anywhere
# else, and a missing or half-built `dist/` aborts before rsync can mirror
# emptiness over a live game.
set -euo pipefail

TARGET="${1:-ubuntu@games.tail4fabd8.ts.net}"
[[ "$TARGET" == --* ]] && TARGET="ubuntu@games.tail4fabd8.ts.net"
SSH_KEY="${SSH_KEY:-$HOME/Documents/flask_pem.pem}"

# Must match `base` in vite.config.ts — the bundle's asset URLs are absolute,
# so the folder name is baked into the build and cannot be renamed here.
GAME_FOLDER=budget-annihilation
REMOTE_ROOT=/var/www/games.niemo.io
REMOTE_DIR="$REMOTE_ROOT/$GAME_FOLDER"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$REPO_DIR/dist"

# A plain flag, not an array: macOS ships bash 3.2, where expanding an empty
# array under `set -u` is an unbound-variable error.
DRY_RUN=no
for arg in "$@"; do
  [[ "$arg" == "--dry-run" ]] && DRY_RUN=yes
done

ssh_run() { ssh -i "$SSH_KEY" -o IdentitiesOnly=yes "$TARGET" "$@"; }

# --- refuse to ship a build that is not there -------------------------------
[[ -n "$GAME_FOLDER" ]] || { echo "!! GAME_FOLDER is empty; refusing" >&2; exit 1; }
[[ -d "$DIST_DIR" ]] || { echo "!! no dist/ — run 'npm run build' first" >&2; exit 1; }
[[ -f "$DIST_DIR/index.html" ]] || { echo "!! dist/index.html missing — build is incomplete" >&2; exit 1; }
grep -q "/$GAME_FOLDER/" "$DIST_DIR/index.html" || {
  echo "!! dist/index.html does not reference /$GAME_FOLDER/ — wrong vite base" >&2; exit 1; }
asset_count="$(find "$DIST_DIR/assets" -type f 2>/dev/null | wc -l | tr -d ' ')"
[[ "$asset_count" -gt 0 ]] || { echo "!! dist/assets is empty — build is incomplete" >&2; exit 1; }

echo "==> deploying $DIST_DIR ($asset_count asset files) to $TARGET:$REMOTE_DIR"

# The folder is www-data-owned while we connect as ubuntu, so rsync writes
# through sudo. --delete is scoped to REMOTE_DIR and drops the stale hashed
# bundles the new build replaces; sibling game folders are never in its scope.
ssh_run "test -d $REMOTE_DIR || sudo mkdir -p $REMOTE_DIR"
rsync_flags=(-az --delete --exclude '.DS_Store')
[[ "$DRY_RUN" == yes ]] && rsync_flags+=(--dry-run --itemize-changes)
rsync "${rsync_flags[@]}" \
  --rsync-path="sudo rsync" \
  -e "ssh -i $SSH_KEY -o IdentitiesOnly=yes" \
  "$DIST_DIR"/ "$TARGET:$REMOTE_DIR/"

if [[ "$DRY_RUN" == yes ]]; then
  echo "==> dry run only; nothing was written"
  exit 0
fi

ssh_run "sudo chown -R www-data:www-data $REMOTE_DIR"

echo "==> verifying"
ssh_run "test -f $REMOTE_DIR/index.html && echo 'index.html present' &&
  echo \"files: \$(find $REMOTE_DIR -type f | wc -l)\""
curl -fsS -o /dev/null -w "https://games.niemo.io/$GAME_FOLDER/ -> %{http_code}\n" \
  "https://games.niemo.io/$GAME_FOLDER/"

echo "==> done"
