#!/usr/bin/env python3
import asyncio
import websockets
import json
import sys

async def check():
    try:
        async with websockets.connect("ws://localhost:8766/ws") as ws:
            print("Connected to WebSocket.")
            message = await asyncio.wait_for(ws.recv(), timeout=5.0)
            data = json.loads(message)
            if "detections" in data and "lanes" in data:
                print("✅ WebSocket telemetry looks healthy (contains detections and lanes).")
                sys.exit(0)
            else:
                print("❌ Telemetry is missing required fields:", data.keys())
                sys.exit(1)
    except Exception as e:
        print(f"❌ WebSocket connection failed: {e}")
        sys.exit(1)

asyncio.run(check())
