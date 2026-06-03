#!/usr/bin/env python3
"""
Car cluster serial bridge.

Reads ESP32-C3 telemetry over USB serial and serves it to the dashboard UI
(Chromium kiosk) as JSON over a WebSocket. Also serves the static web/ folder,
so one process runs the whole thing.

Pipeline:
    ESP32-C3 --USB serial--> serial_bridge.py --WebSocket JSON--> web/ (Chromium)

Input on the serial line (auto): one compact JSON object per line from the C3
firmware (see firmware_patch.md), e.g.
    {"rpm":3450,"mph":62,"fuel":73,"t":22.5,"h":44.0,"d":-1,"lt":2,"st":22,"sq":1234,"ms":56789}
Lines that are not JSON (the C3's debug prints) are ignored, so both can share USB.

Run:
    python3 serial_bridge.py                 # auto-detect serial port, fall back to demo
    python3 serial_bridge.py --port /dev/ttyACM0
    python3 serial_bridge.py --demo          # no hardware, synthetic data for UI dev
"""
import argparse
import asyncio
import glob
import hashlib
import json
import math
import os
import threading
import time
from pathlib import Path

import serial  # pyserial
from fastapi import FastAPI, WebSocket
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

BASE = Path(__file__).resolve().parent
WEB = BASE / "web"
BAUD = 115200
STALE_AFTER = 1.0  # s without a packet => link "stale"
PUSH_HZ = 30

# Mirror of sensor_packet.h bit flags.
LIGHT_BITS = {"head": 1 << 0, "left": 1 << 1, "right": 1 << 2, "brake": 1 << 3, "hazard": 1 << 4}
STATUS_BITS = {"fuelConnected": 1 << 0, "tachLocked": 1 << 1, "vssActive": 1 << 2,
               "distanceValid": 1 << 3, "dhtValid": 1 << 4}

state = {
    "rpm": 0, "mph": 0, "fuelPct": 0,
    "tempC": None, "humidity": None, "distanceCm": None,
    "lights": {k: False for k in LIGHT_BITS},
    "status": {k: False for k in STATUS_BITS},
    "seq": 0, "ms": 0,
}
state_lock = threading.Lock()
last_rx = 0.0
demo = False


def expand_flags(value: int, table: dict) -> dict:
    return {name: bool(value & bit) for name, bit in table.items()}


def normalize(d: dict) -> dict:
    """Accept compact firmware keys or verbose names; produce UI schema."""
    def get(*keys, default=None):
        for k in keys:
            if k in d and d[k] is not None:
                return d[k]
        return default

    temp = get("t", "tempC")
    if temp is not None and temp <= -100:   # NaN sentinel from firmware
        temp = None
    hum = get("h", "humidity")
    if hum is not None and hum < 0:
        hum = None
    dist = get("d", "distanceCm")
    if dist is not None and dist < 0:        # -1 == no echo / NaN
        dist = None

    lt = int(get("lt", "lights", default=0) or 0)
    st = int(get("st", "status", "statusFlags", default=0) or 0)
    return {
        "rpm": int(get("rpm", default=0) or 0),
        "mph": int(get("mph", default=0) or 0),
        "fuelPct": int(get("fuel", "fuelPct", default=0) or 0),
        "tempC": temp,
        "humidity": hum,
        "distanceCm": dist,
        "lights": expand_flags(lt, LIGHT_BITS),
        "status": expand_flags(st, STATUS_BITS),
        "seq": int(get("sq", "seq", default=0) or 0),
        "ms": int(get("ms", "millisSent", default=0) or 0),
    }


def find_port():
    for pat in ("/dev/ttyACM*", "/dev/ttyUSB*", "/dev/cu.usbmodem*", "/dev/cu.wchusbserial*"):
        hits = sorted(glob.glob(pat))
        if hits:
            return hits[0]
    return None


def reader_thread(port: str):
    global last_rx
    while True:
        try:
            ser = serial.Serial(port, BAUD, timeout=1)
        except Exception as e:
            print(f"[bridge] open {port} failed: {e}; retry in 2s")
            time.sleep(2)
            continue
        print(f"[bridge] serial open {port} @ {BAUD}")
        while True:
            try:
                raw = ser.readline()
            except Exception as e:
                print(f"[bridge] read error: {e}; reopening")
                break
            if not raw:
                continue
            s = raw.strip()
            if not s.startswith(b"{"):
                continue  # skip C3 debug prints
            try:
                d = json.loads(s.decode("utf-8", "ignore"))
            except Exception:
                continue
            tele = normalize(d)
            with state_lock:
                state.update(tele)
                last_rx = time.time()


def demo_thread():
    global last_rx
    print("[bridge] DEMO mode — synthetic telemetry")
    while True:
        t = time.time()
        phase = int(t % 12)
        lt = 0
        if phase in (0, 1):
            lt = LIGHT_BITS["left"]
        elif phase in (2, 3):
            lt = LIGHT_BITS["right"]
        elif phase in (4,):
            lt = LIGHT_BITS["brake"]
        elif phase in (5,):
            lt = LIGHT_BITS["hazard"]
        elif phase >= 8:
            lt = LIGHT_BITS["head"]
        d = {
            "rpm": 3600 + math.sin(t * 1.35) * 2300,
            "mph": 58 + math.cos(t * 0.65) * 24,
            "fuel": 68 + math.sin(t * 0.18) * 18,
            "t": 22.0 + math.sin(t * 0.12) * 3.0,
            "h": 45.0 + math.cos(t * 0.10) * 8.0,
            "d": -1,
            "lt": lt,
            "st": STATUS_BITS["tachLocked"] | STATUS_BITS["vssActive"]
                  | STATUS_BITS["fuelConnected"] | STATUS_BITS["dhtValid"],
            "sq": int(t * PUSH_HZ),
            "ms": int(t * 1000) % 2_000_000_000,
        }
        tele = normalize(d)
        with state_lock:
            state.update(tele)
            last_rx = time.time()
        time.sleep(1.0 / PUSH_HZ)


app = FastAPI()

# --------------- file-watcher for auto-reload ---------------
# Monitors web/ for any file changes and notifies connected browsers via
# /ws-reload so Chromium instantly reloads when you scp new CSS/JS to the Pi.
reload_clients: list[WebSocket] = []
reload_lock = threading.Lock()
_file_hashes: dict[str, str] = {}


def _hash_file(path: str) -> str:
    try:
        return hashlib.md5(open(path, 'rb').read()).hexdigest()
    except Exception:
        return ''


def _scan_web_hashes() -> dict[str, str]:
    hashes = {}
    for root, _, files in os.walk(str(WEB)):
        for f in files:
            if f.startswith('.') or '/_legacy/' in root:
                continue
            fp = os.path.join(root, f)
            hashes[fp] = _hash_file(fp)
    return hashes


async def _notify_reload(changed: list[str]):
    msg = json.dumps({"type": "reload", "changed": changed})
    with reload_lock:
        clients = list(reload_clients)
    for ws_client in clients:
        try:
            await ws_client.send_text(msg)
        except Exception:
            with reload_lock:
                try:
                    reload_clients.remove(ws_client)
                except ValueError:
                    pass


async def _watch_files():
    global _file_hashes
    _file_hashes = _scan_web_hashes()
    while True:
        await asyncio.sleep(0.8)  # poll interval — light on CPU
        new_hashes = _scan_web_hashes()
        changed = []
        for fp, h in new_hashes.items():
            if _file_hashes.get(fp) != h:
                changed.append(os.path.basename(fp))
        # detect deleted files too
        for fp in _file_hashes:
            if fp not in new_hashes:
                changed.append(os.path.basename(fp))
        if changed:
            print(f"[bridge] file change detected: {changed} — sending reload")
            _file_hashes = new_hashes
            await _notify_reload(changed)


@app.on_event("startup")
async def start_watcher():
    asyncio.create_task(_watch_files())


@app.websocket("/ws-reload")
async def ws_reload(websocket: WebSocket):
    await websocket.accept()
    with reload_lock:
        reload_clients.append(websocket)
    try:
        while True:
            await websocket.receive_text()  # keep alive
    except Exception:
        with reload_lock:
            try:
                reload_clients.remove(websocket)
            except ValueError:
                pass


@app.websocket("/ws")
async def ws(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            now = time.time()
            with state_lock:
                payload = dict(state)
                age = now - last_rx
            payload["link"] = "demo" if demo else ("live" if age < STALE_AFTER else "stale")
            payload["ts"] = now
            await websocket.send_text(json.dumps(payload))
            await asyncio.sleep(1.0 / PUSH_HZ)
    except Exception:
        pass  # client closed


# --------------- no-cache static files ---------------
# Chromium kiosk aggressively caches; serve everything with no-store so
# CSS/JS/HTML changes take effect immediately on next load or reload.
class NoCacheStaticFiles(StaticFiles):
    async def __call__(self, scope, receive, send):
        # Intercept the response to add Cache-Control headers
        original_send = send

        async def send_with_no_cache(message):
            if message.get("type") == "http.response.start":
                headers = list(message.get("headers", []))
                headers.append([b"cache-control", b"no-store, no-cache, must-revalidate, max-age=0"])
                headers.append([b"pragma", b"no-cache"])
                message["headers"] = headers
            await original_send(message)

        await super().__call__(scope, receive, send_with_no_cache)


# Static UI mounted last so /ws and /ws-reload win.
app.mount("/", NoCacheStaticFiles(directory=str(WEB), html=True), name="web")


def main():
    global demo
    ap = argparse.ArgumentParser(description="Car cluster serial -> WebSocket bridge")
    ap.add_argument("--port", help="serial device (default: auto-detect)")
    ap.add_argument("--demo", action="store_true", help="synthetic data, no hardware")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--http-port", type=int, default=8000)
    args = ap.parse_args()

    demo = args.demo
    if demo:
        threading.Thread(target=demo_thread, daemon=True).start()
    else:
        port = args.port or find_port()
        if not port:
            print("[bridge] no serial port found — using demo. (pass --port to override)")
            demo = True
            threading.Thread(target=demo_thread, daemon=True).start()
        else:
            threading.Thread(target=reader_thread, args=(port,), daemon=True).start()

    print(f"[bridge] http://{args.host}:{args.http_port}/  (ws at /ws)")
    import uvicorn
    uvicorn.run(app, host=args.host, port=args.http_port, log_level="warning")


if __name__ == "__main__":
    main()
