#!/usr/bin/env bash
set -euo pipefail

python - <<'PY'
import ctypes
import pathlib
import psutil
import sys
import time

user32 = ctypes.windll.user32
expected_exe = pathlib.Path(r"D:\WindowsOnly\Games\H1EMU_Client\H1Z1.exe").resolve()
found = []
windows = []
EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

@EnumWindowsProc
def enum_cb(hwnd, _):
    pid = ctypes.c_ulong()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    if pid.value:
        windows.append((hwnd, pid.value))
    return True

user32.EnumWindows(enum_cb, 0)
for proc in psutil.process_iter(["pid", "name", "exe", "cwd", "cmdline"]):
    try:
        info = proc.info
        if (info.get("name", "").lower() == "h1z1.exe" and
                pathlib.Path(info.get("exe") or "").resolve() == expected_exe and
                (info.get("cmdline") or []) == [str(expected_exe), "sessionid=0", "server=localhost:1115"]):
            found.append(proc.pid)
    except (psutil.NoSuchProcess, psutil.AccessDenied, FileNotFoundError):
        pass
if not found:
    print("No exact H1Z1 client found.")
    sys.exit(1)

for pid in found:
    hwnds = [hwnd for hwnd, owner in windows if owner == pid]
    for hwnd in hwnds:
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        user32.SetForegroundWindow(hwnd)
    print(f"Focused H1Z1 PID {pid}; windows={len(hwnds)}")
time.sleep(0.5)
PY
