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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import scope_data

HERE = Path(__file__).parent
FRONTEND = HERE / "frontend"
CACHE: dict[str, dict] = {}  # key -> {"_sig", "_json": 概要层字节, "_runs": {run_id: spans字节}, "_last": (run_id, 解析缓存)}
CURRENT_ROOT: list = [None]  # 最近一次扫描的目录

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

    全量 payload 里波形 spans 有几百 MB，页面一次解析会卡死：
    这里只下发概要层（元信息 + 预聚合，几 MB），spans 按 run 预序列化
    存在 CACHE 里供 /api/spans 按需取用。首次构建仍需几分钟，之后秒回。
    """
    p = Path(path_str).expanduser().resolve()
    if not p.is_dir():
        raise ValueError(f"目录不存在: {p}")
    key = str(p)
    sig = _data_sig(p)
    if refresh or key not in CACHE or CACHE[key].get("_sig") != sig:
        payload = scope_data.build_payload(p)
        CACHE[key] = {
            "_sig": sig,
            "_json": json.dumps(scope_data.summary_of(payload),
                                ensure_ascii=False).encode("utf-8"),
            "_runs": scope_data.run_spans_bytes(payload),
            "_last": (None, None),
        }
    CURRENT_ROOT[0] = key
    return CACHE[key]["_json"]


def spans_json(path_str: str, run_id: str, t0=None, t1=None, eps=None) -> bytes:
    """按需加载层：返回某 run 的 span 子集（时间窗过滤或指定 episode 全量）。"""
    p = Path(path_str).expanduser().resolve()
    if not p.is_dir():
        raise ValueError(f"目录不存在: {p}")
    key = str(p)
    if key not in CACHE:
        scan_json(path_str)
    entry = CACHE[key]
    if run_id not in entry["_runs"]:
        raise ValueError(f"没有这个 run: {run_id}")
    if entry["_last"][0] != run_id:  # 只缓存最近一个 run 的解析结果
        entry["_last"] = (run_id, json.loads(entry["_runs"][run_id]))
    sel = scope_data.filter_spans(
        entry["_last"][1], t0, t1,
        set(eps.split(",")) if eps else None)
    return json.dumps({"run": run_id, "spans": sel},
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

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path == "/api/ping":
                self._json({"ok": True})
            elif u.path == "/api/status":
                self._json({"root": CURRENT_ROOT[0]})
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
                self._json(scope_data.load_memlog(
                    q.get("path", ""), float(ref) if ref else None))
            elif u.path in ("/", "/index.html"):
                self._file(FRONTEND / "index.html")
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
            payload = scan(args.runs_dir)
            n = sum(len(r["episodes"]) for r in payload["runs"])
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
