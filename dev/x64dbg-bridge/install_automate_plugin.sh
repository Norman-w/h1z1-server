#!/usr/bin/env bash
# Git Bash / MSYS 下安装 x64dbg Automate 插件（无需 PowerShell）
# 依赖: curl, unzip
# 用法:
#   export X64DBG_ROOT="D:/WindowsOnly/Software/snapshot_2025-08-19_19-40"
#   ./install_automate_plugin.sh
#   或: ./install_automate_plugin.sh "D:/path/to/snapshot_..."

set -euo pipefail

RELEASE_TAG="v0.6.1-green_pepe"
ZIP_NAME="release64-0.6.1-green_pepe.zip"
URL="https://github.com/dariushoule/x64dbg-automate/releases/download/${RELEASE_TAG}/${ZIP_NAME}"

ROOT="${1:-${X64DBG_ROOT:-}}"
if [[ -z "$ROOT" ]]; then
  echo "请设置环境变量 X64DBG_ROOT 或传入参数: 指向 x64dbg snapshot 根目录" >&2
  exit 1
fi

X64EXE="${ROOT}/release/x64/x64dbg.exe"
PLUGDIR="${ROOT}/release/x64/plugins"
if [[ ! -f "$X64EXE" ]]; then
  echo "未找到 x64dbg.exe: $X64EXE" >&2
  exit 1
fi

mkdir -p "$PLUGDIR"
TMP="${TMPDIR:-/tmp}/h1-x64-auto-$$"
mkdir -p "$TMP"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

echo "[install_automate_plugin] 下载 $URL"
curl -fL --connect-timeout 30 --max-time 600 --retry 3 --retry-delay 2 -o "$TMP/$ZIP_NAME" "$URL"

mkdir -p "$TMP/extract"
# Git Bash / MSYS：官方 zip 内为 Release\*.dll，unzip 会警告 “backslashes…” 并以退出码 1 结束；
# 在 set -e 下会导致脚本在此处中止、从未执行 cp，plugins 目录一直为空。
set +e
unzip -o -q "$TMP/$ZIP_NAME" -d "$TMP/extract"
_uz=$?
set -e

REL=""
if [[ -d "$TMP/extract/Release" ]]; then
  REL="$TMP/extract/Release"
elif [[ -d "$TMP/extract/release" ]]; then
  REL="$TMP/extract/release"
else
  echo "[install_automate_plugin] ZIP 内未找到 Release 目录（unzip 退出码: $_uz）" >&2
  exit 1
fi

cp -f "$REL"/* "$PLUGDIR"/
echo "[install_automate_plugin] 已复制到: $PLUGDIR"
echo "[install_automate_plugin] 请确认: $PLUGDIR/x64dbg-automate.dp64"
