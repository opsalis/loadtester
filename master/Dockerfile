FROM node:22-alpine

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY server.js ./

RUN mkdir -p /data

ENV PORT=4002
ENV DB_PATH=/data/loadtester.db

EXPOSE 4002

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:4002/health || exit 1

CMD ["node", "server.js"]
