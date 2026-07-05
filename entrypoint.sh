#!/bin/sh
# Materialize a cookies.txt at runtime from YOUTUBE_COOKIES env var so
# yt-dlp can authenticate against YouTube's bot check. The env var should
# contain the full Netscape-format cookies.txt exported from a signed-in
# browser (e.g. via the "Get cookies.txt" extension).
set -e

COOKIES_PATH="${YOUTUBE_COOKIES_PATH:-/app/cookies.txt}"

if [ -n "$YOUTUBE_COOKIES" ]; then
  printf '%s\n' "$YOUTUBE_COOKIES" > "$COOKIES_PATH"
  chmod 600 "$COOKIES_PATH"
  echo "entrypoint: wrote YouTube cookies to $COOKIES_PATH"
  export YOUTUBE_COOKIES_PATH="$COOKIES_PATH"
fi

exec "$@"
