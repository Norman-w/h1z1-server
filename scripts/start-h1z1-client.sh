#!/usr/bin/env bash
set -euo pipefail

python - <<'PY'
import pathlib
import subprocess
import sys
import time

exe = pathlib.Path(r"D:\WindowsOnly\Games\H1EMU_Client\H1Z1.exe").resolve()
cwd = exe.parent
cmd = [str(exe), "sessionid=0", "server=localhost:1115"]
if not exe.is_file():
    raise SystemExit(f"H1Z1 client executable is missing: {exe}")

try:
    import psutil
except ImportError:
    raise SystemExit("psutil is required for safe client identity checks.")

for proc in psutil.process_iter(["pid", "name", "exe", "cwd", "cmdline"]):
    try:
        info = proc.info
        if (info.get("name", "").lower() == "h1z1.exe" and
                pathlib.Path(info.get("exe") or "").resolve() == exe and
                pathlib.Path(info.get("cwd") or "").resolve() == cwd and
                (info.get("cmdline") or []) == cmd):
            print(f"H1Z1 client already running: PID {info['pid']}")
            sys.exit(0)
    except (psutil.NoSuchProcess, psutil.AccessDenied, FileNotFoundError):
        continue

flags = getattr(subprocess, "DETACHED_PROCESS", 0x00000008) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
child = subprocess.Popen(
    cmd,
    cwd=str(cwd),
    stdin=subprocess.DEVNULL,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
    creationflags=flags,
    close_fds=True,
)
time.sleep(1.0)
if child.poll() is not None:
    raise SystemExit(f"H1Z1 client exited immediately with code {child.returncode}.")
print(f"H1Z1 client started: PID {child.pid}")
print("Arguments: sessionid=0 server=localhost:1115")
PY
