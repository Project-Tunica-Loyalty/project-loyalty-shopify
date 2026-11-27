FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
COPY extensions/loyalty-discount/package.json extensions/loyalty-discount/package.json
RUN npm ci
COPY . .
RUN npx prisma generate
RUN npm run build

ENV NODE_ENV=production
ENV LOYALTY_BACKEND_URL=https://uat-be.reglrs.ai/api

COPY . .

RUN npm ci --include=dev && npm run build && npm prune --omit=dev && npm cache clean --force

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache openssl
ENV NODE_ENV=production
ENV PORT=3000
COPY package.json package-lock.json ./
COPY extensions/loyalty-discount/package.json extensions/loyalty-discount/package.json
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate && npm cache clean --force
COPY --from=build /app/build ./build
COPY --from=build /app/public ./public
EXPOSE 3000
USER node
CMD ["npm", "run", "docker-start"]
