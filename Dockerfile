# syntax=docker/dockerfile:1.4

FROM node:22-alpine AS builder

RUN apk add --no-cache \
    vips-dev \
    python3 \
    make \
    g++ \
    cairo-dev \
    pango-dev \
    pixman-dev

WORKDIR /build
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine

RUN apk add --no-cache \
    vips \
    libstdc++ \
    curl

RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

WORKDIR /app

COPY --from=builder --chown=appuser:appgroup /build/node_modules ./node_modules
COPY --chown=appuser:appgroup . .

RUN mkdir -p /tmp/image-converter && \
    chown -R appuser:appgroup /tmp/image-converter

ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=1024" \
    PORT=3000

EXPOSE 3000

USER appuser

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -sf http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
