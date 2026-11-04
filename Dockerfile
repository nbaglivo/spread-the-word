FROM node:26-slim
LABEL org.opencontainers.image.source=https://github.com/nbaglivo/warmhole \
      org.opencontainers.image.description="A warm little portal from your static site into the fediverse."
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
RUN mkdir -p /data /config && chown node:node /data
ENV NODE_ENV=production \
    WARMHOLE_DB=/data/warmhole.db \
    WARMHOLE_CONFIG=/config/warmhole.json \
    PORT=8080
USER node
VOLUME /data
EXPOSE 8080
CMD ["node", "src/server.ts"]
