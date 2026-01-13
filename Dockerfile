FROM node:20-alpine

# wajib untuk dependency github:... (npm butuh git)
RUN apk add --no-cache git

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production

CMD ["node", "index.js"]
