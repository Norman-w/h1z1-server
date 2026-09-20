#!/usr/bin/env bash
set -euo pipefail

python - <<'PY'
import pathlib
import psutil
import sys

expected_exe = pathlib.Path(r"D:\WindowsOnly\Games\H1EMU_Client\H1Z1.exe").resolve()
expected_cwd = expected_exe.parent
expected_cmdline = [
    str(expected_exe),
    "sessionid=0",
    "server=localhost:1115",
]
matches = []
for proc in psutil.process_iter(["pid", "name", "exe", "cwd", "cmdline"]):
    try:
        info = proc.info
        exe = pathlib.Path(info.get("exe") or "").resolve()
        cwd = pathlib.Path(info.get("cwd") or "").resolve()
        cmdline = info.get("cmdline") or []
        if (info.get("name", "").lower() == "h1z1.exe" and
                exe == expected_exe and cwd == expected_cwd and
                cmdline == expected_cmdline):
            matches.append(proc)
    except (psutil.NoSuchProcess, psutil.AccessDenied, FileNotFoundError):
        continue

if not matches:
    print("No exact H1Z1 client process found.")
    sys.exit(0)

for proc in matches:
    print(f"Stopping exact H1Z1 client PID {proc.pid}.")
    proc.terminate()

gone, alive = psutil.wait_procs(matches, timeout=8)
if alive:
    for proc in alive:
        print(f"H1Z1 client PID {proc.pid} did not exit; terminating verified PID.")
        proc.kill()
    psutil.wait_procs(alive, timeout=3)

still = []
for proc in psutil.process_iter(["pid", "name", "exe", "cwd", "cmdline"]):
    try:
        info = proc.info
        if info.get("pid") in {p.pid for p in matches}:
            still.append(info["pid"])
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        pass

if still:
    print("ERROR: verified H1Z1 PID still present:", still)
    sys.exit(1)
print("H1Z1 clients stopped; no matching game process remains.")
PY
