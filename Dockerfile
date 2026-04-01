# =============================================================================
# CIC Backend — Dockerfile
# Multi-stage build: deps → production image
# Node 22 Alpine (small + secure)
# Build: 2026-04-01
# =============================================================================

# Stage 1: install dependencies
FROM node:22-alpine AS deps

WORKDIR /app

# Copy package files only (for layer caching)
COPY package.json package-lock.json* ./

# Install production deps only
RUN npm ci --omit=dev --ignore-scripts

# =============================================================================
# Stage 2: production image
# =============================================================================
FROM node:22-alpine AS runner

# Security: run as non-root user
RUN addgroup -g 1001 -S cic && adduser -S cic -u 1001

WORKDIR /app

# Copy installed deps from stage 1
COPY --from=deps /app/node_modules ./node_modules

# Copy source code (respects .dockerignore)
COPY --chown=cic:cic . .

# Switch to non-root user
USER cic

# Expose port (Railway sets PORT env automatically)
EXPOSE 3001

# Health check — Railway uses this to verify container is up
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3001}/health || exit 1

# Start server
CMD ["node", "index.js"]
