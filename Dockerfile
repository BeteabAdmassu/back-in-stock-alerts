FROM node:22-alpine
WORKDIR /app
COPY harness/ ./
COPY BRIEF.md ./
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
RUN mkdir -p /data
EXPOSE 3000
CMD ["node", "server.js"]
