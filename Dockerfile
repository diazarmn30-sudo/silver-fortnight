FROM node:20-alpine

WORKDIR /app

# perlu git kalau ada dependency yang narik dari git url
RUN apk add --no-cache git

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 8000

CMD ["node", "index.js"]
