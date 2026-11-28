# 应用宝扫码登录与掉线自动重连

## 登录方式

项目现在只保留扫码登录：

- **应用宝扫码登录（默认）**：应用宝 PC 端的扫码渠道，实际使用微信扫码实现。
- **微信扫码登录**：与应用宝共用同一渠道，扫码结果同样会签发应用宝 `login_buffer`。

QQ 登录（QQ扫码 / NapCat）已移除，账号创建时固定写入 `platform: "wx"`。

## 扫码时保存了什么

扫码确认后，应用宝网关除返回游戏 Code 外，还会签发：

- `openid`
- `access_token`（约 2 小时）
- `refresh_token`（扫码授权窗口约 30 天）
- `login_buffer`（MMTLS ManualAuth 票据，可直接换游戏 Code）

这些凭据随账号保存在 `data/accounts.json` 的 `wxCredential` 字段里，**不会返回给浏览器**：管理面板只拿到 Code，服务端在 `/api/accounts` 建号时按 Code 自动挂载凭据。

## 掉线自动重连

账号断线或被踢下线后，主进程按设置里的间隔重试：

| 次数 | 默认间隔 | 动作 |
| --- | --- | --- |
| 第 1 次 | 3 秒 | 复用 `login_buffer` 或刷新 `access_token`，重新取 Code 并拉起账号 |
| 第 2 次 | 1 分钟 | 同上 |
| 第 3 次 | 3 分钟 | 同上 |
| 全部失败 | — | 生成新的登录二维码，推送到已启用的推送渠道（默认 PushPlus） |

- 所有重试必须在掉线后 10 分钟内完成。
- **凭据失效不重试**：重连报 `40188 invalid scope`（`Login buffer rejected: code=-101 GetLoginBuffer error`）、
  `Refresh token rejected`、或账号没有应用宝凭据时，说明这份凭据已经救不回来，直接跳过剩余重试、立刻生成二维码。
- 每次重试前都会检查账号是否已被手动启动、是否已被删除，避免和人工操作打架。
- 重连成功后会写回新的 Code 与凭据，账号立即恢复运行。
- 如果账号没有 `wxCredential`（例如旧的手动 Code 账号），三次重试都会失败并直接进入扫码流程。

## 推送二维码与扫码回登

三次重试都失败、或中途判定凭据失效后：

1. 服务端创建新的微信扫码任务，并注册一个随机公开 token；
2. 通过已启用的渠道推送 Markdown 图片：

   ```markdown
   ![扫码登录](https://<服务地址>/api/wx-login/public/<token>/qr)
   ```

3. 该图片地址无需登录，只认随机 token，5 分钟后失效；
4. 自动重连开启时，被踢下线 / 连接断开两条链路**不再单独推送下线提醒**，只保留这次的二维码推送，
   一次掉线只收一条消息（离线超时自动删除等其他提醒不受影响）；
5. 服务端在后台轮询二维码状态，用户扫码并确认后：
   - 自动调用应用宝回调换取新的 `login_buffer`；
   - 用新凭据换游戏 Code；
   - 更新账号并自动重新登录，无需再进管理面板操作。

公开地址优先读取 `RENDER_EXTERNAL_URL`（Render 自动注入），其次 `PUBLIC_BASE_URL` / `FARM_PUBLIC_URL`。

## 设置项

管理面板「设置 → 登录与自动重连」：

- 应用宝扫码登录开关（默认开）
- 微信扫码登录开关（默认开）
- 掉线自动重连开关（默认开）
- 三次重连间隔（默认 3 / 60 / 180 秒，可改）

对应接口：

- `GET/POST /api/settings/login-config` → `{ yybQrLogin, wechatQrLogin }`
- `GET/POST /api/settings/auto-relogin` → `{ enabled, intervalsSec: [3, 60, 180] }`

## 环境变量

- `PUSHPLUS_TOKEN`：存在时自动注入并启用 PushPlus 渠道，自动重连失败时默认用它推送二维码。
- `RENDER_EXTERNAL_URL`：Render 自动注入，用于拼接二维码公开地址。
- `PUBLIC_BASE_URL`：自建部署时手动指定公网地址，例如 `https://farm.example.com`。

## 网络链路与排障

扫码回登整条链路会访问四个域名，任何一个不通都会在日志里表现为失败：

| 阶段 | 域名 | 协议 |
| --- | --- | --- |
| 生成二维码 / 轮询扫码状态 | `open.weixin.qq.com`、`long.open.weixin.qq.com` | HTTPS |
| 换 `login_buffer`、拉用户信息 | `yybadaccess.3g.qq.com` | HTTPS |
| 查微信云分发节点 | `aedns.weixin.qq.com` | HTTPS（上游写死明文 HTTP，已改为优先 HTTPS） |
| 换游戏 Code | `shortcloud.weixin.com` | 明文 HTTP（自定义协议） |

海外机器（Render 新加坡等）最常见的问题是 `aedns` 那条请求（上游原本写死明文 HTTP）和 DNS 抖动；Node 的 `fetch` 只会抛 `TypeError: fetch failed`，真正的原因在 `error.cause` 里，以前日志把它丢掉了。

现在 `core/src/services/wx-login/net.ts` 会：

1. 保留真实错误码（`ENOTFOUND` / `ECONNRESET` / `ETIMEDOUT` / `UND_ERR_*`），日志形如
   `扫码后自动登录失败（第 1 次）: 网络请求失败 aedns.weixin.qq.com [fetch#1:ECONNRESET syscall=read ...]`；
2. 网络层失败先重试 2 次，再按「系统 DNS → DoH（Google / Cloudflare）→ 内置兜底 IP」解析，
   用解析出的 IP 直连并保持域名 SNI 与 `Host` 头；
3. 扫码换票失败时保留当前二维码，最多重试 5 次（退避 1.5s、3s、4.5s、6s），不再一次失败就作废。

常见错误码对应处理：

- `ENOTFOUND` / `EAI_AGAIN`：DNS 问题，已是 DoH + 固定 IP 兜底，仍失败说明出口 DNS 被劫持，改用自建解析或代理；
- `ECONNRESET` / `ETIMEDOUT`：出口 IP 被对端重置，确认机器地区是否被限制，必要时给 `core` 进程加代理；
- `HTTP 401/403` 且 body 带 `40188 invalid scope`：凭据失效，属正常路径，等扫码换新凭据即可；
- `socket timeout`：明文 HTTP 端口不通，检查平台是否封了 80 端口。
