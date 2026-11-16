FROM node:22-alpine
WORKDIR /app
COPY . .
ENV PORT=3000 DB_PATH=/data/samoletpay.db BACKUP_DIR=/data/backups
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/healthz || exit 1
USER node
CMD ["node", "--no-warnings", "server/index.js"]
