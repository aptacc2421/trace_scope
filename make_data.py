"""离线生成前端静态数据：python make_data.py <runs_dir> [-o frontend/data.js]。

解析逻辑在 scope_data.py；生成的 data.js 用于免服务的 file:// 直开模式。
日常交互使用请直接跑 server.py。
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import scope_data


def main():
    ap = argparse.ArgumentParser(description="扫描 runs 目录生成 trace_scope 静态数据")
    ap.add_argument("runs_dir", type=Path)
    ap.add_argument("-o", "--out", type=Path,
                    default=Path(__file__).parent / "frontend" / "data.js")
    args = ap.parse_args()

    payload = scope_data.build_payload(args.runs_dir)
    if not payload["runs"]:
        raise SystemExit(f"在 {args.runs_dir} 下没有发现可解析的 run（manifest.json 或 records/*.json）")

    js = "window.SCOPE_DATA = " + json.dumps(payload, ensure_ascii=False) + ";\n"
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(js.replace("</", "<\\/"), encoding="utf-8")

    for r in payload["runs"]:
        n_spans = sum(len(e["spans"]) for e in r["episodes"])
        print(f"[{r['id']}] episodes={len(r['episodes'])} spans={n_spans} "
              f"wall_s={r['wall_s']} ({r['config'].get('concurrency', '?')} 并发)")
    print(f"已写出 {args.out}（{args.out.stat().st_size / 1024:.0f} KB）")


if __name__ == "__main__":
    main()
