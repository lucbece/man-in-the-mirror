# The bot as a container. Same code path as `npm start`; the differences are
# where things live and who runs them:
#
# - Debian slim, not Alpine: the Agent SDK ships a native `claude` binary that
#   it spawns for every agent turn, built against glibc.
# - `data/` and `runtime/` are volumes. The first holds config.json (the keys,
#   mode 0600) and the filler cache; the second holds the yt-dlp binary fetched
#   on first use. Both must outlive the image.
# - Runs as the unprivileged `node` user with a real HOME, because the claude
#   subprocess writes under ~/.claude.
# - The panel binds 0.0.0.0 *inside* the container so the healthcheck and the
#   port mapping can reach it; compose.yaml publishes it on the host's loopback
#   only. It has no login, so it must never face the internet.
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first so a code change does not reinstall them. Install scripts
# must run: ffmpeg-static downloads its binary in one.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src

RUN mkdir -p /app/data /app/runtime /home/node/.claude \
  && chown -R node:node /app/data /app/runtime /home/node
USER node
ENV HOME=/home/node \
    WEB_HOST=0.0.0.0 \
    WEB_PORT=3000

VOLUME ["/app/data", "/app/runtime"]
EXPOSE 3000

# The panel's state endpoint answers as soon as the process is up, whether or
# not a token is configured, so "healthy" means "the process serves", not
# "logged in to Discord". Login problems show in the log, not here.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEB_PORT||3000)+'/api/state').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
