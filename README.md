> 声明：本仓库是纯 AI 生成/整理的代码仓库，内容来自多位原作者项目的二次开发与整合，并附加了个人需求补丁；仅作个人使用，版权归原作者所有。

<div align="center">

# QQ 农场机器人

</div>

## 部署到 Render

已内置 Render 部署支持：设置环境变量 `ADMIN_USERNAME`、`ADMIN_PASSWORD`、`PUSHPLUS_TOKEN` 后，管理面板登录与 PushPlus 推送直接读取这些变量，无需再改本地配置文件。

- Blueprint：连接仓库后按根目录 `render.yaml` 创建服务
- 手动：Docker 运行时，Dockerfile 选 `core/Dockerfile`，构建上下文为仓库根目录
- 详细说明见 [docs/render-deploy.md](docs/render-deploy.md)
- Render 选择 Node 语言时：Build Command 用 `sh scripts/render-build.sh`，Start Command 用 `sh scripts/start-render.sh`（自动处理 `NODE_OPTIONS` / `tsx/cjs` 报错）

## 登录与自动重连

- 只保留应用宝 / 微信扫码登录（同一渠道，默认应用宝），QQ 登录已移除。
- 掉线后按 3 秒 / 1 分钟 / 3 分钟自动重连；三次失败会用 PushPlus 推送新的登录二维码，扫码后自动恢复。
- 间隔可在「设置 → 登录与自动重连」调整，详见 [docs/yyb-auto-relogin.md](docs/yyb-auto-relogin.md)。

