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

    out = {
        "id": f"{trace}__t{task}__s{samp}",
        "seq": ep.get("seq"),
        "trace": trace, "task": task, "samp": samp,
        "issue": ep.get("issue_id") or "",
        "start": start, "end": end,
        "wall": round(wall or 0.0, 3),
        "gen_s": round(gen_s or 0.0, 3), "tool_s": round(tool_s or 0.0, 3),
        "n_steps": len(steps), "failed": failed,
        "stop": ep.get("stop_reason") or "",
        "reward": ep.get("reward"),
        # 预聚合（概要层下发，波形 spans 按需加载后这些统计不再依赖全量 span）
        "iv": _merge_iv(spans, start, end),   # 全部 span 区间合并（沙箱上下文并发口径）
        "tiv": _merge_iv([sp for sp in spans if sp["t"] == "tool"], start, end, fallback=False),
                                              # 仅 tool span 合并（沙箱内实际占用口径）；无工具调用为空
        "ag": _span_stats(spans),             # gen/tool 块耗时 [条数, 累计秒, 最大秒]
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

    # records 里有、manifest 没有的 episode 补进来
    have = {(e["trace"], e["task"], e["samp"]) for e in episodes}
    for f in sorted(rec_dir.glob("*.json")) if rec_dir.is_dir() else []:
        try:
            ep = build_episode(json.loads(f.read_text(encoding="utf-8")),
                               with_spans, ("file", str(f)))
        except (json.JSONDecodeError, OSError):
            continue
        if (ep["trace"], ep["task"], ep["samp"]) not in have:
            episodes.append(ep)
            have.add((ep["trace"], ep["task"], ep["samp"]))

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
    return {
        "id": run_dir.name,
        "start": min(starts), "end": max(ends),
        "wall_s": round((max(ends) - min(starts)) / 1000, 3),
        "config": {k: cfg[k] for k in CFG_KEYS if k in cfg},
        "peak": _peak_of(episodes),  # 并发峰值预聚合
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
