// 套件 2：结果推送去重（自动续跑/重试不重复推）+ 失败重试
import fs from "node:fs";
import path from "node:path";
import { newEnv, loadBundle, captureTerminal, startStub, writeCredentials, makeHost, makeCheck, msgEntry, sleep } from "./harness.mjs";

const { home, state } = newEnv("dedup");
const term = captureTerminal();
const stub = await startStub();
writeCredentials(state, stub.port, "u1@im.wechat");

const { pushStats, default: factory } = await loadBundle();
const { check, finish } = makeCheck();
const branchRef = { value: [msgEntry("e1", "结果A")] };
const host = makeHost({ branchRef, userId: "u1@im.wechat", home });
factory(host.fakePi);
const settle = () => host.handlers.agent_settled[0]({}, host.fakeCtx);

await host.handlers.session_start[0]({}, host.fakeCtx);
await sleep(250);
check("监控启动且终端静默", term.length === 0, JSON.stringify(term));

await settle();
check("启动时已存在的旧回复不重推", stub.sent.length === 0, JSON.stringify(stub.texts()));

branchRef.value = [...branchRef.value, msgEntry("e2", "结果B")];
await settle();
await settle();
await settle();
check("同一条回复只推一次", stub.sent.length === 1 && stub.texts()[0] === "结果B", JSON.stringify(stub.texts()));

branchRef.value = [...branchRef.value, msgEntry("e3", null)];
await settle();
check("无新文本的续轮不推旧结果", stub.sent.length === 1, JSON.stringify(stub.texts()));

stub.state.failNext = true;
branchRef.value = [...branchRef.value, msgEntry("e4", "结果C")];
await settle();
check("失败时确实尝试发送", stub.sent.length === 2, JSON.stringify(stub.texts()));
check("失败计数累加", pushStats.failures === 1, JSON.stringify(pushStats));
stub.state.failNext = false;
await settle();
check("失败后下次 settle 重试成功", stub.sent.length === 3 && stub.texts()[2] === "结果C", JSON.stringify(stub.texts()));
await settle();
check("重试成功后不重复", stub.sent.length === 3, JSON.stringify(stub.texts()));

branchRef.value = [...branchRef.value, msgEntry("e5", "结果D")];
await settle();
check("新回复照常推送", stub.sent.length === 4 && stub.texts()[3] === "结果D", JSON.stringify(stub.texts()));
await host.handlers.session_start[0]({}, host.fakeCtx);
await settle();
await settle();
check("重载后不重推同一条", stub.sent.length === 4, JSON.stringify(stub.texts()));

const log = fs.readFileSync(path.join(state, "weixin.log"), "utf-8");
check("去重写入日志", log.includes("跳过重复推送"), "");
check("日志记录主动消息额度", /本窗口第 \d+ 条主动消息/.test(log), "");
check("终端始终安静", term.length === 0, JSON.stringify(term));

await host.handlers.session_shutdown[0]();
stub.close();
process.exit(finish() ? 0 : 1);
