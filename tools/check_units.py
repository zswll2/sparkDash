#!/usr/bin/env python3
"""Print a compact status line for every unit registered in sparkDash."""
import json
import urllib.request

BASE = "http://192.168.10.100:5555"


def get(path):
    with urllib.request.urlopen(f"{BASE}{path}", timeout=20) as response:
        return json.load(response)


units = [s["id"] for s in get("/api/sparks")["sparks"]]
print(f"共 {len(units)} 个单元: {', '.join(units)}\n")

for unit in units:
    d = get(f"/api/sparks/{unit}/metrics")
    m = d.get("metrics") or {}
    gpu = m.get("gpu")
    cpu = m.get("cpu") or {}
    ram = m.get("ram") or {}
    um = m.get("unifiedMemory")
    if gpu is None:
        gpu_text = "省略(无 N 卡)"
    else:
        vram = gpu.get("vram") or {}
        gpu_text = (
            f"{gpu.get('temperature')}°C "
            f"{round((vram.get('used') or 0) / 1024, 1)}/"
            f"{round((vram.get('total') or 0) / 1024, 1)}GB"
        )
    um_text = "null" if um is None else f"{um.get('percentage')}%"
    print(
        f"{unit:12s} online={str(d.get('online')):5s} | GPU {gpu_text:24s} | "
        f"CPU {cpu.get('usage')}% {cpu.get('temperature')}°C | "
        f"RAM {round((ram.get('used') or 0) / 1024, 1)}/{round((ram.get('total') or 0) / 1024, 1)}GB | "
        f"统一内存 {um_text}"
    )
    if unit == "pve":
        storage = m.get("storage") or []
        for disk in storage:
            print(
                f"             存储 {disk.get('label')}: "
                f"{round((disk.get('used') or 0) / 1024)}/{round((disk.get('total') or 0) / 1024)}GB "
                f"({disk.get('percentage')}%)"
            )
