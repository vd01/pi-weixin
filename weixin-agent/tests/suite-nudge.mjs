// 套件 5：微信任务回复后 agent 空闲超过阈值 → 自动发「继续」→ 状态合并进它的下一条回复
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
process.env.WEIXIN_NUDGE_REACTION_TIMEOUT_MS = "1200";
process.env.WEIXIN_NUDGE_MERGE_MS = "600"; // 合并窗口（无文本回复多久后单独补状态）
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

const logText = () => fs.readFileSync(path.join(state, "weixin.log"), "utf-8");
const nudges = () => host.outbound.filter(([t]) => t === "继续").length;

/** 一轮：微信发任务 → agent 出回复 → 落定 → 等催办窗口 */
const wechatTurn = async (task, reply, { idleAfter = true, expectPush = true } = {}) => {
  stub.state.inbox = [weixinInbound(task, USER)];
  await sleep(350);
  branchRef.value = [...branchRef.value, userEntry(`u-${task}`, task), msgEntry(`a-${task}-${Math.random()}`, reply)];
  host.handlers.message_end[0]({ message: { role: "assistant", content: [{ type: "text", text: reply }] } }, ctx);
  await sleep(300);
  host.flags.idle = idleAfter;
  await host.handlers.agent_settled[0]({}, ctx);
  await sleep(NUDGE_MS + 300);
  return expectPush;
};

// ── 1) 微信任务 + 回复里有后续计划 + 空闲 → 自动发「继续」
host.outbound.length = 0;
await wechatTurn("重跑 B_anchor", "B_anchor 已启动。下一步：核对 collapse 判据，然后跑 seed1。");
check("空闲超阈值后自动发「继续」", nudges() === 1, JSON.stringify(host.outbound.map((o) => o[0].slice(0, 12))));
check("催办动作写入日志", /已向 agent 发「继续」/.test(logText()), "");

// ── 2) agent 反应：状态合并进它的回复（同一条消息，不额外发）
const before = stub.sent.length;
host.flags.idle = false;
host.handlers.agent_start[0]({}, ctx);
host.handlers.tool_execution_start[0](
  { toolCallId: "tc-n1", toolName: "bash", args: { command: "python3 ssl_train.py --leg B_anchor" } },
  ctx,
);
branchRef.value = [...branchRef.value, msgEntry("a-react", "收到，继续跑 C 腿。")];
host.handlers.message_end[0]({ message: { role: "assistant", content: [{ type: "text", text: "收到，继续跑 C 腿。" }] } }, ctx);
await sleep(900);
const added = stub.sent.slice(before);
check("反应后只多 1 条消息（状态已合并）", added.length === 1, JSON.stringify(added));
check("合并消息含 agent 原文", /收到，继续跑 C 腿/.test(added[0] ?? ""), added[0]);
check("合并消息含状态段", /\[状态\] 执行中/.test(added[0] ?? ""), added[0]);
check("合并消息含当前动作", /\[当前\] bash · python3 ssl_train\.py/.test(added[0] ?? ""), added[0]);
check("合并消息含资源行", /\[资源\] CPU: .*GPU/.test(added[0] ?? ""), added[0]);
check("合并动作写入日志", /状态已合并进回复/.test(logText()), "");
host.handlers.tool_execution_end[0]({ toolCallId: "tc-n1", toolName: "bash", result: {}, isError: false }, ctx);
await sleep(600);

// ── 3) 推送失败不影响催办（第二条条件不要求推送成功）
host.outbound.length = 0;
stub.state.failNext = true;
stub.state.inbox = [weixinInbound("跑 F 腿", USER)];
await sleep(350);
branchRef.value = [...branchRef.value, msgEntry("a-F", "F 腿已启动。下一步：等训练结束汇总。")];
host.handlers.message_end[0]({ message: { role: "assistant", content: [{ type: "text", text: "F 腿已启动。下一步：等训练结束汇总。" }] } }, ctx);
await sleep(300);
host.flags.idle = true;
await host.handlers.agent_settled[0]({}, ctx);
stub.state.failNext = false;
await sleep(NUDGE_MS + 300);
check("推送失败也照样催办", nudges() === 1, JSON.stringify(host.outbound.map((o) => o[0].slice(0, 12))));

// ── 4) 回复里没有后续任务 → 不催
host.outbound.length = 0;
host.flags.idle = true;
await wechatTurn("查一下日志有没有报错", "日志没有报错，一切正常。");
check("无后续任务不催办", nudges() === 0, JSON.stringify(host.outbound));

// ── 5) 终端输入过的任务不催（最后一条消息不是微信）
host.outbound.length = 0;
host.handlers.input[0]({ source: "interactive", text: "tui 里直接问一句" }, ctx);
await sleep(80);
branchRef.value = [...branchRef.value, userEntry("u-tui", "tui 里直接问一句"), msgEntry("a-tui", "好的。下一步：继续跑 C 腿。")];
await host.handlers.agent_settled[0]({}, ctx);
await sleep(NUDGE_MS + 300);
check("终端任务不催办", nudges() === 0, JSON.stringify(host.outbound));

// ── 6) 关闭开关后不催
fs.writeFileSync(path.join(state, "settings.json"), JSON.stringify({ nudge: false }));
host.outbound.length = 0;
await wechatTurn("再跑一次 C 腿", "已开始。下一步：核对结果后跑 D 腿。");
check("nudge=off 时不催办", nudges() === 0, JSON.stringify(host.outbound));
fs.writeFileSync(path.join(state, "settings.json"), JSON.stringify({ nudge: true }));

// ── 7) 定时器到点时 agent 已在执行 → 不催
host.outbound.length = 0;
const p7 = wechatTurn("跑 D 腿", "D 腿已开始。下一步：等待训练结束后汇总。", { idleAfter: false });
await p7;
check("agent 忙时不催办", nudges() === 0, JSON.stringify(host.outbound));
host.flags.idle = true;

// ── 8) 新微信消息重置计数（能再次催）
host.outbound.length = 0;
await wechatTurn("继续推进 E 腿", "E 腿进行中。下一步：跑 F 腿。");
check("新微信任务可再次催办", nudges() === 1, JSON.stringify(host.outbound));

// ── 9) agent 完全不响应 → 超时回报
host.outbound.length = 0;
const beforeTimeout = stub.sent.length;
stub.state.inbox = [weixinInbound("跑 G 腿", USER)];
await sleep(350);
branchRef.value = [...branchRef.value, msgEntry("a-G", "G 腿已开始。下一步：等待训练结束。")];
host.handlers.message_end[0]({ message: { role: "assistant", content: [{ type: "text", text: "G 腿已开始。下一步：等待训练结束。" }] } }, ctx);
await sleep(300);
host.flags.idle = true;
await host.handlers.agent_settled[0]({}, ctx);
await sleep(NUDGE_MS + 200);
check("已发「继续」", nudges() >= 1, `nudges=${nudges()}`);
await sleep(1400); // 不调用 agent_start，模拟完全不响应
check("无响应会回报微信", /没有响应/.test(stub.sent.slice(beforeTimeout).join("\n")), JSON.stringify(stub.sent.slice(beforeTimeout)));

// ── 10) 有反应但一直没文本回复 → 兜底推一条状态（含 [状态]）
host.outbound.length = 0;
const beforeFallback = stub.sent.length;
stub.state.inbox = [weixinInbound("跑 H 腿", USER)];
await sleep(350);
branchRef.value = [...branchRef.value, msgEntry("a-H", "H 腿已开始。下一步：等待训练结束。")];
host.handlers.message_end[0]({ message: { role: "assistant", content: [{ type: "text", text: "H 腿已开始。下一步：等待训练结束。" }] } }, ctx);
await sleep(300);
host.flags.idle = true;
await host.handlers.agent_settled[0]({}, ctx);
await sleep(NUDGE_MS + 200);
host.flags.idle = false;
host.handlers.agent_start[0]({}, ctx); // 有反应
host.handlers.tool_execution_start[0](
  { toolCallId: "tc-H", toolName: "bash", args: { command: "python3 ssl_train.py --leg H" } },
  ctx,
);
await sleep(1100); // 合并窗口 600ms，期间不产生文本回复
const fb = stub.sent.slice(beforeFallback).join("\n");
check("无文本回复时 1 秒级补状态（不等 5 分钟）", /agent 已继续执行但暂无文本回复/.test(fb) && /\[状态\]/.test(fb), fb.slice(0, 200));
check("兜底推送有结果留痕", /催办状态\(兜底\)推送成功/.test(logText()), "");

check("终端保持安静", term.length === 0, JSON.stringify(term));

await host.handlers.session_shutdown[0]();
stub.close();
process.exit(finish() ? 0 : 1);
