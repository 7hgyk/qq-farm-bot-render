#!/bin/sh
# Render Node 运行时入口：先清掉平台注入的 NODE_OPTIONS（例如 --require tsx/cjs），
# 再运行编译后的 core/client.js。生产环境不需要任何 TS loader。
set -e
# 平台可能注入 --require tsx/cjs；放一个空占位模块兜底，再清变量。
mkdir -p node_modules/tsx core/node_modules/tsx
if [ ! -f node_modules/tsx/cjs.js ]; then printf 'module.exports = {};\n' > node_modules/tsx/cjs.js; fi
if [ ! -f core/node_modules/tsx/cjs.js ]; then printf 'module.exports = {};\n' > core/node_modules/tsx/cjs.js; fi
unset NODE_OPTIONS
exec node --max-old-space-size="${NODE_MAX_OLD_SPACE_SIZE:-400}" core/client.js
