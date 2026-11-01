/**
 * 本机资源采集（供微信「状态」指令使用）
 *
 * 只读 /proc 与 nvidia-smi，不碰 agent 会话，不会打断正在执行的任务。
 * 目标：单条微信消息内能说清 CPU / 内存 / GPU，失败一律降级为「不可用」。
 */

import fs from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";

function readCpuTimes(): { idle: number; total: number } | null {
  try {
    const line = fs.readFileSync("/proc/stat", "utf-8").split("\n")[0] ?? "";
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    if (parts.length < 4 || parts.some((n) => Number.isNaN(n))) return null;
    const idle = (parts[3] ?? 0) + (parts[4] ?? 0); // idle + iowait
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch {
    return null;
  }
}

/** 采样两次 /proc/stat 求区间 CPU 使用率；失败返回 null */
async function cpuUsagePercent(sampleMs = 150): Promise<number | null> {
  const a = readCpuTimes();
  if (!a) return null;
  await new Promise((r) => setTimeout(r, sampleMs));
  const b = readCpuTimes();
  if (!b) return null;
  const totalDelta = b.total - a.total;
  const idleDelta = b.idle - a.idle;
  if (totalDelta <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
}

/** 用 os.loadavg 做降级（没有 /proc 时） */
function loadNote(): string {
  const [l1, l5, l15] = os.loadavg().map((n) => n.toFixed(1));
  return `负载 ${l1}/${l5}/${l15}`;
}

function runCmd(cmd: string, args: string[], timeoutMs = 1500): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 }, (err, stdout) => {
        if (err && !stdout) {
          resolve(null);
          return;
        }
        resolve(String(stdout ?? ""));
      });
    } catch {
      resolve(null);
    }
  });
}

/** GPU：优先 nvidia-smi；没有则返回说明文字 */
async function gpuLines(max = 4): Promise<string[]> {
  const out = await runCmd("nvidia-smi", [
    "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu",
    "--format=csv,noheader,nounits",
  ]);
  if (out === null) return ["GPU: 不可用（未找到 nvidia-smi）"];
  const rows = out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (rows.length === 0) return ["GPU: 不可用（nvidia-smi 无输出）"];
  const lines = rows.slice(0, max).map((row) => {
    const [idx, name, util, used, total, temp] = row.split(",").map((s) => s.trim());
    const shortName = (name ?? "")
      .replace(/NVIDIA\s+/i, "")
      .replace(/GeForce\s+/i, "")
      .slice(0, 18);
    const gib = (mb?: string) => (mb && !Number.isNaN(Number(mb)) ? (Number(mb) / 1024).toFixed(1) : "?");
    return `GPU${idx} ${shortName}: ${util ?? "?"}% 显存 ${gib(used)}/${gib(total)}G ${temp ?? "?"}℃`;
  });
  if (rows.length > max) lines.push(`…另有 ${rows.length - max} 块 GPU`);
  return lines;
}

/** 采集结果：若干行，可直接拼进微信消息 */
export async function collectSysInfo(opts: { gpu?: boolean } = {}): Promise<string[]> {
  const lines: string[] = [];

  const cpu = await cpuUsagePercent();
  const cores = os.cpus().length || 0;
  lines.push(cpu === null ? `CPU: ${loadNote()}（${cores} 核）` : `CPU: ${cpu}%（${cores} 核，${loadNote()}）`);

  const totalGb = os.totalmem() / 1024 ** 3;
  const freeGb = os.freemem() / 1024 ** 3;
  const usedGb = totalGb - freeGb;
  lines.push(
    `内存: ${usedGb.toFixed(1)}/${totalGb.toFixed(1)}G（${Math.round((usedGb / totalGb) * 100)}%）`,
  );

  if (opts.gpu !== false) lines.push(...(await gpuLines()));
  return lines;
}
