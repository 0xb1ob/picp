# Installer sandbox image (#375; see tests/e2e/README.md "Installer sandbox"): fresh-user prerequisites
# installed, everything cp-install installs only cached, so scenarios run the real paths with --network none.
FROM node:22-bookworm-slim AS node22
FROM node:24-bookworm-slim
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git gh curl ca-certificates procps \
	&& rm -rf /var/lib/apt/lists/*
# The prerequisites scenario runs the entry points with node 22 first on PATH.
COPY --from=node22 /usr/local/bin/node /opt/node22/bin/node
USER node
WORKDIR /home/node
ENV HOME=/home/node \
	NPM_CONFIG_PREFIX=/home/node/.npm-global \
	npm_config_cache=/home/node/.npm \
	npm_config_update_notifier=false \
	PATH=/home/node/.local/bin:/home/node/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
ARG PI_VERSION
RUN test -n "$PI_VERSION" && npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@$PI_VERSION"
# treehouse's own installer picks ~/.local/bin when it is first on PATH (as CI does), never sudo.
RUN mkdir -p .local/bin && curl -fsSL https://kunchenguid.github.io/treehouse/install.sh | sh && treehouse --version
ARG LENS_PACKAGES
RUN npm install -g --prefix /tmp/warm-lens $LENS_PACKAGES && rm -rf /tmp/warm-lens
ARG WORKER_PACKAGES
RUN mkdir -p /tmp/warm-home \
	&& for spec in $WORKER_PACKAGES; do HOME=/tmp/warm-home PI_OFFLINE= pi install "npm:$spec" || exit 1; done \
	&& rm -rf /tmp/warm-home
# Last, so an unchanged lockfile keeps every layer above cached.
COPY --chown=node package.json package-lock.json /tmp/warm-app/
RUN cd /tmp/warm-app && npm ci --no-audit --no-fund --loglevel=error && cd / && rm -rf /tmp/warm-app
