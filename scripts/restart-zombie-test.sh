#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$REPO_ROOT"

# Process inspection/ownership and restart are kept in Python because Git Bash
# does not expose a reliable Windows process command-line/environment API.
# No shell is used for the child server; its inherited environment is retained
# in memory and stdout/stderr go to a fresh temp directory.
#
# Do not assume one machine-wide Python installation.  The start/stop helpers
# already probe the active Git-Bash PATH first; restart must use the same
# resolver or a perfectly healthy server cannot be refreshed on machines where
# C:/Python312 is absent.
# Prefer the native Windows runtime when this script is invoked from WSL-backed
# Git Bash.  The restart path needs psutil to inspect/terminate the Windows
# Node process; WSL's `/usr/bin/python3` is otherwise found first and usually
# does not have that module installed.
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
    echo "Python 3 is required (python, python3, py.exe or C:/Python312/python.exe)." >&2
    exit 1
fi

"$PYTHON_BIN" - "$@" <<'PY'
import json
import os
import pathlib
import psutil
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

repo = pathlib.Path.cwd().resolve()
node = pathlib.Path(r"C:\Program Files\nodejs\node.exe").resolve()
entry = "scripts/h1z1-server-demo-2016.js"
compiled = repo / "out" / "servers" / "ZoneServer2016" / "zoneserver.js"

def fail(message):
    raise SystemExit(message)

def normalize(path):
    return pathlib.Path(str(path)).resolve()

def normalize_node_args(args):
    """Canonicalize the launcher spelling of the first Node argv token."""
    if not args:
        return []
    first = str(args[0])
    # `cmd.exe /c node ...` reports `node` while direct CreateProcess reports
    # the full executable path.  The executable/cwd checks still bind the
    # process to this repository; canonicalizing this token only makes those
    # two legitimate launch forms equivalent.
    if pathlib.Path(first).name.lower() in {"node", "node.exe"}:
        first = str(node)
    else:
        first = str(normalize(first))
    return [first] + list(args[1:])

def find_servers():
    result = []
    for process in psutil.process_iter(["pid", "exe", "cwd", "cmdline"]):
        try:
            # A Windows launcher often leaves a `cmd.exe /c node ...` wrapper
            # beside the actual Node process.  Matching the entry-point text
            # alone therefore finds two processes and makes a safe restart
            # abort even though the demo server is uniquely identifiable.
            # Restrict discovery to the exact executable, cwd and argv that
            # the replacement below will use; the later identity check remains
            # as a second guard before termination.
            actual_exe = normalize(process.info.get("exe") or "")
            actual_cwd = normalize(process.info.get("cwd") or "")
            cmdline = process.info.get("cmdline") or []
            normalized_args = normalize_node_args(cmdline)
            if actual_exe == node and actual_cwd == repo and normalized_args == [
                str(node),
                "--no-warnings",
                "--experimental-require-module",
                entry,
            ]:
                result.append(process)
        except (psutil.NoSuchProcess, psutil.AccessDenied, FileNotFoundError):
            continue
    return result

servers = find_servers()
if len(sys.argv) > 1:
    try:
        target_pid = int(sys.argv[1])
    except ValueError:
        fail("PID must be an integer; nothing was stopped.")
    servers = [process for process in servers if process.pid == target_pid]
if len(servers) != 1:
    fail(f"Expected exactly one identified demo server, found {len(servers)}; nothing was stopped.")

server = servers[0]
try:
    actual_exe = normalize(server.exe())
    actual_cwd = normalize(server.cwd())
    actual_args = server.cmdline()
    # Windows reports the executable in the command line with either slash
    # style depending on which launcher created the process. Normalize only
    # that first executable token; keep the startup flags and entry point
    # exact so an unrelated node process can never be replaced.
    normalized_args = normalize_node_args(actual_args)
    if actual_exe != node or actual_cwd != repo or normalized_args != [
        str(node), "--no-warnings", "--experimental-require-module", entry
    ]:
        fail("Process identity or startup arguments changed; nothing was stopped.")
    if not compiled.is_file():
        fail("Compiled ZoneServer2016 output is missing; nothing was stopped.")
    environment = server.environ()
except (psutil.NoSuchProcess, psutil.AccessDenied, FileNotFoundError) as error:
    fail(f"Cannot inspect the identified server safely ({error}); nothing was stopped.")

port = int(environment.get("DEV_HTTP_PORT", "13371"))
clients_url = f"http://127.0.0.1:{port}/api/clients"
try:
    with urllib.request.urlopen(clients_url, timeout=5) as response:
        payload = json.loads(response.read().decode("utf-8"))
    clients = payload.get("clients")
    if not isinstance(clients, list) or clients:
        fail("Players are connected or client status is unknown; nothing was stopped.")
except (OSError, ValueError, urllib.error.URLError) as error:
    fail(f"Cannot verify an empty local client list ({error}); nothing was stopped.")

log_dir = pathlib.Path(tempfile.mkdtemp(prefix="h1z1-manual-reload-"))
stdout_path = log_dir / "stdout.log"
stderr_path = log_dir / "stderr.log"
print(f"Restarting demo server PID {server.pid}. Logs: {log_dir}")
server.terminate()
try:
    server.wait(timeout=10)
except psutil.TimeoutExpired:
    fail("Original server did not exit within 10 seconds; replacement was not started.")

stdout = stdout_path.open("wb")
stderr = stderr_path.open("wb")
try:
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    replacement = subprocess.Popen(
        [str(node), "--no-warnings", "--experimental-require-module", entry],
        cwd=str(repo), env=environment, stdout=stdout, stderr=stderr,
        stdin=subprocess.DEVNULL, shell=False, creationflags=creationflags,
    )
finally:
    stdout.close()
    stderr.close()
print(f"New server PID: {replacement.pid}")

deadline = time.monotonic() + 30
while time.monotonic() < deadline:
    if replacement.poll() is not None:
        fail(f"New server exited before readiness; inspect logs in {log_dir}")
    try:
        with urllib.request.urlopen(clients_url, timeout=1) as response:
            payload = json.loads(response.read().decode("utf-8"))
        if isinstance(payload.get("clients"), list):
            print("READY: server API is responding. Re-enter the game now.")
            raise SystemExit(0)
    except (OSError, ValueError, urllib.error.URLError):
        time.sleep(1)
fail(f"Server started but readiness is unconfirmed; inspect logs in {log_dir}")
PY
