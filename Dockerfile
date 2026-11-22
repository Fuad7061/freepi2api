FROM node:22-alpine

LABEL maintainer="Fuad <https://github.com/Fuad7061/freepi2api>"
LABEL description="FreePi to OpenAI/Anthropic API Gateway & Management Dashboard"

WORKDIR /app

# Create data directory and non-root user
RUN addgroup -S bridge && adduser -S bridge -G bridge \
    && mkdir -p /app/data /app/data/logs \
    && chown -R bridge:bridge /app

COPY package.json ./
COPY src/ ./src/

RUN chown -R bridge:bridge /app

USER bridge

VOLUME ["/app/data"]

ENV HOST=0.0.0.0
ENV PORT=8787
ENV DATA_DIR=/app/data

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8787/health || exit 1

CMD ["node", "src/server.js"]
