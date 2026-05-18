# Stage 1: Build
FROM node:20-alpine AS builder

RUN apk add --no-cache openssl

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY . .
RUN npm run build

# Stage 2: Production
FROM node:20-alpine

RUN apk add --no-cache openssl wget

WORKDIR /app

# Run as non-root user.
RUN addgroup -S nodejs && adduser -S nestjs -G nodejs

COPY --from=builder --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nodejs /app/dist ./dist
COPY --from=builder --chown=nestjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nestjs:nodejs /app/package.json ./package.json
COPY --chown=nestjs:nodejs start.sh ./start.sh

RUN chmod +x ./start.sh

USER nestjs

EXPOSE 3000

# Container-level healthcheck — Docker (and docker compose) restart the
# container if /health/live stops responding. start-period covers prisma
# migrate deploy on cold boot.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:3000/health/live >/dev/null 2>&1 || exit 1

CMD ["./start.sh"]
