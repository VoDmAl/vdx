#!/usr/bin/env bash
# Smoke test: run vdx audit on the three calibration reference projects.
# Expected (per manual calibration): all capped at L2 on `ci` axis.

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PROJECTS=(
  "/Users/vdm/PhpstormProjects/git.vorobyev.name/telegram.vorobyev.name"
  "/Users/vdm/PhpstormProjects/git.vorobyev.name/www.t23b.org"
  "/Users/vdm/AI Projects/trading-tools-bookmap"
)

for proj in "${PROJECTS[@]}"; do
  echo
  echo "========================================================================"
  echo " $(basename "$proj")"
  echo "========================================================================"
  npx tsx src/index.ts audit "$proj" || true
done
