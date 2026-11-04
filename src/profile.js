import fs from "node:fs";
import path from "node:path";
import { parseNpmrc } from "./util.js";
import { extractLockPackages } from "./lockfile.js";

const OFFICIAL_REGISTRY = "https://registry.npmjs.org/";

/**
 * 装载被测 profile 的全部事实。每个字段都可以缺——被测环境本来就是"可能不完整"的，
 * 缺什么由检查器自行决定 skip / warn / fail。
 */
export function loadProfile(dir) {
  const profile = { dir: path.resolve(dir) };
  profile.packageJson = readJson(profile.dir, "package.json");
  profile.workspaceYaml = readText(profile.dir, "pnpm-workspace.yaml");
  profile.npmrc = readText(profile.dir, ".npmrc");
  profile.lockfile = readLockfile(profile.dir);
  profile.installed = listInstalled(profile.dir);
  profile.residue = listResidue(profile.dir);
  profile.currentRegistry = null; // 由检查器按需探测（要起子进程）
  return profile;
}

export function declaredDeps(packageJson) {
  if (!packageJson) return [];
  const merged = new Map();
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, spec] of Object.entries(packageJson[section] ?? {})) {
      merged.set(name, { name, spec, optional: section === "optionalDependencies" });
    }
  }
  return [...merged.values()];
}

export function overrideTargets(packageJson, workspaceYaml) {
  const targets = [];
  for (const spec of Object.values(packageJson?.overrides ?? {})) {
    if (typeof spec === "string" && spec.startsWith("file:")) {
      targets.push({ source: "package.json overrides", value: spec });
    }
  }
  if (workspaceYaml) {
    let inOverrides = false;
    for (const line of workspaceYaml.split(/\r?\n/)) {
      if (/^overrides:\s*$/.test(line)) { inOverrides = true; continue; }
      if (inOverrides && /^\S/.test(line)) inOverrides = false;
      if (inOverrides) {
        const m = /:\s*(file:.+?)\s*$/.exec(line);
        if (m) targets.push({ source: "pnpm-workspace.yaml overrides", value: m[1] });
      }
    }
  }
  return targets;
}

export function parseProfileNpmrc(profile) {
  if (!profile.npmrc) return null;
  return parseNpmrc(profile.npmrc);
}

function readJson(dir, file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  } catch {
    return null;
  }
}

function readText(dir, file) {
  try {
    return fs.readFileSync(path.join(dir, file), "utf8");
  } catch {
    return null;
  }
}

function readLockfile(dir) {
  const pnpm = readText(dir, "pnpm-lock.yaml");
  if (pnpm) return { kind: "pnpm", packages: extractLockPackages(pnpm) };
  const npm = readText(dir, "package-lock.json");
  if (npm) return { kind: "npm", packages: extractLockPackages(npm) };
  return null;
}

/** node_modules 顶层盘点：name -> version（跳过 .pnpm/.bin/.ignored 等内部目录） */
export function listInstalled(profileDir) {
  const root = path.join(profileDir, "node_modules");
  const map = new Map();
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (!e.isDirectory()) continue;
    if (e.name.startsWith("@")) {
      let scoped;
      try {
        scoped = fs.readdirSync(path.join(root, e.name), { withFileTypes: true });
      } catch { continue; }
      for (const s of scoped) {
        if (!s.isDirectory() || s.name.startsWith(".")) continue;
        const version = pkgVersion(root, e.name, s.name);
        if (version) map.set(`${e.name}/${s.name}`, version);
      }
    } else {
      const version = pkgVersion(root, e.name);
      if (version) map.set(e.name, version);
    }
  }
  return map;
}

function pkgVersion(root, ...parts) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, ...parts, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/** 残留盘点：profile 顶层的 *.bak-* 与 node_modules 内的一切备份形态 */
export function listResidue(profileDir) {
  const top = [];
  try {
    for (const e of fs.readdirSync(profileDir, { withFileTypes: true })) {
      if (!e.isDirectory() && /\.bak-/.test(e.name)) top.push(e.name);
    }
  } catch { /* 目录不可读时留空 */ }

  const inNodeModules = [];
  const nmRoot = path.join(profileDir, "node_modules");
  try {
    for (const e of fs.readdirSync(nmRoot, { withFileTypes: true })) {
      if (/\.bak-/.test(e.name) || e.name === ".ignored") {
        inNodeModules.push(e.name);
        continue;
      }
      if (e.isDirectory() && !e.name.startsWith("@") && !e.name.startsWith(".")) {
        try {
          for (const s of fs.readdirSync(path.join(nmRoot, e.name))) {
            if (/\.bak-/.test(s)) inNodeModules.push(`${e.name}/${s}`);
          }
        } catch { /* 跳过不可读目录 */ }
      }
    }
  } catch { /* 无 node_modules 属正常 */ }

  return { top, inNodeModules };
}
