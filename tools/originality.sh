#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

paths=(js ./*.html full en)
for dir in assets/lp tests; do
  if [ -d "$dir" ]; then paths+=("$dir"); fi
done

if grep -rniF -f tools/originality.txt \
  --exclude=kit.mjs \
  "${paths[@]}"; then
  exit 1
else
  status=$?
  if [ "$status" -ne 1 ]; then
    exit "$status"
  fi
fi

echo "OK originality: 0 hits"
