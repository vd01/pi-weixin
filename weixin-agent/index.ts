/**
 * pi 微信 Agent 扩展
 *
 * 在微信里查看 pi agent 执行结果（只推最终结果，不含中间过程），回复消息即可下发命令。
 * 使用微信给 OpenClaw 开放的官方 bot 接口（iLink），支持扫码绑定：
 *
 *   - /wx            发起扫码绑定（终端显示二维码，微信扫码确认）
 *   - /wx status     查看微信通道状态
 *   - /wx stop       停止微信通道
 *   - /wx reconnect  用已保存凭据重启通道
 *   - /wx unbind     解绑并清除本地凭据
 *
 * 绑定成功后自动启动长轮询：
 *   - 微信发来的文本消息会作为用户消息下发给 pi（即下发命令）
 *   - 每次 agent 任务结束后，把最终 assistant 回复推送回微信（不含工具调用/思考过程）
 *   - 微信内置命令：帮助 / 状态 / 停止 / 解绑，其余文本全部转发给 pi
 *
 * 凭据存储：~/.pi/agent/weixin/（credentials.json / syncbuf.txt / context.json）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import QRCode from "qrcode";

import {
  fetchQRCode,
  getUpdates,
  notifyStart,
  notifyStop,
  pollQRStatus,
  sendText,
  STALE_TOKEN_ERRCODE,
  type Credentials,
  type WeixinMessage,
} from "./ilink";

// ---------------------------------------------------------------------------
// 持久化存储
// ---------------------------------------------------------------------------

const STATE_DIR = path.join(os.homedir(), CONFIG_DIR_NAME, "agent", "weixin");
const CREDS_FILE = path.join(STATE_DIR, "credentials.json");
const SYNCBUF_FILE = path.join(STATE_DIR, "syncbuf.txt");
const CONTEXT_FILE = path.join(STATE_DIR, "context.json");
const SETTINGS_FILE = path.join(STATE_DIR, "settings.json");
const OWNER_FILE = path.join(STATE_DIR, "owner.json");

function ensureStateDir(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function loadCredentials(): Credentials | null {
  try {
    const raw = JSON.parse(fs.readFileSync(CREDS_FILE, "utf-8")) as Credentials;
    if (raw?.botToken && raw?.baseUrl && raw?.userId) return raw;
  } catch {
    // 不存在或损坏
  }
  return null;
}

function saveCredentials(creds: Credentials): void {
  ensureStateDir();
  fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

function clearCredentials(): void {
  try {
    fs.rmSync(CREDS_FILE, { force: true });
  } catch {
    // ignore
  }
}

function loadSyncBuf(): string {
  try {
    return fs.readFileSync(SYNCBUF_FILE, "utf-8");
  } catch {
    return "";
  }
}

function saveSyncBuf(buf: string): void {
  ensureStateDir();
  fs.writeFileSync(SYNCBUF_FILE, buf, "utf-8");
}

function loadContextTokens(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(CONTEXT_FILE, "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveContextTokens(map: Record<string, string>): void {
  ensureStateDir();
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify(map, null, 2), { mode: 0o600 });
}

interface Settings {
  silent?: boolean;
  /** 是否在输入框上方显示微信状态 widget */
  widget?: boolean;
}

function readSettings(): Settings {
  try {
    return (JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8")) as Settings) ?? {};
  } catch {
    return {};
  }
}

function writeSettings(patch: Settings): void {
  ensureStateDir();
  const next = { ...readSettings(), ...patch };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
}

function loadSilent(): boolean {
  return Boolean(readSettings().silent);
}

function saveSilent(silent: boolean): void {
  writeSettings({ silent });
}

function loadWidgetEnabled(): boolean {
  return readSettings().widget !== false; // 默认开启
}

// --- 连接所有权锁：同一时间只允许一个 pi 实例连接微信 ---

interface OwnerInfo {
  pid: number;
  session: string;
  takenAt: number;
}

function readOwner(): OwnerInfo | null {
  try {
    const o = JSON.parse(fs.readFileSync(OWNER_FILE, "utf-8")) as OwnerInfo;
    if (typeof o?.pid === "number") return o;
  } catch {
    // 不存在或损坏
  }
  return null;
}

function ownerAlive(o: OwnerInfo): boolean {
  if (o.pid === process.pid) return true;
  try {
    process.kill(o.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function claimOwner(session: string): void {
  ensureStateDir();
  fs.writeFileSync(
    OWNER_FILE,
    JSON.stringify({ pid: process.pid, session, takenAt: Date.now() } satisfies OwnerInfo, null, 2),
    { mode: 0o600 },
  );
}

function releaseOwnerIfOurs(): void {
  const o = readOwner();
  if (o?.pid === process.pid) {
    try {
      fs.rmSync(OWNER_FILE, { force: true });
    } catch {
      // ignore
    }
  }
}

/** 若锁被其他存活实例持有则返回描述，否则返回 null */
function otherOwnerDescription(): string | null {
  const o = readOwner();
  if (!o || o.pid === process.pid || !ownerAlive(o)) return null;
  return `pid=${o.pid} 会话=${o.session || "未知"}`;
}

// ---------------------------------------------------------------------------
// 运行时状态
// ---------------------------------------------------------------------------

type Runtime = {
  creds: Credentials;
  abort: AbortController;
  stopped: boolean;
  monitorTask: Promise<void>;
  /** 每个用户最近一次消息的上下文令牌（主动推送结果时需回传） */
  contextTokens: Record<string, string>;
  /** 当前任务是否由微信消息触发（用于结束时补充空结果提示） */
  pendingFromWechat: boolean;
  lastPollAt: number;
};

let rt: Runtime | null = null;

const WIDGET_ID = "weixin";

// ---------------------------------------------------------------------------
// 发送到微信（最终结果推送）
// ---------------------------------------------------------------------------

/** 按行边界对文本分块，每条消息最多约 1500 字符 */
function chunkText(text: string, max = 1500): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function pushToWechat(text: string, opts: { prefix?: string } = {}): Promise<boolean> {
  if (!rt || rt.stopped) return false;
  const { creds } = rt;
  const contextToken = rt.contextTokens[creds.userId];
  const fullText = opts.prefix ? `${opts.prefix}${text}` : text;
  try {
    let first = true;
    for (const part of chunkText(fullText)) {
      if (!first) await new Promise((r) => setTimeout(r, 300)); // 分段间隔，避免突发被拒
      first = false;
      await sendTextWithFallback({
        baseUrl: creds.baseUrl,
        token: creds.botToken,
        toUserId: creds.userId,
        text: part,
        contextToken,
      });
    }
    return true;
  } catch (err) {
    console.error(`[weixin] 推送失败: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** 发送一条文本；ret=-2 (prepare failed) 通常是 context_token 过期，自动去掉 token 重试一次 */
async function sendTextWithFallback(params: {
  baseUrl: string;
  token: string;
  toUserId: string;
  text: string;
  contextToken?: string;
}): Promise<void> {
  try {
    await sendText(params);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (params.contextToken && /ret=-2|prepare failed/i.test(msg)) {
      console.error("[weixin] sendmessage ret=-2，尝试不带 context_token 重试");
      await sendText({ ...params, contextToken: undefined });
      return;
    }
    throw err;
  }
}

/** 更新 TUI 中的 widget 状态行（可在设置中关闭） */
function updateStatusWidget(ctx: ExtensionContext | null, extra?: string): void {
  if (!ctx?.hasUI) return;
  if (!loadWidgetEnabled()) {
    ctx.ui.setWidget(WIDGET_ID, undefined);
    return;
  }
  const line = rt && !rt.stopped ? "微信: 已连接 (发 /wx status 查看详情)" : "微信: 未连接 (/wx 扫码绑定)";
  ctx.ui.setWidget(WIDGET_ID, extra ? [line, extra] : [line]);
}

// ---------------------------------------------------------------------------
// 消息监听（长轮询）
// ---------------------------------------------------------------------------

async function startMonitor(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  creds: Credentials,
  opts: { takeover?: boolean } = {},
): Promise<void> {
  // 连接所有权检查：同一时间只允许一个实例连接，避免多实例重复收发
  const ownerDesc = otherOwnerDescription();
  if (ownerDesc && !opts.takeover) {
    const msg = `微信连接正被另一个 pi 实例持有（${ownerDesc}），本实例不重复连接。在本实例执行 /wx reconnect 可接管连接。`;
    console.log(`[weixin] ${msg}`);
    if (ctx.hasUI) ctx.ui.notify(msg, "warning");
    return;
  }
  if (ownerDesc && opts.takeover) {
    console.log(`[weixin] 接管微信连接（原持有者: ${ownerDesc}），原实例将自动退出`);
  }

  stopMonitor();
  claimOwner(pi.getSessionName() || path.basename(ctx.cwd));

  const abort = new AbortController();
  rt = {
    creds,
    abort,
    stopped: false,
    monitorTask: Promise.resolve(),
    contextTokens: loadContextTokens(),
    pendingFromWechat: false,
    lastPollAt: 0,
  };

  let getUpdatesBuf = loadSyncBuf();
  const seenMessageIds = new Set<string>();

  rt.monitorTask = (async () => {
    try {
      await notifyStart(creds.baseUrl, creds.botToken);
    } catch (err) {
      console.error(`[weixin] notifystart 失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    let consecutiveFailures = 0;
    let nextTimeoutMs = 35_000;

    while (rt && !rt.stopped && !abort.signal.aborted) {
      // 所有权被其他实例接管：本实例自动退出轮询
      const ownerDesc = otherOwnerDescription();
      if (ownerDesc) {
        console.log(`[weixin] 连接已被其他实例接管（${ownerDesc}），本实例停止长轮询`);
        if (ctx.hasUI) ctx.ui.notify("微信连接已被另一个 pi 实例接管", "warning");
        stopMonitor();
        updateStatusWidget(ctx);
        return;
      }
      try {
        const resp = await getUpdates({
          baseUrl: creds.baseUrl,
          token: creds.botToken,
          getUpdatesBuf,
          timeoutMs: nextTimeoutMs,
          signal: abort.signal,
        });
        if (!rt || rt.stopped) break;

        if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
          nextTimeoutMs = resp.longpolling_timeout_ms;
        }

        const isApiError =
          (resp.ret !== undefined && resp.ret !== 0) ||
          (resp.errcode !== undefined && resp.errcode !== 0);

        if (isApiError) {
          const code = resp.errcode ?? resp.ret;
          if (code === STALE_TOKEN_ERRCODE) {
            // 凭据失效：停止通道并提示重新扫码
            console.error("[weixin] 凭据已失效 (errcode -14)，请使用 /wx 重新绑定");
            if (ctx.hasUI) ctx.ui.notify("微信凭据已失效，请使用 /wx 重新绑定", "error");
            stopMonitor();
            updateStatusWidget(ctx);
            return;
          }
          consecutiveFailures += 1;
          console.error(`[weixin] getupdates 错误: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""} (${consecutiveFailures}/3)`);
          if (consecutiveFailures >= 3) {
            await sleep(30_000, abort.signal);
          } else {
            await sleep(2_000, abort.signal);
          }
          continue;
        }

        consecutiveFailures = 0;
        if (rt) rt.lastPollAt = Date.now();

        if (resp.get_updates_buf) {
          getUpdatesBuf = resp.get_updates_buf;
          saveSyncBuf(getUpdatesBuf);
        }

        for (const msg of resp.msgs ?? []) {
          await handleInbound(pi, ctx, msg, seenMessageIds);
          if (!rt || rt.stopped) break;
        }
      } catch (err) {
        if (abort.signal.aborted || !rt || rt.stopped) break;
        consecutiveFailures += 1;
        console.error(`[weixin] getupdates 异常 (${consecutiveFailures}/3): ${err instanceof Error ? err.message : String(err)}`);
        await sleep(consecutiveFailures >= 3 ? 30_000 : 2_000, abort.signal);
      }
    }

    try {
      await notifyStop(creds.baseUrl, creds.botToken);
    } catch {
      // ignore
    }
  })();
}

function stopMonitor(): void {
  if (!rt) return;
  rt.stopped = true;
  rt.abort.abort();
  saveContextTokens(rt.contextTokens);
  releaseOwnerIfOurs();
  rt = null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

/** 提取消息中的文本内容（仅文本，暂不支持媒体文件） */
function extractText(msg: WeixinMessage): string {
  const parts: string[] = [];
  for (const item of msg.item_list ?? []) {
    const text = item.text_item?.text?.trim();
    if (item.type === 1 && text) parts.push(text);
  }
  return parts.join("\n").trim();
}

async function handleInbound(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  msg: WeixinMessage,
  seen: Set<string>,
): Promise<void> {
  const from = msg.from_user_id ?? "";
  if (!from || msg.message_type !== 1) return;
  // 只处理绑定用户的私聊消息
  if (from !== rt?.creds.userId) return;
  // 去重（服务端可能重推）
  const msgId = String(msg.message_id ?? msg.seq ?? "");
  if (msgId) {
    if (seen.has(msgId)) return;
    seen.add(msgId);
    if (seen.size > 500) {
      for (const id of seen) {
        seen.delete(id);
        if (seen.size <= 200) break;
      }
    }
  }

  if (msg.context_token) {
    rt.contextTokens[from] = msg.context_token;
  }

  const text = extractText(msg);
  if (!text) {
    await pushToWechat("(暂不支持该消息类型，请发送文本)");
    return;
  }

  // ---- 本地内置命令（不转发给 pi） ----
  if (text === "帮助") {
    await pushToWechat(
      [
        "pi 微信命令：",
        "- 直接发送任意文本：作为任务下发给 pi，完成后自动推送最终结果",
        "- 状态：查看 pi 当前状态",
        "- 停止：中断当前任务",
        "- 静默：切换结果推送模式（开启后仅微信下发的任务回结果）",
        "- 解绑：解除微信绑定",
      ].join("\n"),
    );
    return;
  }
  if (text === "状态") {
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "未知";
    const busy = !ctx.isIdle();
    const session = pi.getSessionName() || "默认会话";
    await pushToWechat(
      [
        `pi 状态: ${busy ? "正在执行任务…" : "空闲"}`,
        `模型: ${model}`,
        `会话: ${session}`,
        `微信通道: 已连接`,
      ].join("\n"),
    );
    return;
  }
  if (text === "停止") {
    if (!ctx.isIdle()) {
      ctx.abort();
      await pushToWechat("已停止当前任务。");
    } else {
      await pushToWechat("当前没有正在运行的任务。");
    }
    return;
  }
  if (text === "静默") {
    const next = !loadSilent();
    saveSilent(next);
    await pushToWechat(
      next
        ? "已开启静默：终端触发的任务不再推送结果，微信下发的任务仍会回复。再发一次\"静默\"可关闭。"
        : "已关闭静默：所有任务的最终结果都会推送到微信。",
    );
    return;
  }
  if (text === "解绑") {
    await pushToWechat("已解绑。请在 pi 终端使用 /wx 重新绑定。");
    stopMonitor();
    clearCredentials();
    updateStatusWidget(ctx);
    return;
  }

  // ---- 普通文本：作为用户消息转发给 pi ----
  if (rt) rt.pendingFromWechat = true;
  if (ctx.hasUI) ctx.ui.notify(`微信消息: ${text.slice(0, 50)}`, "info");
  try {
    if (ctx.isIdle()) {
      pi.sendUserMessage(text);
    } else {
      pi.sendUserMessage(text, { deliverAs: "followUp" });
    }
  } catch (err) {
    if (rt) rt.pendingFromWechat = false;
    console.error(`[weixin] 消息下发失败: ${String(err)}`);
    await pushToWechat(`消息下发失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// 最终结果提取
// ---------------------------------------------------------------------------

/** 从当前会话分支取最后一条有文本内容的 assistant 消息（不含工具调用/思考） */
function lastAssistantText(ctx: ExtensionContext): string | null {
  const entries = ctx.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: string; content?: unknown };
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = (message.content as Array<{ type?: string; text?: string }>)
      .filter((c) => c.type === "text" && typeof c.text === "string" && c.text.trim())
      .map((c) => (c.text as string).trim())
      .join("\n\n")
      .trim();
    if (text) return text;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 扫码绑定流程
// ---------------------------------------------------------------------------
/** 终端 ASCII 渲染二维码（半块字符，约 2 行/模块行，确保完整显示） */
async function renderQRLines(url: string): Promise<string[]> {
  try {
    const ascii = await QRCode.toString(url, { type: "terminal", small: true });
    return ascii.split("\n").filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

/** 非 TUI（print/RPC）模式：打印二维码到控制台并轮询（不支持验证码输入） */
async function headlessLogin(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  qr: { qrcode: string; qrcode_img_content: string },
  localTokens: string[],
): Promise<void> {
  const lines = [
    ...(await renderQRLines(qr.qrcode_img_content)),
    "",
    "请用手机微信扫描上方二维码绑定 pi",
    qr.qrcode_img_content,
  ];
  console.log(lines.join("\n"));

  let pollBaseUrl: string | undefined;
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const status = await pollQRStatus(qr.qrcode, { baseUrl: pollBaseUrl });
    switch (status.status) {
      case "wait":
        break;
      case "scaned":
        break;
      case "need_verifycode":
        console.log("[weixin] 需要输入验证码，请在交互式终端中执行 /wx 完成绑定。");
        return;
      case "verify_code_blocked":
      case "expired":
        console.log("[weixin] 二维码已失效，请在交互式终端中重新执行 /wx。");
        return;
      case "scaned_but_redirect":
        if (status.redirect_host) pollBaseUrl = `https://${status.redirect_host}`;
        break;
      case "binded_redirect": {
        const existing = loadCredentials();
        if (existing) {
          await finishLogin(pi, ctx, existing, true);
        } else {
          console.log("[weixin] 该微信已绑定到其他实例，请用对应微信扫码。");
        }
        return;
      }
      case "confirmed": {
        if (!status.ilink_bot_id || !status.bot_token || !status.baseurl) {
          console.log("[weixin] 登录确认缺少必要字段。");
          return;
        }
        const creds: Credentials = {
          botToken: status.bot_token,
          botId: status.ilink_bot_id,
          baseUrl: status.baseurl,
          userId: status.ilink_user_id ?? "",
          savedAt: Date.now(),
        };
        saveCredentials(creds);
        await finishLogin(pi, ctx, creds, false);
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log("[weixin] 绑定超时，请重试 /wx");
}

/**
 * TUI 模式：全屏 overlay 显示二维码（不会被裁剪），轮询状态实时更新到覆盖层。
 * 覆盖层仅在需要输入验证码 / 登录结束 / 用户按 Esc 时关闭。
 */
async function runLoginFlow(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  // 绑定会覆写共享凭据：若锁被其他存活实例持有，先要求接管
  const ownerDesc = otherOwnerDescription();
  if (ownerDesc) {
    const msg = `微信连接正被另一个 pi 实例持有（${ownerDesc}）。若要在本实例重新绑定，请先执行 /wx reconnect 接管。`;
    if (ctx.hasUI) ctx.ui.notify(msg, "warning");
    else console.log(`[weixin] ${msg}`);
    return;
  }

  const existing = loadCredentials();
  const localTokens = existing ? [existing.botToken] : [];

  let qr: { qrcode: string; qrcode_img_content: string };
  try {
    qr = await fetchQRCode(localTokens);
  } catch (err) {
    const msg = `二维码创建失败: ${err instanceof Error ? err.message : String(err)}`;
    if (ctx.hasUI) ctx.ui.notify(msg, "error");
    else console.error(`[weixin] ${msg}`);
    return;
  }

  if (ctx.mode !== "tui") {
    await headlessLogin(pi, ctx, qr, localTokens);
    return;
  }

  let pollBaseUrl: string | undefined;
  let pendingVerifyCode: string | undefined;
  let refreshCount = 0;
  const maxRefresh = 3;
  const deadline = Date.now() + 5 * 60_000;

  while (Date.now() < deadline) {
    // 覆盖层共享的可变状态（轮询中刷新二维码/状态行后 requestRender 即可）
    const session = {
      qrLines: await renderQRLines(qr.qrcode_img_content),
      url: qr.qrcode_img_content,
      statusLine: "等待扫码…",
    };
    // 使用可变 holder 避免 TS 对闭包内赋值的类型收窄
    const ctl: { close?: (reason: string) => void; tui?: { requestRender(): void } } = {};
    // 每轮独立的会话中止控制器（用户按 Esc 时中断后台轮询）
    const sessionAbort = new AbortController();

    const overlayPromise = ctx.ui.custom<string>(
      (tui, theme, _kb, done) => {
        ctl.close = done;
        ctl.tui = tui;
        let cached: string[] | undefined;

        const render = (width: number): string[] => {
          if (cached) return cached;
          const w = Math.max(20, width);
          const lines: string[] = [];
          lines.push(theme.fg("accent", "─".repeat(w)));
          lines.push(theme.fg("text", "  微信扫码绑定 pi  "));
          lines.push("");
          for (const l of session.qrLines) lines.push(l);
          if (session.qrLines.length === 0) {
            lines.push(theme.fg("warning", "  二维码渲染失败，请用下方链接打开："));
            lines.push(theme.fg("muted", `  ${session.url}`));
          }
          lines.push("");
          lines.push(theme.fg("accent", session.statusLine));
          lines.push(theme.fg("dim", "  备用链接（微信中打开）："));
          lines.push(theme.fg("muted", `  ${session.url}`));
          lines.push("");
          lines.push(theme.fg("dim", "  Esc 取消绑定"));
          lines.push(theme.fg("accent", "─".repeat(w)));
          cached = lines;
          return lines;
        };

        return {
          render,
          invalidate: () => {
            cached = undefined;
          },
          handleInput: (data: string) => {
            if (matchesKey(data, Key.escape)) done("cancel");
          },
        };
      },
      { overlay: true, overlayOptions: { width: "80%", maxHeight: "95%" } },
    );

    // 后台轮询当前二维码，直到需要输入 / 登录结束 / 二维码失效
    let outcome: "verify" | "confirmed" | "binded" | "bound-elsewhere" | "failed" | null = null;
    let confirmedCreds: Credentials | null = null;

    const pollTask = (async () => {
      while (!sessionAbort.signal.aborted) {
        let status;
        try {
          status = await pollQRStatus(qr.qrcode, {
            verifyCode: pendingVerifyCode,
            baseUrl: pollBaseUrl,
            signal: sessionAbort.signal,
          });
        } catch {
          return; // 会话被取消
        }
        if (sessionAbort.signal.aborted) return;

        switch (status.status) {
          case "wait":
            break;
          case "scaned":
            pendingVerifyCode = undefined;
            session.statusLine = "已扫码，请在手机上确认…";
            ctl.tui?.requestRender();
            break;
          case "need_verifycode":
            outcome = "verify";
            ctl.close?.("verify");
            return;
          case "verify_code_blocked": {
            pendingVerifyCode = undefined;
            refreshCount += 1;
            if (refreshCount > maxRefresh) {
              outcome = "failed";
              ctl.close?.("failed");
              return;
            }
            try {
              qr = await fetchQRCode(localTokens);
            } catch {
              outcome = "failed";
              ctl.close?.("failed");
              return;
            }
            session.qrLines = await renderQRLines(qr.qrcode_img_content);
            session.url = qr.qrcode_img_content;
            session.statusLine = "二维码已刷新，请重新扫码";
            ctl.tui?.requestRender();
            break;
          }
          case "expired": {
            refreshCount += 1;
            if (refreshCount > maxRefresh) {
              outcome = "failed";
              ctl.close?.("failed");
              return;
            }
            try {
              qr = await fetchQRCode(localTokens);
            } catch {
              outcome = "failed";
              ctl.close?.("failed");
              return;
            }
            session.qrLines = await renderQRLines(qr.qrcode_img_content);
            session.url = qr.qrcode_img_content;
            session.statusLine = "二维码已过期，已自动刷新，请重新扫码";
            ctl.tui?.requestRender();
            break;
          }
          case "scaned_but_redirect":
            if (status.redirect_host) pollBaseUrl = `https://${status.redirect_host}`;
            break;
          case "binded_redirect":
            outcome = existing ? "binded" : "bound-elsewhere";
            ctl.close?.("done");
            return;
          case "confirmed": {
            if (!status.ilink_bot_id || !status.bot_token || !status.baseurl) {
              outcome = "failed";
              ctl.close?.("failed");
              return;
            }
            confirmedCreds = {
              botToken: status.bot_token,
              botId: status.ilink_bot_id,
              baseUrl: status.baseurl,
              userId: status.ilink_user_id ?? "",
              savedAt: Date.now(),
            };
            outcome = "confirmed";
            ctl.close?.("done");
            return;
          }
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    })();

    const closeReason = await overlayPromise;
    if (closeReason === "cancel") {
      sessionAbort.abort();
      await pollTask;
      if (ctx.hasUI) ctx.ui.notify("已取消绑定", "warning");
      return;
    }
    await pollTask;

    if (outcome === "confirmed" && confirmedCreds) {
      saveCredentials(confirmedCreds);
      await finishLogin(pi, ctx, confirmedCreds, false);
      return;
    }
    if (outcome === "binded" && existing) {
      await finishLogin(pi, ctx, existing, true);
      return;
    }
    if (outcome === "bound-elsewhere") {
      if (ctx.hasUI) ctx.ui.notify("该微信已绑定到其他实例，请用对应微信扫码", "error");
      return;
    }
    if (outcome === "failed") {
      if (ctx.hasUI) ctx.ui.notify("二维码多次失效，绑定已终止，请稍后再试", "error");
      return;
    }
    if (outcome === "verify") {
      const code = await ctx.ui.input(
        pendingVerifyCode ? "验证码不匹配，请重新输入：" : "请输入手机微信上显示的数字以继续：",
      );
      if (!code) {
        if (ctx.hasUI) ctx.ui.notify("已取消绑定", "warning");
        return;
      }
      pendingVerifyCode = code.trim();
      continue; // 重新打开二维码覆盖层（二维码未变）
    }
  }

  if (ctx.hasUI) ctx.ui.notify("绑定超时，请重试 /wx", "warning");
}

async function finishLogin(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  creds: Credentials,
  alreadyBound: boolean,
): Promise<void> {
  if (ctx.hasUI) {
    ctx.ui.notify(alreadyBound ? "微信已绑定，通道已恢复" : "微信绑定成功！", "info");
  } else {
    console.log(`[weixin] ${alreadyBound ? "已绑定" : "绑定成功"}`);
  }
  await startMonitor(pi, ctx, creds);
  updateStatusWidget(ctx);
  await pushToWechat(
    alreadyBound
      ? "pi 微信通道已恢复。直接发送文本即可下发任务，完成后会自动推送最终结果。"
      : "绑定成功！这里是 pi agent。直接发送文本即可下发任务，完成后会自动推送最终结果（不含中间过程）。发送\"帮助\"查看可用命令。",
  );
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

export default function weixinAgent(pi: ExtensionAPI) {
  // 会话启动时自动恢复连接
  pi.on("session_start", async (_event, ctx) => {
    const creds = loadCredentials();
    if (creds) {
      await startMonitor(pi, ctx, creds);
    }
    updateStatusWidget(ctx);
  });

  // 会话结束时清理长轮询资源
  pi.on("session_shutdown", async () => {
    stopMonitor();
  });

  // agent 完全落定后把最终结果推回微信
  // （只推最终 assistant 回复，不含工具执行等中间过程）
  pi.on("agent_settled", async (_event, ctx) => {
    if (!rt || rt.stopped) return;
    const pending = rt.pendingFromWechat;
    rt.pendingFromWechat = false;
    // 静默模式下只回微信下发的任务
    if (!pending && loadSilent()) return;
    try {
      const text = lastAssistantText(ctx);
      if (text) {
        // 加会话前缀，多实例时可在微信里区分结果来源
        const label = pi.getSessionName() || path.basename(ctx.cwd);
        await pushToWechat(text, { prefix: `[${label}] ` });
      } else if (pending) {
        await pushToWechat("(任务已完成，无文本输出)");
      }
    } catch (err) {
      console.error(`[weixin] 结果推送失败: ${String(err)}`);
    }
  });

  const WX_SUBCOMMANDS = ["status", "stop", "reconnect", "unbind", "widget", "help"];

  function wxHelp(ctx: ExtensionContext): void {
    const lines = [
      "/wx                  扫码绑定（未连接时）",
      "/wx status           查看通道状态",
      "/wx stop             停止通道",
      "/wx reconnect        接管连接（从其他 pi 实例抢过来）",
      "/wx unbind           解绑并清除本地凭据",
      "/wx widget [on|off]  开关输入框上方的微信状态提示",
      "/wx help             显示本帮助",
    ];
    if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
    else console.log(lines.join("\n"));
  }

  pi.registerCommand("wx", {
    description: "微信绑定与通道管理 (/wx help 查看子命令)",
    getArgumentCompletions: (prefix) => {
      const items = WX_SUBCOMMANDS.map((s) => ({ value: s, label: s }));
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim().toLowerCase();
      if (sub === "help" || sub === "帮助") {
        wxHelp(ctx);
        return;
      }
      if (sub === "widget" || sub.startsWith("widget ")) {
        const arg = sub.slice("widget".length).trim();
        const current = loadWidgetEnabled();
        const next = arg === "on" ? true : arg === "off" ? false : !current;
        writeSettings({ widget: next });
        updateStatusWidget(ctx);
        const msg = next ? "已开启输入框上方的微信状态提示" : "已关闭输入框上方的微信状态提示（/wx widget 可重新开启）";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else console.log(`[weixin] ${msg}`);
        return;
      }
      if (sub === "" || sub === "status") {
        if (sub === "status") {
          const creds = loadCredentials();
          const owner = readOwner();
          const ownerLine = owner
            ? `连接持有者: pid=${owner.pid}（${owner.pid === process.pid ? "本实例" : `会话=${owner.session || "未知"}`}）`
            : "连接持有者: 无";
          const lines = [
            `绑定状态: ${creds ? `已绑定 (bot=${creds.botId.slice(0, 8)}…)` : "未绑定"}`,
            `通道状态: ${rt && !rt.stopped ? "运行中" : "已停止"}`,
            ownerLine,
            `最近轮询: ${rt?.lastPollAt ? new Date(rt.lastPollAt).toLocaleTimeString() : "-"}`,
            `pi 状态: ${ctx.isIdle() ? "空闲" : "正在执行任务"}`,
            `推送模式: ${loadSilent() ? "静默（仅微信任务回结果）" : "全部推送"}`,
            `凭据目录: ${STATE_DIR}`,
          ];
          if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
          else console.log(lines.join("\n"));
          return;
        }
        // /wx 无参数：未运行则发起绑定
        if (rt && !rt.stopped) {
          if (ctx.hasUI) ctx.ui.notify("微信通道运行中。用 /wx status 查看状态，/wx unbind 解绑", "info");
          return;
        }
        await runLoginFlow(pi, ctx);
        return;
      }
      if (sub === "stop") {
        stopMonitor();
        updateStatusWidget(ctx);
        if (ctx.hasUI) ctx.ui.notify("微信通道已停止", "info");
        return;
      }
      if (sub === "unbind") {
        stopMonitor();
        clearCredentials();
        updateStatusWidget(ctx);
        if (ctx.hasUI) ctx.ui.notify("已解绑，本地凭据已清除", "info");
        return;
      }
      if (sub === "reconnect" || sub === "takeover" || sub === "接管") {
        const creds = loadCredentials();
        if (!creds) {
          if (ctx.hasUI) ctx.ui.notify("尚未保存凭据，请先用 /wx 扫码绑定", "warning");
          return;
        }
        await startMonitor(pi, ctx, creds, { takeover: true });
        updateStatusWidget(ctx);
        if (ctx.hasUI) ctx.ui.notify(rt ? "本实例已接管微信连接" : "接管失败，详见终端日志", "info");
        return;
      }
      wxHelp(ctx);
    },
  });
}
