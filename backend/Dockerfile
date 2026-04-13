FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json index.ts ./
RUN npx tsc

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
EXPOSE 3400
ENV NODE_ENV=production
# SCENARIO_ENCRYPTION_KEY must be set as an environment variable
# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
CMD ["node", "dist/index.js"]
