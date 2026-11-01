// 套件 4：微信「状态」（空闲只回“空闲” / 执行中不打断并给汇总）与「打断」
import {
  newEnv,
  loadBundle,
  captureTerminal,
  startStub,
  writeCredentials,
  makeHost,
  makeCheck,
  userEntry,
  msgEntry,
  weixinInbound,
  sleep,
} from "./harness.mjs";

process.env.WEIXIN_EARLY_PUSH_MS = "300";
const USER = "u1@im.wechat";
const { home, state } = newEnv("status");
const term = captureTerminal();
const stub = await startStub();
writeCredentials(state, stub.port, USER);

const { default: factory } = await loadBundle();
const { check, finish } = makeCheck();

const branchRef = {
  value: [
    userEntry("u1", "把 B_anchor 那条腿重跑，并核对 collapse 判据"),
    msgEntry("a1", "正在重跑 B_anchor/seed0。\n下一步：核对 collapse 判据是否误判\n然后：再跑 seed1 对照"),
  ],
};
const host = makeHost({ branchRef, userId: USER, home });
factory(host.fakePi);
const ctx = host.fakeCtx;
await host.handlers.session_start[0]({}, ctx);
await sleep(150);

const ask = async (text, waitMs = 700) => {
  stub.state.inbox = [weixinInbound(text, USER)];
  await sleep(waitMs);
};

// 1) 空闲「状态」→ 只回“空闲”，不打扰 agent
host.flags.idle = true;
await ask("状态");
check("空闲只回“空闲”", stub.last() === "空闲", JSON.stringify(stub.texts()));
check("空闲不向 agent 下发指令", host.outbound.length === 0, JSON.stringify(host.outbound));

// 2) 执行中「状态」→ 不打断，汇总任务/当前动作/计划 + CPU/GPU
host.flags.idle = false;
host.handlers.agent_start[0]({}, ctx);
host.handlers.tool_execution_start[0](
  { toolCallId: "tc1", toolName: "bash", args: { command: "python3 ssl_train.py --leg B_anchor --seed 0" } },
  ctx,
);
await ask("状态", 900);
const busy = stub.last();
check("执行中未 abort", host.aborts.count === 0, String(host.aborts.count));
check("执行中不向 agent 下发指令", host.outbound.length === 0, JSON.stringify(host.outbound));
check("含执行状态", /状态: 执行中/.test(busy), busy.split("\n")[0]);
check("含任务来源", /任务: 把 B_anchor 那条腿重跑/.test(busy), busy);
check("含当前动作与耗时", /当前: bash · python3 ssl_train\.py.*（已 \d+s）/.test(busy), busy);
check("含计划（摘自最近回复）", /计划: .*下一步.*核对 collapse 判据/.test(busy), busy);
check("含 CPU", /CPU: (\d+%（|负载 )/.test(busy), busy);
check("含 GPU", /GPU\d .*: \d+% 显存|GPU: 不可用/.test(busy), busy);
check("含内存", /内存: \d+\.\d+\/\d+\.\d+G（\d+%）/.test(busy), busy);
check("含模型", /模型: deepseek\/deepseek-flash/.test(busy), busy);
check("汇总控制在一 Messenger 条（<800 字）", busy.length < 800, `len=${busy.length}`);

// 3) 工具结束后降级说明
host.handlers.tool_execution_end[0]({ toolCallId: "tc1", toolName: "bash", result: {}, isError: false }, ctx);
await ask("状态", 900);
check("工具结束后降级", /当前: 模型生成中|当前: 等待模型响应/.test(stub.last()), stub.last().split("\n")[2]);

// 4) 「打断」→ abort + 要求汇报（带快照）
host.flags.idle = false;
host.handlers.agent_start[0]({}, ctx);
host.handlers.tool_execution_start[0](
  { toolCallId: "tc2", toolName: "bash", args: { command: "python3 ssl_train.py --leg B_anchor" } },
  ctx,
);
await ask("打断", 800);
check("打断会 abort", host.aborts.count === 1, String(host.aborts.count));
check("打断回复已中断说明", /已中断当前执行/.test(stub.last()), stub.last());
check("打断下发汇报指令", host.outbound.length === 1 && /微信中断指令/.test(host.outbound[0][0]), String(host.outbound.length));
const prompt = host.outbound[0]?.[0] ?? "";
check("汇报指令带扩展快照", /扩展侧快照[\s\S]*中断时正在运行: bash/.test(prompt), prompt.slice(-160));
check("汇报指令禁止继续执行", /不要自行继续执行/.test(prompt), "");

// 5) 汇报结果自动推回微信
branchRef.value = [
  ...branchRef.value,
  msgEntry("a2", "被打断时正在重跑 B_anchor/seed0（已跑到 1200/3000 步）。计划：1) 核对判据 2) 跑 seed1 3) 出对照表。"),
];
host.handlers.message_end[0]({ message: { role: "assistant", content: [{ type: "text", text: "计划：1) 核对判据 2) 跑 seed1 3) 出对照表" }] } }, ctx);
await sleep(800);
check("汇报结果自动推回微信", /被打断时正在重跑 B_anchor/.test(stub.last()), stub.last().slice(0, 50));

// 6) 空闲「打断」→ 提示空闲、不 abort
host.flags.idle = true;
const before = host.aborts.count;
await ask("打断");
check("空闲打断不 abort", host.aborts.count === before, String(host.aborts.count));
check("空闲打断提示空闲", /空闲/.test(stub.last()), stub.last());

// 6.5) loop：下发 research-loop skill + 「按计划执行、不因上下文紧张停下」提示
host.outbound.length = 0;
host.flags.idle = true;
await ask("loop");
const loopMsg = host.outbound.find(([t]) => t.startsWith("/skill:"));
check("loop 注入 skill:research-loop", Boolean(loopMsg) && loopMsg[0].startsWith("/skill:research-loop"), JSON.stringify(host.outbound.map((o) => o[0].slice(0, 40))));
check("loop 带“按计划执行”提示", /按照预定计划执行，中途不要因为上下文紧张等原因停下来/.test(loopMsg?.[0] ?? ""), loopMsg?.[0]);
check("loop 启用 skill 展开", loopMsg?.[1]?.expandPromptTemplates === true, JSON.stringify(loopMsg?.[1]));
check("loop 有回执", /已下发 research-loop/.test(stub.last() ?? ""), stub.last());

// agent 忙时 loop → 排队 followUp
host.flags.idle = false;
host.outbound.length = 0;
await ask("loop");
const queued = host.outbound.find(([t]) => t.startsWith("/skill:"));
check("忙时 loop 排队 followUp", queued?.[1]?.deliverAs === "followUp", JSON.stringify(queued?.[1]));
check("忙时 loop 回执说明排队", /正在执行，已排队/.test(stub.last() ?? ""), stub.last());
host.flags.idle = true;

// skill 不存在 → 不注入、给出原因
host.availableCommands.length = 0;
host.outbound.length = 0;
await ask("loop");
check("skill 缺失时不注入", host.outbound.length === 0, JSON.stringify(host.outbound));
check("skill 缺失时说明原因", /未找到 skill「research-loop」/.test(stub.last() ?? ""), stub.last());
host.availableCommands.push({ name: "skill:research-loop", description: "research loop" });

// 7) 帮助列出两条新指令
await ask("帮助");
const help = stub.last();
check("帮助含状态说明", /状态：.*不打断/.test(help), "");
check("帮助含打断说明", /打断：终止当前执行.*汇报/.test(help), "");
check("帮助含 loop 说明", /loop：下发 research-loop skill/.test(help), "");

check("终端保持安静", term.length === 0, JSON.stringify(term));

await host.handlers.session_shutdown[0]();
stub.close();
process.exit(finish() ? 0 : 1);
