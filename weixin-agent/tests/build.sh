#!/usr/bin/env bash
# 生成可被 node 直接运行的测试 bundle：
#   - 把 @earendil-works/* 与 qrcode 替换成本地 stub（不依赖 pi 运行时/网络）
#   - 追加内部函数导出，便于断言
set -euo pipefail
cd "$(dirname "$0")"

ESBUILD="${ESBUILD:-/usr/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/.bin/esbuild}"
[ -x "$ESBUILD" ] || { echo "找不到 esbuild: $ESBUILD（用 ESBUILD=... 指定）" >&2; exit 1; }

WORK="$(mktemp -d)"
cp ../index.ts ../ilink.ts ../sysinfo.ts "$WORK/"
printf '\nexport { wxLog, pushStats };\n' >> "$WORK/index.ts"

"$ESBUILD" "$WORK/index.ts" --bundle --platform=node --format=esm \
  --alias:@earendil-works/pi-coding-agent="$PWD/stubs/pi.mjs" \
  --alias:@earendil-works/pi-tui="$PWD/stubs/tui.mjs" \
  --alias:qrcode="$PWD/stubs/qrcode.mjs" \
  --outfile="$PWD/bundle.mjs" >/dev/null

rm -rf "$WORK"
echo "built tests/bundle.mjs"
