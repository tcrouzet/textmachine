#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
current_date=$(date +"%Y-%m-%d %H:%M:%S")
git add .
git commit -m "sync $current_date"
git push -u origin main
