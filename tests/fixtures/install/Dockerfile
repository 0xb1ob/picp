# Installer sandbox image (#375; see tests/e2e/README.md "Installer sandbox"): fresh-user prerequisites
# installed, everything cp-install installs only cached, so scenarios run the real paths with --network none.
FROM node:22-bookworm-slim AS node22
FROM node:24.0.0-bookworm-slim AS node24floor
FROM node:24-bookworm-slim
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git gh curl ca-certificates procps \
	&& rm -rf /var/lib/apt/lists/*
# The prerequisites scenario runs the entry points with node 22 first on PATH; node-floor with node 24.0.0 (no
# import.meta.main, which landed in 24.2).
COPY --from=node22 /usr/local/bin/node /opt/node22/bin/node
COPY --from=node24floor /usr/local/bin/node /opt/node24.0/bin/node
USER node
WORKDIR /home/node
ENV HOME=/home/node \
	NPM_CONFIG_PREFIX=/home/node/.npm-global \
	npm_config_cache=/home/node/.npm \
	npm_config_update_notifier=false \
	PATH=/home/node/.local/bin:/home/node/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
ARG PI_VERSION
RUN test -n "$PI_VERSION" && npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@$PI_VERSION"
# Cached only: the unpinned pi install-tools runs when pi is absent (the recovery scenario), offline.
RUN npm install -g --prefix /tmp/warm-pi --ignore-scripts @earendil-works/pi-coding-agent && rm -rf /tmp/warm-pi
# The pinned release asset, as install-tools downloads it: no "latest" API call (#428).
ARG TREEHOUSE_VERSION
RUN test -n "$TREEHOUSE_VERSION" && mkdir -p .local/bin \
	&& curl -fsSL "https://github.com/kunchenguid/treehouse/releases/download/v${TREEHOUSE_VERSION}/treehouse-v${TREEHOUSE_VERSION}-linux-$(dpkg --print-architecture).tar.gz" | tar xz -C .local/bin treehouse \
	&& treehouse --version
ARG LENS_PACKAGES
RUN npm install -g --prefix /tmp/warm-lens $LENS_PACKAGES && rm -rf /tmp/warm-lens
ARG WORKER_PACKAGES
RUN mkdir -p /tmp/warm-home \
	&& for spec in $WORKER_PACKAGES; do HOME=/tmp/warm-home PI_OFFLINE= pi install "npm:$spec" || exit 1; done \
	&& rm -rf /tmp/warm-home
# Last, so an unchanged lockfile keeps every layer above cached.
COPY --chown=node package.json package-lock.json /tmp/warm-app/
RUN cd /tmp/warm-app && npm ci --no-audit --no-fund --loglevel=error && cd / && rm -rf /tmp/warm-app
