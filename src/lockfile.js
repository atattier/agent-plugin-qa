/**
 * lockfile 提取：只提取「顶层包名 → 版本集合」这一件事。
 * 支持 pnpm-lock.yaml v9（文本行解析，只认 packages: 段 2 空格缩进的
 * 'name@version': 键）与 package-lock.json v2/v3（JSON，node_modules/<name> 键）。
 * 不做完整 YAML 解析——零依赖是刻意的，宁可提取得保守，也不引一棵 YAML 树。
 */

export function extractLockPackages(lockText) {
  const map = new Map(); // name -> Set<version>
  const add = (name, version) => {
    if (!name || !version) return;
    if (!map.has(name)) map.set(name, new Set());
    map.get(name).add(version);
  };

  const trimmed = String(lockText);
  if (trimmed.startsWith("{")) {
    extractPackageLock(trimmed, add);
  } else {
    extractPnpmLock(trimmed, add);
  }
  return map;
}

function extractPackageLock(text, add) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return;
  }
  const packages = json.packages ?? {};
  for (const [key, entry] of Object.entries(packages)) {
    if (!key.startsWith("node_modules/")) continue;
    const name = key.slice("node_modules/".length);
    if (!name || name.includes("node_modules/")) continue; // 嵌套依赖不算顶层
    add(name, entry?.version);
  }
}

function extractPnpmLock(text, add) {
  const lines = text.split(/\r?\n/);
  let inPackages = false;
  // pnpm v9: packages: 段下的键为 2 空格缩进的 'name@version':
  const keyRe = /^\s{2}'?([^'"\s]+?)@([^'"\s]+?)'?\s*:\s*$/;
  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    if (/^\S/.test(line)) { inPackages = false; continue; } // 回到顶层级段
    // packages 段结束后会遇到 snapshots: 等同级段（键无缩进），上面已切断。
    const m = keyRe.exec(line);
    if (!m) continue;
    // 去掉 peer 后缀 foo@1.0.0(bar@2.0.0)
    const version = m[2].replace(/\(.*\)$/, "");
    add(m[1], version);
  }
}
