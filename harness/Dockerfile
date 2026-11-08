# Sandbox test server. Build from this directory: docker build -t bis-harness harness
FROM node:22-alpine
WORKDIR /app
COPY server.js ./
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
RUN mkdir -p /data
EXPOSE 3000
CMD ["node", "server.js"]
