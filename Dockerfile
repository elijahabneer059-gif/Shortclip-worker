# shortclip-worker — Node 20 + ffmpeg + yt-dlp (nightly) + python
FROM node:20-bookworm-slim

# System deps: ffmpeg for video, python3 + pip for yt-dlp nightly.
# We install yt-dlp from its nightly channel via pip so we can bump it easily
# by rebuilding — YouTube changes their player often and the stable release
# lags behind. Pin to a specific version with YT_DLP_VERSION at build time
# if you need a reproducible build.
ARG YT_DLP_VERSION=
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    ca-certificates \
    curl \
  && pip3 install --no-cache-dir --break-system-packages \
       "yt-dlp[default]${YT_DLP_VERSION:+==$YT_DLP_VERSION}" \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "src/server.js"]
