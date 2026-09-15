"""HTTP POST /v1/exec 的 op 与 params 说明（供 cli.py / daemon --help 共用，避免与 _dispatch 漂移）。"""

EXEC_OPS_TEXT = """
exec 子命令通过 --op 指定操作，其它参数放 --params-json（JSON 对象）。
地址约定（凡涉及 h1z1.exe 映像内代码/数据）：优先 params.rva（与 Ghidra 一致，daemon 用 memmap 基址+RVA 抗 ASLR）。
params.address / addr 表示运行时绝对 VA（堆、栈、其它 DLL）；二者择一即可，同时给 rva 时以 rva 为准。
可选 CLI：--rva 并入 params.rva；--addr 并入 params.address（见 cli.py --help）。

  ping                    params: {}
  status | snapshot       params: {}
  go                      params: { "pass_exceptions": bool, "swallow_exceptions": bool }
  go_pass_burst           params: { "count"?: 1-200, "delay_sec"?, "swallow_exceptions"? }  # 连发 pass_exceptions go
  hit_capture             params: { "label"?, "memory"?:[{ "rva"?|"address"|"addr"|"reg" (如 rdx), "size"? }], "log"?, "skip_go"?, "pass_exceptions"?, "go_burst_after"?:0-200 }
                          # 断点命中后：快照+读内存→写入 logs/*.jsonl→默认一次 go(pass_exceptions=true) 撤离
  dbg_cmd                 params: { "cmd"|"command": "x64dbg 脚本命令" }  # bpcnd 等需 VA 时建议用 set_breakpoint/interest 返回的 va_hex，或 dbg_eval 取 mod.base 后自行拼
  dbg_eval                params: { "expr"|"expression": "x64dbg 表达式" }  # 例 mod.base("h1z1.exe")
  prepare_fun_1404f1080_std_bpx  params: { "rva"?: 默认 0x4F1080, "name"?, "fallback_symbol"? }
                          # 清全部断点；memmap 取 h1z1 基址+RVA 下标准 bpx（验 ASLR）；失败则 bpx h1z1+0x4F1080
  prepare_ucs_downstream_bps     params: { "clear_first"?: true, "arm_53d4e0"?: true, "arm_4ff870"?, "arm_4eb0f0"?, "arm_526310"?, "526310_singleshoot"?: true, "bpcnd_526310"? }
                          # UCS 下一环：可只下 53d4e0；53d4e0 多路径共用（死亡等也会进），建议 bpcnd ReadByte(rdx) 验 0F0A 或先 4f1080 再跟
                          # 526310/4ff870/4eb0f0 须显式 arm（526310 易刷断，建议 bpcnd）
  interest_bps_batch    params: { "clear_first"?: true, "points": [ { "rva"? (推荐)|"address"|"addr", "name"?, "singleshoot"?, "bpcnd"|"condition"? } ] }
                          # 一条 CLI 下多个兴趣断点；可选 H1_INTEREST_BPS_MAX 默认 48；bpcnd 里地址用解析后的 VA（见返回 va_hex）
  clear_breakpoint        params: { "rva"?|"address"|"addr"? }  # 全无 = 清全部软件断点；有 rva 则按 h1z1+RVA 解析后清除
  prepare_ucs_case9_bps   params: { "rva"?, "rva_511840"?, "rva_4f1080"?, "rva_53d4e0"? }  # 默认清 0x511840/0x4F1080/0x53D4E0 三处（均按 RVA），仅在 4F1080 设断 + UCS 包头 bpcnd
                          # 不写死 0x140……；返回 armed/cleared 中含解析后 va_hex
  wait_capture_resume     params: { "timeout_sec"?:1-600, "label"?, "memory"?, "log"?, "go_burst_after"?:1-200, "skip_resume"?: bool, "stay_paused"?: bool, "swallow_exceptions"?, "delay_sec"?,
                          "expect_h1_rva"?, "expect_cip"?, "expect_cip_any"?, "expect_regs"?, "max_spurious_resume"?, "spurious_go_burst"? }
                          # skip_resume 或 stay_paused=true：命中并写日志后**不**执行 go（便于链式下断点）；默认 false 仍 go_burst_after（默认 35）
                          # 可选 expect_*：CIP 须命中 h1z1+RVA 或 expect_cip(_any)；并可加 expect_regs。不匹配则 go×spurious_go_burst 后重等，超 max_spurious_resume 则失败。无 expect_* 时同旧版。
  pause                   params: {}
  set_breakpoint          params: { "rva"? (推荐)|"address"|"addr", "name"?, "singleshoot"? }
  wait_stopped            params: { "timeout_sec": int }
  read_memory             params: { "rva"?|"address"|"addr", "size"? }
  write_memory            params: { "rva"?|"address"|"addr", "hex"|"data_hex", "virt_protect"? }
  stepi | stepo           params: { "count"? }
  detach_session          params: {}
  terminate_session       params: {}
"""

CLI_EXAMPLES = """
示例（在 dev/x64dbg-bridge 下，需先启动 daemon.py 或 start-2016-with-client.sh）:
  py -3 cli.py health
  py -3 cli.py exec --op status
  py -3 cli.py exec --op go --params-json "{\\"pass_exceptions\\": true}"
  py -3 cli.py exec --op go_pass_burst --params-json "{\\"count\\":40}"
  py -3 cli.py exec --op hit_capture --params-json "{\\"label\\":\\"ucs\\",\\"memory\\":[{\\"rva\\":\\"0x0\\",\\"size\\":32}]}"
  py -3 cli.py exec --op prepare_ucs_downstream_bps
  # 上一行=清全部后只留 53d4e0（易误中死亡等）；建议 interest_bps_batch 给 53d4e0 加 ReadByte 条件或只用 prepare_ucs_case9_bps
  py -3 cli.py exec --op interest_bps_batch --params-json "{\\"clear_first\\":true,\\"points\\":[{\\"rva\\":\\"0x4F1080\\",\\"name\\":\\"ucs9\\",\\"bpcnd\\":\\"ReadByte(rdx)==0x0F && ReadByte(rdx+1)==0x0A\\"}]}"
  py -3 cli.py exec --op prepare_ucs_case9_bps
  py -3 cli.py exec --op wait_capture_resume --params-json "{\\"timeout_sec\\":120,\\"label\\":\\"ucs511840\\",\\"expect_h1_rva\\":\\"0x511840\\",\\"expect_regs\\":{\\"rdx\\":10},\\"skip_resume\\":true,\\"memory\\":[{\\"reg\\":\\"r8\\",\\"size\\":48}]}"
  py -3 ucs_entity_chain.py   # UCS case9：phase1 打印 rcx/rdx/r8/r9、64B dump、[缓冲+10] 22B；再 53d4e0→可选 526310
  py -3 cli.py exec --op set_breakpoint --rva 0x4f1080

注意: 改过 daemon.py 后必须重启 daemon（否则 unknown op）。
  py -3 cli.py exec --op read_memory --rva 0 --params-json "{\\"size\\": 16}"

环境: .env 中 H1_X64DBG_DAEMON_HOST / H1_X64DBG_DAEMON_PORT（默认 127.0.0.1:18765）
"""
