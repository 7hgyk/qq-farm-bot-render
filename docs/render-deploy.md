# 部署到 Render

本项目的管理面板、Worker 和 Web 前端都由 `core/Dockerfile` 构建，可直接在 Render 上以 Docker Web Service 运行。

## 一、用 Blueprint 创建（推荐）

1. 在 Render 控制台选择 **New → Blueprint**，连接本仓库。
2. Render 会读取根目录的 `render.yaml`，创建 `qq-farm-bot` Web Service。
3. 首次创建时填写以下变量（标记为 `sync: false`，不会写进仓库）：

| 变量 | 必填 | 作用 |
| --- | --- | --- |
| `ADMIN_USERNAME` | 否 | 管理面板登录用户名，默认 `admin` |
| `ADMIN_PASSWORD` | 否 | 管理面板登录密码；设置后优先于 `data/admin.json`，且不再强制修改密码 |
| `PUSHPLUS_TOKEN` | 否 | PushPlus 推送 Token；设置后自动注入并启用 PushPlus 渠道 |
| `ADMIN_PORT` | 否 | 监听端口；未设置时使用 Render 注入的 `PORT`，再无则 `3007` |
| `FARM_DATA_DIR` | 否 | 数据目录，Blueprint 默认 `/app/core/data` |
| `TZ` | 否 | 时区，默认 `Asia/Shanghai` |

4. 部署完成后打开服务的公网地址，用 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登录。

## 二、手动创建 Docker 服务

- **Runtime**：Docker
- **Dockerfile Path**：`core/Dockerfile`
- **Docker Build Context Directory**：仓库根目录 `.`
- **Health Check Path**：`/api/game-version`
- 变量与上表一致；端口无需手动指定，本项目会读取 Render 注入的 `PORT`。

## 三、环境变量覆盖规则

- `ADMIN_PASSWORD` 存在时，登录校验使用 `ADMIN_USERNAME`（缺省 `admin`）和该密码；`data/admin.json` 中的旧账号保留但不再生效，删除变量后自动恢复。
- 环境变量托管期间，面板里的「修改密码」会被拒绝，请直接改 Render 变量并重启服务。
- `PUSHPLUS_TOKEN` 存在时，离线提醒的 PushPlus 渠道始终使用该 Token 并保持启用；面板里保存的其他 Token 不会生效，删除变量后恢复本地配置。
- 所有覆盖只作用于运行期内存，不会写回 `data/`，方便随时回滚。

## 四、数据持久化

Render 免费实例的磁盘是临时的，重新部署或重启后 `data/` 会重置（账号需要重新扫码登录）。另外免费实例在无流量时会休眠，机器人会随之下线，需要 7×24 运行请使用付费实例并关闭休眠。需要长期保留数据时：

1. 升级到支持持久磁盘的实例；
2. 在服务设置中挂载磁盘到 `/app/core/data`（或在 `render.yaml` 中取消 `disk` 段注释）；
3. 保持 `FARM_DATA_DIR=/app/core/data`。

## 五、验证

- `GET /api/ping` 返回 `{ ok: true }` 说明服务与端口正常。
- 登录页使用环境变量中的账号密码；`data/admin.json` 被删除也不会退回 `admin/admin`。
- 推送测试：管理面板「设置 → 推送」中点测试，日志出现 PushPlus 发送成功即可。

## 六、常见启动错误

### `Cannot find module 'tsx/cjs'`（Require stack: internal/preload）

说明部署环境注入了 `NODE_OPTIONS=--require tsx/cjs`，而生产依赖里没有 `tsx`。本项目已做三层处理：

1. `render.yaml` 显式设置 `NODE_OPTIONS=""`；
2. 生产镜像 `core/Dockerfile` 设置 `ENV NODE_OPTIONS=""`；
3. `tsx` 已移入 `dependencies`，即使平台仍然注入预加载参数也能找到模块。

如果服务是在 Render 控制台手动创建的，请到 **Environment** 删除 `NODE_OPTIONS` 变量，或确认 Blueprint 同步后值为空，然后重新部署。镜像入口会执行 `unset NODE_OPTIONS` 后再启动 `node client.js`；不要在 Render 里把启动命令改成 `pnpm dev`（开发模式依赖 tsx）。

## 七、UptimeRobot 保活

可用于监控的公开路径（都不需要登录）：

| 路径 | 用途 |
| --- | --- |
| `/api/health` | 最轻量，直接返回 `{"ok":true}`，推荐给 UptimeRobot |
| `/api/game-version` | 返回客户端版本与服务摘要，也可用于监控 |
| `/api/ping` | 返回运行时长与版本 |

UptimeRobot 建议配置：

- Monitor Type：`HTTP(s)`
- URL：`https://<你的服务>.onrender.com/api/health`
- Method：`GET`（HEAD 也支持）
- Interval：`5 minutes`（必须小于 15 分钟，否则 Render 免费实例会休眠）
- Timeout：`60 seconds`（Render 免费实例冷启动可能要 30-60 秒）

如果 UptimeRobot 报 down，先用浏览器或 `curl -i` 打开同一地址确认状态码：

- 返回 200 但 UptimeRobot 仍报错：把超时调大，或检查监控节点网络；
- 返回 502/503：Render 正在重新部署或实例冷启动，等 1-2 分钟再试；
- 返回 401：说明访问的不是上述公开路径（例如 `/api/ping` 在旧版本需要登录，本版本已公开）。

## 八、Render 选择 Node 语言（不使用 Docker）

Render 的 Node 运行时不会执行仓库里的 Dockerfile，所以 `NODE_OPTIONS=--require tsx/cjs` 这类平台变量会直接传给 `node`，在加载业务代码之前就报：

```text
Cannot find module 'tsx/cjs'
Require stack:
- internal/preload
```

**Build Command**（仓库根目录，Root Directory 留空）：

```bash
sh scripts/render-build.sh
```

**Start Command**：

```bash
sh scripts/start-render.sh
```

两个脚本都会先清掉 `NODE_OPTIONS`，并放置空的 `tsx/cjs` 占位模块；即使平台坚持注入 `--require tsx/cjs`，Node/pnpm 也不会再报 `Cannot find module 'tsx/cjs'`。

`env -u NODE_OPTIONS` 会在启动 node 之前删掉这个变量，因此即使 Render 的 Environment 里还留着 `NODE_OPTIONS` 也不会再触发 tsx 预加载。

**Environment 建议**：

| 变量 | 值 |
| --- | --- |
| `NODE_VERSION` | `20.19.6` |
| `NODE_ENV` | `production` |
| `FARM_DATA_DIR` | `/opt/render/project/src/core/data` |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 你的面板账号 |
| `PUSHPLUS_TOKEN` | PushPlus Token |
| `NODE_OPTIONS` | 删除，或留空 |

**Health Check Path**：`/api/health`

注意：

- 不要用 `pnpm dev` 作为启动命令，那是 tsx 开发模式；生产必须跑 `core/client.js`。
- 构建命令里的 `--prod=false` 是为了确保 `turbo`、`typescript` 等构建依赖被安装；Render 默认的 `NODE_ENV=production` 可能跳过 devDependencies。
- 如果构建日志里出现 `pnpm: not found`，在 Build Command 前面加 `corepack enable &&`。
