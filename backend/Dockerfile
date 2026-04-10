FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json *.ts ./
RUN npx tsc

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 3400
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
