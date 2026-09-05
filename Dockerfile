FROM node:22-alpine AS build
WORKDIR /st-gateway
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /st-gateway
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /st-gateway/dist ./dist
EXPOSE 3002
CMD ["node", "dist/server.js"]
