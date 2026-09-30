# Shopee Aff API — stateless (tạo link qua s.shopee.vn/an_redir, report bằng cookie).
# Không cần Chrome/Xvfb/noVNC nữa — chỉ Node.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

ENV PORT=4000
EXPOSE 4000

CMD ["node", "src/server.js"]
