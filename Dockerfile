# Shopee Aff API + Chrome thật + Xvfb + noVNC trong 1 container
FROM node:22-bookworm-slim

# Chrome + màn hình ảo (Xvfb) + VNC + noVNC + window manager
RUN apt-get update && apt-get install -y --no-install-recommends \
      wget gnupg ca-certificates fonts-liberation fonts-noto-cjk \
      xvfb x11vnc fluxbox novnc websockify dumb-init tini \
 && wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
 && apt-get install -y --no-install-recommends /tmp/chrome.deb \
 && rm -f /tmp/chrome.deb \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

# Profile Chrome (login + cookie tin cậy) nằm ở volume /data
ENV DISPLAY=:99 \
    CHROME_PATH=/usr/bin/google-chrome \
    PORT=4000 \
    VNC_PORT=6080

# 4000 = API, 6080 = noVNC (đăng nhập/giải captcha qua web)
EXPOSE 4000 6080

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bash", "entrypoint.sh"]
