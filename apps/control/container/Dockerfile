# Agent sandbox image for both phases (Claude Code implements, pi reviews). Built and pushed by `wrangler deploy` (see wrangler.jsonc).
# The image holds tools only: no GitHub token and no LLM key. Claude Code reads a
# placeholder key (ANTHROPIC_API_KEY or OPENAI_API_KEY) that the exec call sets;
# the Worker's Outbound handler swaps in the real key on the way out.
FROM node:24-trixie-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends bash ca-certificates coreutils git ripgrep curl procps \
	&& rm -rf /var/lib/apt/lists/*

# Pinned. The install scripts of these two packages are needed; npm blocks others by default.
RUN npm install --global --allow-scripts=@anthropic-ai/claude-code,pnpm @anthropic-ai/claude-code@2.1.318 pnpm@12.18.0 \
	&& claude --version

# The reviewer engine (stage 3), pinned as in the sandbox experiment. Its install scripts are not needed.
RUN npm install --global --ignore-scripts @earendil-works/pi-coding-agent@1.5.0 \
	&& command -v pi

# Provides the command shim the Sandbox runtime uses to run processes in the container.
COPY --from=docker.io/cloudflare/sandbox:1.0.3 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

WORKDIR /workspace
# Keep the container running between requests.
CMD ["sleep", "infinity"]
