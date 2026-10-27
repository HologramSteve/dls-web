# Central server: the built web app + live collaboration (rooms are stored in /data).
#   docker build -t dls-web . && docker run -p 8787:8787 -v dls-data:/data dls-web
FROM oven/bun:1.4.4 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.4.4
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY server ./server
COPY src/collab/Protocol.ts ./src/collab/Protocol.ts
COPY src/cloud/CloudProtocol.ts ./src/cloud/CloudProtocol.ts
ENV PORT=8787 DATA_DIR=/data STATIC_DIR=/app/dist
RUN mkdir -p /data && chown bun:bun /data
VOLUME /data
EXPOSE 8787
USER bun
CMD ["bun", "server/index.ts"]
