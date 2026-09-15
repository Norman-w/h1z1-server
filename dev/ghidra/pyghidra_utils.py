#!/usr/bin/env python3
# PyGhidra 跑脚本前共用的工具：检查工程 lock、发现并结束占用工程的进程。
# 各 run_*.py 在 open_project 前调用 ensure_project_unlocked(project_dir, project_name)。
#
# 行为：若存在 project_name.lock，则先查找可能占用该工程目录的 Java 进程（依赖 psutil，
#       未安装则只尝试删 lock），终止后再删除 lock。环境变量 PYGHIDRA_NO_KILL=1 时仅删 lock、不杀进程。

import os
import sys
import time

def get_lock_path(project_dir, project_name="H1Z1"):
    """Ghidra 工程锁文件路径：project_dir / (project_name + ".lock")。"""
    return os.path.join(project_dir, project_name + ".lock")

def is_project_locked(project_dir, project_name="H1Z1"):
    """工程是否处于锁定状态（存在 lock 文件）。"""
    return os.path.isfile(get_lock_path(project_dir, project_name))

def _find_java_pids_with_project(project_dir):
    """找出可能占用该工程目录的 Java 进程 PID 列表（cmdline 或 cwd 含 project_dir）。"""
    try:
        import psutil
    except ImportError:
        return []
    project_dir_abs = os.path.abspath(project_dir)
    project_dir_norm = os.path.normcase(project_dir_abs)
    pids = []
    for p in psutil.process_iter(["pid", "name", "cmdline", "cwd"]):
        try:
            name = (p.info.get("name") or "").lower()
            if "java" not in name:
                continue
            cmdline = p.info.get("cmdline") or []
            cmdline_str = " ".join(str(x) for x in cmdline)
            cwd = (p.info.get("cwd") or "") or ""
            if project_dir_norm in os.path.normcase(cmdline_str) or project_dir_norm in os.path.normcase(cwd):
                pids.append(p.info["pid"])
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return pids

def _kill_pids(pids, verbose=True):
    """尝试终止给定 PID 的进程；先 SIGTERM，短暂等待后 SIGKILL。"""
    try:
        import psutil
    except ImportError:
        if verbose:
            print("未安装 psutil，无法结束进程。", file=sys.stderr)
        return False
    for pid in pids:
        try:
            proc = psutil.Process(pid)
            proc.terminate()
            if verbose:
                print("已发送 SIGTERM 到 PID %s (可能为上一轮 PyGhidra)" % pid, file=sys.stderr)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    if pids:
        time.sleep(1.5)
        for pid in pids:
            try:
                proc = psutil.Process(pid)
                if proc.is_running():
                    proc.kill()
                    if verbose:
                        print("已 SIGKILL PID %s" % pid, file=sys.stderr)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
    return True

def ensure_project_unlocked(project_dir, project_name="H1Z1", kill_holder=True):
    """
    若工程被 lock，则尝试解除：
    - kill_holder=True：先查找可能占用工程的 Java 进程并结束，再删除 lock 文件；
    - kill_holder=False：仅尝试删除 lock 文件。
    返回 True 表示当前无 lock（可继续 open_project）；False 表示仍有 lock 或删除失败，建议退出。
    环境变量 PYGHIDRA_NO_KILL=1 时不做杀进程，只删 lock。
    """
    lock_path = get_lock_path(project_dir, project_name)
    if not os.path.isfile(lock_path):
        return True
    do_kill = kill_holder and os.environ.get("PYGHIDRA_NO_KILL") != "1"
    if do_kill:
        pids = _find_java_pids_with_project(project_dir)
        if pids:
            _kill_pids(pids)
            time.sleep(0.5)
    try:
        os.remove(lock_path)
        if do_kill and pids:
            print("已移除 lock 并结束占用进程，可继续执行。", file=sys.stderr)
        return True
    except OSError as e:
        print("工程被锁定且无法删除 lock: %s" % lock_path, file=sys.stderr)
        print("  %s" % e, file=sys.stderr)
        if do_kill:
            print("  已尝试结束占用工程的 Java 进程；若仍失败请关闭 Ghidra GUI 或手动结束 java 进程。", file=sys.stderr)
        return False
