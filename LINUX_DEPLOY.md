# Flashing the 2012 MacBook Pro → Ubuntu vision box

Wipe macOS Catalina, run a lean Linux so the 2012 MBP (2.5GHz i5, 4GB, HD4000)
spends its RAM and CPU on detection instead of OS overhead.

Why bother (measured/expected vs Catalina):
- **RAM**: Catalina idle ~2GB → Ubuntu Server headless ~0.4GB. ~1.5GB freed →
  room to run MORE models (plates, lights) not just the LITE single detector.
- **Webcam**: Linux has no TCC permission wall → `/dev/video0` just works
  (this was blocked on macOS over SSH).
- **CPU**: ~10-20% inference gain from no WindowServer/Spotlight. The Ivy Bridge
  ceiling stays (~8-11 FPS @416), but every cycle goes to YOLO.

> ⚠️ This ERASES the drive — macOS, Homebridge, all data gone. Back up first.

---

## 1. Make the USB installer (on the Windows PC)

1. Download **Ubuntu Server 22.04 LTS** ISO: https://ubuntu.com/download/server
   (Server = no desktop = lightest. Want a GUI? Use **Xubuntu 22.04** instead.)
2. Flash to an 8GB+ USB stick with **Rufus** (https://rufus.ie) or balenaEtcher.

## 2. Boot the 2012 Mac from USB

1. Insert USB, power on, immediately hold **Option (⌥)** at the chime.
2. Pick the orange **EFI Boot** USB entry.
3. Use a **wired ethernet** adapter for install — the 2012's Broadcom WiFi
   needs a driver Ubuntu doesn't ship by default (fixed post-install below).

## 3. Install Ubuntu

- Erase the whole disk (remove macOS). Default guided partitioning is fine.
- Create user — **use the same name `homebridge`** to match the scripts, or any
  name (the setup script adapts).
- Enable **"Install OpenSSH server"** when prompted → you can SSH in headless.
- Finish, remove USB, reboot.

## 4. Post-install fixes (2012 MBP quirks)

SSH in (or use the console): `ssh <user>@<box-ip>`

```bash
# WiFi (Broadcom BCM4331) — only if not on ethernet:
sudo apt-get update
sudo apt-get install -y bcmwl-kernel-source

# (optional) keep the lid-closed box awake as a server:
sudo sed -i 's/#HandleLidSwitch=.*/HandleLidSwitch=ignore/' /etc/systemd/logind.conf
sudo systemctl restart systemd-logind
```

## 5. Deploy RetroVision (one command)

```bash
curl -fsSL https://raw.githubusercontent.com/seanwirkus/RetroVision/master/scripts/setup_linux.sh | bash
```

This installs Python, torch (CPU), ultralytics, OpenCV, clones the repo, and
registers **systemd services** for the vision server (:8766) and dashboard
(:8000), both auto-starting on boot. Stock `yolov8n` auto-downloads, so it's
working immediately — webcam live by default.

Open `http://<box-ip>:8000` from any browser on the network.

## 6. Upgrade to the good models (more detection)

Copy the custom weights onto the box (from the Mac/Windows over scp, or USB):
```bash
scp "self_v2.pt" "anpr-2.pt" "plate-chars.pt" "traffic-light-detection.pt" \
    <user>@<box-ip>:~/retrovision/RetroVision/"Vision Lab"/
```
Then enable the richer (non-LITE) profile so plates + lights load too:
```bash
sudo systemctl edit --full retrovision-vision   # change LITE=1 -> LITE=0
sudo systemctl restart retrovision-vision
```
On 4GB, watch RAM (`free -h`); if it swaps, go back to LITE=1.

## Manage it
```bash
journalctl -u retrovision-vision -f          # live logs
sudo systemctl restart retrovision-vision    # restart vision
sudo systemctl restart retrovision-dashboard # restart dashboard
free -h ; uptime                             # RAM + load
```
