// 套件 5：微信任务回复后 agent 空闲超过阈值 → 自动发「继续」→ 反应后回报状态
import fs from "node:fs";
import path from "node:path";
import {
  newEnv,
  loadBundle,
  captureTerminal,
  startStub,
  writeCredentials,
  makeHost,
  makeCheck,
  msgEntry,
  userEntry,
  weixinInbound,
  sleep,
} from "./harness.mjs";

const NUDGE_MS = 400;
process.env.WEIXIN_NUDGE_MS = String(NUDGE_MS);
process.env.WEIXIN_NUDGE_REPORT_MS = "200";
process.env.WEIXIN_NUDGE_REACTION_TIMEOUT_MS = "1200";
process.env.WEIXIN_EARLY_PUSH_MS = "200";

const USER = "u1@im.wechat";
const { home, state } = newEnv("nudge");
const term = captureTerminal();
const stub = await startStub();
writeCredentials(state, stub.port, USER);

const { default: factory } = await loadBundle();
const { check, finish } = makeCheck();

const branchRef = { value: [] };
const host = makeHost({ branchRef, userId: USER, home });
factory(host.fakePi);
const ctx = host.fakeCtx;
await host.handlers.session_start[0]({}, ctx);
await sleep(150);

/** 一轮：微信发任务 → agent 回复（早推）→ 落定 */
const wechatTurn = async (task, reply, { idleAfter = true } = {}) => {
  stub.state.inbox = [weixinInbound(task, USER)];
  await sleep(350);
  branchRef.value = [...branchRef.value, userEntry(`u-${task}`, task), msgEntry(`a-${task}`, reply)];
  host.handlers.message_end[0]({ message: { role: "assistant", content: [{ type: "text", text: reply }] } }, ctx);
  await sleep(350);
  host.flags.idle = idleAfter;
  await host.handlers.agent_settled[0]({}, ctx);
  await sleep(NUDGE_MS + 300);
};

const nudges = () => host.outbound.filter(([t]) => t === "继续").length;

// ── 1) 微信任务 + 回复里有后续计划 + 空闲 → 自动发「继续」
host.outbound.length = 0;
await wechatTurn("重跑 B_anchor", "B_anchor 已启动。下一步：核对 collapse 判据，然后跑 seed1。");
check("空闲超阈值后自动发「继续」", nudges() === 1, JSON.stringify(host.outbound.map((o) => o[0].slice(0, 20))));
check("回复已推送到微信", stub.sent.some((s) => /B_anchor 已启动/.test(s)), JSON.stringify(stub.sent.slice(-3)));
check("催办动作写入日志", /已向 agent 发「继续」/.test(fs.readFileSync(path.join(state, "weixin.log"), "utf-8")), "");

// ── 2) agent 反应后把状态报告推回微信
const sentBefore = stub.sent.length;
host.flags.idle = false;
host.handlers.agent_start[0]({}, ctx);
host.handlers.tool_execution_start[0](
  { toolCallId: "tc-n1", toolName: "bash", args: { command: "python3 ssl_train.py --leg B_anchor" } },
  ctx,
);
await sleep(600);
check("反应后推送了状态报告", stub.sent.length > sentBefore, JSON.stringify(stub.sent.slice(sentBefore)));
const report = stub.sent[stub.sent.length - 1] ?? "";
check("报告说明已发「继续」", /已自动发「继续」/.test(report), report.slice(0, 60));
check("报告含当前动作", /当前: bash · python3 ssl_train\.py/.test(report), report);
check("报告含 CPU/GPU", /CPU: /.test(report) && /GPU/.test(report), report);
host.handlers.tool_execution_end[0]({ toolCallId: "tc-n1", toolName: "bash", result: {}, isError: false }, ctx);

// ── 3) 回复里没有后续任务 → 不催
host.flags.idle = true;
host.outbound.length = 0;
await wechatTurn("查一下日志有没有报错", "日志没有报错，一切正常。");
check("无后续任务不催办", nudges() === 0, JSON.stringify(host.outbound));

// ── 4) 终端输入过的任务不催（最后一条消息不是微信）
host.outbound.length = 0;
host.handlers.input[0]({ source: "interactive", text: "tui 里直接问一句" }, ctx);
await sleep(100);
branchRef.value = [...branchRef.value, userEntry("u-tui", "tui 里直接问一句"), msgEntry("a-tui", "好的。下一步：继续跑 C 腿。")];
await host.handlers.agent_settled[0]({}, ctx);
await sleep(NUDGE_MS + 300);
check("终端任务不催办", nudges() === 0, JSON.stringify(host.outbound));

// ── 5) 关闭开关后不催
fs.writeFileSync(path.join(state, "settings.json"), JSON.stringify({ nudge: false }));
host.outbound.length = 0;
await wechatTurn("再跑一次 C 腿", "已开始。下一步：核对结果后跑 D 腿。");
check("nudge=off 时不催办", nudges() === 0, JSON.stringify(host.outbound));
fs.writeFileSync(path.join(state, "settings.json"), JSON.stringify({ nudge: true }));

// ── 6) 定时器到点时 agent 已在执行 → 不催
host.outbound.length = 0;
stub.state.inbox = [weixinInbound("跑 D 腿", USER)];
await sleep(350);
branchRef.value = [...branchRef.value, msgEntry("a-D", "D 腿已开始。下一步：等待训练结束后汇总。")];
host.handlers.message_end[0]({ message: { role: "assistant", content: [{ type: "text", text: "D 腿已开始。下一步：等待训练结束后汇总。" }] } }, ctx);
await sleep(350);
host.flags.idle = true;
await host.handlers.agent_settled[0]({}, ctx);
host.flags.idle = false; // 还没到点时就已经在干活
await sleep(NUDGE_MS + 300);
check("agent 忙时不催办", nudges() === 0, JSON.stringify(host.outbound));
host.flags.idle = true;

// ── 7) 催办次数上限（默认 2 次）
host.outbound.length = 0;
const nudgeThenSettle = async () => {
  stub.state.inbox = [weixinInbound("继续推进 E 腿", USER)];
  await sleep(350);
  branchRef.value = [...branchRef.value, msgEntry(`a-E-${Math.random()}`, "E 腿进行中。下一步：跑 F 腿。")];
  host.handlers.message_end[0]({ message: { role: "assistant", content: [{ type: "text", text: "E 腿进行中。下一步：跑 F 腿。" }] } }, ctx);
  await sleep(350);
  host.flags.idle = true;
  await host.handlers.agent_settled[0]({}, ctx);
  await sleep(NUDGE_MS + 300);
};
await nudgeThenSettle(); // 第 1 次
await nudgeThenSettle(); // 第 2 次（新微信消息会重置计数）
check("新微信任务重置催办计数", nudges() >= 2, `nudges=${nudges()}`);

// ── 8) agent 不响应 → 超时后回报
host.outbound.length = 0;
const beforeTimeout = stub.sent.length;
stub.state.inbox = [weixinInbound("跑 G 腿", USER)];
await sleep(350);
branchRef.value = [...branchRef.value, msgEntry("a-G", "G 腿已开始。下一步：等待训练结束。")];
host.handlers.message_end[0]({ message: { role: "assistant", content: [{ type: "text", text: "G 腿已开始。下一步：等待训练结束。" }] } }, ctx);
await sleep(350);
host.flags.idle = true;
await host.handlers.agent_settled[0]({}, ctx);
await sleep(NUDGE_MS + 200);
check("已发「继续」", nudges() >= 1, `nudges=${nudges()}`);
host.flags.idle = true; // 一直空闲，不响应
await sleep(1500);
check("长时间无响应会回报微信", /没有响应/.test(stub.sent.slice(beforeTimeout).join("\n")), JSON.stringify(stub.sent.slice(beforeTimeout)));

check("终端保持安静", term.length === 0, JSON.stringify(term));

await host.handlers.session_shutdown[0]();
stub.close();
process.exit(finish() ? 0 : 1);
