"""trace_scope 本地服务（零依赖，纯标准库，只读）。

用法:
    python server.py [目录] [--port 8765]

启动后浏览器打开 http://127.0.0.1:8765 ，页面里点“打开文件夹”即可分析任意目录。
只做只读解析，绝不修改任何数据文件，只绑定 127.0.0.1。
"""
from __future__ import annotations

import argparse
import json
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import scope_data

HERE = Path(__file__).parent
FRONTEND = HERE / "frontend"
CACHE: dict[str, dict] = {}  # key -> {"_sig", "_json": 概要层字节, "_src": {run_id: {ep_id: src}}, "_span": {ep_id: spans} 按需}
CURRENT_ROOT: list = [None]  # 最近一次扫描的目录（会被每次 /api/scan 改写）
BOOT_ROOT: list = [None]     # 服务启动时预扫描的目录，全程不变：整目录加载的稳定回退值

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
}


def _data_sig(root: Path) -> str:
    """数据指纹：记录文件的 mtime 集合（root 下两层，与 discover 同深），数据一变缓存自动失效。"""
    parts = []
    frontier = [root]
    for _ in range(3):
        nxt = []
        for d in frontier:
            for name in ("manifest.json", "config.json", "run.json"):
                f = d / name
                if f.is_file():
                    parts.append(f"{d.name}/{name}:{f.stat().st_mtime_ns}")
            rec = d / "records"
            if rec.is_dir():
                for f in rec.glob("*.json"):
                    parts.append(f"{d.name}/records/{f.name}:{f.stat().st_mtime_ns}")
                for f in rec.glob("*.guest.csv"):
                    parts.append(f"{d.name}/records/{f.name}:{f.stat().st_mtime_ns}")
            for f in d.glob("*.guest.csv"):
                parts.append(f"{d.name}/{f.name}:{f.stat().st_mtime_ns}")
            for f in d.glob("*.json"):
                if scope_data.SAMPLE_RE.match(f.name):
                    parts.append(f"{d.name}/{f.name}:{f.stat().st_mtime_ns}")
            try:
                nxt += [p for p in d.iterdir() if p.is_dir()]
            except OSError:
                pass
        frontier = nxt
    return "|".join(parts)


def scan_json(path_str: str, refresh: bool = False) -> bytes:
    """扫描目录并返回概要层 payload 的 JSON 字节。

    概要层含元信息 + 预聚合，几 MB。spans 不在此处构建/序列化：只记录每条
    episode 的源文件位置，/api/spans 按可视时间窗现读单条源文件。
    这样扫描成本 O(文件数) 但常驻内存只有概要 + 已访问 ep 的 spans，
    不再一次性 json.dumps 全量 spans（几十万条时 C 层持 GIL 会把服务卡死）。
    """
    p = Path(path_str).expanduser().resolve()
    if not p.is_dir():
        raise ValueError(f"目录不存在: {p}")
    key = str(p)
    sig = _data_sig(p)
    if refresh or key not in CACHE or CACHE[key].get("_sig") != sig:
        # with_spans=False：build_episode 仍算 iv/ag/top 预聚合，但不产出 spans dict
        payload = scope_data.build_payload(p, with_spans=False)
        CACHE[key] = {
            "_sig": sig,
            "_json": json.dumps(scope_data.summary_of(payload),
                                ensure_ascii=False).encode("utf-8"),
            "_src": scope_data.src_map(payload),
            "_span": {},  # ep_id -> spans，按需填充，长期常驻上限由 SPAN_CACHE_MAX 控制
        }
    CURRENT_ROOT[0] = key
    return CACHE[key]["_json"]


SPAN_CACHE_MAX = 400  # 最多缓存 400 条 episode 的 spans（约几万 span），超出淘汰最早条目

MEMLOG_CACHE: dict[str, tuple] = {}  # path -> (mtime_ns, size, json_bytes)
VM_CACHE: dict[str, tuple] = {}      # path -> ((mtime_ns, size, metric), json_bytes)
GUEST_CACHE: dict[str, tuple] = {}   # path -> ((mtime_ns, size), json_bytes)
RUN_GUEST_CACHE: dict[str, tuple] = {}  # run 目录 -> ((sig), json_bytes)
PERVM_CACHE: dict[str, tuple] = {}   # pervm 批次目录 -> ((index mtime, 文件数), json_bytes)
SWE_CACHE: dict[str, tuple] = {}     # swe 批次目录 -> ((records mtime, 文件数), json_bytes)


def memlog_json(path_str: str, ref_ms=None) -> bytes:
    """memlog 解析结果缓存：同一文件只解析/序列化一次，切换 A/B 路秒回。"""
    p = Path(path_str).expanduser().resolve()
    if not p.is_file():
        raise ValueError(f"文件不存在: {p}")
    st = p.stat()
    sig = (st.st_mtime_ns, st.st_size)
    hit = MEMLOG_CACHE.get(str(p))
    if hit and hit[0] == sig:
        return hit[2]
    d = scope_data.load_memlog(str(p), ref_ms)
    body = json.dumps(d, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(MEMLOG_CACHE) >= 8:
        MEMLOG_CACHE.pop(next(iter(MEMLOG_CACHE)))
    MEMLOG_CACHE[str(p)] = (sig, None, body)
    return body


def vm_json(path_str: str, metric: str = "rss") -> bytes:
    """memlog 的 per-VM 明细缓存：按（文件，指标）只解析一次。"""
    p = Path(path_str).expanduser().resolve()
    if not p.is_file():
        raise ValueError(f"文件不存在: {p}")
    st = p.stat()
    sig = (st.st_mtime_ns, st.st_size, metric)
    hit = VM_CACHE.get(str(p))
    if hit and hit[0] == sig:
        return hit[1]
    d = scope_data.load_memlog_vm(str(p), metric)
    body = json.dumps(d, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(VM_CACHE) >= 12:
        VM_CACHE.pop(next(iter(VM_CACHE)))
    VM_CACHE[str(p)] = (sig, body)
    return body


def pervm_json(path_str: str) -> bytes:
    """pervm 批次目录的逐 sandbox guest/host 配对数据：整个目录解析一次并缓存。

    指纹 = index.jsonl 的 (mtime,size) + guest/host csv 文件数；采样期目录静态，
    文件数不变即命中缓存，避免每次点击都重读上百份 CSV。
    """
    p = Path(path_str).expanduser().resolve()
    if not p.is_dir():
        raise ValueError(f"目录不存在: {p}")
    ix = p / "index.jsonl"
    ix_sig = (ix.stat().st_mtime_ns, ix.stat().st_size) if ix.is_file() else (0, 0)
    n_g = len(list((p / "per-vm").glob("*/guest.csv"))) if (p / "per-vm").is_dir() else 0
    n_h = len(list((p / "host").glob("*.csv"))) if (p / "host").is_dir() else 0
    sig = (ix_sig, n_g, n_h)
    hit = PERVM_CACHE.get(str(p))
    if hit and hit[0] == sig:
        return hit[1]
    d = scope_data.load_pervm(str(p))
    body = json.dumps(d, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(PERVM_CACHE) >= 6:
        PERVM_CACHE.pop(next(iter(PERVM_CACHE)))
    PERVM_CACHE[str(p)] = (sig, body)
    return body


def swe_json(path_str: str) -> bytes:
    """SWE 负载总览：按 episode 聚合 guest 内存均值/占比，整个目录解析一次并缓存。

    指纹 = records/*.json 的总大小+文件数 + guest.csv 文件数；跑批期目录静态。
    """
    p = Path(path_str).expanduser().resolve()
    runs = p / "runs"
    if not runs.is_dir():
        raise ValueError(f"目录不存在或无 runs/: {p}")
    recs = list(runs.glob("*/records/*.json"))
    sig = (len(recs), sum(f.stat().st_size for f in recs),
           len(list((p / "per-vm").glob("*/guest.csv"))) if (p / "per-vm").is_dir() else 0)
    hit = SWE_CACHE.get(str(p))
    if hit and hit[0] == sig:
        return hit[1]
    d = scope_data.load_swe_summary(str(p))
    body = json.dumps(d, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(SWE_CACHE) >= 6:
        SWE_CACHE.pop(next(iter(SWE_CACHE)))
    SWE_CACHE[str(p)] = (sig, body)
    return body


def _guest_sig(paths: list) -> tuple:
    """一组 guest.csv 的 (mtime,size) 指纹，任一变化即失效。"""
    sig = []
    for f in paths:
        try:
            st = Path(f).stat()
            sig.append((f, st.st_mtime_ns, st.st_size))
        except OSError:
            sig.append((f, -1, -1))
    return tuple(sig)


def guest_json(path_str: str, run_paths=None) -> bytes:
    """单份 guest.csv 或整个 run 的 guest 集合 → 解析结果缓存。

    run_paths 给定时按整组指纹缓存（一键加载整 run 用），否则缓存单文件。
    """
    if run_paths is not None:
        sig = _guest_sig(run_paths)
        hit = RUN_GUEST_CACHE.get(path_str)
        if hit and hit[0] == sig:
            return hit[1]
        d = scope_data.load_runs_guest(Path(path_str))
        body = json.dumps(d, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(RUN_GUEST_CACHE) >= 16:
            RUN_GUEST_CACHE.pop(next(iter(RUN_GUEST_CACHE)))
        RUN_GUEST_CACHE[path_str] = (sig, body)
        return body
    p = Path(path_str).expanduser().resolve()
    if not p.is_file():
        raise ValueError(f"文件不存在: {p}")
    st = p.stat()
    sig = (st.st_mtime_ns, st.st_size)
    hit = GUEST_CACHE.get(str(p))
    if hit and hit[0] == sig:
        return hit[1]
    d = scope_data.load_guest_csv(str(p))
    body = json.dumps(d, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(GUEST_CACHE) >= 32:
        GUEST_CACHE.pop(next(iter(GUEST_CACHE)))
    GUEST_CACHE[str(p)] = (sig, body)
    return body


def spans_json(path_str: str, run_id: str, t0=None, t1=None, eps=None) -> bytes:
    """按需加载层：按可视时间窗（或指定 episode）从源文件重建 spans。"""
    p = Path(path_str).expanduser().resolve()
    if not p.is_dir():
        raise ValueError(f"目录不存在: {p}")
    key = str(p)
    if key not in CACHE:
        scan_json(path_str)
    entry = CACHE[key]
    src_by_ep = entry["_src"].get(run_id)
    if src_by_ep is None:
        raise ValueError(f"没有这个 run: {run_id}")
    if eps:
        ids = [e for e in eps.split(",") if e in src_by_ep]
    else:
        # 先用概要层的 iv 区间裁剪：只读取与时间窗相交的 episode 文件，
        # 避免窗口请求遍历整轮上千个文件。
        ids = []
        for eid, meta in src_by_ep.items():
            if t0 is None:
                ids.append(eid)
                continue
            iv = meta.get("iv") or []
            if any(s <= t1 and e >= t0 for s, e in iv):
                ids.append(eid)

    out = {}
    span_cache = entry["_span"]
    for eid in ids:
        spans = span_cache.get(eid)
        if spans is None:
            spans = scope_data.spans_of_episode(src_by_ep[eid]["src"])
            span_cache[eid] = spans
            if len(span_cache) > SPAN_CACHE_MAX:
                first = next(iter(span_cache))
                if first != eid:
                    del span_cache[first]
        if t0 is not None:
            spans = [sp for sp in spans if sp["s"] <= t1 and sp["e"] >= t0]
        out[eid] = spans
    return json.dumps({"run": run_id, "spans": out},
                      ensure_ascii=False).encode("utf-8")


def list_dirs(path_str: str) -> dict:
    p = Path(path_str).expanduser().resolve() if path_str else Path.home()
    if not p.is_dir():
        raise ValueError(f"目录不存在: {p}")
    dirs = []
    try:
        for child in sorted(p.iterdir()):
            if not child.is_dir() or child.name.startswith("."):
                continue
            dirs.append({"name": child.name, "has_runs": scope_data.is_run_dir(child)})
    except PermissionError:
        raise ValueError(f"无权限读取: {p}")
    parent = str(p.parent) if p.parent != p else None
    return {"path": str(p), "parent": parent, "dirs": dirs,
            "self_has_runs": scope_data.is_run_dir(p)}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self._json_bytes(body, code)

    def _json_bytes(self, body: bytes, code=200):
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: Path):
        if not path.is_file():
            self._json({"error": f"not found: {self.path}"}, 404)
            return
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(path.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _index(self):
        """首页：把 __BUILD__ 换成 index.html 的修改时间。

        页面自己印不出「这是哪一版」，改完样式或逻辑后只能靠文案差异反推
        浏览器跑的是不是新文件；用文件 mtime 注入，改一次就自动换一次。
        """
        p = FRONTEND / "index.html"
        if not p.is_file():
            self._json({"error": "frontend/index.html 缺失"}, 404)
            return
        stamp = datetime.fromtimestamp(p.stat().st_mtime).strftime("%m-%d %H:%M").encode()
        body = p.read_bytes().replace(b"__BUILD__", stamp)
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path == "/api/ping":
                self._json({"ok": True})
            elif u.path == "/api/status":
                self._json({"root": CURRENT_ROOT[0], "boot_root": BOOT_ROOT[0]})
            elif u.path == "/api/ls":
                self._json(list_dirs(q.get("path", "")))
            elif u.path == "/api/scan":
                self._json_bytes(scan_json(q.get("path", ""), q.get("refresh") == "1"))
            elif u.path == "/api/spans":
                t0, t1 = q.get("t0"), q.get("t1")
                self._json_bytes(spans_json(
                    q.get("path", ""), q.get("run", ""),
                    float(t0) if t0 else None, float(t1) if t1 else None,
                    q.get("eps")))
            elif u.path == "/api/memlog/ls":
                self._json(scope_data.list_memlogs(q.get("path", "")))
            elif u.path == "/api/memlog/load":
                ref = q.get("ref")
                self._json_bytes(memlog_json(
                    q.get("path", ""), float(ref) if ref else None))
            elif u.path == "/api/memlog/vm":
                self._json_bytes(vm_json(q.get("path", ""), q.get("metric") or "rss"))
            elif u.path == "/api/guest/ls":
                self._json(scope_data.list_guest_csv(q.get("path", "")))
            elif u.path == "/api/guest/load":
                self._json_bytes(guest_json(q.get("path", "")))
            elif u.path == "/api/guest/run":
                paths = [v for k, v in q.items() if k.startswith("f") and k[1:].isdigit()]
                self._json_bytes(guest_json(q.get("path", ""), paths))
            elif u.path == "/api/pervm/load":
                self._json_bytes(pervm_json(q.get("path", "")))
            elif u.path == "/api/swe/load":
                self._json_bytes(swe_json(q.get("path", "")))
            elif u.path in ("/", "/index.html"):
                self._index()
            elif u.path == "/data.js":
                f = FRONTEND / "data.js"
                if f.is_file():
                    self._file(f)
                else:
                    body = b"window.SCOPE_DATA=null;"
                    self.send_response(200)
                    self.send_header("Content-Type", MIME[".js"])
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    self.wfile.write(body)
            else:
                # 静态文件限制在 frontend 目录内
                rel = unquote(u.path).lstrip("/").replace("\\", "/")
                target = (FRONTEND / rel).resolve()
                if FRONTEND.resolve() in target.parents:
                    self._file(target)
                else:
                    self._json({"error": "forbidden"}, 403)
        except ValueError as e:
            self._json({"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001 — 兜底返回错误信息
            self._json({"error": repr(e)}, 500)

    def do_POST(self):
        u = urlparse(self.path)
        if u.path != "/api/scan":
            self._json({"error": "unknown api"}, 404)
            return
        try:
            n = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(n) or b"{}")
            self._json_bytes(scan_json(body.get("path", ""), bool(body.get("refresh"))))
        except ValueError as e:
            self._json({"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001
            self._json({"error": repr(e)}, 500)


def main():
    ap = argparse.ArgumentParser(description="trace_scope 本地只读分析服务")
    ap.add_argument("runs_dir", nargs="?", default=None, help="启动时预扫描的目录")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    if args.runs_dir:
        try:
            payload = json.loads(scan_json(args.runs_dir))
            n = sum(len(r["episodes"]) for r in payload["runs"])
            BOOT_ROOT[0] = payload["root"]
            print(f"预扫描 {payload['root']}: {len(payload['runs'])} runs / {n} episodes")
        except ValueError as e:
            print(f"预扫描失败: {e}")

    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{args.port}"
    print(f"trace_scope 已启动: {url}   （Ctrl+C 退出；全程只读，不动任何数据）")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已退出")


if __name__ == "__main__":
    main()
