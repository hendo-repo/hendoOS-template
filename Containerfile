# Local test image. Build with this repository as the context.
FROM oven/bun:1.4.2
USER root
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json LICENSE NOTICE AGENTS.md CLAUDE.md ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
COPY content ./content
COPY docs ./docs
COPY .github ./.github
COPY .gitignore Containerfile ./
# Supply an empty local index for candidate enumeration; no host Git metadata.
RUN git init --quiet
CMD ["bun", "verify"]
