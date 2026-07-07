FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN apk add --no-cache python3 make g++ \
  && npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
