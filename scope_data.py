"""trace_scope 数据适配层：把任意 runs 目录解析成前端/服务端共用的统一结构。

来源适配（缺哪个都行，都有则 manifest 优先、records 补缺）:
    * <run>/manifest.json  — schema: run-v1（run_rl.py 写出，内含 episodes + step_records）
    * <run>/records/*.json — schema: trace-v2 / trace-v3（sandbox_workflow 逐 episode 落盘）
    * <run>/*__tN__sM.json — schema: trace-v2 / trace-v3（逐样本直接落盘在 run 目录）
统一输出:
    {"root": str, "runs": [{"id", "start", "end", "wall_s", "config", "episodes": [...]}]}
每个 episode 的 spans: [{"t": "gen"|"tool", "s": ms, "e": ms, ...}]
只读解析，不修改任何数据文件。
"""
from __future__ import annotations

import csv
import json
import re
from datetime import datetime
from pathlib import Path

CFG_KEYS = [
    "run_id", "n", "concurrency", "group_size", "model_name",
    "sandbox_backend", "bundle", "ttft", "decode_tps",
    "max_steps", "episode_timeout",
]

# 逐样本 trace 记录文件名：<trace>__t<task>__s<samp>.json 或 <v3>__<date>__gen__t<samp>.json（__tN 后可无 __sM）
SAMPLE_RE = re.compile(r".+__t\d+(?:__s\d+)?\.json$")


def parse_ts(s):
    if not s:
        return None
    s = str(s).strip().replace("T", " ")
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            return int(datetime.strptime(s, fmt).timestamp() * 1000)
        except ValueError:
            continue
    return None


def extract_steps(ep):
    steps = ep.get("steps")
    return steps if isinstance(steps, list) else (ep.get("step_records") or [])


def steps_to_spans(steps):
    """step → span 列表：request→response 为 gen（模型等待），tool_times 为 tool（bash 执行）。"""
    spans = []
    for st in steps:
        i = st.get("i", 0)
        s, e = parse_ts(st.get("request_at")), parse_ts(st.get("response_at"))
        if s is not None and e is not None:
            spans.append({
                "t": "gen", "s": s, "e": e, "i": i,
                "pt": st.get("prompt_tokens"), "ct": st.get("completion_tokens"),
                "ttft": st.get("ttft_s"), "tps": st.get("decode_tps"),
            })
        tools = st.get("tool_times") or []
        cmds = st.get("commands") or []
        exits = st.get("exits") or []
        for k, tt in enumerate(tools):
            tt = tt or []
            ts_, te_ = parse_ts(tt[0] if tt else None), parse_ts(tt[1] if len(tt) > 1 else None)
            if ts_ is None or te_ is None:
                continue
            spans.append({
                "t": "tool", "s": ts_, "e": te_, "i": i,
                "cmd": cmds[k] if k < len(cmds) else (cmds[-1] if cmds else ""),
                "exit": exits[k] if k < len(exits) else None,
            })
    spans.sort(key=lambda x: x["s"])
    return spans


def _merge_iv(spans, start, end, fallback=True):
    """span 区间合并（并发口径）；fallback=False 时无 span 返回空而非整条 episode。"""
    out: list[list[int]] = []
    for s, e in sorted(([sp["s"], sp["e"]] for sp in spans), key=lambda x: x[0]):
        if out and s <= out[-1][1]:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    if not out and fallback:
        out = [[start, end if end is not None else start]]
    return out


def _span_stats(spans):
    """gen/tool 块耗时统计 [条数, 累计秒, 最大秒]（Lane 统计口径）。"""
    st = {"g": [0, 0.0, 0.0], "t": [0, 0.0, 0.0]}
    for sp in spans:
        d = (sp["e"] - sp["s"]) / 1000
        k = "g" if sp["t"] == "gen" else "t"
        st[k][0] += 1
        st[k][1] += d
        st[k][2] = max(st[k][2], d)
    st["g"][1] = round(st["g"][1], 3)
    st["t"][1] = round(st["t"][1], 3)
    return st


def _tool_call_stats(spans, to_s=299.0):
    """工具调用单次耗时口径（per-traj 宽表 / calc.md §8）：
    n/sum=全量条数与累计秒；to=≥299s 的超时条数；nc/sc=剔除超时后的条数/累计秒（单次均值=sc/nc）。"""
    durs = [(sp["e"] - sp["s"]) / 1000 for sp in spans if sp["t"] == "tool"]
    keep = [d for d in durs if d < to_s]
    return {
        "n": len(durs), "sum": round(sum(durs), 3),
        "to": len(durs) - len(keep),
        "nc": len(keep), "sc": round(sum(keep), 3),
    }


def _top_gen(spans, n=8):
    """最慢推理段 TOP-N（全局 TOP-N 必落在各 episode TOP-N 的并集里）。"""
    gens = sorted((sp for sp in spans if sp["t"] == "gen"),
                  key=lambda sp: sp["e"] - sp["s"], reverse=True)
    return [{
        "t": "gen", "i": sp["i"], "s": sp["s"], "e": sp["e"],
        "d": round((sp["e"] - sp["s"]) / 1000, 3),
        "pt": sp.get("pt"), "ct": sp.get("ct"),
        "tps": sp.get("tps"), "ttft": sp.get("ttft"),
    } for sp in gens[:n]]


def _peak_of(episodes):
    """并发峰值（绝对时钟）：rec=记录条数，samp=去重样本数。"""
    rec_ev, samp_ev = [], []
    by_samp: dict = {}
    for ep in episodes:
        for s, e in ep["iv"]:
            rec_ev.append((s, 1))
            rec_ev.append((e, -1))
        by_samp.setdefault((ep["task"], ep["samp"]), []).extend(ep["iv"])
    for ivs in by_samp.values():
        ivs.sort()
        cs = ce = None
        for s, e in ivs:
            if cs is None:
                cs, ce = s, e
            elif s <= ce:
                ce = max(ce, e)
            else:
                samp_ev.append((cs, 1))
                samp_ev.append((ce, -1))
                cs, ce = s, e
        if cs is not None:
            samp_ev.append((cs, 1))
            samp_ev.append((ce, -1))

    def pk(ev):
        c = p = 0
        for _, d in sorted(ev, key=lambda x: (x[0], x[1])):
            c += d
            p = max(p, c)
        return p

    return {"rec": pk(rec_ev), "samp": pk(samp_ev)}


def build_episode(ep, with_spans=True, src=None):
    steps = extract_steps(ep)
    spans = steps_to_spans(steps)
    trace = ep.get("trace") or "?"
    task = ep.get("task_id", 0)
    samp = ep.get("sample_idx", 0)

    start, end = parse_ts(ep.get("started_at")), parse_ts(ep.get("finished_at"))
    if start is None and spans:
        start = spans[0]["s"]
    if end is None and spans:
        end = spans[-1]["e"]

    gen_s = ep.get("gen_s")
    tool_s = ep.get("tool_s")
    if gen_s is None:
        gen_s = sum(x["e"] - x["s"] for x in spans if x["t"] == "gen") / 1000
    if tool_s is None:
        tool_s = sum(x["e"] - x["s"] for x in spans if x["t"] == "tool") / 1000

    wall = ep.get("wall_s")
    if not wall and start is not None and end is not None:
        wall = (end - start) / 1000

    failed = ep.get("failed_steps")
    if failed is None:
        failed = sum(1 for st in steps if any(x != 0 for x in (st.get("exits") or [0])))

    # 录制数据标记：trace-v3 是数据集生成时落盘的录制轨迹（带 source_run），
    # 回放由 sandbox_workflow 写 trace-v2。对比视图靠它把「录制基线」与回放路分开。
    schema = str(ep.get("schema") or "")
    recorded = 1 if (schema.endswith("-v3") or ep.get("source_run")) else 0

    # 推理量：录制轨迹逐步记了 prompt/completion token 与 ttft；回放把 token 数原样带下来，
    # 但不起模型（replay 直接 sleep 录制时的每步延迟），所以两路 gen 秒数天生相同。
    # 要跨模型 / 跨硬件比，只能用 token 数重算 gen = ttft + completion ÷ 吞吐。
    tot = ep.get("totals") or {}
    ct = tot.get("completion_tokens")
    pt = tot.get("prompt_tokens")
    tt = tot.get("ttft_sum_s")
    if ct is None:
        ct = sum(int(st.get("completion_tokens") or 0) for st in steps)
    if pt is None:
        pt = sum(int(st.get("prompt_tokens") or 0) for st in steps)
    if tt is None:
        tt = sum(float(st.get("ttft_s") or 0) for st in steps)
    ct, pt, tt = int(ct or 0), int(pt or 0), float(tt or 0)
    # tps 用「去掉首 token 等待后的纯解码速率」，逐步 decode_tps 在 token 数很小的步上会被
    # 除零放大成几十万，只做整条的才可比
    tps = ct / (gen_s - tt) if gen_s and gen_s > tt else 0.0

    out = {
        "id": f"{trace}__t{task}__s{samp}",
        "seq": ep.get("seq"),
        "trace": trace, "task": task, "samp": samp,
        "issue": ep.get("issue_id") or "",
        "start": start, "end": end,
        "wall": round(wall or 0.0, 3),
        "gen_s": round(gen_s or 0.0, 3), "tool_s": round(tool_s or 0.0, 3),
        "n_steps": len(steps), "failed": failed,
        "rec": recorded,
        "tok": {"ct": ct, "pt": pt, "ttft": round(tt, 3), "tps": round(tps, 2)},
        "stop": ep.get("stop_reason") or "",
        "reward": ep.get("reward"),
        # 预聚合（概要层下发，波形 spans 按需加载后这些统计不再依赖全量 span）
        "iv": _merge_iv(spans, start, end),   # 全部 span 区间合并（沙箱上下文并发口径）
        "tiv": _merge_iv([sp for sp in spans if sp["t"] == "tool"], start, end, fallback=False),
                                              # 仅 tool span 合并（沙箱内实际占用口径）；无工具调用为空
        "ag": _span_stats(spans),             # gen/tool 块耗时 [条数, 累计秒, 最大秒]
        "tstat": _tool_call_stats(spans),     # 工具单次耗时口径（300s 超时剔除，宽表/对比用）
        "top": _top_gen(spans),               # 最慢推理段 TOP-8
    }
    # 文件来源：仅服务端按需读取 spans 时用，不下发概要层；src=(run_dir, file_path)
    if src is not None:
        out["_src"] = src
    if with_spans:
        out["spans"] = spans
    return out


def load_run(run_dir: Path, with_spans: bool = True):
    episodes, cfg = [], {}
    manifest = run_dir / "manifest.json"
    mani = {}
    if manifest.exists():
        try:
            mani = json.loads(manifest.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            mani = {}
        cfg = mani.get("config") or {}
    if not cfg and (run_dir / "run.json").exists():
        try:
            cfg = json.loads((run_dir / "run.json").read_text(encoding="utf-8")).get("config") or {}
        except (json.JSONDecodeError, OSError):
            pass

    # records/*.json 是权威来源：每条 episode 都有独立小文件，src 指向它，
    # 按需读 spans 时 O(单文件)。manifest 只提供 config 和 records 缺失时补缺。
    file_src = {}  # (trace, task, samp) -> 文件路径；重跑副本按出现顺序分配
    rec_dir = run_dir / "records"
    if rec_dir.is_dir():
        for f in sorted(rec_dir.glob("*.json")):
            try:
                head = json.loads(f.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            key = (head.get("trace"), head.get("task_id", 0), head.get("sample_idx", 0))
            file_src.setdefault(key, []).append(str(f))

    def take_src(trace, task, samp, used):
        paths = file_src.get((trace, task, samp)) or []
        n = used.get((trace, task, samp), 0)
        if n < len(paths):
            used[(trace, task, samp)] = n + 1
            return ("file", paths[n])
        return None

    used = {}
    for i, ep in enumerate(mani.get("episodes") or []):
        tr, tk, sp = ep.get("trace"), ep.get("task_id", 0), ep.get("sample_idx", 0)
        src = take_src(tr, tk, sp, used)
        if src is None:  # records 没有这条，退回 manifest 内嵌 steps
            src = ("manifest", str(manifest), i)
        episodes.append(build_episode(ep, with_spans, src))

    # records 里有、manifest 没用到的 episode 全部补进来。
    # 同键多文件 = 重跑副本（数据命名约定 __dN 文件名后缀），一并收入，
    # 由末尾 __dN 重命名区分；已被 take_src 分配给 manifest 条目的文件不重复加。
    used_files = {e["_src"][1] for e in episodes if e.get("_src") and e["_src"][0] == "file"}
    for f in sorted(rec_dir.glob("*.json")) if rec_dir.is_dir() else []:
        if str(f) in used_files:
            continue
        try:
            ep = build_episode(json.loads(f.read_text(encoding="utf-8")),
                               with_spans, ("file", str(f)))
        except (json.JSONDecodeError, OSError):
            continue
        episodes.append(ep)

    # 逐样本记录直接落在 run 目录（命名：<trace>__tN__sM.json）
    for f in sorted(run_dir.glob("*.json")):
        if not SAMPLE_RE.match(f.name):
            continue
        try:
            ep = build_episode(json.loads(f.read_text(encoding="utf-8")),
                               with_spans, ("file", str(f)))
        except (json.JSONDecodeError, OSError):
            continue
        if ep["id"] not in {e["id"] for e in episodes}:
            episodes.append(ep)

    # 没有时间信息的 episode 无法排时间轴；全部缺失时整个 run 不可用
    episodes = [e for e in episodes if e["start"] is not None]
    if not episodes:
        return None
    episodes.sort(key=lambda e: e["start"])
    # 同一 (trace, task, sample) 的重跑（dispatcher 超发等）按数据命名约定加 __dN 区分
    seen = set()
    rerun = {}
    for e in episodes:
        base = e["id"]
        if base not in seen:
            seen.add(base)
            continue
        n = rerun.get(base, 0) + 1
        rerun[base] = n
        e["id"] = f"{base}__d{n}"
        e["rerun"] = n
        while e["id"] in seen:
            n += 1
            e["id"] = f"{base}__d{n}"
        seen.add(e["id"])
    for e in episodes:
        label = f"t{e['task']} s{e['samp']}"
        if e.get("rerun"):
            label += f" d{e['rerun']}"
        e["label"] = label
    starts = [e["start"] for e in episodes]
    ends = [e["end"] or e["start"] for e in episodes]
    # 资产发现：guest.csv（guest 视角）与 memlog（host 视角），只记路径不下发内容，
    # 前端一键加载按这些路径取数；两种布局都认：file 直接在 run 根，或藏在 records/host 子目录。
    guest_files = sorted(set(list(run_dir.glob("*.guest.csv")) +
                             list((run_dir / "records").glob("*.guest.csv"))))
    guest_assets = [{"samp": (GUEST_CSV_RE.match(f.name).group(2)
                              if GUEST_CSV_RE.match(f.name) else "0"),
                     "path": str(f)} for f in guest_files]
    # memlog 三种布局都认：run 根 / run 的 host·measure 子目录 / 父目录层
    # （老布局里整机 memlog 采在 run 的父目录或父目录的 measure 子目录，多个 run 共用一份）
    mem_assets = []
    seen_mem = set()
    for sub in (run_dir, run_dir / "host", run_dir / "measure",
                run_dir.parent, run_dir.parent / "measure", run_dir.parent / "host"):
        if not sub.is_dir():
            continue
        for f in sorted(sub.glob("memlog.jsonl")):
            if str(f) not in seen_mem:
                seen_mem.add(str(f))
                mem_assets.append(str(f))

    return {
        "id": run_dir.name,
        "start": min(starts), "end": max(ends),
        "wall_s": round((max(ends) - min(starts)) / 1000, 3),
        "config": {k: cfg[k] for k in CFG_KEYS if k in cfg},
        "peak": _peak_of(episodes),  # 并发峰值预聚合
        "assets": {"guest": guest_assets, "memlog": mem_assets},
        "episodes": episodes,
    }


def is_run_dir(p: Path) -> bool:
    return ((p / "manifest.json").exists() or (p / "records").is_dir()
            or any(SAMPLE_RE.match(f.name) for f in p.glob("*.json")))


def discover(root: Path, with_spans: bool = True):
    """root 及其下两层子目录里的 run 目录（run 目录不再下钻）。

    覆盖布局：run 直接在 root 下、<task>/（逐任务 run）。
    """
    runs = []

    def scan(d: Path, depth: int):
        if is_run_dir(d):
            r = load_run(d, with_spans)
            if r:
                # id 用相对路径消歧（不同批次下可能有同名任务目录）
                rel = d.relative_to(root).as_posix()
                r["id"] = rel if rel != "." else d.name
                runs.append(r)
            return
        if depth >= 2:
            return
        try:
            kids = sorted(p for p in d.iterdir() if p.is_dir())
        except OSError:
            return
        for k in kids:
            scan(k, depth + 1)

    scan(root, 0)
    return runs


def build_payload(root, with_spans: bool = True) -> dict:
    root = Path(root).resolve()
    runs = discover(root, with_spans)
    return {"root": str(root), "runs": runs}


def src_map(payload) -> dict:
    """ {run_id: {ep_id: {"src": src, "iv": [[s,e],...]}}}，供 /api/spans 先按 iv 裁剪再读单文件。"""
    return {
        r["id"]: {
            ep["id"]: {"src": ep.get("_src"), "iv": ep.get("iv") or []}
            for ep in r["episodes"]
        }
        for r in payload["runs"]
    }


def spans_of_episode(src):
    """按需从单个 episode 源文件 / manifest 条目重建 spans（只读一条，不扫全 run）。

    src=("file", path) 直接读该 json；src=("manifest", path, idx) 读 manifest 第 idx 条。
    返回 build_episode 口径的 spans 列表；读失败返回空列表。
    """
    if not src:
        return []
    try:
        if src[0] == "file":
            ep = json.loads(Path(src[1]).read_text(encoding="utf-8"))
        elif src[0] == "manifest":
            with Path(src[1]).open(encoding="utf-8") as fh:
                m = json.load(fh)
            ep = (m.get("episodes") or [])[src[2]]
        else:
            return []
    except (json.JSONDecodeError, OSError, IndexError, TypeError):
        return []
    return steps_to_spans(extract_steps(ep))


# ── guest 采样（guest_probe / guest.csv）────────────────────────────
# 每个 episode 一份，文件名 <trace>__sN.guest.csv，注入 guest 内读 /proc 得到，
# 与 host 的 per_vm（宿主 fc 进程视角）是两种独立采样，不能混为一谈。
# ts 是浮点 epoch 秒（guest 时钟，与轨迹时钟同步），字段为 /proc/meminfo + 派生量：
#   total/avail/free/cached/buffers/shmem/anon_kb, pgfault, pgmajfault,
#   rx/tx_bytes+ pkt, procs, chrome_rss, node_rss, py_rss, iowait_ticks,
#   pgpgin/pgpgout_kb, pgscan, pgsteal, refault, disk_rd/wr_kb, ctxt
# 两种表头：早期 20 字段、当前 30 字段；按实际表头解析，缺字段不报错。
GUEST_CSV_RE = re.compile(r"(.+)__s(\d+)\.guest\.csv$")

# 字段展示名 / 单位：前端字段面板与 guest 视图共用
GUEST_FIELDS = {
    "anon_kb": "匿名页 MB", "cached_kb": "页缓存 MB", "avail_kb": "可用 MB",
    "free_kb": "空闲 MB", "buffers_kb": "缓冲 MB", "shmem_kb": "共享 MB",
    "total_kb": "总内存 MB", "pgfault": "缺页/次", "pgmajfault": "主缺页/次",
    "rx_bytes": "收 MB", "tx_bytes": "发 MB", "rx_pkt": "收包", "tx_pkt": "发包",
    "rx_drop": "丢包", "procs": "进程数", "chrome_rss": "chrome RSS",
    "chrome_n": "chrome 数", "node_rss": "node RSS", "py_rss": "python RSS",
    "iowait_ticks": "iowait tick", "steal_ticks": "steal tick",
    "pgpgin_kb": "换入 MB", "pgpgout_kb": "换出 MB", "pgscan": "扫描页",
    "pgsteal": "回收页", "refault": "refault", "disk_rd_kb": "磁盘读 MB",
    "disk_wr_kb": "磁盘写 MB", "ctxt": "上下文切换",
}
# 需要 /1024 转成 MB 的字段
GUEST_KB_FIELDS = {
    "anon_kb", "cached_kb", "avail_kb", "free_kb", "buffers_kb", "shmem_kb",
    "total_kb", "pgpgin_kb", "pgpgout_kb", "disk_rd_kb", "disk_wr_kb",
}


def guest_field_scale(field: str) -> float:
    return 1 / 1024.0 if field in GUEST_KB_FIELDS else 1.0


def list_guest_csv(path_str: str) -> dict:
    """列出目录里（含 records/ 子目录）的 guest.csv 候选，并给出可进入的子目录。"""
    p = Path(path_str).expanduser().resolve() if path_str else Path.home()
    if not p.is_dir():
        raise ValueError(f"目录不存在: {p}")
    dirs, files = [], []
    try:
        for child in sorted(p.iterdir()):
            if child.name.startswith("."):
                continue
            if child.is_dir():
                dirs.append({"name": child.name,
                             "n_guest": len(list(child.glob("*.guest.csv")))})
            elif child.is_file() and GUEST_CSV_RE.match(child.name):
                st = child.stat()
                files.append({"name": child.name, "size": st.st_size,
                              "mtime": int(st.st_mtime)})
    except PermissionError:
        raise ValueError(f"无权限读取: {p}")
    parent = str(p.parent) if p.parent != p else None
    return {"path": str(p), "parent": parent, "dirs": dirs, "files": files}


def load_guest_csv(path_str: str, max_points: int = 2400) -> dict:
    """解析单份 guest.csv → 各字段时间序列（t=epoch ms，只读）。

    返回结构与 load_memlog 保持一致（fields/series/range/t0/t1/n），
    前端可复用同一套字段面板；额外带 trace/samp 便于和轨迹配对。
    数值保持原始单位（_kb 字段前端按 GUEST_KB_FIELDS 换算），peak/range 同原始单位。
    """
    p = Path(path_str).expanduser().resolve()
    if not p.is_file():
        raise ValueError(f"文件不存在: {p}")
    m = GUEST_CSV_RE.match(p.name)
    trace = m.group(1) if m else p.name.replace(".guest.csv", "")
    samp = int(m.group(2)) if m else 0

    fields: list[str] = []
    series: dict[str, list] = {}
    n = 0
    t0 = t1 = None
    with open(p, encoding="utf-8", errors="replace", newline="") as f:
        rd = csv.DictReader(f)
        head = rd.fieldnames or []
        fields = [k for k in head if k and k != "ts"]
        for k in fields:
            series[k] = []
        for row in rd:
            raw = row.get("ts")
            if raw is None:
                continue
            try:
                t = int(float(raw) * 1000)
            except (ValueError, TypeError):
                continue
            for k in fields:
                v = row.get(k)
                if v is None or v == "":
                    continue
                try:
                    series[k].append([t, float(v)])
                except (ValueError, TypeError):
                    continue
            n += 1
            if t0 is None or t < t0:
                t0 = t
            if t1 is None or t > t1:
                t1 = t
    if n == 0:
        raise ValueError("guest.csv 没有解析到数据行")
    # 与 memlog 一致：每字段保 min/max 降采样，峰值不丢
    series = {k: _downsample_minmax(v, max_points) for k, v in series.items()}
    rng = {}
    for k, pts in series.items():
        vs = [v for _, v in pts]
        rng[k] = [min(vs), max(vs)] if vs else [0.0, 0.0]
    return {
        "path": str(p), "trace": trace, "samp": samp,
        "n": n, "t0": t0, "t1": t1,
        "fields": fields, "series": series, "range": rng,
    }


def load_runs_guest(run_dir: Path, max_points: int = 1200) -> dict:
    """解析一个 run 目录下全部 guest.csv → {trajs:[{samp,label,fields,series,range,t0,t1,n},...], ...}。

    samp 直接取文件名 __sN，与轨迹的 sample_idx 对应；这份是 guest 视角采样，
    不依赖 host memlog，也不和 per_vm 混用。
    """
    d = Path(run_dir)
    files = sorted(list(d.glob("*.guest.csv")) + list((d / "records").glob("*.guest.csv")))
    trajs = []
    t0 = t1 = None
    for f in files:
        try:
            g = load_guest_csv(str(f), max_points)
        except (ValueError, OSError):
            continue
        trajs.append({
            "samp": g["samp"], "label": "s" + str(g["samp"]),
            "trace": g["trace"], "path": g["path"],
            "n": g["n"], "t0": g["t0"], "t1": g["t1"],
            "fields": g["fields"], "series": g["series"], "range": g["range"],
        })
        if t0 is None or g["t0"] < t0:
            t0 = g["t0"]
        if t1 is None or g["t1"] > t1:
            t1 = g["t1"]
    trajs.sort(key=lambda x: x["samp"])
    if not trajs:
        raise ValueError("这个 run 没有 guest.csv（guest 采样未开启）")
    return {"path": str(d), "trajs": trajs, "t0": t0, "t1": t1,
            "n": len(trajs), "fields": trajs[0]["fields"]}


def summary_of(payload) -> dict:
    """概要层：去掉 spans（体积占绝大部分），保留元信息 + 预聚合（iv/ag/top/peak）。
    波形 span 由 /api/spans 按可视时间窗按需加载。"""
    runs = []
    for r in payload["runs"]:
        eps = [{k: v for k, v in ep.items() if k not in ("spans", "_src")}
               for ep in r["episodes"]]
        runs.append({**{k: v for k, v in r.items() if k != "episodes"}, "episodes": eps})
    return {"root": payload["root"], "lazy": True, "runs": runs}


# ── memlog（内存采样日志 / datalog）解析 ─────────────────────────────
# 两种格式，都是 key=value 采样行：
#   A. memlog / *.memlog   ts=YYYY-MM-DD HH:MM:SS cell=xxx avail_mb=... anon_mb=... （绝对日期）
#   B. *.mem.log           HH:MM:SS used=... avail=... cg=... anon=... （仅时分秒，按 ref 就近对齐日期）
_TS_RE = re.compile(r"ts=(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})")
_TOD_RE = re.compile(r"^(\d{2}):(\d{2}):(\d{2})\b")
_KV_RE = re.compile(r"(\w+)=([^\s]+)")


def _is_memlog_name(name: str) -> bool:
    n = name.lower()
    return "mem" in n and "log" in n


def list_memlogs(path_str: str) -> dict:
    """列出目录里的 datalog 候选文件（文件名含 mem+log）与可进入的子目录。"""
    p = Path(path_str).expanduser().resolve() if path_str else Path.home()
    if not p.is_dir():
        raise ValueError(f"目录不存在: {p}")
    dirs, files = [], []
    try:
        for child in sorted(p.iterdir()):
            if child.name.startswith("."):
                continue
            if child.is_dir():
                has_mem = any(_is_memlog_name(f.name) for f in child.iterdir() if f.is_file())
                dirs.append({"name": child.name, "has_mem": has_mem})
            elif child.is_file() and _is_memlog_name(child.name):
                st = child.stat()
                files.append({"name": child.name, "size": st.st_size, "mtime": int(st.st_mtime)})
    except PermissionError:
        raise ValueError(f"无权限读取: {p}")
    parent = str(p.parent) if p.parent != p else None
    return {"path": str(p), "parent": parent, "dirs": dirs, "files": files}


def _flat_num(d: dict, pre: str = ""):
    """嵌套 dict 的数值拍平成 a.b.c 字段名（int/float/数字字符串）；bool 与非数值跳过。"""
    for k, v in d.items():
        if isinstance(v, dict):
            yield from _flat_num(v, pre + k + ".")
        elif isinstance(v, bool):
            continue
        elif isinstance(v, (int, float)):
            yield pre + k, float(v)
        elif isinstance(v, str):
            try:
                yield pre + k, float(v)
            except ValueError:
                continue


def _memlog_ts_ms(s: str, cache: dict) -> int:
    """'YYYY-MM-DD HH:MM:SS' → epoch ms。日期只 strptime 一次，其余靠切片。"""
    day = s[:10]
    base = cache.get(day)
    if base is None:
        base = int(datetime.strptime(day, "%Y-%m-%d").timestamp() * 1000)
        cache[day] = base
    return base + (int(s[11:13]) * 3600 + int(s[14:16]) * 60 + int(s[17:19])) * 1000


def _iter_jsonl(f, dc):
    """JSONL（measure/memlog.jsonl）：每行一条采样
    {"ts", "mem", "vm", "cg", "psi", "derived", ...}，嵌套数值（含数字字符串）
    拍平成 a.b.c 字段名。产出 (t_epoch_ms, vals)。"""
    for line in f:
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            d = json.loads(line)
            t = _memlog_ts_ms(str(d.get("ts", ""))[:19], dc)
        except (ValueError, TypeError, KeyError):
            continue
        vals = dict(_flat_num(d))
        if vals:
            yield t, vals


def _iter_kv(f, ref: float):
    """key=value 采样行；时间戳 ts=YYYY-MM-DD HH:MM:SS 或行首 HH:MM:SS（按 ref 对齐日期）。产出 (t_epoch_ms, vals)。"""
    for line in f:
        line = line.strip()
        if not line:
            continue
        t = None
        m = _TS_RE.search(line)
        if m:
            t = int(datetime.strptime(m.group(1) + " " + m.group(2), "%Y-%m-%d %H:%M:%S").timestamp() * 1000)
        else:
            m2 = _TOD_RE.match(line)
            if m2:
                tod = int(m2.group(1)) * 3600 + int(m2.group(2)) * 60 + int(m2.group(3))
                base = datetime.fromtimestamp(ref / 1000).replace(hour=0, minute=0, second=0, microsecond=0)
                t = int((base.timestamp() + tod) * 1000)
                while t - ref > 43200000:
                    t -= 86400000
                while ref - t > 43200000:
                    t += 86400000
        if t is None:
            continue
        vals = {}
        for k, v in _KV_RE.findall(line):
            if k == "ts":
                continue
            try:
                vals[k] = float(v)
            except ValueError:
                continue
        if vals:
            yield t, vals


def load_memlog(path_str: str, ref_ms=None, max_points: int = 2400) -> dict:
    """解析 memlog 文件 → 各字段时间序列（t=epoch ms，只读）。

    JSONL 大文件（几百 MB、上万采样点、上千字段）用时间窗聚合降采样：
    每窗每字段保 min/max 两点（极值不丢），每字段点数 ≤ max_points。
    cg.* 等字段照常解析（前端按分组自行勾选显隐，不在解析层丢弃）。

    ref_ms：仅时分秒格式（HH:MM:SS）时用于确定日期，取离 ref 最近的一天（跨零点 ±24h 择近）。
    max_points：每字段点数上限（默认 2400），超出按时间窗口保 min/max 降采样；<=0 不降采样。
    """
    p = Path(path_str).expanduser().resolve()
    if not p.is_file():
        raise ValueError(f"文件不存在: {p}")
    ref = float(ref_ms) if ref_ms else datetime.now().timestamp() * 1000
    with open(p, "rb") as fb:
        n_lines = sum(buf.count(b"\n") for buf in iter(lambda: fb.read(1 << 20), b""))
    # 时间窗行宽：每窗每字段保 min/max 两点 → 字段点数 ≤ max_points（极值不丢）；<=0 不降采样
    wins = max(1, (max_points or 0) // 2) if max_points and max_points > 0 else max(1, n_lines)
    rows_per_win = max(1, (n_lines + wins - 1) // wins)
    order: list[str] = []
    seen: set[str] = set()
    series: dict = {}
    win: dict = {}   # 当前窗聚合 {k: [min_v, min_t, max_v, max_t]}
    win_idx = -1
    n = 0
    t0 = t1 = None

    def flush():
        for k, (mnv, mnt, mxv, mxt) in win.items():
            s = series.setdefault(k, [])
            if mnt == mxt and mnv == mxv:
                s.append([mnt, mnv])
            elif mnt <= mxt:
                s.append([mnt, mnv])
                s.append([mxt, mxv])
            else:
                s.append([mxt, mxv])
                s.append([mnt, mnv])
        win.clear()

    with open(p, encoding="utf-8", errors="replace") as f:
        is_jsonl = f.readline().lstrip().startswith("{")
        f.seek(0)
        dc: dict[str, int] = {}
        it = _iter_jsonl(f, dc) if is_jsonl else _iter_kv(f, ref)
        for i, (t, vals) in enumerate(it):
            b = i // rows_per_win
            if b != win_idx:
                flush()
                win_idx = b
            for k, v in vals.items():
                if k.startswith("cg.io."):
                    # cg.io.<块设备>.* 按设备逐个展开（单文件可达数千字段、字段数爆炸且前端默认隐藏），整体丢弃；
                    # 其余 cg.*（stat/events/cpu/psi 等稳定家族）照常保留
                    continue
                if k.startswith("per_vm."):
                    # 每沙箱明细（pid → rss/pss/cpu/io）拍平后是几百个字段，会把字段面板冲垮；
                    # 它单独走 load_memlog_vm 的解析与 per-VM 面板
                    continue
                if k not in seen:
                    seen.add(k)
                    order.append(k)
                cur = win.get(k)
                if cur is None:
                    win[k] = [v, t, v, t]
                else:
                    if v < cur[0]:
                        cur[0], cur[1] = v, t
                    if v > cur[2]:
                        cur[2], cur[3] = v, t
            n += 1
            if t0 is None or t < t0:
                t0 = t
            if t1 is None or t > t1:
                t1 = t
    flush()
    if n == 0:
        raise ValueError("没有解析到数据点（需要 ts=日期时间 或 HH:MM:SS 开头的 key=value 行）")
    if is_jsonl:
        # 字段顺序：友好段优先（derived/psi/cg/mem/vm/node），段内保持发现顺序
        prio = {"derived": 0, "psi": 1, "cg": 2, "mem": 3, "vm": 4, "node": 5}
        order.sort(key=lambda k: prio.get(k.split(".")[0], 6))
    for k in order:
        series[k].sort(key=lambda pt: pt[0])
    rng = {}
    for k in order:
        vs = [v for _, v in series[k]]
        rng[k] = [min(vs), max(vs)] if vs else [0.0, 0.0]
    return {
        "path": str(p), "n": n,
        "t0": t0, "t1": t1,
        "fields": order, "series": series, "range": rng,
    }


# ── 每沙箱（per-VM）明细 ─────────────────────────────────────────────
# memlog 的 per_vm 段按 pid 列出每个 Firecracker 进程的占用：
#   {pid: {api_sock, cg, rss_mb, swap_mb, threads, cpu_pct,
#          smaps:{rss_kb,pss_kb,anon_kb,file_kb},
#          io:{rchar,wchar,...}, io_rate:{read_mb_s,write_mb_s}}}
# 这一层和主机级 / cgroup 级字段不是同一种东西：它回答的是「哪个沙箱吃掉多少、
# 活了多久、什么时候回收」，所以单独解析、单独开面板。
VM_METRICS = {
    "rss": ("rss_mb", 1.0),
    "pss": (("smaps", "pss_kb"), 1 / 1024.0),
    "anon": (("smaps", "anon_kb"), 1 / 1024.0),
    "file": (("smaps", "file_kb"), 1 / 1024.0),
    "cpu": ("cpu_pct", 1.0),
    "io_r": (("io_rate", "read_mb_s"), 1.0),
    "io_w": (("io_rate", "write_mb_s"), 1.0),
    "threads": ("threads", 1.0),
}


def _vm_val(v: dict, key):
    """按 ('smaps','pss_kb') / 'rss_mb' 两种写法取嵌套值。"""
    if isinstance(key, tuple):
        cur = v
        for k in key:
            cur = cur.get(k) if isinstance(cur, dict) else None
        val = cur
    else:
        val = v.get(key)
    try:
        return float(val or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _downsample_minmax(pts: list, max_points: int) -> list:
    """按时间窗保 min/max 两点降采样（峰值不丢），点数 ≤ max_points。"""
    if not max_points or max_points <= 0 or len(pts) <= max_points:
        return pts
    wins = max(1, max_points // 2)
    step = (len(pts) + wins - 1) // wins
    out = []
    for i in range(0, len(pts), step):
        chunk = pts[i:i + step]
        if not chunk:
            continue
        if len(chunk) == 1:
            out.append(chunk[0])
            continue
        lo = min(chunk, key=lambda p: p[1])
        hi = max(chunk, key=lambda p: p[1])
        out.extend([lo, hi] if lo[0] <= hi[0] else [hi, lo])
    return out


def _vm_label(sid: str, pid: str) -> str:
    """agentenv-fc-3abVEs → 3abVEs；没有 api_sock 就用 pid 尾巴。"""
    sid = str(sid or "")
    if sid.startswith("agentenv-fc-"):
        return sid[len("agentenv-fc-"):]
    return sid or ("pid" + str(pid)[-5:])


def load_memlog_vm(path_str: str, metric: str = "rss", max_points: int = 520) -> dict:
    """解析 memlog 的 per_vm 段 → 每沙箱一条曲线 + 每采样的汇总。

    返回
      agg：每采样的活跃沙箱数 / Σrss / Σpss / Σanon / Σcpu / Σio（只取一个标量序列）
      vms：每个沙箱 {sid,pid,label,t0,t1,n,peak,pts}，pts 为所选 metric 的时间序列
    metric 只影响 vms[].pts；agg 里的各量始终齐全，切换指标不必重取。
    """
    p = Path(path_str).expanduser().resolve()
    if not p.is_file():
        raise ValueError(f"文件不存在: {p}")
    if metric not in VM_METRICS:
        metric = "rss"
    key, scale = VM_METRICS[metric]
    agg_keys = ("n", "n_live", "rss", "pss", "anon", "cpu", "io_r", "io_w")
    agg_pts = {k: [] for k in agg_keys}
    vms: dict = {}
    dc: dict = {}
    n_samples = 0
    n_pv = 0
    t0 = t1 = None
    with open(p, encoding="utf-8", errors="replace") as f:
        if not f.readline().lstrip().startswith("{"):
            raise ValueError("per-VM 明细只存在于 JSONL 格式的 memlog")
        f.seek(0)
        for line in f:
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                d = json.loads(line)
                t = _memlog_ts_ms(str(d.get("ts", ""))[:19], dc)
            except (json.JSONDecodeError, ValueError, TypeError):
                continue
            pv = d.get("per_vm") or {}
            if not isinstance(pv, dict):
                pv = {}
            if pv:
                n_pv += 1
            s = {"n": len(pv), "n_live": 0, "rss": 0.0, "pss": 0.0, "anon": 0.0,
                 "cpu": 0.0, "io_r": 0.0, "io_w": 0.0}
            for pid, v in pv.items():
                if not isinstance(v, dict):
                    continue
                smaps = v.get("smaps") or {}
                ior = v.get("io_rate") or {}
                rss_mb = _vm_val(v, "rss_mb")
                # 采集端的口径：真 boot 过的沙箱 rss 远大于 64MB，几 MB 的是残留进程
                if rss_mb >= 64:
                    s["n_live"] += 1
                s["rss"] += rss_mb
                s["pss"] += float(smaps.get("pss_kb") or 0) / 1024.0
                s["anon"] += float(smaps.get("anon_kb") or 0) / 1024.0
                s["cpu"] += _vm_val(v, "cpu_pct")
                s["io_r"] += float(ior.get("read_mb_s") or 0)
                s["io_w"] += float(ior.get("write_mb_s") or 0)
                sid = v.get("api_sock") or ("pid" + str(pid))
                vm = vms.get(sid)
                if vm is None:
                    vm = {"sid": sid, "pid": str(pid), "label": _vm_label(sid, pid),
                          "t0": t, "t1": t, "peak": 0.0, "rss_peak": 0.0, "pts": []}
                    vms[sid] = vm
                vm["t1"] = t
                if rss_mb > vm["rss_peak"]:
                    vm["rss_peak"] = round(rss_mb, 2)
                raw = _vm_val(v, key) * scale
                vm["pts"].append([t, round(raw, 2)])
                if raw > vm["peak"]:
                    vm["peak"] = round(raw, 2)
            for k in agg_keys:
                agg_pts[k].append([t, round(s[k], 2)])
            n_samples += 1
            if t0 is None or t < t0:
                t0 = t
            if t1 is None or t > t1:
                t1 = t
    if not n_samples:
        raise ValueError("这个 memlog 里没有 per_vm 段（采集时未开 per-vm 层）")
    if not n_pv:
        raise ValueError("这个 memlog 里没有 per_vm 段（采集时未开 per-vm 层，只有主机级 / cgroup 级字段）")
    out_vms = []
    for vm in vms.values():
        vm["n"] = len(vm["pts"])
        vm["live"] = 1 if vm["rss_peak"] >= 64 else 0
        vm["pts"] = _downsample_minmax(vm["pts"], max_points)
        out_vms.append(vm)
    out_vms.sort(key=lambda v: (-v["live"], -v["rss_peak"], v["t0"]))
    agg = {k: _downsample_minmax(v, max_points) for k, v in agg_pts.items()}
    return {
        "path": str(p), "metric": metric, "metrics": list(VM_METRICS),
        "t0": t0, "t1": t1, "n": n_samples,
        "n_vm": len(out_vms),
        "n_live": sum(v["live"] for v in out_vms),
        "peak": {"n": max((p[1] for p in agg["n_live"]), default=0),
                 "rss": max((p[1] for p in agg["rss"]), default=0)},
        "agg": agg, "vms": out_vms,
    }


# ── pervm-12：逐沙箱 guest/host 双视角采样 ──────────────────────────
# 布局（root 为一个 pervm 批次目录）：
#   index.jsonl         每行 {sandbox, pid, ts, started_at, grow_kb}，sandbox↔fc pid 配对
#   per-vm/<sandbox>/guest.csv   guest 注入读 /proc，1 Hz，列 = /proc/meminfo + vmstat（kB/计数）
#   host/<pid>.csv              宿主 fc 进程 smaps，1 Hz，列 = *_mb + threads
#   runs/<issue>/records/*.json  轨迹，ep.template 不是 sandbox；靠采样时间窗落到轨迹
# 两侧字段单位不同（guest 多 kB、host 全 MB），解析层统一换算到 MB，前端不必分支。

# guest.csv 里按 kB 计、需 /1024 换 MB 的列；其余（pgfault/ctxt 等计数）保持原值
PERVM_GUEST_KB = {
    "MemTotal", "MemAvailable", "MemFree", "Cached", "Buffers", "Shmem",
    "AnonPages", "Mapped", "Slab", "SReclaimable", "KernelStack", "PageTables",
    "SwapTotal", "SwapFree",
}
# 前端对照面板的字段分组：guest 侧取什么、host 侧取什么、口径说明
PERVM_PAIRS = [
    {"key": "used", "guest": "used_mb", "host": "rss_mb", "label": "已用 / RSS MB",
     "note": "guest=MemTotal−MemAvailable（guest 视角已用）；host=fc 进程常驻集 RSS。guest 的页缓存在宿主也是匿名页，两者同量级但不等价。"},
    {"key": "anon", "guest": "AnonPages_mb", "host": "pss_anon_mb", "label": "匿名页 / PSS-anon MB",
     "note": "guest=guest /proc AnonPages；host=fc smaps 匿名映射 PSS。双方统一 MB 后对照，差值主要是页表与 fc 自身开销。"},
    {"key": "file", "guest": "Cached_mb", "host": "pss_file_mb", "label": "页缓存 / PSS-file MB",
     "note": "guest=guest 页缓存 Cached；host=fc 文件映射 PSS（ublk/磁盘映射）。guest 侧看不到这块，量纲对照仅供参考。"},
    {"key": "shmem", "guest": "Shmem_mb", "host": "pss_shmem_mb", "label": "共享内存 / PSS-shmem MB",
     "note": "guest=/proc Shmem；host=fc smaps 共享映射 PSS。"},
    {"key": "swap", "guest": "SwapFree_mb", "host": "swap_mb", "label": "swap MB",
     "note": "guest=剩余 swap；host=fc swap 占用。注意口径方向相反（剩余 vs 占用）。"},
]


def _pervm_csv(path: Path, kb_cols: set, max_points: int) -> dict:
    """解析一份 pervm CSV（第一列 ts=epoch 秒）→ {series,range,t0,t1,n,fields}。

    kb_cols 里的列 /1024 换 MB，字段名加 _mb 后缀以便与 host 侧区分；其余保持原名原值。
    ts 统一 epoch ms。峰值用 _downsample_minmax 保留。
    """
    series: dict[str, list] = {}
    n = 0
    t0 = t1 = None
    with open(path, encoding="utf-8", errors="replace", newline="") as f:
        rd = csv.DictReader(f)
        head = [h for h in (rd.fieldnames or []) if h and h != "ts"]
        for h in head:
            series[h] = []
        for row in rd:
            raw = row.get("ts")
            if raw is None:
                continue
            try:
                t = int(float(raw) * 1000)
            except (ValueError, TypeError):
                continue
            for h in head:
                v = row.get(h)
                if v is None or v == "":
                    continue
                try:
                    x = float(v)
                except (ValueError, TypeError):
                    continue
                series[h].append([t, x])
            n += 1
            if t0 is None or t < t0:
                t0 = t
            if t1 is None or t > t1:
                t1 = t
    if n == 0:
        raise ValueError(f"{path.name} 没有数据行")
    out: dict[str, list] = {}
    for h, pts in series.items():
        if not pts:
            continue
        if h in kb_cols:
            h2 = h + "_mb"
            out[h2] = [[t, round(v / 1024.0, 3)] for t, v in pts]
        else:
            out[h] = pts
    out = {k: _downsample_minmax(v, max_points) for k, v in out.items()}
    rng = {}
    for k, pts in out.items():
        vs = [v for _, v in pts]
        rng[k] = [round(min(vs), 3), round(max(vs), 3)] if vs else [0.0, 0.0]
    # guest 已用 = total − avail（按时间戳对齐；缺一侧则跳过）
    if "MemTotal_mb" in out and "MemAvailable_mb" in out:
        av = dict(out["MemAvailable_mb"])
        used = [[t, round(v - av.get(t, 0.0), 3)] for t, v in out["MemTotal_mb"]]
        out["used_mb"] = used
        vs = [v for _, v in used]
        rng["used_mb"] = [round(min(vs), 3), round(max(vs), 3)] if vs else [0.0, 0.0]
    return {"series": out, "range": rng, "t0": t0, "t1": t1, "n": n,
            "fields": sorted(out)}


def load_pervm(root: str, max_points: int = 900) -> dict:
    """解析 pervm 批次目录 → 逐 sandbox 的 guest/host 配对数据。

    返回 {root, vms:[{sandbox,pid,issue_id,sample_idx,label,t0,t1,
                       guest:{...},host:{...},has_guest,has_host}], pairs, n}
    sandbox 来自 per-vm/ 目录名，pid 经 index.jsonl 查到，host 取 host/<pid>.csv；
    轨迹按采样窗口时间关联，取 issue_id/sample_idx 作标签（无匹配则空）。
    有 guest 无 host（如 000803 那轮）也保留，前端画 guest 单侧。
    """
    p = Path(root).expanduser().resolve()
    if not p.is_dir():
        raise ValueError(f"目录不存在: {p}")
    # index: sandbox -> pid（去重，重复登记取首条）
    sb2pid: dict[str, str] = {}
    ix = p / "index.jsonl"
    if ix.is_file():
        for line in ix.read_text(encoding="utf-8", errors="replace").splitlines():
            if not line.strip().startswith("{"):
                continue
            try:
                d = json.loads(line)
                sb = str(d.get("sandbox") or "")
                pid = str(d.get("pid") or "")
                if sb and pid and sb not in sb2pid:
                    sb2pid[sb] = pid
            except (json.JSONDecodeError, ValueError):
                continue
    # 轨迹时间窗 -> (issue_id, sample_idx, started_at)，用于给 sandbox 贴标签
    ep_spans = []
    for f in sorted((p / "runs").glob("*/records/*.json")):
        if f.name == "run.json":
            continue
        try:
            e = json.loads(f.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        s, en = parse_ts(e.get("started_at")), parse_ts(e.get("finished_at"))
        if s is None:
            continue
        ep_spans.append((s, en if en is not None else s,
                         str(e.get("issue_id") or ""), e.get("sample_idx")))
    ep_spans.sort()

    def tag_of(t0: int, t1: int):
        # ep_spans 的 s/en 与 t0/t1 都是 epoch ms（parse_ts 出 ms，CSV 乘了 1000）
        pad = 120000  # 2 分钟容差：guest 探针可能早于轨迹几秒启动
        best = None
        for s, en, iss, samp in ep_spans:
            if s - pad <= t0 <= en + pad or s - pad <= t1 <= en + pad or (t0 <= s and t1 >= en):
                if best is None or s > best[0]:
                    best = (s, iss, samp)
        return (best[1], best[2]) if best else ("", None)

    vms = []
    gdir = p / "per-vm"
    hdir = p / "host"
    for d in sorted(gdir.iterdir()) if gdir.is_dir() else []:
        if not d.is_dir():
            continue
        gf = d / "guest.csv"
        sb = d.name
        if not gf.is_file() or gf.stat().st_size < 40:
            continue
        try:
            g = _pervm_csv(gf, PERVM_GUEST_KB, max_points)
        except (ValueError, OSError):
            continue
        pid = sb2pid.get(sb, "")
        hf = hdir / (pid + ".csv") if pid else None
        h = None
        if hf and hf.is_file() and hf.stat().st_size >= 40:
            try:
                h = _pervm_csv(hf, set(), max_points)
            except (ValueError, OSError):
                h = None
        iss, samp = tag_of(g["t0"], g["t1"])
        label_bits = [iss]
        if samp is not None:
            label_bits.append("s" + str(samp))
        label_bits.append(sb[:8])
        vms.append({
            "sandbox": sb, "pid": pid, "issue_id": iss, "sample_idx": samp,
            "label": " ".join(x for x in label_bits if x),
            "t0": g["t0"], "t1": g["t1"], "n": g["n"],
            "guest": g, "host": h,
            "has_guest": True, "has_host": h is not None,
        })
    # 只有 host、没有 guest 的 pid 也列出来（000803 那轮只有 host 曲线）
    paired_pids = {v["pid"] for v in vms if v["pid"]}
    for hf in sorted(hdir.glob("*.csv")) if hdir.is_dir() else []:
        pid = hf.stem
        if pid in paired_pids:
            continue
        sb = next((s for s, v in sb2pid.items() if v == pid), "")
        if not sb or hf.stat().st_size < 40:
            continue
        try:
            h = _pervm_csv(hf, set(), max_points)
        except (ValueError, OSError):
            continue
        iss, samp = tag_of(h["t0"], h["t1"])
        vms.append({
            "sandbox": sb, "pid": pid, "issue_id": iss, "sample_idx": samp,
            "label": " ".join(x for x in [iss, ("s" + str(samp)) if samp is not None else "", sb[:8]] if x) + " (host only)",
            "t0": h["t0"], "t1": h["t1"], "n": h["n"],
            "guest": None, "host": h, "has_guest": False, "has_host": True,
        })
    vms.sort(key=lambda v: (v["issue_id"], v["sample_idx"] if v["sample_idx"] is not None else 99, v["sandbox"]))
    return {"root": str(p), "vms": vms,
            "pairs": PERVM_PAIRS, "n": len(vms),
            "n_guest": sum(v["has_guest"] for v in vms),
            "n_host": sum(v["has_host"] for v in vms)}


# SWE 负载总览：guest /proc 内存按 episode 聚合。字段均为 kB → MB。
SWE_MEM_FIELDS = [
    ("AnonPages", "anon", "匿名页"),
    ("Cached", "cached", "页缓存"),
    ("Buffers", "buffers", "块缓冲"),
    ("Slab", "slab", "Slab"),
    ("PageTables", "pagetables", "页表"),
    ("KernelStack", "kstack", "内核栈"),
    ("Shmem", "shmem", "共享内存（含于页缓存）"),
    ("Mapped", "mapped", "Mapped（含于页缓存）"),
    ("SReclaimable", "sreclaim", "可回收 Slab（含于 Slab）"),
]

# 可叠加字段：彼此不重叠。Shmem/Mapped 是 Cached 的子集，SReclaimable 是 Slab 的子集，
# 只作为细项在提示中给出，不参与堆叠条，否则条长会重复计算并超过 100%。
SWE_STACK_KEYS = ("anon", "cached", "buffers", "slab", "pagetables", "kstack")


def load_swe_summary(root: str) -> dict:
    """SWE 批次负载总览：按 episode 聚合 guest 内存均值/峰值/占比 + 步数与时间。

    episode ↔ sandbox 配对：guest.csv 末帧时间 ≈ episode.finished_at（30s 容差，一对一贪心）。
    4 条样本并行、时间窗重叠，started_at 无法区分；末帧时间与结束时刻一一对应（实测 42/48，
    未配对的 6 条是 000803 无 guest 采样）。每个 episode 在配对 guest.csv 上统计：
      - mean_mb / peak_mb：各 /proc 字段在 episode 时间窗内的均值与峰值（kB→MB）
      - share：各类占「已用」(MemTotal−MemAvailable) 的比例（字段间有重叠）
      - stack：非重叠字段（anon/cached/buffers/slab/pagetables/kstack）的归一占比，用于堆叠条
      - spans：gen/tool span（复用 steps_to_spans），用于逐 VM 面板叠加 episode 进度
    返回 episodes（按 issue/sample 排序）+ by_issue 聚合。
    """
    p = Path(root).expanduser().resolve()
    runs = p / "runs"
    if not runs.is_dir():
        raise ValueError(f"目录不存在或无 runs/: {p}")

    # 1) episode 列表
    eps = []
    for f in sorted(runs.glob("*/records/*.json")):
        if f.name == "run.json":
            continue
        try:
            e = json.loads(f.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        st, en = parse_ts(e.get("started_at")), parse_ts(e.get("finished_at"))
        if st is None:
            continue
        steps = extract_steps(e)
        tt = e.get("totals") or {}
        eps.append({
            "issue_id": str(e.get("issue_id") or ""),
            "sample_idx": e.get("sample_idx"),
            "start": st, "end": en if en is not None else st,
            "steps": len(steps), "wall_s": tt.get("wall_s"),
            "gen_s": tt.get("gen_s"), "tool_s": tt.get("tool_s"),
            "peak_mem_mb": tt.get("peak_mem_mb"),
            "prompt_tokens": tt.get("prompt_tokens"),
            "completion_tokens": tt.get("completion_tokens"),
            "reward": e.get("reward"), "stop_reason": e.get("stop_reason"),
            "digest_start": e.get("guest_digest_start"), "digest_end": e.get("guest_digest"),
            "spans": steps_to_spans(steps),
            "path": str(f.relative_to(p)),
            "sandbox": None, "mem": None,
        })
    if not eps:
        raise ValueError("runs/*/records 下没有 episode")

    # 2) guest.csv：末帧时间 + 全字段序列（kB 原值，统计时 /1024）
    gl = []
    gdir = p / "per-vm"
    for gf in sorted(gdir.glob("*/guest.csv")) if gdir.is_dir() else []:
        if gf.stat().st_size < 40:
            continue
        try:
            with open(gf, encoding="utf-8", errors="replace", newline="") as fh:
                rows = list(csv.DictReader(fh))
        except (OSError, csv.Error):
            continue
        if not rows:
            continue
        try:
            last_ts = float(rows[-1].get("ts") or 0)
        except (ValueError, TypeError):
            continue
        seq = {}
        for h in SWE_MEM_FIELDS:
            k = h[0]
            vals = []
            for r in rows:
                try:
                    v = float(r.get(k) or 0)
                except (ValueError, TypeError):
                    v = 0.0
                vals.append(v / 1024.0)
            seq[k] = vals
        # 已用 = MemTotal − MemAvailable（kB→MB）
        used = []
        for r in rows:
            try:
                used.append(max(0.0, (float(r.get("MemTotal") or 0) -
                                      float(r.get("MemAvailable") or 0)) / 1024.0))
            except (ValueError, TypeError):
                used.append(0.0)
        seq["_used"] = used
        try:
            ts_seq = [float(r["ts"]) for r in rows]
        except (ValueError, TypeError, KeyError):
            ts_seq = [0.0] * len(rows)
        gl.append({"sandbox": gf.parent.name, "last_ts": last_ts,
                   "seq": seq, "ts": ts_seq, "n": len(rows)})

    # 3) 一对一贪心配对：末帧时间 ↔ episode.finished_at
    used_sb = set()
    for e in sorted(eps, key=lambda x: x["end"]):
        cands = [g for g in gl if g["sandbox"] not in used_sb and abs(g["last_ts"] * 1000 - e["end"]) <= 30000]
        if not cands:
            continue
        best = min(cands, key=lambda g: abs(g["last_ts"] * 1000 - e["end"]))
        used_sb.add(best["sandbox"])
        e["sandbox"] = best["sandbox"]
        e["mem"] = best

    # 4) 每 episode 聚合
    out_eps = []
    for e in eps:
        g = e["mem"]
        mem = {"mean_mb": {}, "peak_mb": {}, "share": {}, "stack": {}, "n_samples": 0}
        if g:
            used = g["seq"]["_used"]
            n = len(used)
            mean_used = sum(used) / n if n else 0.0
            mem["n_samples"] = n
            mem["mean_mb"]["used"] = round(mean_used, 2)
            mem["peak_mb"]["used"] = round(max(used), 2) if used else 0.0
            for src, key, _ in SWE_MEM_FIELDS:
                vals = g["seq"][src]
                mv = sum(vals) / n if n else 0.0
                mem["mean_mb"][key] = round(mv, 2)
                mem["peak_mb"][key] = round(max(vals), 2) if vals else 0.0
                mem["share"][key] = round(mv / mean_used, 4) if mean_used > 0 else 0.0
            stack_total = sum(mem["mean_mb"].get(k, 0.0) for k in SWE_STACK_KEYS)
            for key in SWE_STACK_KEYS:
                mem["stack"][key] = round(mem["mean_mb"].get(key, 0.0) / stack_total, 4) if stack_total > 0 else 0.0
        out_eps.append({
            "issue_id": e["issue_id"], "sample_idx": e["sample_idx"],
            "start": e["start"], "end": e["end"],
            "steps": e["steps"], "wall_s": e["wall_s"],
            "gen_s": e["gen_s"], "tool_s": e["tool_s"],
            "peak_mem_mb": e["peak_mem_mb"],
            "prompt_tokens": e["prompt_tokens"], "completion_tokens": e["completion_tokens"],
            "reward": e["reward"], "stop_reason": e["stop_reason"],
            "sandbox": e["sandbox"], "mem": mem,
            "spans": e["spans"], "path": e["path"],
        })
    out_eps.sort(key=lambda x: (x["issue_id"], x["sample_idx"] if x["sample_idx"] is not None else 99))

    # 5) 按 issue 聚合（每 issue 4 条样本取均值）
    by_issue = {}
    for e in out_eps:
        k = e["issue_id"] or "(unknown)"
        d = by_issue.setdefault(k, {"issue_id": k, "n": 0, "n_mem": 0,
                                    "mean_mb": {}, "share": {}, "stack": {},
                                    "steps": 0.0, "wall_s": 0.0, "peak_mem_mb": 0.0})
        d["n"] += 1
        if e["mem"]["n_samples"]:
            d["n_mem"] += 1
            for key, v in e["mem"]["mean_mb"].items():
                d["mean_mb"][key] = d["mean_mb"].get(key, 0.0) + v
            for key, v in e["mem"]["share"].items():
                d["share"][key] = d["share"].get(key, 0.0) + v
        for key in ("steps", "wall_s", "peak_mem_mb"):
            if e.get(key) is not None:
                d[key] = (d.get(key) or 0.0) + (e[key] or 0)
    for d in by_issue.values():
        n = max(d["n"], 1)
        for key in ("steps", "wall_s", "peak_mem_mb"):
            d[key] = round((d.get(key) or 0.0) / n, 2)
        for key in list(d["mean_mb"]):
            d["mean_mb"][key] = round(d["mean_mb"][key] / max(d["n_mem"], 1), 2)
        for key in list(d["share"]):
            d["share"][key] = round(d["share"][key] / max(d["n_mem"], 1), 4)
        stack_total = sum(d["mean_mb"].get(k, 0.0) for k in SWE_STACK_KEYS)
        for key in SWE_STACK_KEYS:
            d["stack"][key] = round(d["mean_mb"].get(key, 0.0) / stack_total, 4) if stack_total > 0 else 0.0
    return {"root": str(p), "episodes": out_eps,
            "by_issue": [by_issue[k] for k in sorted(by_issue)],
            "fields": [{"src": s, "key": k, "label": lab} for s, k, lab in SWE_MEM_FIELDS],
            "n": len(out_eps), "n_mem": sum(1 for e in out_eps if e["mem"]["n_samples"])}
