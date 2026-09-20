#!/usr/bin/env python3
"""
H1 x64dbg bridge daemon: 使用 x64dbg + x64dbg Automate 插件调试 H1Z1，
并通过本机 HTTP(JSON) 暴露队列化调试操作，供 cli.py / AI 调用。

默认由 x64dbg 调试启动目标；若环境变量 H1_X64DBG_ATTACH=1，则先普通启动 H1Z1，
再延迟附加，可绕过部分「入口即反调试 / AV」路径（直跑正常、调试即崩时可开）。

依赖: pip install -r requirements.txt
插件: install_automate_plugin.sh + install_scyllahide_plugin.sh（start-2016-with-client.sh 会尝试安装）。
"""

from __future__ import annotations

import io
import json
import logging
import os
import queue
import shlex
import subprocess
import sys
import threading
import time
import traceback
from configparser import ConfigParser
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

# 先加载同目录 .env
_ROOT = Path(__file__).resolve().parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from _envutil import load_dotenv_file

load_dotenv_file(_ROOT / ".env")


def _env_truthy(key: str, default: bool = False) -> bool:
    raw = os.environ.get(key, "")
    if raw is None or not str(raw).strip():
        return default
    return str(raw).strip().lower() in ("1", "true", "yes", "on")


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_int(v: Any) -> int:
    if isinstance(v, int):
        return v
    if isinstance(v, str):
        return int(v.strip(), 0)
    raise TypeError(f"expected int-like, got {type(v)}")


def _parse_rva_from_mapping(d: dict[str, Any], key: str = "rva") -> int | None:
    """若存在非空 rva 字段则解析为 int，否则 None（空字符串视为未提供）。"""
    r = d.get(key)
    if r is None:
        return None
    if isinstance(r, str) and not r.strip():
        return None
    return _parse_int(r)


_MEM_REG_ALIASES = frozenset(
    "rax rbx rcx rdx rsp rbp rsi rdi r8 r9 r10 r11 r12 r13 r14 r15 cip rip".split()
)


def _resolve_memory_address(client: Any, a: Any) -> tuple[int, str | None]:
    """
    解析 hit_capture / wait_capture_resume 的 memory 地址。
    若 a 为通用寄存器名（如 rdx）或 rip，则用 get_reg 取值；否则按十六进制/十进制解析。
    返回 (va, from_reg_or_none)。
    """
    if isinstance(a, int):
        return int(a), None
    if isinstance(a, str):
        s = a.strip().lower()
        if s == "rip":
            s = "cip"
        if s in _MEM_REG_ALIASES and s != "rip":
            reg = "cip" if s == "cip" else s
            return int(client.get_reg(reg)), reg
        return int(a.strip(), 0), None
    raise TypeError(f"memory address/reg expected int or str, got {type(a)}")


class JsonlLog:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def write(self, record: dict[str, Any]) -> None:
        record = {**record, "ts": _utc_iso()}
        line = json.dumps(record, ensure_ascii=False) + "\n"
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(line)


class BridgeState:
    def __init__(self) -> None:
        self.client: Any = None
        self.ready = threading.Event()
        self.start_error: str | None = None
        self.log: JsonlLog | None = None


STATE = BridgeState()
CMD_QUEUE: queue.Queue[dict[str, Any]] = queue.Queue()
_LOG_PATH: Path | None = None


def _spawn_h1z1_without_debugger(exe: str, cmdline: str, cwd: str) -> subprocess.Popen:
    """普通进程启动（非调试器创建），供随后 x64dbg 附加。"""
    exe_abs = str(Path(exe).resolve())
    argv = [exe_abs]
    if cmdline.strip():
        argv.extend(shlex.split(cmdline, posix=False))
    return subprocess.Popen(argv, cwd=cwd)


def _resolve_x64dbg_exe() -> Path:
    explicit = os.environ.get("X64DBG_EXE", "").strip()
    if explicit:
        p = Path(explicit)
        if not p.is_file():
            raise FileNotFoundError(f"X64DBG_EXE 不存在: {p}")
        return p
    root = os.environ.get("X64DBG_ROOT", "").strip()
    if not root:
        raise ValueError("请设置 X64DBG_ROOT 或 X64DBG_EXE")
    p = Path(root) / "release" / "x64" / "x64dbg.exe"
    if not p.is_file():
        raise FileNotFoundError(f"未找到 x64dbg.exe: {p}")
    return p


def _plugin_ok(x64dbg_exe: Path) -> bool:
    pdir = x64dbg_exe.parent / "plugins"
    plug = pdir / "x64dbg-automate.dp64"
    if not plug.is_file():
        return False
    if not pdir.is_dir():
        return False
    return any(
        f.is_file() and "zmq" in f.name.lower() and f.suffix.lower() == ".dll"
        for f in pdir.iterdir()
    )


def _load_ini_text(path: Path) -> tuple[str, str]:
    """
    读取 x64dbg 的 ini（多为 UTF-8，少数 UTF-16-LE）。
    返回 (文本, 写回时使用的编码标签: utf-8 | utf-16-le | utf-16-be)。
    """
    raw = path.read_bytes()
    if raw.startswith(b"\xff\xfe"):
        return raw[2:].decode("utf-16-le"), "utf-16-le"
    if raw.startswith(b"\xfe\xff"):
        return raw[2:].decode("utf-16-be"), "utf-16-be"
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw[3:].decode("utf-8"), "utf-8"
    try:
        return raw.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        return raw.decode("cp1252"), "utf-8"


def _save_ini_text(path: Path, text: str, codec: str) -> None:
    data = text.replace("\n", "\r\n")
    if data and not data.endswith("\r\n"):
        data += "\r\n"
    if codec == "utf-16-le":
        path.write_bytes(b"\xff\xfe" + data.encode("utf-16-le"))
    elif codec == "utf-16-be":
        path.write_bytes(b"\xfe\xff" + data.encode("utf-16-be"))
    else:
        path.write_bytes(data.encode("utf-8"))


def _collect_x64dbg_ini_paths(x64dbg_exe: Path) -> list[Path]:
    """
    可能同时存在：便携目录下的 x96dbg.ini、以及 %LOCALAPPDATA%\\x64dbg\\x96dbg.ini。
    x64dbg 实际读哪份因安装/首次运行而异，故在均未显式指定 X64DBG_INI 时，对**所有已存在的**
    候选各写一遍 [Events]；若都不存在则在 x64dbg.exe 同目录创建 x96dbg.ini。
    """
    override = os.environ.get("X64DBG_INI", "").strip()
    if override:
        return [Path(override)]

    seen: set[Path] = set()
    out: list[Path] = []

    def add(p: Path) -> None:
        try:
            key = p.resolve()
        except OSError:
            key = p
        if key in seen:
            return
        seen.add(key)
        out.append(p)

    parent = x64dbg_exe.parent
    for name in ("x96dbg.ini", "x64dbg.ini"):
        p = parent / name
        if p.is_file():
            add(p)

    la = os.environ.get("LOCALAPPDATA", "").strip()
    if la:
        ap = Path(la) / "x64dbg" / "x96dbg.ini"
        if ap.is_file():
            add(ap)

    if not out:
        add(parent / "x96dbg.ini")
    return out


def _patch_x64dbg_tls_event_breaks(x64dbg_exe: Path, log: JsonlLog | None) -> None:
    """
    在启动调试会话前写入 x64dbg 的 [Events]（与 GUI「选项 → 事件」一致）。
    关闭 TlsCallbacks + TlsCallbacksSystem，避免每次在 H1Z1 / nvwgf2umx 等 TLS 上 INT3。

    对应源码: x64dbg SettingsDialog.cpp — BridgeSettingSetUint("Events", "TlsCallbacks", …)

    需环境变量 X64DBG_PATCH_TLS_EVENTS=1；可选 X64DBG_INI 指定 ini 绝对路径。
    若 ini 不存在会创建。注意：用 ConfigParser 写回可能丢失原文件中的注释/顺序。
    """
    en = os.environ.get("X64DBG_PATCH_TLS_EVENTS", "").strip().lower()
    if en not in ("1", "true", "yes", "on"):
        return

    for ini_path in _collect_x64dbg_ini_paths(x64dbg_exe):
        text, codec = ("", "utf-8")
        if ini_path.is_file():
            text, codec = _load_ini_text(ini_path)

        cp = ConfigParser(strict=False, interpolation=None, empty_lines_in_values=False)
        cp.optionxform = str
        if text.strip():
            cp.read_file(io.StringIO(text), source=str(ini_path))
        if not cp.has_section("Events"):
            cp.add_section("Events")

        before = {
            "TlsCallbacks": cp.get("Events", "TlsCallbacks", fallback=None),
            "TlsCallbacksSystem": cp.get(
                "Events", "TlsCallbacksSystem", fallback=None
            ),
        }
        cp.set("Events", "TlsCallbacks", "0")
        cp.set("Events", "TlsCallbacksSystem", "0")

        buf = io.StringIO()
        cp.write(buf)
        new_text = buf.getvalue()
        ini_path.parent.mkdir(parents=True, exist_ok=True)
        _save_ini_text(ini_path, new_text, codec)

        if log:
            log.write(
                {
                    "event": "x64dbg_ini_patch_tls",
                    "path": str(ini_path.resolve()),
                    "codec": codec,
                    "before": before,
                    "after": {"TlsCallbacks": "0", "TlsCallbacksSystem": "0"},
                }
            )


def _auto_resume_debuggee(client: Any) -> None:
    """越过系统断点/入口断点，否则 is_running 长期为 false，游戏像卡死。"""
    try:
        rounds = int(os.environ.get("AUTO_GO_ROUNDS", "8"))
    except ValueError:
        rounds = 8
    rounds = max(1, min(rounds, 20))
    log = STATE.log
    for i in range(rounds):
        try:
            if not client.is_debugging():
                break
            if client.is_running():
                if log:
                    log.write({"event": "auto_go_done", "round": i, "running": True})
                return
            pe = _env_truthy("AUTO_GO_PASS_EXCEPTIONS", False)
            client.go(pass_exceptions=pe, swallow_exceptions=False)
            time.sleep(0.25)
        except Exception as e:
            if log:
                log.write(
                    {
                        "event": "auto_go_error",
                        "round": i,
                        "error": str(e),
                        "traceback": traceback.format_exc(),
                    }
                )
            break
    if log:
        log.write(
            {
                "event": "auto_go_finished",
                "running": client.is_running(),
                "debugging": client.is_debugging(),
            }
        )


def _antidebug_hide_peb(client: Any, log: JsonlLog | None) -> None:
    """
    调用 x64dbg 的 hide（通常由 ScyllaHide 提供），清 PEB 等常见反调试痕迹。
    需已安装 ScyllaHideX64DBGPlugin.dp64（install_scyllahide_plugin.sh）。
    """
    if not _env_truthy("AUTO_HIDE_PEB", True):
        return
    try:
        ok = bool(client.hide_debugger_peb())
        if log:
            log.write({"event": "hide_debugger_peb", "ok": ok})
    except Exception as e:
        if log:
            log.write({"event": "hide_debugger_peb_error", "error": str(e)})
    for _ in range(4):
        try:
            if not client.is_debugging():
                break
            if client.is_running():
                return
            client.go(pass_exceptions=True, swallow_exceptions=False)
            time.sleep(0.18)
        except Exception:
            break


def _write_executable_patch(client: Any, addr: int, data: bytes) -> bool:
    """可执行页上写 NOP 等：失败时尝试 VirtualProtect。"""
    from x64dbg_automate import PageRightsConfiguration

    if client.write_memory(addr, data):
        return True
    try:
        if client.virt_protect(addr, PageRightsConfiguration.ExecuteReadWrite, False):
            return bool(client.write_memory(addr, data))
    except Exception:
        pass
    return False


def _try_unstick_trap_at_cip(client: Any, log: JsonlLog | None) -> bool:
    """
    若当前停在 ud2 / int3 等陷阱指令上，NOP 掉并 pass_exceptions 继续。
    用于 H1Z1 等在调试器下故意触发 ILLEGAL_INSTRUCTION (ud2) 的路径。
    """
    try:
        if not client.is_debugging() or client.is_running():
            return False
        cip = int(client.get_reg("cip"))
        buf = client.read_memory(cip, 4)
        if len(buf) < 2:
            return False

        patch: bytes | None = None
        kind = ""

        if buf[:2] == b"\x0f\x0b":
            patch, kind = b"\x90\x90", "ud2"
        elif _env_truthy("AUTO_UNSTICK_PATCH_INT3", False) and buf[:1] == b"\xcc":
            patch, kind = b"\x90", "int3_cc"
        elif _env_truthy("AUTO_UNSTICK_PATCH_INT3", False) and buf[:2] == b"\xcd\x03":
            patch, kind = b"\x90\x90", "int3_cd03"

        if not patch:
            return False

        if not _write_executable_patch(client, cip, patch):
            if log:
                log.write(
                    {
                        "event": "unstick_trap_failed_write",
                        "kind": kind,
                        "addr": hex(cip),
                    }
                )
            return False

        client.go(pass_exceptions=True, swallow_exceptions=False)
        if log:
            log.write(
                {
                    "event": "unstick_trap",
                    "kind": kind,
                    "addr": hex(cip),
                    "len": len(patch),
                }
            )
        return True
    except Exception as e:
        if log:
            log.write({"event": "unstick_trap_error", "error": str(e)})
        return False


def _spawn_unstick_watchdog(client: Any, log: JsonlLog | None) -> None:
    """后台轮询：进程被陷阱/异常卡住时自动 NOP + 继续。"""
    if not _env_truthy("AUTO_UNSTICK_STOPPED", True):
        return

    try:
        total_sec = float(os.environ.get("AUTO_UNSTICK_SEC", "420"))
    except ValueError:
        total_sec = 420.0
    total_sec = max(5.0, min(total_sec, 3600.0))

    try:
        interval_ms = float(os.environ.get("AUTO_UNSTICK_INTERVAL_MS", "280"))
    except ValueError:
        interval_ms = 280.0
    interval = max(0.05, min(interval_ms / 1000.0, 5.0))

    try:
        max_patches = int(os.environ.get("AUTO_UNSTICK_MAX_PATCHES", "800"))
    except ValueError:
        max_patches = 800
    max_patches = max(1, min(max_patches, 10000))

    def run() -> None:
        t0 = time.time()
        patches = 0
        while patches < max_patches and (time.time() - t0) < total_sec:
            try:
                if not client.is_debugging():
                    break
                if _try_unstick_trap_at_cip(client, log):
                    patches += 1
            except Exception:
                pass
            time.sleep(interval)

        if log:
            log.write(
                {
                    "event": "unstick_watchdog_done",
                    "patches": patches,
                    "sec": round(time.time() - t0, 1),
                }
            )

    threading.Thread(target=run, daemon=True, name="h1-unstick").start()


def _h1z1_module_base_from_memmap(c: Any) -> tuple[int | None, str | None]:
    """从 memmap 找 h1z1 映像 allocation_base（抗 ASLR，不依赖 Ghidra 假基址 0x140000000）。"""
    try:
        pages = c.memmap()
    except Exception:
        return None, None
    bases: dict[int, str] = {}
    for m in pages:
        info = (getattr(m, "info", "") or "").strip()
        low = info.lower()
        # 只认主 EXE，避免 h1z1_*.dll 等也带 h1z1 子串
        if "h1z1.exe" not in low:
            continue
        alloc = int(getattr(m, "allocation_base", 0) or 0)
        if alloc:
            bases.setdefault(alloc, info)
    if not bases:
        return None, None
    pick = min(bases.keys())
    return pick, bases[pick]


def _resolve_fun_1404f1080_meta(c: Any, rva: int) -> dict[str, Any]:
    rva = int(rva)
    legacy_va = 0x140000000 + rva
    base, info = _h1z1_module_base_from_memmap(c)
    meta: dict[str, Any] = {
        "rva_hex": hex(rva),
        "legacy_assumed_imagebase_hex": hex(0x140000000),
        "legacy_fixed_va_hex": hex(legacy_va),
        "memmap_h1z1_allocation_base_hex": hex(base) if base else None,
        "memmap_h1z1_info": info,
        "resolved_va_from_memmap_hex": hex(base + rva) if base else None,
        "legacy_minus_resolved": (legacy_va - (base + rva)) if base else None,
    }
    eval_errs: list[dict[str, str]] = []
    for expr in ('mod.base("h1z1.exe")', "mod.base(h1z1)", "mod.base(h1z1.exe)"):
        try:
            val, ok = c.eval_sync(expr)
            if ok and val:
                meta["eval_mod_base_expr"] = expr
                meta["eval_mod_base_hex"] = hex(int(val))
                meta["eval_resolved_va_hex"] = hex(int(val) + rva)
                break
        except Exception as e:
            eval_errs.append({expr: str(e)})
    if eval_errs and "eval_mod_base_hex" not in meta:
        meta["eval_errors"] = eval_errs
    return meta


def _h1z1_resolve_va(c: Any, rva: int) -> tuple[int | None, dict[str, Any]]:
    """h1z1.exe 主模块基址 + RVA → VA；失败时返回 (None, meta)。"""
    rva = int(rva)
    base, info = _h1z1_module_base_from_memmap(c)
    meta: dict[str, Any] = {"rva_hex": hex(rva), "memmap_h1z1_info": info}
    if base:
        meta["base_hex"] = hex(base)
        meta["source"] = "memmap"
        return base + rva, meta
    for expr in ('mod.base("h1z1.exe")', "mod.base(h1z1)", "mod.base(h1z1.exe)"):
        try:
            val, ok = c.eval_sync(expr)
            if ok and val:
                b = int(val)
                meta["base_hex"] = hex(b)
                meta["source"] = "eval"
                meta["eval_expr"] = expr
                return b + rva, meta
        except Exception:
            continue
    meta["source"] = "failed"
    return None, meta


def _resolve_params_va_h1_or_absolute(
    c: Any, params: dict[str, Any], *, op: str
) -> tuple[int, dict[str, Any]]:
    """
    断点/读写内存等：优先 params['rva']（h1z1.exe 映像内偏移 → memmap/eval 基址+RVA）；
    否则 address/addr 为运行时绝对 VA（堆、栈、其它模块）。
    """
    prva = _parse_rva_from_mapping(params)
    if prva is not None:
        va, rmeta = _h1z1_resolve_va(c, prva)
        meta: dict[str, Any] = {"resolve_mode": "rva", "rva_hex": hex(prva), **rmeta}
        if va is None:
            raise ValueError(
                f"{op}: 无法将 rva 解析为 VA（未得到 h1z1 基址）；"
                "请确认已附加且模块已加载，或改用 address/addr 传绝对 VA"
            )
        return va, meta
    a = params.get("address")
    if a is None:
        a = params.get("addr")
    if a is None:
        raise ValueError(
            f"{op}: 需要 rva（推荐，与 Ghidra 一致、抗 ASLR）"
            f" 或 address/addr（绝对 VA）"
        )
    va = _parse_int(a)
    return va, {"resolve_mode": "absolute_va", "va_hex": hex(va)}


def _resolve_hit_memory_item_va(
    c: Any, item: dict[str, Any]
) -> tuple[int, str | None, dict[str, Any]]:
    """hit_capture / wait_capture_resume 的单条 memory：rva → h1z1+RVA；否则 address/addr/reg。"""
    prva = _parse_rva_from_mapping(item)
    if prva is not None:
        va, rmeta = _h1z1_resolve_va(c, prva)
        meta: dict[str, Any] = {"resolve_mode": "rva", "rva_hex": hex(prva), **rmeta}
        if va is None:
            raise ValueError("rva 无法解析为 VA（未得到 h1z1 基址）")
        return va, None, meta
    a = item.get("address") if "address" in item else item.get("addr")
    if a is None:
        a = item.get("reg")
    if a is None:
        raise ValueError("memory 项需要 rva 或 address/addr/reg")
    addr, from_reg = _resolve_memory_address(c, a)
    return addr, from_reg, {"resolve_mode": "absolute_or_reg"}


def _set_bpx_h1z1_rva(
    c: Any,
    rva: int,
    name: str,
    fallback_sym: str,
    *,
    singleshoot: bool = False,
) -> dict[str, Any]:
    va, rmeta = _h1z1_resolve_va(c, rva)
    if va is not None:
        ok = bool(c.set_breakpoint(va, name=name, singleshoot=singleshoot))
        return {
            "ok": ok,
            "va_hex": hex(va),
            "name": name,
            "singleshoot": singleshoot,
            **rmeta,
        }
    ok = bool(c.set_breakpoint(fallback_sym, name=name, singleshoot=singleshoot))
    return {
        "ok": ok,
        "va_hex": None,
        "name": name,
        "singleshoot": singleshoot,
        "fallback_symbol": fallback_sym,
        **rmeta,
    }


def _snapshot(client: Any) -> dict[str, Any]:
    regs = [
        "cip",
        "rax",
        "rbx",
        "rcx",
        "rdx",
        "rsp",
        "rbp",
        "rsi",
        "rdi",
        "r8",
        "r9",
        "r10",
        "r11",
        "r12",
        "r13",
        "r14",
        "r15",
    ]
    out: dict[str, Any] = {
        "is_running": client.is_running(),
        "is_debugging": client.is_debugging(),
    }
    try:
        out["debugee_pid"] = client.debugee_pid()
    except Exception:
        out["debugee_pid"] = None
    rvals: dict[str, Any] = {}
    for r in regs:
        try:
            rvals[r] = client.get_reg(r)
        except Exception:
            rvals[r] = None
    out["regs"] = rvals
    return out


def _wait_capture_has_expect_filters(params: dict[str, Any]) -> bool:
    if params.get("expect_h1_rva") is not None:
        return True
    if params.get("expect_cip") is not None:
        return True
    if params.get("expect_cip_any"):
        return True
    er = params.get("expect_regs")
    return isinstance(er, dict) and len(er) > 0


def _stop_matches_wait_expectation(
    c: Any, snap: dict[str, Any], params: dict[str, Any]
) -> tuple[bool, dict[str, Any]]:
    """
    wait_capture_resume 可选过滤：未配置任何 expect_* 时恒 True。
    expect_h1_rva：h1z1 主模块基址 + RVA 与 CIP 相等（抗 ASLR，与 interest_bps_batch 的 rva 一致）。
    expect_cip / expect_cip_any：绝对 VA 白名单。
    expect_regs：寄存器必须等于给定值（如 {\"rdx\": 10}），键名大小写不敏感，rip 视作 cip。
    """
    if not _wait_capture_has_expect_filters(params):
        return True, {"filter": "none"}

    meta: dict[str, Any] = {"filter": "active"}
    regs = snap.get("regs") or {}
    cip = regs.get("cip")
    if cip is None:
        return False, {**meta, "reason": "no_cip"}

    expected_cips: list[int] = []
    ehr = params.get("expect_h1_rva")
    if ehr is not None:
        rva = _parse_int(ehr)
        va, rmeta = _h1z1_resolve_va(c, rva)
        if va is None:
            return False, {
                **meta,
                "reason": "expect_h1_rva_unresolved",
                "rva_hex": hex(rva),
                **{k: v for k, v in rmeta.items() if k in ("memmap_h1z1_info",)},
            }
        expected_cips.append(int(va))
    ec = params.get("expect_cip")
    if ec is not None:
        expected_cips.append(int(_parse_int(ec)))
    for x in params.get("expect_cip_any") or []:
        expected_cips.append(int(_parse_int(x)))
    if expected_cips:
        if int(cip) not in expected_cips:
            return False, {
                **meta,
                "reason": "cip_mismatch",
                "cip": int(cip),
                "expected_cip_any": [hex(v) for v in expected_cips],
            }

    er = params.get("expect_regs") or {}
    if isinstance(er, dict):
        for name, want in er.items():
            nm = str(name).strip().lower()
            if nm == "rip":
                nm = "cip"
            got = regs.get(nm)
            if got is None:
                return False, {**meta, "reason": "reg_missing", "reg": nm}
            w = int(want) if isinstance(want, int) else int(_parse_int(want))
            if int(got) != w:
                return False, {
                    **meta,
                    "reason": "reg_mismatch",
                    "reg": nm,
                    "got": int(got),
                    "want": w,
                }

    return True, meta


def _dispatch(op: str, params: dict[str, Any]) -> dict[str, Any]:
    c = STATE.client
    if c is None:
        return {"ok": False, "error": "client_not_ready"}

    if op == "ping":
        return {"pong": True}

    if op == "status":
        return _snapshot(c)

    if op == "snapshot":
        return _snapshot(c)

    if op == "go":
        pe = params.get("pass_exceptions", False)
        sw = params.get("swallow_exceptions", False)
        return {"go": bool(c.go(pass_exceptions=pe, swallow_exceptions=sw))}

    if op == "go_pass_burst":
        # 连续「把异常交给调试目标」并运行，缓解 F9 在多种第一次异常上反复停住
        n = int(params.get("count", 25))
        n = max(1, min(n, 200))
        sw = bool(params.get("swallow_exceptions", False))
        delay = float(params.get("delay_sec", 0.05))
        delay = max(0.0, min(delay, 1.0))
        done = 0
        for _ in range(n):
            try:
                if c.is_running():
                    break
                if not c.is_debugging():
                    break
                if c.go(pass_exceptions=True, swallow_exceptions=sw):
                    done += 1
                if delay:
                    time.sleep(delay)
            except Exception:
                break
        return {
            "go_pass_burst": done,
            "is_running": c.is_running(),
            "is_debugging": c.is_debugging(),
            "snapshot": _snapshot(c),
        }

    if op == "hit_capture":
        # 命中断点后：记寄存器 + 可选多段内存 → 写 logs jsonl → 再 go（快速撤离）
        label = str(params.get("label", "hit"))
        snap = _snapshot(c)
        mem_out: list[dict[str, Any]] = []
        for item in params.get("memory", []) or []:
            if not isinstance(item, dict):
                continue
            if (
                _parse_rva_from_mapping(item) is None
                and item.get("address") is None
                and item.get("addr") is None
                and item.get("reg") is None
            ):
                continue
            try:
                addr, from_reg, rmeta = _resolve_hit_memory_item_va(c, item)
            except Exception as e:
                mem_out.append({"item": item, "error": str(e)})
                continue
            size = int(item.get("size", 64))
            size = max(1, min(size, 4096))
            try:
                data = c.read_memory(addr, size)
                row: dict[str, Any] = {
                    "address": addr,
                    "size": len(data),
                    "hex": data.hex(),
                    **rmeta,
                }
                if from_reg:
                    row["from_reg"] = from_reg
                mem_out.append(row)
            except Exception as e:
                mem_out.append({"address": addr, "from_reg": from_reg, **rmeta, "error": str(e)})
        record: dict[str, Any] = {
            "event": "hit_capture",
            "label": label,
            "snapshot": snap,
            "memory": mem_out,
        }
        if STATE.log and params.get("log", True):
            STATE.log.write(record)

        resume: dict[str, Any] = {}
        if params.get("skip_go", False):
            resume = {"skip_go": True}
        elif int(params.get("go_burst_after", 0) or 0) > 0:
            n = int(params.get("go_burst_after", 0))
            n = max(1, min(n, 200))
            sw = bool(params.get("swallow_exceptions", False))
            delay = float(params.get("delay_sec", 0.05))
            delay = max(0.0, min(delay, 1.0))
            done = 0
            for _ in range(n):
                try:
                    if c.is_running():
                        break
                    if not c.is_debugging():
                        break
                    if c.go(pass_exceptions=True, swallow_exceptions=sw):
                        done += 1
                    if delay:
                        time.sleep(delay)
                except Exception:
                    break
            resume = {"go_pass_burst": done}
        else:
            pe = bool(params.get("pass_exceptions", True))
            sw = bool(params.get("swallow_exceptions", False))
            resume = {
                "go": bool(c.go(pass_exceptions=pe, swallow_exceptions=sw)),
            }

        after = _snapshot(c)
        return {
            "hit_capture": record,
            "resume": resume,
            "after_snapshot": after,
        }

    if op == "dbg_cmd":
        s = (params.get("cmd") or params.get("command") or "").strip()
        if not s:
            raise ValueError("dbg_cmd 需要非空 cmd 或 command（x64dbg 脚本命令）")
        ok = bool(c.cmd_sync(s))
        return {"dbg_cmd": ok, "ran": s}

    if op == "dbg_eval":
        expr = (params.get("expr") or params.get("expression") or "").strip()
        if not expr:
            raise ValueError("dbg_eval 需要 expr 或 expression（x64dbg 表达式）")
        val, ok = c.eval_sync(expr)
        return {
            "dbg_eval": bool(ok),
            "expr": expr,
            "value": int(val) if ok else None,
            "value_hex": hex(int(val)) if ok else None,
        }

    if op == "prepare_fun_1404f1080_std_bpx":
        """
        清全部软件/硬件/内存断点；用 memmap 解析 h1z1 基址 + RVA 0x4F1080 下标准断点（无条件）。
        用于验证「假地址 0x1404F1080」是否因 ASLR 未命中。
        """
        rva = _parse_int(params.get("rva", 0x4F1080))
        name = str(params.get("name") or "FUN_1404f1080_std")
        c.clear_breakpoint(None)
        c.clear_hardware_breakpoint(None)
        c.clear_memory_breakpoint(None)
        meta = _resolve_fun_1404f1080_meta(c, rva)
        va: int | None = None
        if meta.get("memmap_h1z1_allocation_base_hex"):
            base = int(meta["memmap_h1z1_allocation_base_hex"], 0)
            va = base + rva
        elif meta.get("eval_mod_base_hex"):
            base = int(meta["eval_mod_base_hex"], 0)
            va = base + rva
        ok_bpx = False
        if va is not None:
            ok_bpx = bool(c.set_breakpoint(va, name=name))
        else:
            sym = str(params.get("fallback_symbol") or "h1z1+0x4F1080")
            ok_bpx = bool(c.set_breakpoint(sym, name=name))
            meta["fallback_symbol_used"] = sym
        if STATE.log:
            STATE.log.write({"event": "prepare_fun_1404f1080_std_bpx", "meta": meta, "bpx": ok_bpx})
        return {
            "prepare_fun_1404f1080_std_bpx": True,
            "set_breakpoint": ok_bpx,
            "breakpoint_va_hex": hex(va) if va else None,
            **meta,
        }

    if op == "prepare_ucs_downstream_bps":
        """
        UCS：清断点后默认只下 FUN_14053d4e0（验证 4f1080 之后是否入队）。
        用于「已确认 4f1080 命中」后关掉入口断点，避免 wait_capture 总停在 4f1080。
        526310 / 4ff870 / 4eb0f0 默认关；需则 arm_* 打开。
        """
        if bool(params.get("clear_first", True)):
            c.clear_breakpoint(None)
            c.clear_hardware_breakpoint(None)
            c.clear_memory_breakpoint(None)
        armed: dict[str, Any] = {}
        if bool(params.get("arm_53d4e0", True)):
            rva = _parse_int(params.get("rva_53d4e0", 0x53D4E0))
            nm = str(params.get("name_53d4e0") or "FUN_14053d4e0_ucs_queue")
            armed["53d4e0"] = _set_bpx_h1z1_rva(c, rva, nm, f"h1z1+0x{rva:X}")
        if bool(params.get("arm_4ff870", False)):
            rva = _parse_int(params.get("rva_4ff870", 0x4FF870))
            nm = str(params.get("name_4ff870") or "FUN_1404ff870_8cf_writer")
            armed["4ff870"] = _set_bpx_h1z1_rva(c, rva, nm, f"h1z1+0x{rva:X}")
        if bool(params.get("arm_4eb0f0", False)):
            rva = _parse_int(params.get("rva_4eb0f0", 0x4EB0F0))
            nm = str(params.get("name_4eb0f0") or "FUN_1404eb0f0_queue_node")
            armed["4eb0f0"] = _set_bpx_h1z1_rva(c, rva, nm, f"h1z1+0x{rva:X}")
        if bool(params.get("arm_526310", False)):
            rva = _parse_int(params.get("rva_526310", 0x526310))
            nm = str(params.get("name_526310") or "FUN_140526310_tick_merge_35b")
            ss = bool(params.get("526310_singleshoot", True))
            entry = _set_bpx_h1z1_rva(
                c, rva, nm, f"h1z1+0x{rva:X}", singleshoot=ss
            )
            armed["526310"] = entry
            va_hex = entry.get("va_hex")
            if va_hex and entry.get("ok"):
                bpcnd = (params.get("bpcnd_526310") or "").strip()
                if bpcnd:
                    c.cmd_sync(f"bpcnd 0x{int(va_hex, 0):x}, {bpcnd}")
                entry["bpcnd"] = bpcnd or None
        if STATE.log:
            STATE.log.write({"event": "prepare_ucs_downstream_bps", "armed": armed})
        return {
            "prepare_ucs_downstream_bps": True,
            "armed": armed,
            "hint": "526310 每 tick 极高频：务必 bpcnd 或 singleshoot+单次抓；配合 hit_capture / wait_capture_resume 写 jsonl",
        }

    if op == "interest_bps_batch":
        """
        一条请求下多个「兴趣点」软件断点。每项优先 rva（h1z1.exe 映像内偏移）；可选绝对 VA；可选 bpcnd、singleshoot。
        params.points: [{ "rva"?, "address"|"addr"?, "name"?, "singleshoot"?, "bpcnd"|"condition"?, "fallback_symbol"? }]
        """
        if bool(params.get("clear_first", True)):
            c.clear_breakpoint(None)
            c.clear_hardware_breakpoint(None)
            c.clear_memory_breakpoint(None)
        raw_pts = params.get("points") or params.get("interest") or []
        if not isinstance(raw_pts, list) or not raw_pts:
            raise ValueError("interest_bps_batch 需要非空 points（或 interest）数组")
        max_n = int(os.environ.get("H1_INTEREST_BPS_MAX", "48"))
        max_n = max(1, min(max_n, 128))
        if len(raw_pts) > max_n:
            raise ValueError(f"points 过多（>{max_n}），改小列表或调大环境变量 H1_INTEREST_BPS_MAX")
        results: list[dict[str, Any]] = []
        for i, p in enumerate(raw_pts):
            va: int | None = None
            if not isinstance(p, dict):
                results.append({"index": i, "error": "not_an_object"})
                continue
            name = str(p.get("name") or f"interest_{i}")
            ss = bool(p.get("singleshoot", False))
            bpcnd = (p.get("bpcnd") or p.get("condition") or "").strip()
            entry: dict[str, Any] = {"index": i, "name": name, "singleshoot": ss}
            try:
                prva = _parse_rva_from_mapping(p)
                if prva is not None:
                    rva = prva
                    va, rmeta = _h1z1_resolve_va(c, rva)
                    entry["mode"] = "rva"
                    entry["rva_hex"] = hex(rva)
                    entry.update(rmeta)
                    fb = (p.get("fallback_symbol") or "").strip() or f"h1z1+0x{rva:X}"
                    if va is not None:
                        ok = bool(c.set_breakpoint(va, name=name, singleshoot=ss))
                    else:
                        ok = bool(c.set_breakpoint(fb, name=name, singleshoot=ss))
                        entry["fallback_symbol"] = fb
                    entry["ok"] = ok
                    entry["va_hex"] = hex(va) if va is not None else None
                elif p.get("address") is not None or p.get("addr") is not None:
                    a = p.get("address") if p.get("address") is not None else p.get("addr")
                    va = _parse_int(a)
                    entry["mode"] = "absolute_va"
                    entry["ok"] = bool(c.set_breakpoint(va, name=name, singleshoot=ss))
                    entry["va_hex"] = hex(va)
                else:
                    entry["error"] = "需要 rva（推荐）或 address/addr（绝对 VA）"
                    results.append(entry)
                    continue
            except Exception as e:
                entry["ok"] = False
                entry["error"] = str(e)
                results.append(entry)
                continue
            if bpcnd and entry.get("ok") and va is not None:
                entry["bpcnd"] = bpcnd
                entry["bpcnd_ok"] = bool(c.cmd_sync(f"bpcnd 0x{va:x}, {bpcnd}"))
            results.append(entry)
        if STATE.log:
            STATE.log.write({"event": "interest_bps_batch", "count": len(results), "results": results})
        ok_all = all(r.get("ok") is True for r in results)
        return {
            "interest_bps_batch": True,
            "clear_first": bool(params.get("clear_first", True)),
            "points": results,
            "all_ok": ok_all,
            "hint": "命中后用 hit_capture / wait_capture_resume 记 jsonl；高频点务必 bpcnd 或 singleshoot",
        }

    if op == "prepare_ucs_case9_bps":
        """
        调查主线：只保留 FUN_1404f1080（UpdateCharacterState 解析体入口，默认 RVA 0x4F1080）。
        入口 RDX 为缓冲指针，勿用 rdx==.10（那是 Ghidra 上层 case 编号，不是指针里的 10）。
        条件用包头小端前两字节 0F 0A（opcode 0x0F0A）过滤，避免死亡等路径误命中。
        清断点与下断均经 memmap+RVA，不写死 0x140…… 假 VA。
        """
        ucs_bpcnd = (
            "ReadByte(rdx)==0x0F && ReadByte(rdx+1)==0x0A"
        )
        rva_511840 = _parse_int(params.get("rva_511840", 0x511840))
        rva_4f1080 = _parse_int(params.get("rva_4f1080", params.get("rva", 0x4F1080)))
        rva_53d4e0 = _parse_int(params.get("rva_53d4e0", 0x53D4E0))
        cleared_meta: list[dict[str, Any]] = []
        for rva in (rva_511840, rva_4f1080, rva_53d4e0):
            va_clr, m = _h1z1_resolve_va(c, rva)
            row = {"rva_hex": hex(rva), **m}
            if va_clr is not None:
                try:
                    c.clear_breakpoint(va_clr)
                    row["cleared_va_hex"] = hex(va_clr)
                except Exception as e:
                    row["clear_error"] = str(e)
            cleared_meta.append(row)
        entry = _set_bpx_h1z1_rva(
            c,
            rva_4f1080,
            "h1_ucs_4f1080_bpcnd_opcode_0f0a",
            f"h1z1+0x{rva_4f1080:X}",
            singleshoot=False,
        )
        ok_bpx = bool(entry.get("ok"))
        va_hex = entry.get("va_hex")
        ok_cnd = False
        if va_hex:
            va_int = int(va_hex, 0)
            ok_cnd = bool(c.cmd_sync(f"bpcnd 0x{va_int:x}, {ucs_bpcnd}"))
        elif entry.get("fallback_symbol"):
            ok_cnd = bool(
                c.cmd_sync(f"bpcnd {entry['fallback_symbol']}, {ucs_bpcnd}")
            )
        if STATE.log:
            STATE.log.write(
                {
                    "event": "prepare_ucs_case9_bps",
                    "bpx": ok_bpx,
                    "bpcnd_ucs_opcode": ok_cnd,
                    "bpcnd_expr": ucs_bpcnd,
                    "armed": entry,
                    "cleared": cleared_meta,
                }
            )
        return {
            "prepare_ucs_case9_bps": True,
            "cleared": cleared_meta,
            "armed": entry,
            "condition": ucs_bpcnd,
            "bpx_ok": ok_bpx,
            "bpcnd_ok": ok_cnd,
        }

    if op == "wait_capture_resume":
        """
        阻塞等待调试目标暂停 → 记现场 → go_pass_burst 恢复（防卡死）。
        可选 expect_*：仅在停在对的 CIP/寄存器时抓取；否则自动 go 继续等（减轻「任意原因暂停」误抓）。
        """
        timeout = int(params.get("timeout_sec", 90))
        timeout = max(1, min(timeout, 7200))
        deadline = time.monotonic() + float(timeout)
        max_spurious = int(params.get("max_spurious_resume", 512))
        max_spurious = max(0, min(max_spurious, 100_000))
        spurious_go = int(params.get("spurious_go_burst", 1))
        spurious_go = max(1, min(spurious_go, 50))

        spurious_count = 0
        last_snap: dict[str, Any] | None = None
        last_reject: dict[str, Any] | None = None
        snap: dict[str, Any] | None = None
        final_match_meta: dict[str, Any] | None = None

        while True:
            rem = deadline - time.monotonic()
            if rem <= 0:
                return {
                    "ok_hit": False,
                    "reason": "timeout_waiting_match"
                    if _wait_capture_has_expect_filters(params)
                    else "timeout_not_stopped",
                    "timeout_sec": timeout,
                    "spurious_stops": spurious_count,
                    "last_snapshot": last_snap,
                    "last_reject": last_reject,
                }
            wt = max(1, min(int(rem + 0.999), 600))
            if not c.wait_until_stopped(wt):
                return {
                    "ok_hit": False,
                    "reason": "timeout_not_stopped",
                    "timeout_sec": timeout,
                    "spurious_stops": spurious_count,
                    "last_snapshot": last_snap,
                    "last_reject": last_reject,
                }
            snap = _snapshot(c)
            last_snap = snap
            ok_match, match_meta = _stop_matches_wait_expectation(c, snap, params)
            if ok_match:
                final_match_meta = match_meta
                break
            last_reject = match_meta
            spurious_count += 1
            if spurious_count > max_spurious:
                return {
                    "ok_hit": False,
                    "reason": "max_spurious_resume_exceeded",
                    "spurious_stops": spurious_count,
                    "max_spurious_resume": max_spurious,
                    "last_snapshot": snap,
                    "last_reject": last_reject,
                }
            sw_sp = bool(params.get("swallow_exceptions", False))
            delay_sp = float(params.get("delay_sec", 0.05))
            delay_sp = max(0.0, min(delay_sp, 1.0))
            for _ in range(spurious_go):
                try:
                    if c.is_running():
                        break
                    if not c.is_debugging():
                        break
                    c.go(pass_exceptions=True, swallow_exceptions=sw_sp)
                    if delay_sp:
                        time.sleep(delay_sp)
                except Exception:
                    break

        assert snap is not None
        # skip_resume / stay_paused：抓现场后不再 go，便于换装断点链（511840 → 53d4e0 → 526310）
        skip_resume = bool(params.get("skip_resume") or params.get("stay_paused"))
        if skip_resume:
            burst = 0
        else:
            burst = int(params.get("go_burst_after", 35))
            burst = max(1, min(burst, 200))
        inner = {
            **params,
            "label": params.get("label", "ucs_case9_wait"),
            "skip_go": False,
            "go_burst_after": burst,
            "log": params.get("log", True),
        }
        label = str(inner.get("label", "hit"))
        mem_out: list[dict[str, Any]] = []
        for mem_item in inner.get("memory", []) or []:
            if not isinstance(mem_item, dict):
                continue
            if (
                _parse_rva_from_mapping(mem_item) is None
                and mem_item.get("address") is None
                and mem_item.get("addr") is None
                and mem_item.get("reg") is None
            ):
                continue
            try:
                addr, from_reg, rmeta = _resolve_hit_memory_item_va(c, mem_item)
            except Exception as e:
                mem_out.append({"item": mem_item, "error": str(e)})
                continue
            size = int(mem_item.get("size", 64))
            size = max(1, min(size, 4096))
            try:
                data = c.read_memory(addr, size)
                row2: dict[str, Any] = {
                    "address": addr,
                    "size": len(data),
                    "hex": data.hex(),
                    **rmeta,
                }
                if from_reg:
                    row2["from_reg"] = from_reg
                mem_out.append(row2)
            except Exception as e:
                mem_out.append({"address": addr, "from_reg": from_reg, **rmeta, "error": str(e)})
        record: dict[str, Any] = {
            "event": "wait_capture_resume",
            "label": label,
            "snapshot": snap,
            "memory": mem_out,
            "spurious_stops_before_hit": spurious_count,
            "expect_match_meta": final_match_meta,
        }
        if STATE.log and inner.get("log", True):
            STATE.log.write(record)
        sw = bool(inner.get("swallow_exceptions", False))
        delay = float(inner.get("delay_sec", 0.05))
        delay = max(0.0, min(delay, 1.0))
        done = 0
        for _ in range(burst):
            try:
                if c.is_running():
                    break
                if not c.is_debugging():
                    break
                if c.go(pass_exceptions=True, swallow_exceptions=sw):
                    done += 1
                if delay:
                    time.sleep(delay)
            except Exception:
                break
        after = _snapshot(c)
        return {
            "ok_hit": True,
            "capture": record,
            "go_pass_burst": done,
            "skip_resume": skip_resume,
            "after_snapshot": after,
            "spurious_stops": spurious_count,
            "expect_match_meta": final_match_meta,
        }

    if op == "pause":
        return {"pause": bool(c.pause())}

    if op == "set_breakpoint":
        va, meta = _resolve_params_va_h1_or_absolute(c, params, op="set_breakpoint")
        name = params.get("name")
        singleshoot = bool(params.get("singleshoot", False))
        return {
            "set_breakpoint": bool(
                c.set_breakpoint(va, name=name, singleshoot=singleshoot)
            ),
            **meta,
        }

    if op == "clear_breakpoint":
        if _parse_rva_from_mapping(params) is not None:
            va, meta = _resolve_params_va_h1_or_absolute(c, params, op="clear_breakpoint")
            return {"clear_breakpoint": bool(c.clear_breakpoint(va)), **meta}
        if params.get("address") is None and params.get("addr") is None:
            return {"clear_breakpoint": bool(c.clear_breakpoint(None))}
        a = params.get("address") if params.get("address") is not None else params.get("addr")
        va = _parse_int(a)
        return {
            "clear_breakpoint": bool(c.clear_breakpoint(va)),
            "resolve_mode": "absolute_va",
            "va_hex": hex(va),
        }

    if op == "wait_stopped":
        timeout_sec = int(params.get("timeout_sec", 30))
        stopped = bool(c.wait_until_stopped(timeout_sec))
        return {"stopped": stopped, "snapshot": _snapshot(c)}

    if op == "read_memory":
        addr, meta = _resolve_params_va_h1_or_absolute(c, params, op="read_memory")
        size = int(params.get("size", 64))
        size = max(1, min(size, 65536))
        data = c.read_memory(addr, size)
        return {
            "address": addr,
            "size": len(data),
            "hex": data.hex(),
            **meta,
        }

    if op == "write_memory":
        addr, meta = _resolve_params_va_h1_or_absolute(c, params, op="write_memory")
        hx = params.get("hex") or params.get("data_hex")
        if not isinstance(hx, str) or not hx.strip():
            raise ValueError("write_memory 需要 hex 或 data_hex（无空格十六进制）")
        raw = bytes.fromhex(hx.replace(" ", ""))
        if len(raw) > 65536:
            raise ValueError("write_memory 长度过大")
        if params.get("virt_protect", False):
            ok = _write_executable_patch(c, addr, raw)
        else:
            ok = bool(c.write_memory(addr, raw))
        return {"write_memory": ok, "address": addr, "size": len(raw), **meta}

    if op == "stepi":
        n = int(params.get("count", 1))
        return {"stepi": bool(c.stepi(step_count=n))}

    if op == "stepo":
        n = int(params.get("count", 1))
        return {"stepo": bool(c.stepo(step_count=n))}

    if op == "detach_session":
        c.detach_session()
        return {
            "detach": True,
            "note": "仅断开 Python 与 x64dbg 的 ZMQ，调试器进程可能仍在",
        }

    if op == "terminate_session":
        c.terminate_session()
        STATE.client = None
        return {"terminate": True, "note": "已结束 x64dbg 会话并关闭连接"}

    raise ValueError(f"unknown op: {op}")


def _worker() -> None:
    global _LOG_PATH
    try:
        log_dir = Path(os.environ.get("LOG_DIR", "logs"))
        if not log_dir.is_absolute():
            log_dir = _ROOT / log_dir
        log_dir.mkdir(parents=True, exist_ok=True)
        safe_ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        _LOG_PATH = log_dir / f"daemon-{safe_ts}.jsonl"
        STATE.log = JsonlLog(_LOG_PATH)
        STATE.log.write({"event": "daemon_start", "root": str(_ROOT)})

        x64 = _resolve_x64dbg_exe()
        if not _plugin_ok(x64):
            raise RuntimeError(
                f"未检测到 Automate 插件，请将 release64 的 Release 内容复制到:\n"
                f"  {x64.parent / 'plugins'}\n"
                f"需要: x64dbg-automate.dp64, libzmq-mt-4_3_5.dll\n"
                f"可运行: powershell -File install_automate_plugin.ps1"
            )

        _patch_x64dbg_tls_event_breaks(x64, STATE.log)

        from x64dbg_automate import X64DbgClient

        client = X64DbgClient(str(x64))
        auto = os.environ.get("AUTO_START_SESSION", "1").strip().lower() in (
            "1",
            "true",
            "yes",
        )
        if auto:
            exe = os.environ.get("H1Z1_EXE", "").strip()
            if not exe:
                raise ValueError("AUTO_START_SESSION=1 时需要 H1Z1_EXE")
            cmdline = os.environ.get("H1Z1_CMDLINE", "").strip()
            cwd = str(Path(exe).resolve().parent)
            existing_pid_raw = os.environ.get("H1_X64DBG_EXISTING_PID", "").strip()
            attach_first = _env_truthy("H1_X64DBG_ATTACH", False)
            child: subprocess.Popen | None = None
            try:
                if existing_pid_raw:
                    existing_pid = int(existing_pid_raw, 0)
                    if existing_pid <= 0:
                        raise ValueError("H1_X64DBG_EXISTING_PID must be positive")
                    STATE.log.write(
                        {
                            "event": "start_session_attach_existing",
                            "pid": existing_pid,
                        }
                    )
                    print(
                        f"[daemon] H1_X64DBG_EXISTING_PID={existing_pid}：附加已有客户端…",
                        flush=True,
                    )
                    client.start_session_attach(existing_pid)
                elif attach_first:
                    try:
                        delay = float(os.environ.get("H1_ATTACH_DELAY_SEC", "6"))
                    except ValueError:
                        delay = 6.0
                    delay = max(0.0, min(delay, 120.0))
                    STATE.log.write(
                        {
                            "event": "spawn_debugee_normal",
                            "exe": exe,
                            "cmdline": cmdline,
                            "cwd": cwd,
                            "attach_delay_sec": delay,
                        }
                    )
                    print(
                        f"[daemon] H1_X64DBG_ATTACH=1：先普通启动客户端，{delay}s 后 x64dbg 附加…",
                        flush=True,
                    )
                    child = _spawn_h1z1_without_debugger(exe, cmdline, cwd)
                    STATE.log.write(
                        {"event": "debugee_spawned_pid", "pid": child.pid}
                    )
                    time.sleep(delay)
                    STATE.log.write(
                        {
                            "event": "start_session_attach",
                            "pid": child.pid,
                        }
                    )
                    client.start_session_attach(child.pid)
                else:
                    STATE.log.write(
                        {
                            "event": "start_session",
                            "exe": exe,
                            "cmdline": cmdline,
                            "cwd": cwd,
                        }
                    )
                    client.start_session(exe, cmdline, cwd)
            except Exception:
                if child is not None and child.poll() is None:
                    try:
                        child.terminate()
                    except Exception:
                        pass
                raise
        else:
            client.start_session("")
        STATE.client = client
        # x64dbg 启动后常停在系统断点/入口，is_running=false 看起来像“挂死”；自动 F9 几次越过初始断点
        if os.environ.get("AUTO_GO_AFTER_START", "1").strip().lower() in (
            "1",
            "true",
            "yes",
        ):
            _auto_resume_debuggee(client)
        # 反调试：ScyllaHide hide + 后台摘掉 ud2/int3 陷阱（见 .env.example）
        _antidebug_hide_peb(client, STATE.log)
        _spawn_unstick_watchdog(client, STATE.log)
        snap = _snapshot(client)
        STATE.log.write({"event": "session_ready", "snapshot": snap})
        print(
            f"[daemon] 调试目标 PID={snap.get('debugee_pid')} "
            f"running={snap.get('is_running')} debugging={snap.get('is_debugging')} — "
            "若 running 长期为 false，请在 x64dbg 按 F9 或: "
            "python dev/x64dbg-bridge/cli.py exec --op go",
            flush=True,
        )
        STATE.ready.set()
    except Exception:
        STATE.start_error = traceback.format_exc()
        STATE.ready.set()
        if STATE.log:
            STATE.log.write({"event": "fatal_start", "error": STATE.start_error})

    while True:
        item = CMD_QUEUE.get()
        if item is None:
            break
        op = item["op"]
        params = item.get("params") or {}
        t0 = time.perf_counter()
        try:
            if STATE.start_error:
                item["result"] = {
                    "ok": False,
                    "error": "start_failed",
                    "traceback": STATE.start_error,
                }
            elif STATE.client is None:
                item["result"] = {
                    "ok": False,
                    "error": "no_client",
                }
            else:
                result = _dispatch(op, params)
                item["result"] = {"ok": True, "data": result}
        except Exception as e:
            item["result"] = {
                "ok": False,
                "error": str(e),
                "traceback": traceback.format_exc(),
            }
        dt = time.perf_counter() - t0
        if STATE.log:
            STATE.log.write(
                {
                    "event": "op_done",
                    "op": op,
                    "ms": round(dt * 1000, 2),
                    "ok": item["result"].get("ok"),
                }
            )
        item["done"].set()


def _submit_op(op: str, params: dict[str, Any], wait_timeout: float) -> dict[str, Any]:
    if not STATE.ready.is_set():
        STATE.ready.wait(timeout=120)

    done = threading.Event()
    item = {"op": op, "params": params, "done": done, "result": None}
    CMD_QUEUE.put(item)
    if not done.wait(timeout=wait_timeout):
        return {"ok": False, "error": "daemon_queue_timeout", "op": op}
    return item["result"]


class Handler(BaseHTTPRequestHandler):
    server_version = "H1X64Bridge/0.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        logging.info("%s - %s", self.address_string(), fmt % args)

    def _send_json(self, code: int, body: dict[str, Any]) -> None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, OSError):
            # 客户端在长时间 op 期间 Ctrl+C / 关闭连接
            logging.debug("client closed before response body sent", exc_info=True)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path in ("/health", "/v1/health"):
            if not STATE.ready.is_set():
                self._send_json(
                    503,
                    {"ok": False, "status": "starting"},
                )
                return
            if STATE.start_error:
                self._send_json(
                    503,
                    {"ok": False, "status": "start_failed"},
                )
                return
            body: dict[str, Any] = {"ok": True, "status": "ready"}
            c = STATE.client
            if c is not None:
                try:
                    body["debugee_running"] = c.is_running()
                    body["debugee_debugging"] = c.is_debugging()
                except Exception:
                    pass
            self._send_json(200, body)
            return
        if parsed.path in ("/v1/status",):
            r = _submit_op("status", {}, wait_timeout=60.0)
            self._send_json(200 if r.get("ok") else 500, r)
            return
        self._send_json(404, {"ok": False, "error": "not_found"})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/v1/exec":
            self._send_json(404, {"ok": False, "error": "not_found"})
            return
        length = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as e:
            self._send_json(400, {"ok": False, "error": f"json: {e}"})
            return
        op = body.get("op")
        if not op:
            self._send_json(400, {"ok": False, "error": "missing op"})
            return
        params = body.get("params") if isinstance(body.get("params"), dict) else {}
        extra = float(body.get("wait_timeout_sec", 120))
        if op == "wait_stopped":
            extra = max(extra, float(params.get("timeout_sec", 30)) + 15.0)
        if op == "wait_capture_resume":
            extra = max(extra, float(params.get("timeout_sec", 90)) + 30.0)
        r = _submit_op(str(op), params, wait_timeout=max(60.0, extra))
        code = 200 if r.get("ok") else 500
        self._send_json(code, r)


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] in ("-h", "--help"):
        print(
            "h1-x64dbg daemon — 在 dev/x64dbg-bridge 目录: py -3 daemon.py\n"
            "需 .env（见 .env.example）。HTTP 接口:\n"
            "  GET  /v1/health\n"
            "  POST /v1/exec  JSON: {\"op\":\"status\",\"params\":{}}\n"
            "全部 op 与 CLI 示例: py -3 cli.py --help\n",
            flush=True,
        )
        return 0

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    host = os.environ.get("H1_X64DBG_DAEMON_HOST", "127.0.0.1").strip()
    port = int(os.environ.get("H1_X64DBG_DAEMON_PORT", "18765"))

    # 必须先绑定 HTTP，再在后台线程里连 x64dbg；否则会话初始化超过
    # SESSION_READY_TIMEOUT_SEC 时进程会直接退出，导致 CLI 连接被拒绝。
    threading.Thread(target=_worker, daemon=True).start()

    httpd = ThreadingHTTPServer((host, port), Handler)
    print(
        f"[daemon] HTTP 已监听 http://{host}:{port}/v1/health （x64dbg 会话在后台初始化中）",
        flush=True,
    )
    print(
        f"[daemon] JSON 命令: POST http://{host}:{port}/v1/exec  body={{\"op\":\"status\"}}",
        flush=True,
    )
    print(
        "[daemon] 若 CLI 报 unknown op：请重启本 daemon 以加载最新 op（如 go_pass_burst / hit_capture）。",
        flush=True,
    )
    print("[daemon] 日志目录: dev/x64dbg-bridge/logs/（会话建立后写入带时间戳的 .jsonl）", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[daemon] 退出中…")
        CMD_QUEUE.put(None)
        if STATE.client:
            try:
                STATE.client.detach_session()
            except Exception:
                pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
