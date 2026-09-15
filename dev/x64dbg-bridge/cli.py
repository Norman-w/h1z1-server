#!/usr/bin/env python3
"""
调用本机 h1-x64dbg daemon 的薄 CLI（HTTP JSON）。
无参数或 -h/--help 打印完整说明；详见同目录 _ops_help.py 中的 op 列表。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

_ROOT = Path(__file__).resolve().parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from _envutil import load_dotenv_file
from _ops_help import CLI_EXAMPLES, EXEC_OPS_TEXT

load_dotenv_file(_ROOT / ".env")


def _base_url() -> str:
    host = os.environ.get("H1_X64DBG_DAEMON_HOST", "127.0.0.1").strip()
    port = os.environ.get("H1_X64DBG_DAEMON_PORT", "18765").strip()
    return f"http://{host}:{port}"


def http_get(path: str, timeout: float) -> tuple[int, dict[str, Any]]:
    url = _base_url() + path
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            return resp.status, json.loads(body)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, {"error": "non_json_body", "raw": raw}


def http_post_json(path: str, payload: dict, timeout: float) -> tuple[int, dict[str, Any]]:
    url = _base_url() + path
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={"Content-Type": "application/json; charset=utf-8"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8")
        return resp.status, json.loads(body)


def _build_parser() -> argparse.ArgumentParser:
    epilog = (EXEC_OPS_TEXT + "\n" + CLI_EXAMPLES).strip()
    p = argparse.ArgumentParser(
        prog="cli.py",
        description="H1 x64dbg bridge：通过本机 HTTP 调用 daemon（需先运行 daemon.py）。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=epilog,
    )
    sub = p.add_subparsers(dest="cmd", metavar="子命令", required=False)

    sp_h = sub.add_parser("health", help="GET /v1/health，检查 daemon 与调试会话快照")
    sp_h.add_argument("--timeout", type=float, default=10.0, help="秒")

    sp_e = sub.add_parser(
        "exec",
        help="POST /v1/exec：执行调试 op（见下方 op 列表）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="params 字段名与 daemon _dispatch 一致；复杂参数用 --params-json。",
    )
    sp_e.add_argument("--op", required=True, help="操作名，如 status / go / set_breakpoint")
    sp_e.add_argument(
        "--params-json",
        default="{}",
        help='JSON 对象，如 \'{"timeout_sec":30,"pass_exceptions":true}\'',
    )
    sp_e.add_argument(
        "--rva",
        default="",
        help="可选；并入 params.rva（相对 h1z1.exe，优先于 --addr）",
    )
    sp_e.add_argument(
        "--addr",
        default="",
        help="可选；并入 params.address（绝对 VA；堆栈或非 h1z1 映像时用）",
    )
    sp_e.add_argument(
        "--wait-timeout",
        type=float,
        default=120.0,
        help="HTTP 层等待 daemon 执行完毕的最长时间（秒）",
    )

    return p


def main() -> int:
    p = _build_parser()
    args = p.parse_args()

    if args.cmd is None:
        p.print_help()
        return 0

    try:
        if args.cmd == "health":
            code, obj = http_get("/v1/health", timeout=args.timeout)
            print(json.dumps(obj, ensure_ascii=False, indent=2))
            if code == 200:
                return 0
            if code == 503:
                st = obj.get("status")
                if st == "starting":
                    return 0
                if st == "start_failed":
                    return 1
            return 1

        if args.cmd == "exec":
            try:
                params = json.loads(args.params_json)
            except json.JSONDecodeError as e:
                print(f"params-json 无效: {e}", file=sys.stderr)
                return 2
            if not isinstance(params, dict):
                print("params-json 必须是 JSON 对象", file=sys.stderr)
                return 2

            rva_s = getattr(args, "rva", "") or ""
            if rva_s.strip():
                if "rva" not in params:
                    params["rva"] = rva_s.strip()
            addr_s = getattr(args, "addr", "") or ""
            if addr_s.strip():
                if "address" not in params and "addr" not in params and "rva" not in params:
                    params["address"] = addr_s.strip()

            op = args.op
            wait_http = args.wait_timeout
            if op == "wait_stopped":
                wait_http = max(
                    wait_http, float(params.get("timeout_sec", 30)) + 20.0
                )
            payload = {
                "op": op,
                "params": params,
                "wait_timeout_sec": wait_http,
            }
            code, obj = http_post_json("/v1/exec", payload, timeout=wait_http + 15.0)
            print(json.dumps(obj, ensure_ascii=False, indent=2))
            if not obj.get("ok"):
                return 1
            if op == "wait_stopped":
                data = obj.get("data") or {}
                if not data.get("stopped"):
                    return 3
            return 0 if code == 200 else 1

    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            print(json.dumps(json.loads(raw), ensure_ascii=False, indent=2))
        except json.JSONDecodeError:
            print(raw, file=sys.stderr)
        return 1
    except urllib.error.URLError as e:
        print(f"连接失败: {e}", file=sys.stderr)
        return 4

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
