#!/usr/bin/env bash
# Regenerate parser parity fixtures from the reference Haskell compiler.
# Requires forsyde-compiler-exe (from forsyde-devtools) on PATH, plus the
# forsyde-shallow package DB. Not run in CI; fixtures are committed.
#
# Usage: scripts/regen-fixtures.sh [pkgdb-path]
set -euo pipefail

cd "$(dirname "$0")/.."

PKGDB="${1:-$(find "$HOME/.stack/snapshots" -maxdepth 4 -type d -name pkgdb 2>/dev/null | head -1)}"
[ -n "$PKGDB" ] || { echo "no stack pkgdb found; pass it as argument" >&2; exit 1; }

for hs in examples/shallow/*.hs; do
  name=$(basename "$hs" .hs)
  if forsyde-compiler-exe "$hs" --output-forsyde-ir-json --stdout \
      --forsyde-pkgpath "$PKGDB" > "fixtures/$name.ir.json" 2>"fixtures/$name.err"; then
    rm -f "fixtures/$name.err"
    cp "$hs" "fixtures/$name.hs"
    echo "ok    $name"
  else
    rm -f "fixtures/$name.ir.json"
    echo "FAIL  $name (see fixtures/$name.err)"
  fi
done
