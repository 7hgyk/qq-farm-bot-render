# syntax=docker/dockerfile:1.7
# Render 只会自动识别仓库根目录的 Dockerfile；此文件与 core/Dockerfile 内容一致。
# 构建上下文是仓库根目录，Dockerfile 路径填 ./Dockerfile。

ARG NODE_IMAGE=node:20.19.6-alpine3.21
ARG PNPM_VERSION=10.30.2
ARG NPM_REGISTRY=https://registry.npmjs.org/

FROM ${NODE_IMAGE} AS pnpm-base

ARG PNPM_VERSION
ARG NPM_REGISTRY

WORKDIR /app

RUN npm config set registry "${NPM_REGISTRY}" \
    && npm install --global "pnpm@${PNPM_VERSION}" \
    && pnpm config set registry "${NPM_REGISTRY}" \
    && pnpm config set store-dir /pnpm/store \
    && pnpm --version

# Dependency installation is isolated from source copies so normal code changes
# keep this expensive layer cached. The store cache also survives lockfile edits.
FROM pnpm-base AS workspace-deps

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY core/package.json ./core/
COPY web/package.json ./web/
COPY packages/session-contract/package.json ./packages/session-contract/

RUN --mount=type=cache,id=qq-farm-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile

# Web and Core use independent stages. BuildKit can reuse or execute them
# independently instead of rebuilding Web after a Core-only source change.
FROM workspace-deps AS web-builder

COPY web ./web
RUN pnpm -C web build

FROM workspace-deps AS core-builder

COPY packages/session-contract ./packages/session-contract
RUN pnpm -C packages/session-contract build
COPY tools/record-build.cjs ./tools/
COPY core ./core
RUN pnpm -C core build:ts

# Production dependencies have their own cached stage and are unaffected by
# application source changes.
FROM pnpm-base AS prod-deps

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY core/package.json ./core/
COPY web/package.json ./web/
COPY packages/session-contract/package.json ./packages/session-contract/

RUN --mount=type=cache,id=qq-farm-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm -C core install --prod --frozen-lockfile

# ==========================================

FROM ${NODE_IMAGE} AS runner

WORKDIR /app/core

ENV NODE_ENV=production
ENV TZ=Asia/Shanghai
# 生产镜像运行编译产物，禁止通过 NODE_OPTIONS 注入 tsx 等开发期 loader。
ENV NODE_OPTIONS=""

RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone && \
    apk del tzdata

COPY --from=prod-deps /app/node_modules ../node_modules/
COPY --from=prod-deps /app/core/node_modules ./node_modules/
COPY --from=prod-deps /app/package.json ../package.json
COPY --from=prod-deps /app/core/package.json ./package.json

COPY --from=core-builder /app/packages/session-contract/package.json ../packages/session-contract/package.json
COPY --from=core-builder /app/packages/session-contract/dist ../packages/session-contract/dist
COPY --from=core-builder /app/core/src/activity-data ./src/activity-data
COPY --from=core-builder /app/core/client.js ./client.js
COPY --from=core-builder /app/core/dist ./dist
COPY --from=core-builder /app/core/src/gameConfig ./src/gameConfig
COPY --from=core-builder /app/core/src/proto ./src/proto
RUN mkdir -p src/utils data/logs
COPY --from=core-builder /app/core/src/utils/tsdk.wasm ./src/utils/tsdk.wasm
COPY --from=core-builder /app/core/src/utils/tsdk-wx.wasm ./src/utils/tsdk-wx.wasm
COPY --from=web-builder /app/web/dist ../web/dist

RUN chmod -R 755 data

VOLUME ["/app/core/data"]

EXPOSE 3007

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget -q --spider "http://127.0.0.1:${PORT:-3007}/api/health" || exit 1

# 清掉平台可能注入的 NODE_OPTIONS（例如 --require tsx/cjs），再启动编译产物。
CMD ["sh", "-c", "unset NODE_OPTIONS; exec node client.js"]
