#!/usr/bin/env bash
set -euo pipefail

python - <<'PY'
import pathlib
import psutil
import sys
import time

root = pathlib.Path(r"C:\Users\WS\CursorProjects\h1z1-server").resolve()
matches = []
for proc in psutil.process_iter(["pid", "name", "exe", "cwd", "cmdline"]):
    try:
        info = proc.info
        exe = pathlib.Path(info.get("exe") or "").resolve()
        cwd = pathlib.Path(info.get("cwd") or "").resolve()
        cmdline = info.get("cmdline") or []
        if (info.get("name", "").lower() == "node.exe" and
                exe == pathlib.Path(r"C:\Program Files\nodejs\node.exe").resolve() and
                cwd == root and
                cmdline == [
                    r"C:\Program Files\nodejs\node.exe",
                    "--no-warnings",
                    "--experimental-require-module",
                    "scripts/h1z1-server-demo-2016.js",
                ]):
            matches.append(proc)
    except (psutil.NoSuchProcess, psutil.AccessDenied, FileNotFoundError):
        continue

if not matches:
    print("No exact demo server process found.")
    sys.exit(0)

for proc in matches:
    print(f"Stopping exact demo server PID {proc.pid}.")
    proc.terminate()

gone, alive = psutil.wait_procs(matches, timeout=8)
if alive:
    # Escalate only for the already identity-verified demo PID(s).
    for proc in alive:
        print(f"Demo server PID {proc.pid} did not exit; terminating verified PID.")
        proc.kill()
    psutil.wait_procs(alive, timeout=3)

time.sleep(0.25)
remaining = []
for proc in psutil.process_iter(["pid", "name", "exe", "cwd", "cmdline"]):
    try:
        info = proc.info
        if info.get("pid") in {p.pid for p in matches}:
            remaining.append(info["pid"])
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        pass

if remaining:
    print("ERROR: verified demo PID still present:", remaining)
    sys.exit(1)
print("Demo server stopped; port 13371 should now be released.")
PY
