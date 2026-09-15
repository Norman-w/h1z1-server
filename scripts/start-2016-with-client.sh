#!/usr/bin/env bash
# 一键启动：本仓库 2016 服 + 游戏客户端（不依赖 H1EMU 启动器，客户端用 server=localhost:1115 无需打补丁）
# 每次运行前会自动结束已占用的 1115/1117 进程和已运行的 H1Z1 客户端。脚本前台执行，日志直接在本终端看。
# 用法：./scripts/start-2016-with-client.sh
#       自定客户端路径：export H1Z1_EXE="/你的路径/H1Z1.exe" 再执行
#       脚本默认 DISABLE_NAV=1（不加载 nav）；要开 nav 时：DISABLE_NAV=0 ./scripts/start-2016-with-client.sh
#       默认在 x64dbg 下调试启动客户端（dev/x64dbg-bridge：自动 .env、插件、pip）。
#       仅直跑游戏不要调试器：USE_X64DBG=0 ./scripts/start-2016-with-client.sh

set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
SERVER_PID=""
BRIDGE_DIR="$ROOT/dev/x64dbg-bridge"
# bootstrap 成功后写入，供启动 daemon 与 pip 使用（Git Bash 常只有 py -3）
H1_BRIDGE_PYTHON=""
H1_BRIDGE_USE_PY_LAUNCHER=0

# 默认不加载 navmesh，仅直线追人+发包测试（避免 recast 卡死）。需要 nav 时在运行前 unset DISABLE_NAV
export DISABLE_NAV="${DISABLE_NAV:-1}"

# 默认开启动态调试（x64dbg + daemon）；设为 0 则与普通直连启动 H1Z1 一致
USE_X64DBG="${USE_X64DBG:-1}"

# Git Bash：D:/path 若 -e 失败，再试 /d/path（始终 echo 一路径且 return 0，避免 set -e 在赋值时退出）
_h1_msys_fix_path() {
  local p="$1"
  if [[ -e "$p" ]]; then
    echo "$p"
    return 0
  fi
  if [[ "$p" =~ ^[Dd]:[/\\] ]]; then
    # 不用 ${var,,}：部分 Git Bash 的 bash 3.x 会报 “p: 1,,: syntax error”
    local _d="${p:0:1}"
    _d=$(printf '%s' "$_d" | tr '[:upper:]' '[:lower:]')
    local q="/${_d}${p:2}"
    if [[ -e "$q" ]]; then
      echo "$q"
      return 0
    fi
  fi
  echo "$p"
  return 0
}

# 仅 Bash / MSYS 路径变体（不调用 cmd）：统一斜杠、D:/ ↔ /d/
_h1_file_exists() {
  local f="$1"
  [[ -z "$f" ]] && return 1
  local g="${f//\\//}"
  [[ -f "$g" ]] && return 0
  if [[ "$g" =~ ^[Dd]:/(.*) ]]; then
    local rest="${BASH_REMATCH[1]}"
    local dl="${g:0:1}"
    dl=$(printf '%s' "$dl" | tr '[:upper:]' '[:lower:]')
    [[ -f "/${dl}/${rest}" ]] && return 0
  fi
  if [[ "$g" =~ ^/([a-zA-Z])/(.*) ]]; then
    local L="${BASH_REMATCH[1]}"
    local rest="${BASH_REMATCH[2]}"
    L=$(printf '%s' "$L" | tr '[:lower:]' '[:upper:]')
    [[ -f "${L}:/${rest}" ]] && return 0
  fi
  return 1
}

# D:/a/b -> /d/a/b；非盘符路径则输出空
_h1_d_to_msys() {
  local g="${1//\\//}"
  if [[ "$g" =~ ^[Dd]:/(.*) ]]; then
    local dl=$(printf '%s' "${g:0:1}" | tr '[:upper:]' '[:lower:]')
    echo "/${dl}${g:2}"
  fi
}

# /d/a/b -> D:/a/b
_h1_msys_to_d() {
  local g="${1//\\//}"
  if [[ "$g" =~ ^/([a-zA-Z])/(.*) ]]; then
    local L=$(printf '%s' "${BASH_REMATCH[1]}" | tr '[:lower:]' '[:upper:]')
    echo "${L}:/${BASH_REMATCH[2]}"
  fi
}

# plugins 目录的多种写法（Git Bash 下往往只有一种能 -d/-f 成功）
_h1_plugin_path_candidates() {
  local b="${1//\\//}"
  [[ -z "$b" ]] && return 0
  printf '%s\n' "$b"
  local t
  t=$(_h1_d_to_msys "$b")
  [[ -n "$t" && "$t" != "$b" ]] && printf '%s\n' "$t"
  t=$(_h1_msys_to_d "$b")
  [[ -n "$t" && "$t" != "$b" ]] && printf '%s\n' "$t"
}

# 在任一候选路径下同时存在 dp64 与 *zmq*.dll 则成功，stdout 输出实际目录
_h1_find_automate_plugins_dir() {
  local nominal="$1"
  nominal="${nominal//\\//}"
  local c f
  while IFS= read -r c; do
    [[ -z "$c" ]] && continue
    [[ ! -d "$c" ]] && continue
    f="${c}/x64dbg-automate.dp64"
    [[ ! -f "$f" ]] && continue
    shopt -s nullglob
    local z=("$c"/*zmq*.dll)
    shopt -u nullglob
    [[ ${#z[@]} -gt 0 ]] && { echo "$c"; return 0; }
  done < <(_h1_plugin_path_candidates "$nominal")
  return 1
}

# 任一候选路径下存在 ScyllaHide x64 主插件（及 Hook DLL）则成功，stdout 输出实际目录
_h1_find_scyllahide_plugins_dir() {
  local nominal="$1"
  nominal="${nominal//\\//}"
  local c
  while IFS= read -r c; do
    [[ -z "$c" ]] && continue
    [[ ! -d "$c" ]] && continue
    [[ ! -f "${c}/ScyllaHideX64DBGPlugin.dp64" ]] && continue
    [[ ! -f "${c}/HookLibraryx64.dll" ]] && continue
    echo "$c"
    return 0
  done < <(_h1_plugin_path_candidates "$nominal")
  return 1
}

_h1_pick_python_for_bridge() {
  H1_BRIDGE_PYTHON=""
  H1_BRIDGE_USE_PY_LAUNCHER=0
  if command -v python >/dev/null 2>&1; then
    H1_BRIDGE_PYTHON=python
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    H1_BRIDGE_PYTHON=python3
    return 0
  fi
  if command -v py >/dev/null 2>&1; then
    H1_BRIDGE_USE_PY_LAUNCHER=1
    return 0
  fi
  return 1
}

# 将 dev/x64dbg-bridge/.env 导出到当前 shell（供本脚本检查路径；daemon 自己会再读 .env）
# 仅允许 KEY=VAL 行，避免 eval 注入；值用 printf %q 转义
_h1_export_bridge_dotenv() {
  local ef="$BRIDGE_DIR/.env"
  [[ -f "$ef" ]] || return 0
  local line key val
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line// }" ]] && continue
    [[ "$line" != *=* ]] && continue
    key="${line%%=*}"
    val="${line#*=}"
    key="${key//[[:space:]]/}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    if [[ "$val" =~ ^\".*\"$ ]]; then val="${val:1:${#val}-2}"
    elif [[ "$val" =~ ^\'.*\'$ ]]; then val="${val:1:${#val}-2}"; fi
    eval "$(printf 'export %q=%q' "$key" "$val")"
  done <"$ef"
}

_h1_bridge_bootstrap() {
  echo "[start] x64dbg 桥接：检查 dev/x64dbg-bridge …"
  if [[ ! -d "$BRIDGE_DIR" ]]; then
    echo "[start] 未找到 $BRIDGE_DIR，跳过 x64dbg。" >&2
    return 1
  fi
  if [[ ! -f "$BRIDGE_DIR/.env" ]]; then
    if [[ -f "$BRIDGE_DIR/.env.example" ]]; then
      cp "$BRIDGE_DIR/.env.example" "$BRIDGE_DIR/.env"
      echo "[start] 已创建 $BRIDGE_DIR/.env（来自 .env.example），可按需修改路径。"
    else
      echo "[start] 缺少 .env.example，无法创建 .env。" >&2
      return 1
    fi
  fi
  _h1_export_bridge_dotenv

  local xroot="${X64DBG_ROOT:-}"
  if [[ -z "$xroot" ]]; then
    echo "[start] .env 中未设置 X64DBG_ROOT" >&2
    return 1
  fi
  xroot="$(_h1_msys_fix_path "$xroot")"
  export X64DBG_ROOT="$xroot"

  local xexe="${xroot}/release/x64/x64dbg.exe"
  xexe="$(_h1_msys_fix_path "$xexe")"

  if ! _h1_file_exists "$xexe"; then
    echo "[start] 找不到 x64dbg.exe，已尝试: $xexe" >&2
    echo "[start] 请编辑 $BRIDGE_DIR/.env 核对 X64DBG_ROOT（须含 release/x64/x64dbg.exe）。" >&2
    return 1
  fi

  local plugdir_nom="${xroot%/}/release/x64/plugins"
  plugdir_nom="${plugdir_nom//\\//}"
  local _plug_ok=""
  _plug_ok="$(_h1_find_automate_plugins_dir "$plugdir_nom" 2>/dev/null)" || true

  if [[ -z "$_plug_ok" ]]; then
    echo "[start] 未检测到 Automate 插件（已尝试 D: 与 /d/ 路径: $plugdir_nom），正在下载并安装 …"
    chmod +x "$BRIDGE_DIR/install_automate_plugin.sh" 2>/dev/null || true
    X64DBG_ROOT="$xroot" bash "$BRIDGE_DIR/install_automate_plugin.sh" || {
      echo "[start] 插件安装失败（需 curl、unzip）。可手动运行: bash dev/x64dbg-bridge/install_automate_plugin.sh" >&2
      return 1
    }
    _plug_ok="$(_h1_find_automate_plugins_dir "$plugdir_nom" 2>/dev/null)" || true
    if [[ -z "$_plug_ok" ]]; then
      echo "[start] 安装后仍检测不到插件。请核对 X64DBG_ROOT。尝试列出各候选目录：" >&2
      local _c
      while IFS= read -r _c; do
        echo "--- $_c ---" >&2
        ls -la "$_c" 2>&1 >&2 || echo "(无法访问)" >&2
      done < <(_h1_plugin_path_candidates "$plugdir_nom")
      return 1
    fi
    echo "[start] Automate 插件已就绪: $_plug_ok"
  else
    echo "[start] 已检测到 Automate 插件: $_plug_ok"
  fi

  local _shy_ok=""
  _shy_ok="$(_h1_find_scyllahide_plugins_dir "$plugdir_nom" 2>/dev/null)" || true
  if [[ -z "$_shy_ok" ]]; then
    echo "[start] 未检测到 ScyllaHide，正在下载并安装（反反调试，失败不阻断）…"
    chmod +x "$BRIDGE_DIR/install_scyllahide_plugin.sh" 2>/dev/null || true
    X64DBG_ROOT="$xroot" bash "$BRIDGE_DIR/install_scyllahide_plugin.sh" || {
      echo "[start] WARN: ScyllaHide 未安装成功，可手动: bash dev/x64dbg-bridge/install_scyllahide_plugin.sh" >&2
    }
    _shy_ok="$(_h1_find_scyllahide_plugins_dir "$plugdir_nom" 2>/dev/null)" || true
    if [[ -n "$_shy_ok" ]]; then
      echo "[start] ScyllaHide 已就绪: $_shy_ok"
    fi
  else
    echo "[start] 已检测到 ScyllaHide: $_shy_ok"
  fi

  if ! _h1_pick_python_for_bridge; then
    echo "[start] 未找到 python / python3 / py，无法安装 x64dbg_automate（Windows 可安装 Python 或确保 py 在 PATH）。" >&2
    return 1
  fi
  echo "[start] pip 安装/更新 dev/x64dbg-bridge 依赖 …"
  if [[ "$H1_BRIDGE_USE_PY_LAUNCHER" == "1" ]]; then
    py -3 -m pip install -q -r "$BRIDGE_DIR/requirements.txt" || {
      echo "[start] pip install 失败，请手动: py -3 -m pip install -r $BRIDGE_DIR/requirements.txt" >&2
      return 1
    }
  else
    "$H1_BRIDGE_PYTHON" -m pip install -q -r "$BRIDGE_DIR/requirements.txt" || {
      echo "[start] pip install 失败，请手动: $H1_BRIDGE_PYTHON -m pip install -r $BRIDGE_DIR/requirements.txt" >&2
      return 1
    }
  fi
  echo "[start] x64dbg 桥接就绪（USE_X64DBG=1，将用 x64dbg 启动客户端）。"
  return 0
}

# 游戏客户端 exe：未设置时用默认路径（与 .env.example 一致；bridge .env 会覆盖 export）
if [ -z "$H1Z1_EXE" ]; then
  H1Z1_EXE="D:/WindowsOnly/Games/H1EMU_Client/H1Z1.exe"
fi

if [ "$USE_X64DBG" = "1" ]; then
  if ! _h1_bridge_bootstrap; then
    echo "[start] x64dbg 环境未就绪，改用普通方式启动客户端（无调试器）。需要调试时请修复上述错误后重试。" >&2
    USE_X64DBG=0
  fi
fi

# ---------- 自动干掉已存在的服务端（node）和客户端（H1Z1.exe） ----------
echo "[start] 检查并结束已存在的服务端与客户端..."
_do_kill() {
  local name=$1
  if command -v taskkill >/dev/null 2>&1; then
    taskkill //F //IM "$name" 2>/dev/null && echo "[start] 已结束: $name" || true
  elif [[ -x /c/Windows/System32/taskkill.exe ]]; then
    /c/Windows/System32/taskkill.exe //F //IM "$name" 2>/dev/null && echo "[start] 已结束: $name" || true
  elif [[ -x /c/WINDOWS/System32/taskkill.exe ]]; then
    /c/WINDOWS/System32/taskkill.exe //F //IM "$name" 2>/dev/null && echo "[start] 已结束: $name" || true
  fi
}
_do_kill "node.exe"
_do_kill "H1Z1.exe"
if [ "$USE_X64DBG" = "1" ]; then
  _do_kill "x64dbg.exe"
fi
sleep 1
echo ""

echo "[start] 仓库根目录: $ROOT"
echo "[start] 编译并启动 2016 服（Login 1115 + Zone 1117），前台运行，日志在下方向下滚动..."
npm run build
node --no-warnings --experimental-require-module ./scripts/h1z1-server-demo-2016.js &
SERVER_PID=$!
echo "[start] 服务器已启动 PID=$SERVER_PID，等待就绪后将启动客户端..."
sleep 4

if [ "$USE_X64DBG" = "1" ]; then
  echo "[start] 动态调试：dev/x64dbg-bridge/daemon.py（x64dbg 下启动 H1Z1，后台）。"
  echo "[start] HTTP: http://${H1_X64DBG_DAEMON_HOST:-127.0.0.1}:${H1_X64DBG_DAEMON_PORT:-18765}/v1/health"
  if [[ "$H1_BRIDGE_USE_PY_LAUNCHER" == "1" ]]; then
    echo "[start] Python: py -3（Git Bash 无 python 命令时常见）"
    ( cd "$ROOT/dev/x64dbg-bridge" && py -3 daemon.py ) &
  else
    echo "[start] Python: $H1_BRIDGE_PYTHON"
    ( cd "$ROOT/dev/x64dbg-bridge" && "$H1_BRIDGE_PYTHON" daemon.py ) &
  fi
  DAEMON_PID=$!
  echo "[start] daemon PID=$DAEMON_PID；日志 dev/x64dbg-bridge/logs/。CLI: ${H1_BRIDGE_PYTHON:-py -3} dev/x64dbg-bridge/cli.py health"
  sleep 2
  if command -v curl >/dev/null 2>&1; then
    _hp="http://${H1_X64DBG_DAEMON_HOST:-127.0.0.1}:${H1_X64DBG_DAEMON_PORT:-18765}/v1/health"
    _hc=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 2 --max-time 3 "$_hp" || echo "000")
    if [[ "$_hc" != "200" && "$_hc" != "503" ]]; then
      echo "[start] WARN: daemon HTTP 无响应 (http_code=$_hc)。请另开终端查看: cd dev/x64dbg-bridge && py -3 daemon.py 或 python daemon.py" >&2
    else
      echo "[start] daemon HTTP 正常 (http_code=$_hc；503=仍在连接 x64dbg 属正常)。"
    fi
  fi
  echo "[start] 下方为服务端日志，Ctrl+C 可停服。"
elif [ -n "$H1Z1_EXE" ] && [ -f "$H1Z1_EXE" ]; then
  H1Z1_DIR="$(dirname "$H1Z1_EXE")"
  echo "[start] 启动客户端: $H1Z1_EXE sessionid=0 server=localhost:1115 (cwd=$H1Z1_DIR)"
  ( cd "$H1Z1_DIR" && "$H1Z1_EXE" sessionid=0 server=localhost:1115 ) &
  echo "[start] 客户端已启动。下方为服务端日志，Ctrl+C 可停服。"
else
  [ -n "$H1Z1_EXE" ] && echo "[start] 未找到客户端: $H1Z1_EXE"
  echo "[start] 手动进游戏请在游戏目录执行: H1Z1.exe sessionid=0 server=localhost:1115"
fi
echo "[start] 登录 1115，Zone 1117。"
wait $SERVER_PID 2>/dev/null || true
