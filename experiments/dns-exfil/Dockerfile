# Same base as apps/control/container/Dockerfile, plus DNS and network tools for probing.
# No agents and no keys: the probe only needs a shell.
FROM node:24-trixie-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends bash ca-certificates curl dnsutils netcat-openbsd iproute2 python3 \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=docker.io/cloudflare/sandbox:1.0.3 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

WORKDIR /workspace
CMD ["sleep", "infinity"]
