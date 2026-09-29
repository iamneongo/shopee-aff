#!/usr/bin/env bash
# Khởi động màn hình ảo + VNC + noVNC + API. Chrome do Node (Puppeteer) tự mở
# trên DISPLAY :99, xem/điều khiển qua noVNC để đăng nhập & giải captcha.
set -e

VNC_PASSWORD="${VNC_PASSWORD:-shopee}"
SCREEN="${SCREEN_SIZE:-1280x900x24}"

# Dọn lock cũ nếu container restart
rm -f /tmp/.X99-lock 2>/dev/null || true

# Xóa Chrome SingletonLock từ lần chạy trước (tránh Code:21 khi container mới dùng volume cũ)
CHROME_PROFILE="${CHROME_PROFILE_DIR:-/data/chrome-profile}"
rm -f "$CHROME_PROFILE/SingletonLock" "$CHROME_PROFILE/SingletonCookie" "$CHROME_PROFILE/SingletonSocket" 2>/dev/null || true

echo "[entrypoint] starting Xvfb :99 ($SCREEN)"
Xvfb :99 -screen 0 "$SCREEN" -ac +extension RANDR >/var/log/xvfb.log 2>&1 &
sleep 1

echo "[entrypoint] starting window manager"
fluxbox >/var/log/fluxbox.log 2>&1 &

echo "[entrypoint] starting x11vnc"
x11vnc -display :99 -forever -shared -rfbport 5900 -passwd "$VNC_PASSWORD" -bg -o /var/log/x11vnc.log

echo "[entrypoint] starting noVNC on :${VNC_PORT:-6080}"
websockify --web=/usr/share/novnc "${VNC_PORT:-6080}" localhost:5900 >/var/log/novnc.log 2>&1 &
sleep 1

echo "[entrypoint] starting API"
exec node src/server.js
