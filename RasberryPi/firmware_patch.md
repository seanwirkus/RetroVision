# C3 firmware patch — emit telemetry on USB serial

The Pi reads the C3 over USB (`/dev/ttyACM0`). Right now the C3 only writes the
binary `SensorPacket` to its **UART pins + ESP-NOW** — the USB `Serial` port only
carries debug `printf`. Add **one line** so the bridge gets clean data.

ESP-NOW and the UART bridge are untouched; this is additive.

## Where
`CarPlay_Dashboard/firmware/c3-sensor/main.cpp`, inside `sendSensorPacket()`,
right after the packet fields are filled (just before the `Serial1.write(...)`).

## Add

```cpp
    // ---- USB JSON out for the Raspberry Pi cluster bridge ----
    // One compact line per TX tick on USB CDC Serial. The Pi bridge reads
    // /dev/ttyACM0 and ignores any line that isn't JSON, so debug prints coexist.
    // Sentinels: distance -1 = no echo; temp -1000 = NaN; humidity -1 = NaN.
    {
        const float dOut = isnan(distanceCm) ? -1.0f   : distanceCm;
        const float tOut = isnan(tempC)      ? -1000.0f : tempC;
        const float hOut = isnan(humidity)   ? -1.0f    : humidity;
        Serial.printf(
            "{\"rpm\":%u,\"mph\":%u,\"fuel\":%u,\"t\":%.1f,\"h\":%.1f,\"d\":%.1f,"
            "\"lt\":%u,\"st\":%u,\"sq\":%lu,\"ms\":%lu}\n",
            currentRpm, currentMph, currentFuelPct,
            tOut, hOut, dOut,
            pkt.lights, pkt.statusFlags,
            (unsigned long)txSeq, (unsigned long)millis());
    }
```

`txSeq` is already incremented above this point (`pkt.seq = ++txSeq;`), so it is valid.

## Flash
```bash
cd ~/Documents/CarPlay_Dashboard
pio run -e c3-sensor -t upload
```

## Verify
Open the serial monitor (or on the Pi: `cat /dev/ttyACM0`). You should see a JSON
line ~30x/sec:
```
{"rpm":3450,"mph":62,"fuel":73,"t":22.5,"h":44.0,"d":-1.0,"lt":2,"st":22,"sq":1234,"ms":56789}
```

Then run the bridge **without** `--demo` and it picks up live data automatically.
