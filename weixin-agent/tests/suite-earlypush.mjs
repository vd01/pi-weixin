// 套件 3：微信任务「早推」（不等落定）+ 非微信任务仍只推落定 + 延迟日志
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
  weixinInbound,
  sleep,
} from "./harness.mjs";

process.env.WEIXIN_EARLY_PUSH_MS = "300"; // 测试用短去抖
const USER = "u1@im.wechat";
const { home, state } = newEnv("early");
const term = captureTerminal();
const stub = await startStub();
writeCredentials(state, stub.port, USER);

const { default: factory } = await loadBundle();
const { check, finish } = makeCheck();
const branchRef = { value: [] };
const host = makeHost({ branchRef, userId: USER, home });
factory(host.fakePi);
const settle = () => host.handlers.agent_settled[0]({}, host.fakeCtx);
const messageEnd = (text) =>
  host.handlers.message_end[0]({ message: { role: "assistant", content: text ? [{ type: "text", text }] : [{ type: "toolCall" }] } }, host.fakeCtx);

await host.handlers.session_start[0]({}, host.fakeCtx);
await sleep(200);

// 1) 微信下发任务 → 交给 pi
stub.state.inbox = [weixinInbound("帮我跑个测试", USER)];
await sleep(500);
check("微信消息交付 pi", host.outbound.length === 1 && host.outbound[0][0] === "帮我跑个测试", JSON.stringify(host.outbound));

// 2) 回复文本产生即早推
branchRef.value = [msgEntry("t1", "已跑完，全部通过")];
messageEnd("已跑完，全部通过");
check("早推前不乱发", stub.sent.length === 0, JSON.stringify(stub.texts()));
await sleep(700);
check("回复产生后立即早推（不等落定）", stub.sent.length === 1 && stub.texts()[0] === "已跑完，全部通过", JSON.stringify(stub.texts()));

// 3) 任务期间新文本继续早推
branchRef.value = [...branchRef.value, msgEntry("t2", "补充：耗时 3 分钟")];
messageEnd("补充：耗时 3 分钟");
await sleep(700);
check("任务期间新文本继续早推", stub.sent.length === 2 && stub.texts()[1] === "补充：耗时 3 分钟", JSON.stringify(stub.texts()));
await settle();
check("落定不重复推", stub.sent.length === 2, JSON.stringify(stub.texts()));

// 4) 非微信任务不早推，仅落定推
branchRef.value = [...branchRef.value, msgEntry("t3", "goal 自主续跑的阶段性输出")];
messageEnd("goal 自主续跑的阶段性输出");
await sleep(700);
check("非微信任务不早推", stub.sent.length === 2, JSON.stringify(stub.texts()));
await settle();
check("非微信任务在落定时推送", stub.sent.length === 3 && stub.texts()[2] === "goal 自主续跑的阶段性输出", JSON.stringify(stub.texts()));

// 5) 静默模式：自主输出不推
fs.writeFileSync(path.join(state, "settings.json"), JSON.stringify({ silent: true }));
branchRef.value = [...branchRef.value, msgEntry("t4", "静默下的自主输出")];
await settle();
check("静默模式不推自主输出", stub.sent.length === 3, JSON.stringify(stub.texts()));
fs.writeFileSync(path.join(state, "settings.json"), JSON.stringify({ silent: false }));

// 6) 延迟可核算
const log = fs.readFileSync(path.join(state, "weixin.log"), "utf-8");
check("记录微信→本机延迟", /收到微信任务（微信发出→本机 1s/.test(log), "");
check("记录文本产生→送达延迟", /已推送 条目 t1（来源=微信任务早推；文本产生→送达 \d+s；微信下发→送达 \d+s；本窗口第 1 条主动消息）/.test(log), "");
check("终端保持安静", term.length === 0, JSON.stringify(term));

await host.handlers.session_shutdown[0]();
stub.close();
process.exit(finish() ? 0 : 1);
