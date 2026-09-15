#!/usr/bin/env bash
# 将 ScyllaHide x64dbg 插件安装到 snapshot 的 release/x64/plugins（反反调试，配合 daemon 的 hide / ud2 摘掉）
# 依赖: curl, unzip
# 用法: X64DBG_ROOT="D:/path/to/snapshot" ./install_scyllahide_plugin.sh

set -euo pipefail

RELEASE_TAG="v1.4"
ZIP_NAME="ScyllaHide_2023-03-24_13-03.zip"
URL="https://github.com/x64dbg/ScyllaHide/releases/download/${RELEASE_TAG}/${ZIP_NAME}"

ROOT="${1:-${X64DBG_ROOT:-}}"
if [[ -z "$ROOT" ]]; then
  echo "请设置 X64DBG_ROOT 或传入 snapshot 根目录" >&2
  exit 1
fi

X64EXE="${ROOT}/release/x64/x64dbg.exe"
PLUGDIR="${ROOT}/release/x64/plugins"
if [[ ! -f "$X64EXE" ]]; then
  echo "未找到 x64dbg.exe: $X64EXE" >&2
  exit 1
fi

mkdir -p "$PLUGDIR"
TMP="${TMPDIR:-/tmp}/h1-scyllahide-$$"
mkdir -p "$TMP"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

echo "[install_scyllahide] 下载 $URL"
curl -fL --connect-timeout 30 --max-time 600 --retry 3 --retry-delay 2 -o "$TMP/$ZIP_NAME" "$URL"

mkdir -p "$TMP/extract"
set +e
unzip -o -q "$TMP/$ZIP_NAME" -d "$TMP/extract"
_uz=$?
set -e

SRC="$TMP/extract/x64dbg/x64/plugins"
if [[ ! -f "$SRC/ScyllaHideX64DBGPlugin.dp64" ]]; then
  echo "[install_scyllahide] ZIP 内未找到 x64dbg/x64/plugins（unzip 退出码: $_uz）" >&2
  exit 1
fi

cp -f "$SRC"/* "$PLUGDIR"/
echo "[install_scyllahide] 已复制到: $PLUGDIR"
echo "[install_scyllahide] 请确认: $PLUGDIR/ScyllaHideX64DBGPlugin.dp64"
