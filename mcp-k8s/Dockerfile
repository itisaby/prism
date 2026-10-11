# PRISM Kubernetes MCP server. Runs TypeScript directly with tsx (a runtime dependency).
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
# tsx caches transforms under the OS temp dir; /tmp is an emptyDir in the cluster (rootfs is read-only).
USER node
EXPOSE 8080
CMD ["node_modules/.bin/tsx", "src/index.ts"]
