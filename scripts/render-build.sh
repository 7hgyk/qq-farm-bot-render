#!/bin/sh
# Render Node 运行时构建入口。
# 先放一个空的 tsx/cjs 占位模块，保证平台即使注入
# NODE_OPTIONS=--require tsx/cjs 也不会在 pnpm 启动前报 MODULE_NOT_FOUND。
set -e
mkdir -p node_modules/tsx core/node_modules/tsx
if [ ! -f node_modules/tsx/cjs.js ]; then printf 'module.exports = {};\n' > node_modules/tsx/cjs.js; fi
if [ ! -f core/node_modules/tsx/cjs.js ]; then printf 'module.exports = {};\n' > core/node_modules/tsx/cjs.js; fi
unset NODE_OPTIONS
pnpm install --frozen-lockfile --prod=false
rm -rf core/dist core/node_modules/.cache
mkdir -p node_modules/tsx core/node_modules/tsx
if [ ! -f node_modules/tsx/cjs.js ]; then printf 'module.exports = {};\n' > node_modules/tsx/cjs.js; fi
if [ ! -f core/node_modules/tsx/cjs.js ]; then printf 'module.exports = {};\n' > core/node_modules/tsx/cjs.js; fi
pnpm build
# pnpm 可能重建 node_modules，构建完成后再补一次。
mkdir -p node_modules/tsx core/node_modules/tsx
if [ ! -f node_modules/tsx/cjs.js ]; then printf 'module.exports = {};\n' > node_modules/tsx/cjs.js; fi
if [ ! -f core/node_modules/tsx/cjs.js ]; then printf 'module.exports = {};\n' > core/node_modules/tsx/cjs.js; fi
