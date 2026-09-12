/**
 * 微信 iLink Bot 协议客户端（pi 扩展专用精简版）
 *
 * 复用微信为 OpenClaw 开放的官方 bot 接口（iLink）：
 *   - 扫码登录:  POST https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3
 *               GET  https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=<id>
 *   - 消息收发:  POST <baseurl>/ilink/bot/getupdates | sendmessage | notifystart | notifystop
 *
 * 协议参考: @tencent-weixin/openclaw-weixin 插件与公开协议文档。
 * 凭据（bot token 等）属敏感信息，本文件不打印任何真实值。
 */

import crypto from "node:crypto";

/** 扫码登录固定服务地址（二维码创建/状态轮询始终走这里） */
export const FIXED_LOGIN_BASE_URL = "https://ilinkai.weixin.qq.com";

/** iLink-App-Id（官方插件使用 "bot"） */
const ILINK_APP_ID = "bot";

const EXT_VERSION = "1.0.0";

/** iLink-App-ClientVersion: uint32 编码 0x00MMNNPP */
function versionToUint32(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((p) => parseInt(p, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

const CLIENT_VERSION = versionToUint32(EXT_VERSION);

/** bot_agent 仅供观测，UA 风格: name/version (comment) */
const BOT_AGENT = "pi-agent/1.0 (pi-coding-agent)";

/** 服务端返回 token 失效的错误码 */
export const STALE_TOKEN_ERRCODE = -14;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface Credentials {
  /** 登录后下发的 bot 凭据（Bearer token） */
  botToken: string;
  /** 账号 ID（ilink_bot_id） */
  botId: string;
  /** 登录后消息 API 的基础 URL（按账号下发） */
  baseUrl: string;
  /** 扫码用户 ID（绑定/配对对象） */
  userId: string;
  savedAt: number;
}

export interface QRCodeResult {
  qrcode: string;
  qrcode_img_content: string;
}

export type QRStatus =
  | "wait"
  | "scaned"
  | "need_verifycode"
  | "verify_code_blocked"
  | "expired"
  | "scaned_but_redirect"
  | "binded_redirect"
  | "confirmed";

export interface QRStatusResult {
  status: QRStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

export interface MessageItem {
  type: number;
  text_item?: { text?: string };
  tool_call_start_item?: { tool_name?: string; tool_call_id?: string };
  tool_call_result_item?: { tool_name?: string; tool_call_id?: string; status?: string };
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  group_id?: string;
  /** 1 = USER, 2 = BOT */
  message_type?: number;
  item_list?: MessageItem[];
  /** 会话上下文令牌，回复时需回传 */
  context_token?: string;
}

export interface GetUpdatesResult {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

// ---------------------------------------------------------------------------
// HTTP 基础设施
// ---------------------------------------------------------------------------

function baseInfo(): Record<string, string> {
  return { channel_version: EXT_VERSION, bot_agent: BOT_AGENT };
}

function commonHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(CLIENT_VERSION),
  };
}

/** X-WECHAT-UIN: 随机 uint32 十进制字符串的 base64 */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function postHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...commonHeaders(),
  };
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

async function postJSON<T>(params: {
  baseUrl: string;
  endpoint: string;
  body: unknown;
  token?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  label: string;
}): Promise<T> {
  const url = new URL(params.endpoint, ensureTrailingSlash(params.baseUrl)).toString();
  const controller = new AbortController();
  const timer =
    params.timeoutMs !== undefined
      ? setTimeout(() => controller.abort(), params.timeoutMs)
      : undefined;
  const onExternalAbort = () => controller.abort();
  params.signal?.addEventListener("abort", onExternalAbort, { once: true });
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: postHeaders(params.token),
      body: JSON.stringify(params.body),
      signal: controller.signal,
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`${params.label} HTTP ${res.status}: ${raw.slice(0, 200)}`);
    return JSON.parse(raw) as T;
  } finally {
    if (timer) clearTimeout(timer);
    params.signal?.removeEventListener("abort", onExternalAbort);
  }
}

async function getJSON<T>(params: {
  baseUrl: string;
  endpoint: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  label: string;
}): Promise<T> {
  const url = new URL(params.endpoint, ensureTrailingSlash(params.baseUrl)).toString();
  const controller = new AbortController();
  const timer =
    params.timeoutMs !== undefined
      ? setTimeout(() => controller.abort(), params.timeoutMs)
      : undefined;
  const onExternalAbort = () => controller.abort();
  params.signal?.addEventListener("abort", onExternalAbort, { once: true });
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: commonHeaders(),
      signal: controller.signal,
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`${params.label} HTTP ${res.status}: ${raw.slice(0, 200)}`);
    return JSON.parse(raw) as T;
  } finally {
    if (timer) clearTimeout(timer);
    params.signal?.removeEventListener("abort", onExternalAbort);
  }
}

// ---------------------------------------------------------------------------
// 扫码登录
// ---------------------------------------------------------------------------

/** 创建扫码登录会话。localTokenList 传入本地已保存的 bot token（最多 10 个），便于识别已绑定的 bot。 */
export async function fetchQRCode(localTokenList: string[] = []): Promise<QRCodeResult> {
  return postJSON<QRCodeResult>({
    baseUrl: FIXED_LOGIN_BASE_URL,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=3`,
    body: { local_token_list: localTokenList.slice(0, 10) },
    timeoutMs: 15_000,
    label: "get_bot_qrcode",
  });
}

/** 长轮询扫码状态；客户端超时/网络错误按 wait 处理继续轮询。 */
export async function pollQRStatus(
  qrcode: string,
  opts: { verifyCode?: string; baseUrl?: string; signal?: AbortSignal } = {},
): Promise<QRStatusResult> {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (opts.verifyCode) endpoint += `&verify_code=${encodeURIComponent(opts.verifyCode)}`;
  try {
    return await getJSON<QRStatusResult>({
      baseUrl: opts.baseUrl ?? FIXED_LOGIN_BASE_URL,
      endpoint,
      timeoutMs: 35_000,
      signal: opts.signal,
      label: "get_qrcode_status",
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError" && opts.signal?.aborted) throw err;
    // 超时或网关错误均视为等待
    return { status: "wait" };
  }
}

// ---------------------------------------------------------------------------
// 登录后的消息接口
// ---------------------------------------------------------------------------

export async function notifyStart(baseUrl: string, token: string): Promise<void> {
  await postJSON<{ ret?: number; errmsg?: string }>({
    baseUrl,
    endpoint: "ilink/bot/msg/notifystart",
    body: { base_info: baseInfo() },
    token,
    timeoutMs: 10_000,
    label: "notifystart",
  });
}

export async function notifyStop(baseUrl: string, token: string): Promise<void> {
  await postJSON<{ ret?: number; errmsg?: string }>({
    baseUrl,
    endpoint: "ilink/bot/msg/notifystop",
    body: { base_info: baseInfo() },
    token,
    timeoutMs: 10_000,
    label: "notifystop",
  });
}

/** 长轮询获取新消息。超时返回空结果（ret=0, msgs=[]）。 */
export async function getUpdates(params: {
  baseUrl: string;
  token: string;
  getUpdatesBuf: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<GetUpdatesResult> {
  const timeout = params.timeoutMs ?? 35_000;
  try {
    return await postJSON<GetUpdatesResult>({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: { get_updates_buf: params.getUpdatesBuf ?? "", base_info: baseInfo() },
      token: params.token,
      timeoutMs: timeout,
      signal: params.signal,
      label: "getupdates",
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      if (params.signal?.aborted) throw err;
      return { ret: 0, msgs: [], get_updates_buf: params.getUpdatesBuf };
    }
    throw err;
  }
}

/** 发送一条文本消息。contextToken 回传会话上下文，主动推送时传最近一次收到的值。 */
export async function sendText(params: {
  baseUrl: string;
  token: string;
  toUserId: string;
  text: string;
  contextToken?: string;
  timeoutMs?: number;
}): Promise<void> {
  const body = {
    msg: {
      from_user_id: "",
      to_user_id: params.toUserId,
      client_id: crypto.randomUUID(),
      message_type: 2, // BOT
      message_state: 2, // FINISH
      item_list: [{ type: 1, text_item: { text: params.text } }],
      context_token: params.contextToken || undefined,
    },
    base_info: baseInfo(),
  };
  const resp = await postJSON<{ ret?: number; errmsg?: string }>({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body,
    token: params.token,
    timeoutMs: params.timeoutMs ?? 15_000,
    label: "sendmessage",
  });
  if (resp.ret && resp.ret !== 0) {
    throw new Error(`sendmessage ret=${resp.ret} errmsg=${resp.errmsg ?? "(none)"}`);
  }
}

/** 发送/取消“正在输入”状态。status: 1=输入中, 2=取消。需要先 getConfig 拿 typing_ticket。 */
export async function sendTyping(params: {
  baseUrl: string;
  token: string;
  userId: string;
  contextToken?: string;
  status: 1 | 2;
}): Promise<void> {
  const cfg = await postJSON<{ ret?: number; typing_ticket?: string }>({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getconfig",
    body: {
      ilink_user_id: params.userId,
      context_token: params.contextToken || undefined,
      base_info: baseInfo(),
    },
    token: params.token,
    timeoutMs: 10_000,
    label: "getconfig",
  });
  if (!cfg.typing_ticket) return;
  await postJSON({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendtyping",
    body: {
      ilink_user_id: params.userId,
      typing_ticket: cfg.typing_ticket,
      status: params.status,
      base_info: baseInfo(),
    },
    token: params.token,
    timeoutMs: 10_000,
    label: "sendtyping",
  }).catch(() => {});
}
