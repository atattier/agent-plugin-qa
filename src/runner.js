import { checks } from "./cases.js";
import { loadProfile } from "./profile.js";

function toIdSet(value) {
  return new Set(String(value ?? "").split(",").map(s => s.trim()).filter(Boolean));
}

/** 按 --only / --skip 过滤；unknown 是传入了但不存在的 id，CLI 拿去报错用 */
export function selectChecks({ only, skip } = {}) {
  const knownIds = new Set(checks.map(c => c.id));
  if (only != null && String(only).trim() !== "") {
    const wanted = toIdSet(only);
    return { list: checks.filter(c => wanted.has(c.id)), unknown: [...wanted].filter(id => !knownIds.has(id)) };
  }
  if (skip != null && String(skip).trim() !== "") {
    const unwanted = toIdSet(skip);
    return { list: checks.filter(c => !unwanted.has(c.id)), unknown: [...unwanted].filter(id => !knownIds.has(id)) };
  }
  return { list: checks, unknown: [] };
}

export async function runAllChecks({
  dir = process.cwd(),
  timeoutMs = 8000,
  offline = false,
  only,
  skip,
  fetchImpl,
  assertsDir,
} = {}) {
  const ctx = { dir, timeoutMs, offline, profile: loadProfile(dir), fetchImpl, assertsDir };
  const { list, unknown } = selectChecks({ only, skip });
  const startedAt = Date.now();
  // 各检查互相独立，大头是等网络 / 子进程：并行跑、按声明顺序排版
  const settled = await Promise.allSettled(list.map(c => c.run(ctx)));
  const results = settled.map((r, i) => {
    if (r.status === "fulfilled") return { id: list[i].id, title: list[i].title, ...r.value };
    const reason = r.reason?.message ?? String(r.reason);
    return {
      id: list[i].id,
      title: list[i].title,
      level: "fail",
      detail: `检查器内部异常：${reason}`,
      advice: "这通常是 agent-plugin-qa 自身的 bug，欢迎提 issue",
    };
  });
  const summary = {
    pass: results.filter(r => r.level === "pass").length,
    warn: results.filter(r => r.level === "warn").length,
    fail: results.filter(r => r.level === "fail").length,
    skip: results.filter(r => r.level === "skip").length,
  };
  return {
    results,
    summary,
    meta: {
      dir: ctx.profile.dir,
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      offline,
      durationMs: Date.now() - startedAt,
    },
  };
}
