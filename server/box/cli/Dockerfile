# One image for a CLI bot's turn (Claude Code) and for its gate (node /opt/hq/gate.mjs).
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep ca-certificates procps \
 && rm -rf /var/lib/apt/lists/*

ARG CLAUDE_CODE_VERSION=2.1.325
LABEL hq.claude-version=${CLAUDE_CODE_VERSION}
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force

RUN groupadd --gid 10001 bot \
 && useradd --uid 10001 --gid 10001 --home-dir /home/bot --create-home --shell /bin/bash bot \
 && mkdir -p /work && chown bot:bot /work

COPY gate.mjs /opt/hq/gate.mjs
RUN chmod 0755 /opt/hq && chmod 0644 /opt/hq/gate.mjs

ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_AUTOUPDATER=1

USER bot
WORKDIR /work

CMD ["node", "/opt/hq/gate.mjs"]
