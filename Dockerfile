FROM oven/bun:1-alpine

WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src

# Data (database and encrypted blobs) lives in /data: mount a volume there.
RUN mkdir -p /data && chown bun:bun /data
ENV DATA_DIR=/data HOST=0.0.0.0 PORT=8787
VOLUME /data
EXPOSE 8787
USER bun

HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/v1/health || exit 1
CMD ["bun", "run", "src/server.ts"]
