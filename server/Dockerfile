# ── Build stage ────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc

# ── Production stage ──────────────────────────────
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy compiled JS from builder
COPY --from=builder /app/dist ./dist

# Copy SQL schema (needed at runtime for DB init)
COPY src/db/schema.sql ./dist/db/schema.sql

# auth_info is mounted as a volume at runtime
RUN mkdir -p auth_info

EXPOSE 3001

CMD ["node", "dist/index.js"]