// 测试公共设施：临时 HOME、stub iLink 服务、终端输出捕获、断言
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BUNDLE = new URL("./bundle.mjs", import.meta.url).href;

/** 建一个干净的临时 HOME，并让扩展把状态写进去（必须在 import bundle 之前调用） */
export function newEnv(tag) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `wx-test-${tag}-`));
  process.env.HOME = home;
  delete process.env.WEIXIN_DEBUG;
  const state = path.join(home, ".pi", "agent", "weixin");
  fs.mkdirSync(state, { recursive: true });
  return { home, state };
}

export function loadBundle() {
  return import(BUNDLE);
}

const REAL_LOG = console.log.bind(console);
const REAL_ERROR = console.error.bind(console);

/** 捕获扩展对终端的写（这些写会污染 TUI，必须为空） */
export function captureTerminal() {
  const term = [];
  console.error = (...a) => term.push(a.join(" "));
  console.log = (...a) => term.push("[log] " + a.join(" "));
  return term;
}

/** 恢复真实 console（测试自身打印结果用） */
export function restoreTerminal() {
  console.log = REAL_LOG;
  console.error = REAL_ERROR;
}

/** stub iLink 服务：默认发送成功；inbox 供 getupdates 返回 */
export async function startStub({ getupdatesDelayMs = 60, sendDelayMs = 0 } = {}) {
  const sent = [];
  const state = { inbox: [], failNext: false };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = req.url ?? "";
      const json = (o, code = 200) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(o));
      };
      if (url.includes("getupdates")) {
        const msgs = state.inbox;
        state.inbox = [];
        setTimeout(() => json({ ret: 0, msgs, get_updates_buf: "buf", longpolling_timeout_ms: 60000 }), getupdatesDelayMs);
        return;
      }
      if (url.includes("sendmessage")) {
        const text = JSON.parse(body).msg.item_list?.[0]?.text_item?.text ?? "<no-text>";
        sent.push(text);
        if (state.failNext) {
          json({ ret: -1, errmsg: "simulated failure" }, 500);
          return;
        }
        setTimeout(() => json({ ret: 0 }), sendDelayMs);
        return;
      }
      json({ ret: 0 });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    sent,
    state,
    texts: () => sent.map((s) => s.replace(/^\[sess\] /, "")),
    last: () => sent[sent.length - 1],
    close: () => server.close(),
  };
}

export function writeCredentials(state, port, userId) {
  fs.writeFileSync(
    path.join(state, "credentials.json"),
    JSON.stringify({ botToken: "stub", botId: "stub-bot", baseUrl: `http://127.0.0.1:${port}/`, userId, savedAt: Date.now() }),
  );
}

/** 假的 pi / ctx（只实现扩展用到的方法） */
export function makeHost({ branchRef, userId, home, onSendUserMessage }) {
  const handlers = {};
  const outbound = [];
  const aborts = { count: 0 };
  const flags = { idle: true };
  const commands = {};
  const fakePi = {
    on: (n, f) => ((handlers[n] ??= []).push(f)),
    registerCommand: (n, d) => (commands[n] = d),
    getSessionName: () => "sess",
    sendUserMessage: (t, o) => {
      outbound.push([t, o]);
      onSendUserMessage?.(t, o);
    },
  };
  const fakeCtx = {
    hasUI: false,
    cwd: home,
    model: { provider: "deepseek", id: "deepseek-flash" },
    isIdle: () => flags.idle,
    hasPendingMessages: () => false,
    signal: undefined,
    abort: () => {
      aborts.count += 1;
      flags.idle = true;
    },
    ui: { notify: () => {}, setWidget: () => {}, custom: async () => ({}) },
    sessionManager: { getBranch: () => branchRef.value },
  };
  return { handlers, outbound, aborts, flags, fakePi, fakeCtx, commands };
}

export const msgEntry = (id, text, extra = {}) => ({
  type: "message",
  id,
  timestamp: new Date().toISOString(),
  message: { role: "assistant", content: text ? [{ type: "text", text }] : [{ type: "toolCall", name: "bash" }], ...extra },
});

export const userEntry = (id, text) => ({
  type: "message",
  id,
  timestamp: new Date().toISOString(),
  message: { role: "user", content: [{ type: "text", text }] },
});

export function weixinInbound(text, userId, overrides = {}) {
  return {
    seq: 1,
    message_id: Math.floor(Math.random() * 1e6),
    from_user_id: userId,
    message_type: 1,
    create_time_ms: Date.now() - 1000,
    context_token: `ctx-${Math.random()}`,
    item_list: [{ type: 1, text_item: { text } }],
    ...overrides,
  };
}

export function makeCheck() {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " :: " + String(detail).slice(0, 300) : ""}`);
    return ok;
  };
  const finish = () => {
    const failed = results.filter((r) => r.startsWith("FAIL")).length;
    restoreTerminal();
    REAL_LOG(results.join("\n"));
    REAL_LOG(`\n${results.length - failed}/${results.length} passed`);
    return failed === 0;
  };
  return { check, finish, results };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
