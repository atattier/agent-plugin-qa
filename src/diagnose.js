import { fetchPackument, getCurrentRegistry, OFFICIAL_REGISTRY } from "./registry.js";
import { isValidRange, maxSatisfying } from "./semver.js";

/**
 * 单包诊断：agent-plugin-qa why <pkg>@<spec>
 * 落地缺陷单 BUG-01 的建议——版本解析失败时，明确给出「已查询的源与各源可用版本」。
 */
export async function diagnoseVersion(spec, {
  registry,
  timeoutMs = 8000,
  cwd,
  fetchImpl,
} = {}) {
  const at = spec.lastIndexOf("@");
  if (at <= 0) {
    return { ok: false, error: "无法解析 <pkg>@<spec> 形态（scoped 包写 @scope/pkg@1.0.0）" };
  }
  const name = spec.slice(0, at);
  const wanted = spec.slice(at + 1);

  if (!isValidRange(wanted)) {
    return {
      ok: true,
      name,
      wanted,
      classification: "INVALID_SPEC",
      advice: "版本声明无法解析，检查拼写（对照 semver 形态：1.2.3 / ^1.2.0 / ~1.2 / 1.x / latest）",
      sources: [],
    };
  }

  const sources = [];
  const current = registry ?? await getCurrentRegistry(cwd, timeoutMs) ?? OFFICIAL_REGISTRY;
  sources.push(current);
  if (!sources.includes(OFFICIAL_REGISTRY)) sources.push(OFFICIAL_REGISTRY);

  const probed = [];
  for (const base of sources) {
    const r = await fetchPackument(base, name, { timeoutMs, fetchImpl });
    probed.push({
      registry: base,
      reachable: r.reachable,
      aborted: r.aborted,
      status: r.status,
      message: r.message,
      versionCount: r.versions.length,
      hit: r.reachable ? maxSatisfying(r.versions, wanted) : null,
    });
  }

  const anyUnreachable = probed.some(p => !p.reachable && p.aborted);
  const hitSomewhere = probed.some(p => p.hit);
  const official = probed.find(p => p.registry === OFFICIAL_REGISTRY);
  const mirror = probed.find(p => p.registry !== OFFICIAL_REGISTRY);

  let classification;
  let advice;
  if (anyUnreachable) {
    classification = "NETWORK_UNREACHABLE";
    advice = "至少一个源连接超时：这是网络问题，不是版本问题。先查代理进程与端口，再回来查版本";
  } else if (hitSomewhere) {
    if (mirror && !mirror.hit && official?.hit) {
      classification = "MIRROR_LAG";
      advice = `官方源有该版本、镜像未同步。临时方案：.npmrc 为该 scope 单独指官方源（@scope:registry=${OFFICIAL_REGISTRY}）`;
    } else {
      classification = "OK";
      advice = `在 ${probed.find(p => p.hit)?.registry} 可解析`;
    }
  } else {
    classification = "MISSING_EVERYWHERE";
    advice = "所有可达源都没有命中该声明：版本号写错、或坏条目（真实案例：不存在的 0.1.0 让所有安装失败）。用上方版本列表对照可用版本";
  }

  return {
    ok: true,
    name,
    wanted,
    classification,
    advice,
    sources: probed.map(p => ({
      registry: p.registry,
      reachable: p.reachable,
      versionCount: p.versionCount,
      hit: p.hit,
      status: p.status,
    })),
  };
}
