FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json ./
RUN npm install
COPY tsconfig.json index.ts worker.ts aggregator.ts ./
RUN npx tsc

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache sqlite
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY contracts ./contracts
EXPOSE 3400
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
