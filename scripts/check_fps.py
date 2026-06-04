#!/usr/bin/env python3
import asyncio
import websockets
import time
import sys

async def measure_fps():
    try:
        async with websockets.connect("ws://localhost:8766/ws") as ws:
            print("Listening to WebSocket to calculate FPS...")
            count = 0
            start_time = time.time()
            while count < 30:
                await ws.recv()
                count += 1
            duration = time.time() - start_time
            fps = count / duration
            if fps < 15.0:
                print(f"❌ Telemetry FPS too low: {fps:.1f} updates/sec (Budget requires > 15)")
                sys.exit(1)
            else:
                print(f"✅ Telemetry FPS looks good: {fps:.1f} updates/sec")
                sys.exit(0)
    except Exception as e:
        print(f"❌ Failed to measure FPS: {e}")

asyncio.run(measure_fps())
