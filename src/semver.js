/**
 * 极简 semver：只覆盖依赖声明里最常见的形态（精确版本、^ ~ 范围、x-range、|| 组合、
 * 基础比较符、dist-tag）。明确不支持的形态返回 valid:false，
 * 调用方据此降级为「跳过网络探测」而不是误报——宁可少查，不可错判。
 */

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const KNOWN_TAGS = new Set(["latest", "next", "*"]);

export function parseVersion(v) {
  const m = VERSION_RE.exec(String(v).trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null };
}

export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return NaN;
  for (const key of ["major", "minor", "patch"]) {
    if (pa[key] !== pb[key]) return pa[key] - pb[key];
  }
  // 无 prerelease 视为高于有 prerelease
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  if (pa.pre && pb.pre) return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0;
  return 0;
}

/** 精确锁版本（BUG-02 场景：optionalDependencies 精确锁平台包） */
export function isExactPin(range) {
  return VERSION_RE.test(String(range).trim());
}

/**
 * 声明是否可解析。dist-tag（latest/next/*）与所有可识别的范围返回 true；
 * 空串、纯空白、明显畸形的声明返回 false。
 */
export function isValidRange(range) {
  const s = String(range).trim();
  if (!s) return false;
  if (KNOWN_TAGS.has(s)) return true;
  return s.split("||").some(alt => {
    const toks = alt.trim().split(/\s+/);
    // hyphen range: "1.2.3 - 2.0.0"
    if (toks.length === 3 && toks[1] === "-") {
      return VERSION_RE.test(toks[0]) && VERSION_RE.test(toks[2]);
    }
    return toks.every(tok => isSimpleRange(tok));
  });
}

function isSimpleRange(tok) {
  if (!tok) return false;
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(tok);
  if (!m) return false;
  const op = m[1] ?? "";
  const body = m[2].trim();
  if (VERSION_RE.test(body)) return true;
  // x-range：1.x / 1.2.x / 1.2 / *
  if (/^\d+(\.(x|\d+)){0,2}$/.test(body) || body === "*") return true;
  // hyphen range：1.2.3 - 2.0.0（已被外层按空格拆开，这里处理不到属预期）
  return false;
}

const OPS = {
  ">=": (c) => c >= 0,
  "<=": (c) => c <= 0,
  ">": (c) => c > 0,
  "<": (c) => c < 0,
  "=": (c) => c === 0,
};

function satisfiesSimple(version, tok) {
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(tok.trim());
  if (!m) return false;
  const op = m[1] ?? "";
  const body = m[2].trim();
  const pv = parseVersion(version);
  if (!pv) return false;
  if (body === "*") return true;

  if (op === "^" || op === "~") {
    const pb = parseVersion(body);
    if (!pb) return false;
    const c = compareVersions(version, body);
    if (c < 0) return false;
    // ^: 不越主版本；~: 不越次版本（主版本相同时）
    const upperMajor = pb.major;
    const upperMinor = op === "^" ? Infinity : pb.minor;
    return pv.major === upperMajor && (upperMinor === Infinity || pv.minor <= upperMinor) && pv.pre === null;
  }
  if (op) {
    const c = compareVersions(version, body);
    return Number.isNaN(c) ? false : OPS[op](c);
  }
  // 无操作符：精确版本或 x-range
  if (VERSION_RE.test(body)) return compareVersions(version, body) === 0;
  const xr = /^(\d+)(?:\.(\d+|x))?(?:\.(x|\d+))?$/.exec(body);
  if (xr) {
    if (pv.major !== +xr[1]) return false;
    if (xr[2] && xr[2] !== "x" && pv.minor !== +xr[2]) return false;
    if (xr[3] && xr[3] !== "x" && pv.patch !== +xr[3]) return false;
    return true;
  }
  return false;
}

/** 范围是否命中版本；dist-tag 由调用方单独处理（latest → maxSatisfying 全量） */
export function satisfies(version, range) {
  const s = String(range).trim();
  if (KNOWN_TAGS.has(s)) return true;
  return s.split("||").some(alt => {
    const toks = alt.trim().split(/\s+/);
    // hyphen range: "1.2.3 - 2.0.0"
    if (toks.length === 3 && toks[1] === "-") {
      return compareVersions(version, toks[0]) >= 0 && compareVersions(version, toks[2]) <= 0;
    }
    return toks.every(tok => satisfiesSimple(version, tok));
  });
}

/** 版本列表里命中范围的最大者；无命中返回 null */
export function maxSatisfying(versions, range) {
  const hit = versions.filter(v => satisfies(v, range));
  if (hit.length === 0) return null;
  return hit.sort((a, b) => compareVersions(b, a))[0];
}
