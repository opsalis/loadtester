FROM node:22-alpine

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY worker.js ./

ENV MASTER_URL=ws://master:4002/ws
ENV WORKER_LOCATION=default

CMD ["node", "worker.js"]
