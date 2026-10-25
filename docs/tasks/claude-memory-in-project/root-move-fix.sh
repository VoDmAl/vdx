#!/usr/bin/env bash
# После смены корня папки проектов (`~/AI Projects` → `/Volumes/Working/AI Projects`) путь
# памяти Claude Code в каждом проекте — абсолютный, на старое место (DL #2). Скрипт находит под
# новыми корнями проекты, где путь задан, и зовёт `vdx doctor --fix` там, где doctor
# предупреждает: путь — на новое место, разговоры — под новый путь; ссылка на старом месте —
# тоже перенос (DL #15, vdx 0.39.2+). Одна станция, когда корень сменён на обеих и Syncthing
# догнал; до первой сессии в этих проектах (Sidetrack #6).
#
#   root-move-fix.sh '<новый корень>'...
set -u
[ $# -gt 0 ] || { echo "usage: $0 '<new root>'..." >&2; exit 2; }
need=0.39.2
have=$(vdx --version 2>/dev/null) || { echo "vdx is not on PATH" >&2; exit 1; }
if [ "$(printf '%s\n%s\n' "$need" "$have" | sort -V | head -1)" != "$need" ]; then
  echo "vdx $have: $need or later — before it a link at the old path reads as another folder's memory" >&2
  exit 1
fi

fixed=0 ok=0 failed=0
# fd 3: `vdx doctor --fix` must not read the list as its answers.
while IFS= read -r -d '' dir <&3; do
  grep -qs '"autoMemoryDirectory"' "$dir/.claude/settings.local.json" "$dir/.claude/settings.json" || continue
  line=$(vdx doctor "$dir" </dev/null 2>/dev/null | grep 'Claude memory')
  case "$line" in
    *warning*) ;;
    *) ok=$((ok + 1)); continue ;;
  esac
  echo "== $dir"
  vdx doctor --fix "$dir" </dev/null 2>&1 | grep -E '^(✓|✗)' | sed 's/^/   /'
  # What counts is the doctor line afterwards, not the fix's own words.
  after=$(vdx doctor "$dir" </dev/null 2>/dev/null | grep 'Claude memory')
  case "$after" in
    *warning*) failed=$((failed + 1)); echo "   still: $after" ;;
    *) fixed=$((fixed + 1)) ;;
  esac
done 3< <(find "$@" -maxdepth 4 -path '*/.claude/settings*.json' -not -path '*/node_modules/*' -print0 |
  while IFS= read -r -d '' f; do printf '%s\0' "${f%/.claude/*}"; done | sort -zu)

echo "fixed: $fixed  ok already: $ok  not fixed: $failed"
[ "$failed" -eq 0 ]
