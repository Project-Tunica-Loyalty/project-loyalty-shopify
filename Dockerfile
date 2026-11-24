FROM node:22-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production
ENV LOYALTY_BACKEND_URL=https://uat-be.reglrs.ai/api

COPY . .

RUN npm ci --include=dev && npm run build && npm prune --omit=dev && npm cache clean --force

CMD ["npm", "run", "docker-start"]
