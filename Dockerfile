FROM node:20-alpine

WORKDIR /app

# Copy package dulu
COPY package*.json ./

# Install deps
RUN npm install --production

# Copy semua source (termasuk config.js)
COPY . .

# Folder untuk session WA (biar bisa dipasang Volume Koyeb)
RUN mkdir -p /data

# Default path data (kalau code kamu mau pakai)
ENV DATA_DIR=/data

# Timezone (opsional)
ENV TZ=Asia/Jakarta

# Start bot
CMD ["npm", "start"]
