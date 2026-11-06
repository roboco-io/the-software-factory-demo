FROM node:24-trixie-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends bash ca-certificates git ripgrep curl dnsutils netcat-openbsd procps iproute2 \
	&& rm -rf /var/lib/apt/lists/*

RUN npm install --global --allow-scripts=@anthropic-ai/claude-code,pnpm @anthropic-ai/claude-code@2.1.318 pnpm@12.18.0 \
	&& claude --version
RUN npm install --global --ignore-scripts @earendil-works/pi-coding-agent@1.5.0

COPY --from=docker.io/cloudflare/sandbox:1.0.3 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

WORKDIR /workspace
# Keep the container running between requests
CMD ["sleep", "infinity"]
