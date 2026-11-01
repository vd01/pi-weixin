// 套件 1：后台日志只落盘（不污染 TUI）、/wx status、/wx debug
import fs from "node:fs";
import path from "node:path";
import { newEnv, loadBundle, captureTerminal, startStub, writeCredentials, makeHost, makeCheck } from "./harness.mjs";

const { home, state } = newEnv("logs");
const term = captureTerminal();
const stub = await startStub();
writeCredentials(state, stub.port, "u1@im.wechat");

const { wxLog, pushStats, default: factory } = await loadBundle();
const { check, finish } = makeCheck();
const branchRef = { value: [] };
const host = makeHost({ branchRef, userId: "u1@im.wechat", home });
host.fakeCtx.hasUI = true; // 交互模式下命令走 ui.notify
factory(host.fakePi);
check("扩展入口是函数", typeof factory === "function");
check("注册了 /wx 命令", typeof host.commands.wx?.handler === "function");

// 1) 默认：落盘、终端静默
wxLog("模拟后台错误");
const logFile = path.join(state, "weixin.log");
check("日志落盘", fs.readFileSync(logFile, "utf-8").includes("模拟后台错误"), logFile);
check("终端默认静默", term.length === 0, JSON.stringify(term));

// 2) /wx debug on / off
await host.commands.wx.handler("debug on", host.fakeCtx);
term.length = 0;
wxLog("调试行");
check("debug on 输出终端", term.some((l) => l.includes("调试行")), JSON.stringify(term));
check("debug on 仍落盘", fs.readFileSync(logFile, "utf-8").includes("调试行"));
await host.commands.wx.handler("debug off", host.fakeCtx);
term.length = 0;
wxLog("安静行");
check("debug off 恢复静默", term.length === 0, JSON.stringify(term));

// 3) /wx status 汇总（含推送健康度/额度/日志路径），且终端静默
pushStats.failures = 3;
pushStats.lastError = "ret=-2 prepare failed";
pushStats.lastFailAt = Date.now();
const notified = [];
host.fakeCtx.ui.notify = (m, t) => notified.push([t, m]);
term.length = 0;
await host.commands.wx.handler("status", host.fakeCtx);
const status = notified.map((n) => n[1]).join("\n");
check("status 含推送失败信息", /结果推送: 连续失败 3 次/.test(status), status);
check("status 含主动消息额度", /主动消息: 本窗口已发 0 条/.test(status), status);
check("status 含日志路径", status.includes("weixin.log"), status);
check("status 无终端噪音", term.length === 0, JSON.stringify(term));

// 4) 补全与帮助
check("补全含 debug", host.commands.wx.getArgumentCompletions("d").some((c) => c.value === "debug"));
const help = [];
host.fakeCtx.ui.notify = (m) => help.push(m);
await host.commands.wx.handler("help", host.fakeCtx);
check("帮助含 debug 子命令", /\/wx debug/.test(help.join("\n")), help.join("\n"));

// 5) 无凭据时 session_start 不炸
const emptyEnv = newEnv("logs-empty");
term.length = 0;
try {
  await host.handlers.session_start[0]({}, { ...host.fakeCtx, cwd: emptyEnv.home });
  check("无凭据 session_start 安全", true);
} catch (e) {
  check("无凭据 session_start 安全", false, String(e));
}

stub.close();
process.exit(finish() ? 0 : 1);
