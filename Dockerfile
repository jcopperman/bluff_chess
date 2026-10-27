# The online game server for fly.io: serves the game and hosts PvP rooms (tools/serve.ts).
# Node runs the server's TypeScript directly; the browser build is compiled in the first stage.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=build /app/package.json /app/index.html ./
COPY --from=build /app/ui/styles.css ui/
COPY --from=build /app/assets assets
COPY --from=build /app/data data
COPY --from=build /app/dist dist
COPY --from=build /app/tools tools
COPY --from=build /app/engine engine
COPY --from=build /app/net net
EXPOSE 8080
CMD ["node", "tools/serve.ts"]
