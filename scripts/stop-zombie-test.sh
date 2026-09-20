#!/usr/bin/env bash
set -euo pipefail

SCRIPT_REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
export ZTEST_REPO="${ZTEST_REPO:-$SCRIPT_REPO}"

# Prefer a native Windows interpreter when Git Bash is backed by WSL.  This
# keeps process identity checks consistent with the Windows Node child and
# lets the script use psutil when it is installed in the native environment.
if [[ -x "/c/Python312/python.exe" ]]; then
    PYTHON_BIN="/c/Python312/python.exe"
elif [[ -x "/mnt/c/Python312/python.exe" ]]; then
    PYTHON_BIN="/mnt/c/Python312/python.exe"
elif command -v python >/dev/null 2>&1; then
    PYTHON_BIN="$(command -v python)"
elif command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="$(command -v python3)"
elif command -v py >/dev/null 2>&1; then
    PYTHON_BIN="$(command -v py)"
else
    echo "Python 3 is required (python, C:/Python312/python.exe or py.exe)." >&2
    exit 1
fi

"$PYTHON_BIN" - <<'PY'
import os
import pathlib
import shutil
import sys
import time

root = pathlib.Path(os.environ.get("ZTEST_REPO") or pathlib.Path.cwd()).resolve()
configured_node = os.environ.get("ZTEST_NODE")
if configured_node:
    node = pathlib.Path(configured_node).resolve()
elif os.name == "nt":
    node = pathlib.Path(r"C:\Program Files\nodejs\node.exe").resolve()
else:
    node_name = shutil.which("node")
    node = pathlib.Path(node_name).resolve() if node_name else pathlib.Path()
expected = [str(node), "--no-warnings", "--experimental-require-module", "scripts/h1z1-server-demo-2016.js"]

def proc_rows():
    try:
        import psutil
        for proc in psutil.process_iter(["pid", "exe", "cwd", "cmdline"]):
            try:
                info = proc.info
                yield (proc, info.get("pid"), info.get("exe") or "", info.get("cwd") or "", info.get("cmdline") or [])
            except (psutil.NoSuchProcess, psutil.AccessDenied, FileNotFoundError):
                continue
        return
    except ImportError:
        pass
    proc_root = pathlib.Path("/proc")
    if not proc_root.is_dir():
        raise SystemExit("psutil is required for safe process identity checks; /proc is unavailable.")
    for pid_dir in proc_root.iterdir():
        if not pid_dir.name.isdigit():
            continue
        try:
            pid = int(pid_dir.name)
            exe = os.readlink(pid_dir / "exe")
            cwd = os.readlink(pid_dir / "cwd")
            raw = (pid_dir / "cmdline").read_bytes()
            argv = [part.decode(errors="replace") for part in raw.split(b"\0") if part]
            yield (None, pid, exe, cwd, argv)
        except (OSError, ValueError):
            continue

def same_path(value, target):
    try:
        return pathlib.Path(value).resolve() == target
    except (OSError, ValueError):
        return False

matches = []
for proc, pid, exe, cwd, cmdline in proc_rows():
    if same_path(exe, node) and same_path(cwd, root) and cmdline == expected:
        matches.append((proc, pid))

if not matches:
    print("No exact demo server process found.")
    sys.exit(0)

for proc, pid in matches:
    print(f"Stopping exact demo server PID {pid}.")
    if proc is not None:
        proc.terminate()
    else:
        os.kill(pid, 15)

def live_pids():
    return {pid for _, pid, exe, cwd, cmdline in proc_rows() if same_path(exe, node) and same_path(cwd, root) and cmdline == expected}

deadline = time.monotonic() + 8
while live_pids() and time.monotonic() < deadline:
    time.sleep(0.1)
alive = live_pids()
if alive:
    for proc, pid in matches:
        if pid in alive:
            print(f"Demo server PID {pid} did not exit; terminating verified PID.")
            try:
                if proc is not None:
                    proc.kill()
                else:
                    os.kill(pid, 9)
            except (OSError, ProcessLookupError):
                pass
    deadline = time.monotonic() + 3
    while live_pids() and time.monotonic() < deadline:
        time.sleep(0.1)

time.sleep(0.25)
remaining = sorted(live_pids())

if remaining:
    print("ERROR: verified demo PID still present:", remaining)
    sys.exit(1)
print("Demo server stopped; port 13371 should now be released.")
PY
