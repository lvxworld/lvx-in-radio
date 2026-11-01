#!/bin/sh
# Opens the built app as on a Mac that never ran it: from the DMG, with empty data.
# Extra arguments go to the app. Set LVX_FRESH_DIR to reuse a folder.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
dmg=$(ls -t "$root"/dist/*.dmg | head -1)
work=${LVX_FRESH_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/lvx fresh XXXXXX")}
mount=$(mktemp -d "${TMPDIR:-/tmp}/lvx-dmg-XXXXXX")
hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$mount" >/dev/null
ditto "$mount/LVX in Radio.app" "$work/LVX in Radio.app"
hdiutil detach "$mount" >/dev/null
echo "App and data are in: $work"
LVX_DATA_DIR="$work/data" exec "$work/LVX in Radio.app/Contents/MacOS/LVX in Radio" "$@"
