// 套件 5：空闲提醒（只提醒人，不自动催 agent）+ 微信「继续」指令
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

const REMIND_MS = 400;
process.env.WEIXIN_IDLE_REMIND_MS = String(REMIND_MS);
process.env.WEIXIN_IDLE_WATCHDOG_MS = "300";
process.env.WEIXIN_EARLY_PUSH_MS = "200";

const USER = "u1@im.wechat";
const { home, state } = newEnv("idle");
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
/** 有没有自动向 agent 注入「继续」（自动催就会在这里出现；任务本身也会走 sendUserMessage） */
const injected = () => host.outbound.filter(([t]) => t.startsWith("继续。（")).length;
const reminders = () => stub.sent.filter((s) => /agent 已空闲/.test(s));

/** 一轮：微信发任务 → agent 回复 → 落定 → 等提醒窗口 */
const wechatTurn = async (task, reply, { idleAfter = true } = {}) => {
  stub.state.inbox = [weixinInbound(task, USER)];
  await sleep(350);
  branchRef.value = [...branchRef.value, userEntry(`u-${Math.random()}`, task), msgEntry(`a-${Math.random()}`, reply)];
  host.handlers.message_end[0]({ message: { role: "assistant", content: [{ type: "text", text: reply }] } }, ctx);
  await sleep(300);
  host.flags.idle = idleAfter;
  await host.handlers.agent_settled[0]({}, ctx);
  await sleep(REMIND_MS + 300);
};

// ── 1) 空闲超阈值 → 只提醒微信侧的人，绝不向 agent 注入
host.outbound.length = 0;
const before1 = stub.sent.length;
await wechatTurn(
  "看下 Z3 进展",
  ["**进度（13:12）**", "| ETA | 全部数据齐 ≈ 13:50 |", "数据一齐我就算三 seed 配对，我继续盯。"].join("\n"),
);
check("到点只提醒、不自动催 agent", injected() === 0, JSON.stringify(host.outbound.map((o) => o[0].slice(0, 20))));
const r1 = stub.sent.slice(before1).filter((s) => /agent 已空闲/.test(s));
check("提醒已推到微信", r1.length === 1, JSON.stringify(stub.sent.slice(before1)));
check("提醒说明了依据", /依据：回复含进度\/等待用语/.test(r1[0] ?? ""), r1[0]);
check("提醒告诉人回「继续」", /回复「继续」/.test(r1[0] ?? ""), r1[0]);
check("提醒留痕", /空闲提醒推送成功/.test(logText()), "");

// ── 2) 一个任务只提醒一次
const before2 = stub.sent.length;
await host.handlers.agent_settled[0]({}, ctx);
await sleep(REMIND_MS + 300);
check("同一任务不重复提醒", stub.sent.slice(before2).filter((s) => /agent 已空闲/.test(s)).length === 0, JSON.stringify(stub.sent.slice(before2)));

// ── 3) 人发「继续」→ 这时才真正推动 agent
host.outbound.length = 0;
stub.state.inbox = [weixinInbound("继续", USER)];
await sleep(600);
check("人工「继续」才注入 agent", injected() === 1, JSON.stringify(host.outbound.map((o) => o[0].slice(0, 20))));
check("「继续」带自检说明", /已无待办/.test(host.outbound.find(([t]) => t.startsWith("继续。（"))?.[0] ?? ""), "");
check("人工「继续」有回执", stub.sent.slice(-4).some((x) => /已让 agent 继续/.test(x)), JSON.stringify(stub.sent.slice(-4)));

// ── 4) agent 忙时发「继续」→ 不注入、提示看状态
host.flags.idle = false;
host.outbound.length = 0;
stub.state.inbox = [weixinInbound("继续", USER)];
await sleep(600);
check("忙时不注入「继续」", injected() === 0, JSON.stringify(host.outbound));
check("忙时提示不需要继续", /正在执行，不需要「继续」/.test(stub.last() ?? ""), stub.last());
host.flags.idle = true;

// ── 5) 明确“已无待办/等你决策/无需处理”→ 不提醒
for (const [reply, why] of [
  ["全部完成，已无待办。", "已无待办"],
  ["等你确认方案：选 A 还是 B？", "等你决策"],
  ["日志没有报错，一切正常。", "无需处理"],
]) {
  const before = reminders().length;
  const beforeInject = injected();
  await wechatTurn(`检查项 ${why}`, reply);
  check(`不提醒：${why}`, reminders().length === before && injected() === beforeInject, "");
}

// ── 6) 终端输入的任务不提醒
host.outbound.length = 0;
host.handlers.input[0]({ source: "interactive", text: "tui 里问一句" }, ctx);
await sleep(80);
const before6 = reminders().length;
branchRef.value = [...branchRef.value, userEntry("u-tui", "tui 里问一句"), msgEntry("a-tui", "进度：下一步继续跑 C 腿。")];
await host.handlers.agent_settled[0]({}, ctx);
await sleep(REMIND_MS + 300);
check("终端任务不提醒", reminders().length === before6, "");

// ── 7) /wx nudge off 关闭提醒
fs.writeFileSync(path.join(state, "settings.json"), JSON.stringify({ nudge: false }));
const before7 = reminders().length;
await wechatTurn("再跑一次 C 腿", "已开始。接下来：核对结果后跑 D 腿。");
check("nudge=off 不提醒", reminders().length === before7, "");
fs.writeFileSync(path.join(state, "settings.json"), JSON.stringify({ nudge: true }));

// ── 8) 帮助里说明「继续」由人决定
stub.state.inbox = [weixinInbound("帮助", USER)];
await sleep(600);
check("帮助含「继续」说明", /继续：让空闲的 agent 接着干/.test(stub.last() ?? ""), stub.last());

// ── 9) loop 指令触发的任务也会被提醒（此前只认“普通文本任务”，实测漏提醒）
stub.state.inbox = [weixinInbound("loop", USER)];
await sleep(400);
const before9 = reminders().length;
branchRef.value = [...branchRef.value, msgEntry("a-loop", "已按 research-loop 计划开始（进度：第 1 阶段）。预计 20 分钟。")];
host.handlers.message_end[0]({ message: { role: "assistant", content: [{ type: "text", text: "已按 research-loop 计划开始（进度：第 1 阶段）。预计 20 分钟。" }] } }, ctx);
host.flags.idle = true;
await host.handlers.agent_settled[0]({}, ctx);
await sleep(REMIND_MS + 400);
check("loop 触发的任务也会收到空闲提醒", reminders().length === before9 + 1, JSON.stringify(stub.sent.slice(-2)));

// ── 10) 错过 settle 也能靠巡检兜底：只更新活动时间，不发 settle
const before10 = reminders().length;
host.handlers.input[0]({ source: "extension", text: "x" }, ctx); // 不改状态
stub.state.inbox = [weixinInbound("继续跑 D 腿", USER)];
await sleep(350);
branchRef.value = [...branchRef.value, msgEntry("a-D2", "D 腿进行中。接下来：等训练结束汇总。")];
host.flags.idle = true; // 不调用 agent_settled
await sleep(REMIND_MS + 900); // 等巡检（300ms 间隔）命中
check("错过 settle 时巡检兜底提醒", reminders().length === before10 + 1, JSON.stringify(stub.sent.slice(-2)));

check("终端保持安静", term.length === 0, JSON.stringify(term));

await host.handlers.session_shutdown[0]();
stub.close();
process.exit(finish() ? 0 : 1);
