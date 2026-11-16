#!/bin/bash
# dev-load.sh — build the host half and arm a uniquely-named loader entry in the
# desktop profile patch. A fresh module URL per iteration bypasses Node's ESM
# module cache (same-URL re-imports return the first cached module).
# The patch file is replaced ATOMICALLY (temp + rename): a truncate-in-place
# write lets the profile's file watcher observe a partial file and drop entries.
set -euo pipefail
cd "$(dirname "$0")/.."

node_modules/.bin/tsdown >/dev/null

STAMP=$(date +%H%M%S)
TARGET="lib/dev-$STAMP.js"
cp lib/index.js "$TARGET"
# keep the workspace tidy: drop older dev copies
ls -t lib/dev-*.js 2>/dev/null | tail -n +6 | xargs -r rm -f

python - "$STAMP" <<'EOF'
import os, sys
stamp = sys.argv[1]
p = os.path.expanduser('~/.dsh/profiles/desktop/cordis.patch.yml')
lines = open(p, encoding='utf-8').read().splitlines(keepends=True)
out, i = [], 0
while i < len(lines):
    if lines[i].rstrip('\n') == '- insert:' and i + 2 < len(lines) and 'supermemory-' in lines[i+1]:
        i += 3
        continue
    out.append(lines[i])
    i += 1
out.append(f"\n- insert:\n    - id: supermemory-dev\n      name: 'G:/09 - dsh/SuperMemory/lib/dev-{stamp}.js'\n")
tmp = p + '.tmp'
with open(tmp, 'w', encoding='utf-8') as f:
    f.write(''.join(out))
os.replace(tmp, p)
print(f'armed lib/dev-{stamp}.js (atomic)')
EOF
