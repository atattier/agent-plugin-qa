import { fetchWithTimeout, runCmd } from "./util.js";

export const OFFICIAL_REGISTRY = "https://registry.npmjs.org/";

/**
 * 取当前生效 registry：带 cwd 才能读到 profile 目录下的 .npmrc。
 * 读不到时回退官方源（并让调用方知道这是猜测）。
 */
export async function getCurrentRegistry(cwd, timeoutMs = 6000) {
  const r = await runCmd("npm", ["config", "get", "registry"], { timeoutMs, cwd });
  if (r.ok && r.stdout.trim().startsWith("http")) return r.stdout.trim();
  return null;
}

/**
 * 拉取 packument 并提取版本列表。fetchImpl 可注入（测试用）。
 * 返回 { reachable, aborted, message, status, versions }。
 */
export async function fetchPackument(registryBase, name, { timeoutMs = 8000, fetchImpl = fetchWithTimeout } = {}) {
  const url = registryBase.replace(/\/$/, "") + "/" + name;
  const r = await fetchImpl(url, { timeoutMs, method: "GET" });
  if (!r.ok) {
    return { reachable: false, aborted: Boolean(r.aborted), message: r.message ?? "", status: null, versions: [] };
  }
  let versions = [];
  try {
    const j = JSON.parse(r.body);
    versions = Object.keys(j.versions ?? {});
  } catch {
    // 404 等响应体不是 packument
  }
  return { reachable: r.status >= 200 && r.status < 300 && versions.length > 0, aborted: false, message: "", status: r.status, versions };
}
