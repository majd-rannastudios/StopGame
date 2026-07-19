# Build from repo ROOT (Railway: set "Dockerfile path" = Dockerfile, root directory = /)
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
RUN npm install
COPY packages/shared packages/shared
COPY server server
RUN npx tsc -p packages/shared && npx tsc -p server

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/dist ./node_modules/@stop/shared/dist
COPY --from=build /app/packages/shared/package.json ./node_modules/@stop/shared/package.json
COPY --from=build /app/server/dist ./server/dist
EXPOSE 2567
CMD ["node", "server/dist/index.js"]
