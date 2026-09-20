#!/usr/bin/env bash
set -euo pipefail

# The Codex Git Bash connector can expose a WSL bash rather than native
# msysgit.  Keep the repository path explicit so the same script works in
# native Git Bash, WSL, and PowerShell-launched bash.
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
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

repo = pathlib.Path(os.environ.get("ZTEST_REPO") or pathlib.Path.cwd()).resolve()
configured_node = os.environ.get("ZTEST_NODE")
if configured_node:
    node = pathlib.Path(configured_node).resolve()
elif os.name == "nt":
    node = pathlib.Path(r"C:\Program Files\nodejs\node.exe").resolve()
else:
    node_name = shutil.which("node")
    node = pathlib.Path(node_name).resolve() if node_name else pathlib.Path()
entry = "scripts/h1z1-server-demo-2016.js"
entry_path = repo / entry
api_url = "http://127.0.0.1:13371/api/clients"
child = None

def fail(message):
    global child
    if child is not None and child.poll() is None:
        # Never leave a half-started server behind after a failed readiness
        # check; the next run must be able to trust the port/identity guard.
        child.terminate()
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=3)
    raise SystemExit(message)

if not node.is_file() or not entry_path.is_file():
    fail("Required Node or server entry is missing; nothing was started.")
if not (repo / "out/servers/ZoneServer2016/zoneserver.js").is_file():
    fail("Compiled ZoneServer2016 output is missing; nothing was started.")
if os.environ.get("MONGO_URL", ""):
    fail("MONGO_URL is nonempty; refusing database-connected startup.")

native_capture = os.environ.get("ZTEST_NATIVE_CAPTURE", "0")
if native_capture not in {"0", "1"}:
    fail("ZTEST_NATIVE_CAPTURE must be 0 or 1; nothing was started.")
if native_capture == "1" and not (repo / "tools/task-01a06a01/capture_ztest_scenario.py").is_file():
    fail("ZTEST_NATIVE_CAPTURE=1 requires the capture_ztest_scenario.py worker; nothing was started.")

expected = [str(node), "--no-warnings", "--experimental-require-module", entry]

def proc_rows():
    """Yield (pid, exe, cwd, argv) without requiring psutil on WSL."""
    try:
        import psutil
        for proc in psutil.process_iter(["pid", "exe", "cwd", "cmdline"]):
            try:
                info = proc.info
                yield (info["pid"], info.get("exe") or "", info.get("cwd") or "", info.get("cmdline") or [])
            except (psutil.NoSuchProcess, psutil.AccessDenied, FileNotFoundError):
                continue
        return
    except ImportError:
        pass
    proc_root = pathlib.Path("/proc")
    if not proc_root.is_dir():
        fail("psutil is required for safe process identity checks; /proc is unavailable.")
    for pid_dir in proc_root.iterdir():
        if not pid_dir.name.isdigit():
            continue
        try:
            pid = int(pid_dir.name)
            exe = os.readlink(pid_dir / "exe")
            cwd = os.readlink(pid_dir / "cwd")
            raw = (pid_dir / "cmdline").read_bytes()
            argv = [part.decode(errors="replace") for part in raw.split(b"\0") if part]
            yield (pid, exe, cwd, argv)
        except (OSError, ValueError):
            continue

def same_path(value, target):
    try:
        return pathlib.Path(value).resolve() == target
    except (OSError, ValueError):
        return False

existing = []
for pid, exe, cwd, argv in proc_rows():
    if same_path(exe, node) and same_path(cwd, repo) and argv == expected:
        existing.append(pid)
if existing:
    fail(f"Demo server already exists (PID {existing[0]}); nothing was started.")

def port_free(kind, port):
    family = socket.AF_INET
    socktype = socket.SOCK_STREAM if kind == "tcp" else socket.SOCK_DGRAM
    sock = socket.socket(family, socktype)
    try:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        sock.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        sock.close()

for kind, port in (("udp", 1115), ("udp", 1117), ("tcp", 13371)):
    if not port_free(kind, port):
        fail(f"Required port {port} is occupied; nothing was started.")

log_dir = pathlib.Path(tempfile.mkdtemp(prefix="h1z1-manual-start-"))
env = os.environ.copy()
env.update({
    "DEBUG": "LoginServer",
    "DEV_HTTP_PORT": "13371",
    "DISABLE_NAV": "1",
    "TEST_ZOMBIE_NO_AI": "false",
    "WORLD_ID": "2",
    "CONFIG_PATH": str(repo / "config.yaml"),
    "ZTEST_RECORDING": "1",
    "ZTEST_NATIVE_CAPTURE": native_capture,
})
stdout = open(log_dir / "stdout.log", "w", encoding="utf-8", buffering=1)
stderr = open(log_dir / "stderr.log", "w", encoding="utf-8", buffering=1)
popen_options = dict(
    cwd=str(repo),
    env=env,
    stdin=subprocess.DEVNULL,
    stdout=stdout,
    stderr=stderr,
    close_fds=True,
)
if os.name == "nt":
    popen_options["creationflags"] = (
        getattr(subprocess, "CREATE_NO_WINDOW", 0)
        | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    )
else:
    # WSL/bash tears down children that remain in its process group when the
    # command wrapper exits.  Detach the demo server into its own session so
    # the readiness command has the same lifetime as native Windows startup.
    popen_options["start_new_session"] = True
try:
    child = subprocess.Popen(
        expected,
        **popen_options,
    )
finally:
    stdout.close()
    stderr.close()

print(f"New server PID: {child.pid}")
print(f"Logs: {log_dir}")
ready_timeout = max(30.0, float(os.environ.get("ZTEST_READY_TIMEOUT", "90")))
deadline = time.monotonic() + ready_timeout
ready = False
while time.monotonic() < deadline:
    if child.poll() is not None:
        fail(f"The new server exited before readiness (PID {child.pid}); inspect logs in {log_dir}.")
    try:
        with urllib.request.urlopen(api_url, timeout=1) as response:
            payload = json.loads(response.read().decode("utf-8"))
            ready = isinstance(payload.get("clients"), list)
    except Exception:
        ready = False
    if ready:
        print("READY: server API is responding on 13371. Re-enter the game now.")
        sys.exit(0)
    time.sleep(0.25)
fail(f"Readiness was not confirmed within {ready_timeout:g} seconds; inspect logs in {log_dir}.")
PY
