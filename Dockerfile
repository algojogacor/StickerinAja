FROM node:20-slim

RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --production

COPY . .

ENV NODE_ENV=production
ENV TEMP_DIR=/tmp/stickerin-temp

CMD ["node", "index.js"]
