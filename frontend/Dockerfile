FROM node:24.20.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# `runtime-dev` is a Node-free target (never triggers the build stage above):
# docker-compose.dev.yml (build.target: runtime-dev) bind-mounts a host-built
# dist/ over it, and `scripts/up.sh --host-build` builds this target too, then
# `docker cp`s a host-built dist/ into the running container — both exist so
# a Node image pull failure never blocks getting a working frontend up.
FROM nginx:alpine AS runtime-dev
COPY nginx.conf /etc/nginx/conf.d/default.conf

FROM runtime-dev AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
