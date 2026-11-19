#!/bin/bash
# dev-load.sh — build the host half, copy it to a FRESH module URL, and arm
# that URL in the desktop profile patch (atomic write).
#
# Two hard-won rules live here:
#  1. Node caches ESM modules by URL — a same-URL rebuild is invisible to the
#     running host (disable/enable re-imports the cached namespace). Every
#     iteration therefore lands on a new filename.
#  2. The patch file must be replaced ATOMICALLY (temp + rename): an in-place
#     truncate-write lets the profile watcher observe a partial file and drop
#     entries without recovering.
#
# After this script, poll plugin_manager until the entry's moduleName shows the
# new file, then disable/enable the entry (fast, loader-native remount).
set -euo pipefail
cd "$(dirname "$0")/.."

node_modules/.bin/tsdown >/dev/null

STAMP=$(date +%H%M%S)
TARGET="lib/dev-$STAMP.js"
cp lib/supermemory.js "$TARGET"
# keep the workspace tidy: drop older dev copies (keep the newest 3)
ls -t lib/dev-*.js 2>/dev/null | tail -n +4 | xargs -r rm -f

python - "$STAMP" "$(pwd -W 2>/dev/null || pwd)" <<'EOF'
import os, sys
stamp, repo = sys.argv[1], sys.argv[2].replace('\\', '/')
p = os.path.expanduser('~/.dsh/profiles/desktop/cordis.patch.yml')
lines = open(p, encoding='utf-8').read().splitlines(keepends=True)
out, i = [], 0
while i < len(lines):
    if lines[i].rstrip('\n') == '- insert:' and i + 2 < len(lines) and 'supermemory' in lines[i+1]:
        i += 3
        continue
    out.append(lines[i])
    i += 1
out.append(f"\n# SuperMemory dev load (unique module URL per build; see scripts/dev-load.sh)\n- insert:\n    - id: supermemory\n      name: '{repo}/lib/dev-{stamp}.js'\n")
tmp = p + '.tmp'
with open(tmp, 'w', encoding='utf-8') as f:
    f.write(''.join(out))
os.replace(tmp, p)
print(f'armed lib/dev-{stamp}.js (atomic)')
EOF
