# KubePulse Dockerfile (multi-stage build)

# Base image is pinned by digest so every build uses exactly the same Node.js image.

# Stage 1: run the tests. If a test fails the build stops here.
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS test
WORKDIR /src
COPY package.json ./
COPY app ./app
COPY public ./public
COPY test ./test
RUN node --test test/

# Stage 2: runtime image with only the files needed to run the app
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS runtime

LABEL maintainer="Abhay" \
      description="KubePulse - containerized Node.js app for the Kubernetes assignment" \
      version="1.0"

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

COPY --from=test /src/package.json ./
COPY --from=test /src/app ./app
COPY --from=test /src/public ./public

# run as the non-root "node" user that comes with the base image
USER node

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "app/server.js"]
