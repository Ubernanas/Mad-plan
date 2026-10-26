# Madplan as it runs on Fly.io: the Node server (TypeScript run directly by Node)
# and the Claude Code CLI for making plans. SQLite lives on the volume at /data;
# secrets arrive as environment variables.

# better-sqlite3 may need compiling when no prebuilt binary matches this Node
# version, so dependencies are installed in a stage that has the tools for it.
FROM node:22-slim AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim

ENV NODE_ENV=production \
    PORT=3000 \
    DISABLE_AUTOUPDATER=1

# Claude Code, pinned. The onboarding flag stops a fresh install from waiting at
# its first-run screen instead of using CLAUDE_CODE_OAUTH_TOKEN.
ARG CLAUDE_CODE_VERSION=2.1.283
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force \
 && echo '{"hasCompletedOnboarding": true}' > /home/node/.claude.json \
 && chown node:node /home/node/.claude.json

WORKDIR /app

COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules

COPY config ./config
COPY public ./public
COPY src ./src
COPY deploy/start.sh /usr/local/bin/start
RUN chmod 755 /usr/local/bin/start

EXPOSE 3000
CMD ["start"]
