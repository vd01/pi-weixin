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
  type SendMessageResp,
  type WeixinMessage,
} from "./ilink";
import { collectSysInfo } from "./sysinfo";

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
  /** 后台日志是否输出到终端（默认关闭，日志文件始终写入） */
  debug?: boolean;
  /** 微信任务回复后若 agent 仍空闲且有后续任务，是否发空闲提醒（默认开启；只提醒人，不催 agent） */
  nudge?: boolean;
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

// --- 后台日志：默认只落盘，不写终端 ---
//
// 扩展里的 console.log / console.error 在交互式 TUI 中会直接打到终端上，
// 表现为输入框附近突然冒出来的几行字，非常干扰输入。
// 因此后台路径（推送失败、长轮询错误等）一律只写日志文件，
// 需要现场排查时用 /wx debug on（或环境变量 WEIXIN_DEBUG=1）打开终端输出。

const LOG_FILE = path.join(STATE_DIR, "weixin.log");
const LOG_MAX_BYTES = 256 * 1024;

function loadDebugEnabled(): boolean {
  if (process.env.WEIXIN_DEBUG === "1") return true;
  return Boolean(readSettings().debug);
}

/** 空闲提醒是否开启（默认开；只提醒微信侧的人，不向 agent 注入内容） */
function loadIdleRemindEnabled(): boolean {
  return readSettings().nudge !== false;
}

function wxLog(message: string): void {
  const line = `${new Date().toISOString()} [weixin] ${message}`;
  try {
    ensureStateDir();
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      fs.writeFileSync(LOG_FILE, "");
    }
    fs.appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    // 落盘失败不影响主流程
  }
  if (loadDebugEnabled()) console.error(line);
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
  /** 微信任务进入 pi 的时刻（用于测量端到端延迟） */
  pendingSince: number;
  /** 最近一次收到用户消息（下发 context_token）的时刻 */
  tokenAt: number;
  /** 本窗口已成功发出的主动消息条数（微信每会话主动消息额度有限，需计数） */
  sentSinceInbound: number;
  lastPollAt: number;
};

let rt: Runtime | null = null;

const WIDGET_ID = "weixin";

/**
 * 结果推送健康度：只用于日志与 /wx status，不在 TUI/输入框附近主动弹提示。
 * （静默失败会让用户以为任务没跑完，所以保留按需查询入口）
 */
const pushStats = {
  failures: 0,
  lastError: "",
  lastFailAt: 0,
  lastSuccessAt: 0,
};

/** 微信侧故障回报的最小间隔，避免反复刷屏 */
const PUSH_FAILURE_NOTICE_INTERVAL_MS = 5 * 60_000;
let lastPushFailureNoticeAt = 0;

/** 微信任务「早推」去抖：回复文本产生后等这么久仍没落定就先推一次（可用 WEIXIN_EARLY_PUSH_MS 覆盖，便于测试） */
const EARLY_PUSH_DELAY_MS = Number(process.env.WEIXIN_EARLY_PUSH_MS ?? "") || 20_000;
let earlyPushTimer: ReturnType<typeof setTimeout> | null = null;
let earlyPushCtx: ExtensionContext | null = null;

function clearEarlyPushTimer(): void {
  if (earlyPushTimer) clearTimeout(earlyPushTimer);
  earlyPushTimer = null;
  earlyPushCtx = null;
}

/** 重建去抖计时器：连续多条文本只推最后一条 */
function armEarlyPush(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (earlyPushTimer) clearTimeout(earlyPushTimer);
  earlyPushCtx = ctx;
  earlyPushTimer = setTimeout(() => {
    earlyPushTimer = null;
    const capturedCtx = earlyPushCtx;
    earlyPushCtx = null;
    if (!capturedCtx || !rt || rt.stopped || !rt.pendingFromWechat) return;
    void pushLatestAssistant(capturedCtx, pi, "微信任务早推").catch((err) =>
      wxLog(`早推异常: ${String(err)}`),
    );
  }, EARLY_PUSH_DELAY_MS);
  earlyPushTimer.unref?.();
}

/**
 * 已成功推送过的 assistant 消息条目 id。
 *
 * 每次 agent 落定（agent_settled）都会推送「最后一条带文本的 assistant 消息」，
 * 但自动续跑（goal 继续、重试、仅含工具调用的续轮）不会产生新文本，
 * 于是同一条回复会被反复推送 —— 用条目 id 去重，确保一条回复只发一次。
 */
let lastPushedEntryId: string | null = null;

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

async function pushToWechat(
  text: string,
  opts: { prefix?: string; label?: string } = {},
): Promise<boolean> {
  if (!rt || rt.stopped) {
    if (opts.label) wxLog(`${opts.label}：通道未运行，未发送`);
    return false;
  }
  const { creds } = rt;
  const contextToken = rt.contextTokens[creds.userId];
  const fullText = opts.prefix ? `${opts.prefix}${text}` : text;
  const label = opts.label ?? "推送";
  try {
    let first = true;
    const ids: string[] = [];
    for (const part of chunkText(fullText)) {
      if (!first) await new Promise((r) => setTimeout(r, 300)); // 分段间隔，避免突发被拒
      first = false;
      const resp = await sendTextWithFallback({
        baseUrl: creds.baseUrl,
        token: creds.botToken,
        toUserId: creds.userId,
        text: part,
        contextToken,
      });
      if (rt) rt.sentSinceInbound += 1;
      const id = resp && (resp.msg_id ?? resp.message_id);
      if (id !== undefined && id !== null) ids.push(String(id));
    }
    pushStats.failures = 0;
    pushStats.lastSuccessAt = Date.now();
    if (opts.label) {
      wxLog(`${label}：已提交微信 ${ids.length > 0 ? `（msg_id=${ids.join(",")}）` : ""}`);
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    pushStats.failures += 1;
    pushStats.lastError = msg;
    pushStats.lastFailAt = Date.now();
    wxLog(`推送失败(连续 ${pushStats.failures} 次): ${msg}${quotaNote()}`);
    return false;
  }
}

/** 额度/窗口状态描述（用于日志与 /wx status） */
function quotaNote(): string {
  if (!rt) return "";
  const parts: string[] = [];
  if (rt.tokenAt) parts.push(`token 年龄 ${Math.round((Date.now() - rt.tokenAt) / 1000)}s`);
  else parts.push("无 context_token");
  parts.push(`本窗口已发 ${rt.sentSinceInbound} 条主动消息`);
  return `（${parts.join("；")}）`;
}

/** 向微信回报故障时限流：默认不打扰，最多 5 分钟一条 */
async function noticeFailureToWechat(message: string): Promise<void> {
  const now = Date.now();
  if (now - lastPushFailureNoticeAt < PUSH_FAILURE_NOTICE_INTERVAL_MS) {
    wxLog(`故障提示已限流，未发往微信: ${message}`);
    return;
  }
  lastPushFailureNoticeAt = now;
  await pushToWechat(message);
}

/** 发送一条文本；ret=-2 (prepare failed) 通常是 context_token 过期，自动去掉 token 重试一次 */
async function sendTextWithFallback(params: {
  baseUrl: string;
  token: string;
  toUserId: string;
  text: string;
  contextToken?: string;
}): Promise<SendMessageResp | undefined> {
  try {
    return await sendText(params);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (params.contextToken && /ret=-2|prepare failed/i.test(msg)) {
      wxLog("sendmessage ret=-2，尝试不带 context_token 重试");
      return await sendText({ ...params, contextToken: undefined });
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
    wxLog(msg);
    if (ctx.hasUI) ctx.ui.notify(msg, "warning");
    return;
  }
  if (ownerDesc && opts.takeover) {
    wxLog(`接管微信连接（原持有者: ${ownerDesc}），原实例将自动退出`);
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
    pendingSince: 0,
    tokenAt: 0,
    sentSinceInbound: 0,
    lastPollAt: 0,
  };

  let getUpdatesBuf = loadSyncBuf();
  const seenMessageIds = new Set<string>();

  rt.monitorTask = (async () => {
    try {
      await notifyStart(creds.baseUrl, creds.botToken);
    } catch (err) {
      wxLog(`notifystart 失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    let consecutiveFailures = 0;
    let nextTimeoutMs = 35_000;

    while (rt && !rt.stopped && !abort.signal.aborted) {
      // 所有权被其他实例接管：本实例自动退出轮询
      const ownerDesc = otherOwnerDescription();
      if (ownerDesc) {
        wxLog(`连接已被其他实例接管（${ownerDesc}），本实例停止长轮询`);
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
            wxLog("凭据已失效 (errcode -14)，请使用 /wx 重新绑定");
            if (ctx.hasUI) ctx.ui.notify("微信凭据已失效，请使用 /wx 重新绑定", "error");
            stopMonitor();
            updateStatusWidget(ctx);
            return;
          }
          consecutiveFailures += 1;
          if (consecutiveFailures === 1 || consecutiveFailures % 5 === 0) {
            wxLog(`getupdates 错误: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""} (连续 ${consecutiveFailures} 次)`);
          }
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
        if (consecutiveFailures === 1 || consecutiveFailures % 5 === 0) {
          wxLog(`getupdates 异常 (连续 ${consecutiveFailures} 次): ${err instanceof Error ? err.message : String(err)}`);
        }
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

// ---------------------------------------------------------------------------
// 执行状态观测（供微信「状态」「打断」使用；纯观测，不影响正在执行的 agent）
// ---------------------------------------------------------------------------

type RecentAction = { tool: string; detail: string; startedAt: number; endedAt?: number; isError?: boolean };

const activity = {
  /** 最后一次“有事发生”的时刻（agent 活动或微信消息），用于空闲计时兜底 */
  lastActivityAt: 0,
  runStartedAt: 0,
  current: null as null | { tool: string; detail: string; startedAt: number; toolCallId: string },
  recent: [] as RecentAction[],
};

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** 从工具名+参数里抽出能看懂的一行摘要 */
function toolDetail(toolName: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const pick = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
  const raw =
    toolName === "bash"
      ? pick("command")
      : pick("path") || pick("pattern") || pick("query") || pick("url") || pick("command");
  return clip(raw, 70);
}

/** 本轮任务的来源消息（最近一条 user 消息） */
function lastUserTask(ctx: ExtensionContext): { text: string; at: number } | null {
  const entries = ctx.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: string; content?: unknown };
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    const text = (message.content as Array<{ type?: string; text?: string }>)
      .filter((c) => c.type === "text" && typeof c.text === "string" && c.text.trim())
      .map((c) => (c.text as string).trim())
      .join(" ");
    if (!text) continue;
    const at = Date.parse(String((entry as { timestamp?: string }).timestamp ?? ""));
    return { text, at: Number.isFinite(at) ? at : 0 };
  }
  return null;
}

/** 从最近一条 assistant 回复里摘计划行（找不到就取末尾一行） */
function planLines(ctx: ExtensionContext): string[] {
  const last = lastAssistantEntry(ctx);
  if (!last) return [];
  const lines = last.text
    .split("\n")
    .map((l) => l.replace(/^[\s>*\-\d.、）)]+/, "").trim())
    .filter(Boolean);
  const hit = lines.filter((l) => /(下一步|接下来|计划|后续|待办|TODO|next step|plan)/i.test(l)).slice(0, 2);
  return (hit.length > 0 ? hit : lines.slice(-1)).map((l) => clip(l, 80));
}

/**
 * 微信「状态」（agent 忙时）：不打断执行，只用可观测信息 + 本机资源做简短总结。
 * 不调用 sendUserMessage，不触发任何模型请求。
 */
async function buildBusySummary(ctx: ExtensionContext): Promise<string> {
  const lines: string[] = [];
  const runMs = activity.runStartedAt ? Date.now() - activity.runStartedAt : 0;
  lines.push(`状态: 执行中${runMs > 0 ? `（已 ${fmtDuration(runMs)}）` : ""}`);

  const task = lastUserTask(ctx);
  if (task) lines.push(`任务: ${clip(task.text, 64)}`);

  if (activity.current) {
    const age = fmtDuration(Date.now() - activity.current.startedAt);
    const detail = activity.current.detail ? ` · ${activity.current.detail}` : "";
    lines.push(`当前: ${activity.current.tool}${detail}（已 ${age}）`);
  } else if (ctx.hasPendingMessages()) {
    lines.push("当前: 等待模型响应（有排队消息）");
  } else {
    lines.push("当前: 模型生成中/等待工具结果");
  }

  const recent = activity.recent.filter((r) => r.endedAt).slice(-5);
  if (recent.length > 0) {
    lines.push(`最近: ${recent.map((r) => `${r.tool}${r.isError ? "(失败)" : ""}`).join(" → ")}`);
  }

  const plan = planLines(ctx);
  lines.push(plan.length > 0 ? `计划: ${plan.join(" / ")}` : "计划: 最近回复未写明，需要问它本人");

  lines.push(...(await collectSysInfo()));
  lines.push(`模型: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "?"}`);
  return lines.join("\n");
}

/**
 * 微信「打断」：终止当前执行 → 让它先汇报现状与后续计划 → 之后进入正常对话。
 * 先取快照再 abort，避免丢信息（abort 会杀掉前台工具子进程，后台 nohup 进程不受影响）。
 */
async function interruptAndAskReport(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const task = lastUserTask(ctx);
  const current = activity.current;
  const recent = activity.recent.filter((r) => r.endedAt).slice(-5);

  ctx.abort();

  await pushToWechat(
    [
      "已中断当前执行，正在让它汇报现状。",
      "注意: 前台命令会被终止；nohup/setsid 起的后台进程不受影响。",
    ].join("\n"),
  );
  if (rt) {
    rt.pendingFromWechat = true;
    rt.pendingSince = Date.now();
  }

  const snapshot = [
    task ? `- 我记录到的任务: ${clip(task.text, 80)}` : "",
    current
      ? `- 中断时正在运行: ${current.tool}${current.detail ? ` · ${current.detail}` : ""}（已 ${fmtDuration(Date.now() - current.startedAt)}）`
      : "",
    recent.length > 0
      ? `- 中断前最近动作: ${recent.map((r) => `${r.tool}${r.isError ? "(失败)" : ""}`).join(" → ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = [
    "【微信中断指令】你刚被用户在微信里打断，当前这一轮已经终止。",
    "请先只做回答（不要调用任何工具，不超过 6 行）：",
    "1) 打断时你正在做什么、停在哪一步；",
    "2) 接下来的计划（按优先级 2-3 条）；",
    "3) 是否已有后台进程/训练在跑（nohup/setsid），需不需要用户确认。",
    "回答完就停下等用户下一步指令，不要自行继续执行。",
    snapshot ? `\n扩展侧快照：\n${snapshot}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  // abort 是异步的：等它真正停下（最多 5s），让汇报指令能立即开跑
  const deadline = Date.now() + 5_000;
  while (!ctx.isIdle() && Date.now() < deadline) {
    await sleep(100);
  }

  // abort 之后仍可能没完全 idle：忙则排队为 followUp，确保这条指令一定被投递
  if (ctx.isIdle()) pi.sendUserMessage(prompt);
  else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  wxLog(`已执行微信「打断」并请求现状汇报（前台工具已终止）`);
}

// ---------------------------------------------------------------------------
// 空闲提醒（决定权交给微信侧的人）
//
// agent 回复完微信任务后如果一直空闲，扩展**不再自动发「继续」**，
// 只在「看起来还有没做完的活」时往微信推一条提醒，由人决定要不要回「继续」。
// ---------------------------------------------------------------------------

/** 空闲多久后提醒（默认 3 分钟；WEIXIN_IDLE_REMIND_MS 可调） */
const IDLE_REMIND_DELAY_MS =
  Number(process.env.WEIXIN_IDLE_REMIND_MS ?? process.env.WEIXIN_NUDGE_MS ?? "") || 3 * 60_000;

const idleState = {
  /** 最近一条用户消息来自微信 */
  taskFromWechat: false,
  /** 该微信消息到达的时刻（空闲计时的起点之一） */
  taskFromWechatAt: 0,
  /** 本次微信任务是否已提醒过（一个任务只提醒一次，节省主动消息额度） */
  reminded: false,
  timer: null as ReturnType<typeof setTimeout> | null,
};

function clearIdleTimer(): void {
  if (idleState.timer) clearTimeout(idleState.timer);
  idleState.timer = null;
}

/** 新任务 / 用户接管时重置提醒状态 */
function resetIdleState(reason: string): void {
  const had = idleState.timer !== null || idleState.reminded;
  clearIdleTimer();
  idleState.reminded = false;
  if (had) wxLog(`空闲提醒状态重置（${reason}）`);
}

/** 落定后调用：满足条件则安排 IDLE_REMIND_DELAY_MS 后提醒人（不催 agent） */
function armIdleReminder(ctx: ExtensionContext): void {
  // 注意：这里的每个早退都写日志，否则“为什么没提醒”无从排查（实测踩过）
  if (!rt || rt.stopped) {
    wxLog("空闲提醒未武装：微信通道未运行");
    return;
  }
  if (!loadIdleRemindEnabled()) {
    wxLog("空闲提醒未武装：开关已关闭（/wx nudge on 可开启）");
    return;
  }
  if (!idleState.taskFromWechat) {
    wxLog("空闲提醒未武装：最近一条消息不是微信下发（终端输入会重置）");
    return;
  }
  if (idleState.reminded) {
    wxLog("空闲提醒未武装：本任务已提醒过一次");
    return;
  }
  if (!ctx.isIdle()) {
    wxLog("空闲提醒未武装：落定时 agent 仍在执行");
    return;
  }
  clearIdleTimer();
  idleState.timer = setTimeout(() => {
    idleState.timer = null;
    void sendIdleReminder(ctx);
  }, IDLE_REMIND_DELAY_MS);
  idleState.timer.unref?.();
  wxLog(
    `已安排空闲提醒：${fmtDuration(IDLE_REMIND_DELAY_MS)} 后若仍空闲则提醒微信侧（是否有后续任务由人判断）`,
  );
}

/** 空闲到点：只发提醒，不向 agent 注入任何内容，也不判断是否还有后续任务（交给人判断） */
async function sendIdleReminder(ctx: ExtensionContext): Promise<void> {
  if (!rt || rt.stopped) return;
  if (!loadIdleRemindEnabled() || !idleState.taskFromWechat || idleState.reminded) return;
  if (!ctx.isIdle()) {
    wxLog("取消空闲提醒：agent 已在执行");
    return;
  }
  idleState.reminded = true;
  const ok = await pushToWechat(
    [
      `agent 已空闲 ${fmtDuration(IDLE_REMIND_DELAY_MS)}。`,
      "回复「继续」让它接着干；发「状态」看它在做什么；不用了忽略本条即可。",
    ].join("\n"),
    { label: "空闲提醒" },
  );
  wxLog(`空闲提醒推送${ok ? "成功" : "失败"}`);
}

/** 微信「loop」：下发 research-loop skill，并附「按计划执行、不因上下文紧张停下」的提示 */
const LOOP_SKILL = "research-loop";
const LOOP_HINT = "按照预定计划执行，中途不要因为上下文紧张等原因停下来。";

async function startLoop(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  let hasSkill = false;
  try {
    hasSkill = pi.getCommands().some((c) => c.name === `skill:${LOOP_SKILL}`);
  } catch {
    hasSkill = false;
  }
  if (!hasSkill) {
    await pushToWechat(
      `未找到 skill「${LOOP_SKILL}」，请确认 ~/.pi/agent/skills/${LOOP_SKILL}/SKILL.md 存在（或该 skill 未被加载）。`,
    );
    wxLog(`loop 失败：未找到 skill:${LOOP_SKILL}`);
    return;
  }

  const busy = !ctx.isIdle();
  resetIdleState("loop");
  if (rt) {
    rt.pendingFromWechat = true;
    rt.pendingSince = Date.now();
  }
  // 注意：必须 expandPromptTemplates=true，否则 /skill:xxx 不会被展开成 SKILL.md 内容
  pi.sendUserMessage(`/skill:${LOOP_SKILL} ${LOOP_HINT}`, {
    expandPromptTemplates: true,
    ...(busy ? { deliverAs: "followUp" as const } : {}),
  });
  await pushToWechat(
    busy
      ? `agent 正在执行，已排队：${LOOP_SKILL}（当前这轮结束后按计划持续执行）`
      : `已下发 ${LOOP_SKILL}：按预定计划执行，不因上下文紧张等因素中途停下。`,
  );
  wxLog(`微信下达 loop：${LOOP_SKILL}（${busy ? "排队 followUp" : "立即执行"}）`);
}

/**
 * 空闲计时兜底巡检：settle 事件理论上足够，但一旦错过（例如 reload 时正好落定、
 * 或某条早退分支挡住）就永远不会提醒。这里每 60s 检查一次“空闲是否真的超时”。
 */
let idleWatchdog: ReturnType<typeof setInterval> | null = null;

function startIdleWatchdog(ctx: ExtensionContext): void {
  stopIdleWatchdog();
  idleWatchdog = setInterval(() => {
    void checkIdleByWatchdog(ctx);
  }, Number(process.env.WEIXIN_IDLE_WATCHDOG_MS ?? "") || 60_000);
  idleWatchdog.unref?.();
}

function stopIdleWatchdog(): void {
  if (idleWatchdog) clearInterval(idleWatchdog);
  idleWatchdog = null;
}

async function checkIdleByWatchdog(ctx: ExtensionContext): Promise<void> {
  if (!rt || rt.stopped) return;
  if (!loadIdleRemindEnabled()) return;
  if (!idleState.taskFromWechat || idleState.reminded) return;
  if (!ctx.isIdle()) return;
  const last = Math.max(activity.lastActivityAt, idleState.taskFromWechatAt);
  if (last <= 0 || Date.now() - last < IDLE_REMIND_DELAY_MS) return;
  wxLog(`空闲巡检命中：已空闲 ${fmtDuration(Date.now() - last)}，提醒微信侧人工判断`);
  await sendIdleReminder(ctx);
}

/** 人在微信里发「继续」：这时才真正推动 agent */
async function resumeFromWechat(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  clearIdleTimer();
  idleState.reminded = false;
  if (!ctx.isIdle()) {
    await pushToWechat("agent 正在执行，不需要「继续」。发「状态」可以看进度。");
    return;
  }
  if (rt) {
    rt.pendingFromWechat = true;
    rt.pendingSince = Date.now();
  }
  pi.sendUserMessage(
    "继续。（若有未完成的工作就直接继续，不要重复汇报；若确实已无待办或需要我决定，只回一句「已无待办」或「需要你决定：…」）",
  );
  await pushToWechat("收到，已让 agent 继续。");
  wxLog("微信侧人工下达「继续」");
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
  // 任何来自微信的消息都算“最近一条消息来自微信”（loop/继续/打断等指令也算），
  // 否则指令触发的任务在空闲后不会被提醒（实测漏提醒就出在这里）
  idleState.taskFromWechat = true;
  idleState.taskFromWechatAt = Date.now();
  activity.lastActivityAt = Date.now();
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
    if (rt) {
      // 新的用户消息 = 可能开一个新窗口，主动消息额度可能重置：记录上一窗口用量便于核对限额
      if (rt.sentSinceInbound > 0) {
        wxLog(`收到新消息，主动消息计数归零（上一窗口已发 ${rt.sentSinceInbound} 条）`);
      }
      rt.tokenAt = Date.now();
      rt.sentSinceInbound = 0;
    }
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
        "- 状态：空闲时只回“空闲”；执行中不打断，返回任务/当前动作/计划 + CPU/GPU",
        "- 继续：让空闲的 agent 接着干（收到空闲提醒后再发；扩展不会自动催）",
        "- loop：下发 research-loop skill，按预定计划持续执行（不因上下文紧张停下）",
        "- 打断：终止当前执行，让它先汇报现状与后续计划，之后进入正常对话",
        "- 停止：仅中断当前任务（不要求汇报）",
        "- 静默：切换结果推送模式（开启后仅微信下发的任务回结果）",
        "- 解绑：解除微信绑定",
      ].join("\n"),
    );
    return;
  }
  if (text === "状态") {
    // 空闲：不输出无关信息；忙：纯观测汇总，不打断执行
    if (ctx.isIdle()) {
      await pushToWechat("空闲");
      return;
    }
    await pushToWechat(await buildBusySummary(ctx));
    return;
  }
  if (text === "打断" || text === "中断") {
    if (ctx.isIdle()) {
      await pushToWechat("空闲，没有在跑的任务，直接说要做什么就行。");
      return;
    }
    resetIdleState("打断");
    await interruptAndAskReport(pi, ctx);
    return;
  }
  if (text === "loop" || text === "LOOP" || text === "Loop") {
    await startLoop(pi, ctx);
    return;
  }
  if (text === "继续" || text === "继续吧") {
    // 由微信侧的人决定是否让 agent 接着干（扩展不再自动催）
    await resumeFromWechat(pi, ctx);
    return;
  }
  if (text === "停止") {
    resetIdleState("停止");
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
  const queued = !ctx.isIdle();
  if (rt) {
    rt.pendingFromWechat = true;
    rt.pendingSince = Date.now();
  }
  // 空闲提醒：最近一条消息来自微信，重新开始计数
  resetIdleState("收到新的微信任务");
  idleState.taskFromWechat = true;
  idleState.taskFromWechatAt = Date.now();
  activity.lastActivityAt = Date.now();
  const serverLagS = msg.create_time_ms
    ? Math.round((Date.now() - msg.create_time_ms) / 1000)
    : -1;
  wxLog(
    `收到微信任务（微信发出→本机 ${serverLagS}s；pi ${queued ? "忙，已排队 followUp" : "空闲，立即执行"}）`,
  );
  if (ctx.hasUI) ctx.ui.notify(`微信消息: ${text.slice(0, 50)}`, "info");
  try {
    if (queued) {
      pi.sendUserMessage(text, { deliverAs: "followUp" });
    } else {
      pi.sendUserMessage(text);
    }
  } catch (err) {
    if (rt) {
      rt.pendingFromWechat = false;
      rt.pendingSince = 0;
    }
    wxLog(`消息下发失败: ${String(err)}`);
    await noticeFailureToWechat(`消息下发失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// 最终结果提取
// ---------------------------------------------------------------------------

/** 从当前会话分支取最后一条有文本内容的 assistant 消息（不含工具调用/思考） */
function lastAssistantEntry(ctx: ExtensionContext): { id: string; text: string; ts: number } | null {
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
    if (text) {
      const ts = Date.parse(String((entry as { timestamp?: string }).timestamp ?? ""));
      return { id: String(entry.id ?? ""), text, ts: Number.isFinite(ts) ? ts : 0 };
    }
  }
  return null;
}

/**
 * 推送「最新一条带文本的 assistant 回复」，并记录端到端延迟。
 *
 * 返回：
 *  - pushed  推送成功
 *  - skipped 该条目已推送过（自动续跑/重试重复落定）
 *  - empty   还没有带文本的回复
 *  - failed  推送失败（未标记已送达，下次落定/早推重试）
 */
async function pushLatestAssistant(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  reason: string,
): Promise<"pushed" | "skipped" | "empty" | "failed"> {
  if (!rt || rt.stopped) return "empty";
  const last = lastAssistantEntry(ctx);
  if (!last) return "empty";
  if (last.id === lastPushedEntryId) {
    // 自动续跑（goal 继续 / 重试 / 仅工具调用的续轮）不会有新文本，
    // 再推一次就是把上一条回复重复发给用户
    wxLog(`跳过重复推送（条目 ${last.id} 已推送过，来源=${reason}）`);
    return "skipped";
  }
  const label = pi.getSessionName() || path.basename(ctx.cwd);
  const ok = await pushToWechat(last.text, { prefix: `[${label}] ` });
  if (!ok) {
    wxLog(`推送未成功（来源=${reason}），条目 ${last.id} 保留待重试`);
    return "failed";
  }
  lastPushedEntryId = last.id;
  const textLag = last.ts ? Math.round((Date.now() - last.ts) / 1000) : -1;
  const taskLag = rt.pendingSince ? Math.round((Date.now() - rt.pendingSince) / 1000) : -1;
  wxLog(
    `已推送 条目 ${last.id}（来源=${reason}；文本产生→送达 ${textLag}s` +
      (taskLag >= 0 ? `；微信下发→送达 ${taskLag}s` : "") +
      `；本窗口第 ${rt?.sentSinceInbound ?? 0} 条主动消息）`,
  );
  return "pushed";
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
    // 记住当前最后一条回复，避免重启/重载后把已发过的回复当成“本轮新结果”再推一次
    lastPushedEntryId = lastAssistantEntry(ctx)?.id ?? null;
    activity.lastActivityAt = Date.now();
    startIdleWatchdog(ctx);
    updateStatusWidget(ctx);
  });

  // 会话结束时清理长轮询资源
  pi.on("session_shutdown", async () => {
    clearEarlyPushTimer();
    clearIdleTimer();
    stopIdleWatchdog();
    stopMonitor();
  });

  // 微信下发的任务：回复文本一产生就先推一次，不等整轮工作结束。
  // 实测「文本产生 → agent_settled」可相隔几分钟到几十分钟（长工具链、子代理、goal 续跑），
  // 而微信侧的主动推送窗口很短，拖太久会直接 ret=-2 prepare failed。
  pi.on("message_end", async (event, ctx) => {
    if (!rt || rt.stopped || !rt.pendingFromWechat) return;
    const message = event.message as { role?: string; content?: unknown };
    if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
    const hasText = (message.content as Array<{ type?: string; text?: string }>).some(
      (c) => c.type === "text" && typeof c.text === "string" && c.text.trim().length > 0,
    );
    if (hasText) armEarlyPush(pi, ctx);
  });

  // 执行状态观测（「状态」「打断」用）：只记录，不干预
  pi.on("agent_start", async (_event, ctx) => {
    activity.lastActivityAt = Date.now();
    activity.runStartedAt = Date.now();
    activity.current = null;
    // 开始干活了：撤掉待发的空闲提醒
    clearIdleTimer();
  });

  // 用户在终端直接输入 = 不再是纯粹的微信任务，停掉空闲提醒
  pi.on("input", async (event) => {
    if (event.source === "extension") return; // 扩展自己注入的（含微信任务/继续/打断）
    idleState.taskFromWechat = false;
    resetIdleState(`终端输入（${event.source}）`);
  });

  pi.on("tool_execution_start", async (event) => {
    activity.lastActivityAt = Date.now();
    if (!activity.runStartedAt) activity.runStartedAt = Date.now();
    const startedAt = Date.now();
    const detail = toolDetail(event.toolName, event.args);
    activity.current = { tool: event.toolName, detail, startedAt, toolCallId: event.toolCallId };
    activity.recent.push({ tool: event.toolName, detail, startedAt });
    if (activity.recent.length > 12) activity.recent.splice(0, activity.recent.length - 12);
  });

  pi.on("tool_execution_end", async (event) => {
    if (activity.current?.toolCallId === event.toolCallId) activity.current = null;
    const last = activity.recent[activity.recent.length - 1];
    if (last && !last.endedAt && last.tool === event.toolName) {
      last.endedAt = Date.now();
      last.isError = event.isError;
    }
  });

  // agent 完全落定后把最终结果推回微信
  // （只推最终 assistant 回复，不含工具执行等中间过程）
  pi.on("agent_settled", async (_event, ctx) => {
    if (!rt || rt.stopped) return;
    activity.current = null;
    activity.runStartedAt = 0;
    clearEarlyPushTimer();
    // 空闲提醒与「静默模式」无关（静默只影响结果推送），必须在早退之前武装
    armIdleReminder(ctx);
    const pending = rt.pendingFromWechat;
    // 静默模式下只回微信下发的任务
    if (!pending && loadSilent()) return;
    try {
      const res = await pushLatestAssistant(ctx, pi, "落定");
      if (res === "empty" && pending) {
        await pushToWechat("(任务已完成，无文本输出)");
        if (rt) {
          rt.pendingFromWechat = false;
          rt.pendingSince = 0;
        }
        return;
      }
      if ((res === "pushed" || res === "skipped") && rt && pending) {
        // 本条任务已经回复过（可能由早推完成），后续自主续跑不再当微信任务
        rt.pendingFromWechat = false;
        rt.pendingSince = 0;
      }
    } catch (err) {
      wxLog(`结果推送失败: ${String(err)}`);
    }
  });

  const WX_SUBCOMMANDS = ["status", "stop", "reconnect", "unbind", "widget", "debug", "nudge", "help"];

  function wxHelp(ctx: ExtensionContext): void {
    const lines = [
      "/wx                  扫码绑定（未连接时）",
      "/wx status           查看通道状态",
      "/wx stop             停止通道",
      "/wx reconnect        接管连接（从其他 pi 实例抢过来）",
      "/wx unbind           解绑并清除本地凭据",
      "/wx widget [on|off]  开关输入框上方的微信状态提示",
      "/wx debug [on|off]   后台日志是否输出到终端（默认关，日志文件始终写入）",
      `/wx nudge [on|off]   空闲提醒开关（微信任务回复后空闲超过 ${fmtDuration(IDLE_REMIND_DELAY_MS)} 且有后续任务时提醒你，是否继续由你决定）`,
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
      if (sub === "debug" || sub.startsWith("debug ")) {
        const arg = sub.slice("debug".length).trim();
        const current = loadDebugEnabled();
        const next = arg === "on" ? true : arg === "off" ? false : !current;
        writeSettings({ debug: next });
        const msg = next
          ? `已开启终端调试输出（后台日志也写入 ${LOG_FILE}）`
          : `已关闭终端调试输出（后台日志仍写入 ${LOG_FILE}）`;
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else console.log(`[weixin] ${msg}`);
        return;
      }
      if (sub === "nudge" || sub.startsWith("nudge ")) {
        const arg = sub.slice("nudge".length).trim();
        const next = arg === "on" ? true : arg === "off" ? false : !loadIdleRemindEnabled();
        writeSettings({ nudge: next });
        if (!next) clearIdleTimer();
        const msg = next
          ? `已开启空闲提醒（微信任务回复后空闲超过 ${fmtDuration(IDLE_REMIND_DELAY_MS)} 且还有后续任务时提醒你，是否继续由你决定）`
          : "已关闭空闲提醒（不会自动催 agent，也不会提醒）";
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
          const pushLine =
            pushStats.failures > 0
              ? `结果推送: 连续失败 ${pushStats.failures} 次（最近 ${new Date(pushStats.lastFailAt).toLocaleTimeString()}: ${pushStats.lastError}）`
              : pushStats.lastSuccessAt
                ? `结果推送: 正常（最近 ${new Date(pushStats.lastSuccessAt).toLocaleTimeString()}）`
                : "结果推送: 尚无推送";
          const lines = [
            `绑定状态: ${creds ? `已绑定 (bot=${creds.botId.slice(0, 8)}…)` : "未绑定"}`,
            `通道状态: ${rt && !rt.stopped ? "运行中" : "已停止"}`,
            ownerLine,
            `最近轮询: ${rt?.lastPollAt ? new Date(rt.lastPollAt).toLocaleTimeString() : "-"}`,
            pushLine,
            `主动消息: 本窗口已发 ${rt?.sentSinceInbound ?? 0} 条${rt?.tokenAt ? `（token 年龄 ${Math.round((Date.now() - rt.tokenAt) / 1000)}s）` : ""}`,
            `pi 状态: ${ctx.isIdle() ? "空闲" : "正在执行任务"}`,
            `推送模式: ${loadSilent() ? "静默（仅微信任务回结果）" : "全部推送"}`,
            `空闲提醒: ${loadIdleRemindEnabled() ? `开启（空闲 ${fmtDuration(IDLE_REMIND_DELAY_MS)} 触发，本任务${idleState.reminded ? "已提醒" : "未提醒"}）` : "关闭"}`,
            `凭据目录: ${STATE_DIR}`,
            `日志文件: ${LOG_FILE}${loadDebugEnabled() ? "（终端调试输出已开启）" : ""}`,
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
