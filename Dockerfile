FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
USER node
ENV HOST=0.0.0.0 DATA_DIR=/data
VOLUME /data
EXPOSE 4400
CMD ["node", "server/index.ts"]
