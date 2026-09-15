#!/usr/bin/env bash
set -euo pipefail

python - <<'PY'
import json
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

repo = pathlib.Path(r"C:\Users\WS\CursorProjects\h1z1-server").resolve()
node = pathlib.Path(r"C:\Program Files\nodejs\node.exe").resolve()
entry = "scripts/h1z1-server-demo-2016.js"
entry_path = repo / entry
api_url = "http://127.0.0.1:13371/api/clients"

def fail(message):
    raise SystemExit(message)

if not node.is_file() or not entry_path.is_file():
    fail("Required Node or server entry is missing; nothing was started.")
if not (repo / "out/servers/ZoneServer2016/zoneserver.js").is_file():
    fail("Compiled ZoneServer2016 output is missing; nothing was started.")
if os.environ.get("MONGO_URL", ""):
    fail("MONGO_URL is nonempty; refusing database-connected startup.")

expected = [str(node), "--no-warnings", "--experimental-require-module", entry]
existing = []
try:
    import psutil
    for proc in psutil.process_iter(["pid", "exe", "cwd", "cmdline"]):
        try:
            info = proc.info
            if (pathlib.Path(info.get("exe") or "").resolve() == node and
                    pathlib.Path(info.get("cwd") or "").resolve() == repo and
                    (info.get("cmdline") or []) == expected):
                existing.append(proc.pid)
        except (psutil.NoSuchProcess, psutil.AccessDenied, FileNotFoundError):
            pass
except ImportError:
    fail("psutil is required for safe process identity checks; nothing was started.")
if existing:
    fail(f"Demo server already exists (PID {existing[0]}); nothing was started.")

def port_free(kind, port):
    family = socket.AF_INET
    socktype = socket.SOCK_STREAM if kind == "tcp" else socket.SOCK_DGRAM
    sock = socket.socket(family, socktype)
    try:
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
    "ZTEST_NATIVE_CAPTURE": "1",
})
stdout = open(log_dir / "stdout.log", "w", encoding="utf-8", buffering=1)
stderr = open(log_dir / "stderr.log", "w", encoding="utf-8", buffering=1)
flags = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
try:
    child = subprocess.Popen(
        expected,
        cwd=str(repo),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=stdout,
        stderr=stderr,
        creationflags=flags,
        close_fds=True,
    )
finally:
    stdout.close()
    stderr.close()

print(f"New server PID: {child.pid}")
print(f"Logs: {log_dir}")
deadline = time.monotonic() + 30
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
fail(f"Readiness was not confirmed within 30 seconds; inspect logs in {log_dir}.")
PY
