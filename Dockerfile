FROM node:20-alpine

WORKDIR /app

# WAJIB: git (karena ada dependency dari github/git)
RUN apk add --no-cache git

COPY package*.json ./

# rekomendasi npm modern
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /data
ENV DATA_DIR=/data
ENV TZ=Asia/Jakarta

CMD ["npm", "start"]
