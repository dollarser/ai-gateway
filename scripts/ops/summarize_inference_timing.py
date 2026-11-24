"""Summarize sanitized inference_timing JSONL records on standard input."""

from collections import defaultdict
import json
import math
import sys


def percentile(values, fraction):
    values = sorted(values)
    return values[math.ceil(len(values) * fraction) - 1]


def main():
    groups = defaultdict(lambda: defaultdict(list))
    seen = set()
    for line in sys.stdin:
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if not isinstance(record, dict) or record.get("event") != "inference_timing":
            continue
        request_id = record.get("request_id")
        if not isinstance(request_id, str) or request_id in seen:
            continue
        seen.add(request_id)
        group = (
            record.get("operation") or "unknown",
            record.get("provider") or "unknown",
            "ok" if 200 <= record.get("status", 0) < 400 else "failed",
        )
        metrics = {**record.get("details", {}), "total_ms": record.get("duration_ms")}
        for name, value in metrics.items():
            if (
                (name.endswith("_ms") or name.startswith("db_"))
                and isinstance(value, (int, float))
                and math.isfinite(value)
                and value >= 0
            ):
                groups[group][name].append(value)
    for group, metrics in sorted(groups.items()):
        print("/".join(group))
        for name, values in sorted(metrics.items()):
            print(
                f"  {name:24} n={len(values):5} "
                f"p50={percentile(values, 0.5):g} p95={percentile(values, 0.95):g}"
            )


if __name__ == "__main__":
    main()
