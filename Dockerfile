FROM node:26-slim
LABEL org.opencontainers.image.source=https://github.com/nbaglivo/spread-the-word \
      org.opencontainers.image.description="A warm little portal from your static site into the fediverse."
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
RUN mkdir -p /data /config && chown node:node /data
ENV NODE_ENV=production \
    STW_DB=/data/stw.db \
    STW_CONFIG=/config/stw.json \
    PORT=8080
USER node
VOLUME /data
EXPOSE 8080
CMD ["node", "src/server.ts"]
