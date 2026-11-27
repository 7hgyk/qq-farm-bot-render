export {};
/**
 * 应用宝（微信扫码）签发的登录凭据。
 *
 * 扫码成功后网关会同时下发 openid / access_token / refresh_token，
 * 其中 access_token 约 2 小时有效，refresh_token 用于续期（扫码授权窗口约 30 天）。
 * 这三者加上 login_buffer 可以重新换取游戏登录 Code，无需再次扫码。
 */
export interface WxCredential {
  openid: string;
  accessToken: string;
  refreshToken: string;
  /** access_token 过期时间（毫秒时间戳），0 表示未知。 */
  expiresAt: number;
  loginType: string;
  /** 最近一次取得的应用宝 login_buffer，可在有效期内直接换 Code。 */
  loginBuffer?: string;
  loginBufferAt?: number;
}

export interface Account {
  id: string;
  name: string;
  code: string;
  platform: string;
  uin: string;
  qq: string;
  avatar: string;
  nick?: string;
  /** 应用宝扫码凭据，用于掉线后免扫码自动重连。 */
  wxCredential?: WxCredential;
  createdAt: number;
  updatedAt: number;
}

export interface AccountsData {
  accounts: Account[];
  nextId: number;
}
