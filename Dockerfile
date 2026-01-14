FROM node:20-alpine

WORKDIR /app

# biar dependency yang butuh git ga error (kalau ada dep dari github)
RUN apk add --no-cache git

COPY package.json ./

# ga pake npm ci karena ga ada package-lock.json
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

ENV NODE_ENV=production
ENV PORT=8000
EXPOSE 8000

CMD ["node", "index.js"]
