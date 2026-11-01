#!/usr/bin/env bash
# 跑全部隔离测试（不联网、不碰真实微信账号/状态；临时 HOME）
set -uo pipefail
cd "$(dirname "$0")"
bash ./build.sh || exit 1
fail=0
for f in suite-*.mjs; do
  echo "════ $f"
  node "$f" || fail=1
done
[ "$fail" -eq 0 ] && echo "✅ ALL SUITES PASSED" || echo "❌ SOME SUITES FAILED"
exit $fail
