#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
[ "$(git branch --show-current)" = main ] || { echo 'Branche main requise.' >&2; exit 1; }

RESET_WORK=$(mktemp -d "${TMPDIR:-/tmp}/textmachine-reset.XXXXXX")
trap 'rm -rf -- "$RESET_WORK"' EXIT
git ls-remote --refs origin refs/heads/main 'refs/tags/*' > "$RESET_WORK/remote"
REMOTE_MAIN=$(awk '$2 == "refs/heads/main" {print $1}' "$RESET_WORK/remote")
[ -n "$REMOTE_MAIN" ] || { echo 'Branche main distante introuvable.' >&2; exit 1; }

# Retirer du suivi les fichiers ignorés sans les supprimer du disque.
git ls-files -ci --exclude-standard -z > "$RESET_WORK/ignored"
while IFS= read -r -d '' file; do
  git rm --cached -- "$file"
done < "$RESET_WORK/ignored"
git add -A
git diff --cached --check
TREE=$(git write-tree)
PREVIOUS=$(git rev-parse HEAD)
INITIAL=$(git commit-tree "$TREE" -m 'Initialize Text Machine plugin sources')

OPTIONS=(--atomic "--force-with-lease=refs/heads/main:$REMOTE_MAIN")
REFS=("$INITIAL:refs/heads/main")
while read -r sha ref; do
  case "$ref" in
    refs/tags/*)
      OPTIONS+=("--force-with-lease=$ref:$sha")
      REFS+=(":$ref")
      ;;
  esac
done < "$RESET_WORK/remote"
git push "${OPTIONS[@]}" origin "${REFS[@]}"
git update-ref refs/heads/main "$INITIAL" "$PREVIOUS"
git branch --set-upstream-to=origin/main main

while IFS= read -r tag; do
  [ -z "$tag" ] || git tag -d "$tag"
done < <(git tag -l)
[ "$(git rev-list --count HEAD)" = 1 ]
[ "$(git ls-remote origin refs/heads/main | awk '{print $1}')" = "$INITIAL" ]
[ -z "$(git ls-files -ci --exclude-standard)" ]
printf 'main local et GitHub alignés sur %s : un commit initial, anciens tags retirés, fichiers locaux conservés.\n' "$INITIAL"
