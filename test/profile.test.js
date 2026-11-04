import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadProfile, declaredDeps, overrideTargets, listResidue, listInstalled } from "../src/profile.js";

function makeProfile(mutate) {
  const dir = mkdtempSync(path.join(tmpdir(), "apq-"));
  mutate(dir);
  return dir;
}

test("loadProfile 对空目录保持全空而不是抛错", () => {
  const dir = makeProfile(() => {});
  const p = loadProfile(dir);
  assert.equal(p.packageJson, null);
  assert.equal(p.lockfile, null);
  assert.equal(p.installed.size, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("declaredDeps 合并三个依赖段并标记 optional", () => {
  const deps = declaredDeps({
    dependencies: { a: "^1.0.0" },
    devDependencies: { b: "2.0.0" },
    optionalDependencies: { c: "0.2.1" },
  });
  assert.equal(deps.length, 3);
  assert.equal(deps.find(d => d.name === "c").optional, true);
  assert.equal(deps.find(d => d.name === "a").optional, false);
});

test("overrideTargets 收集 package.json 与 workspace 两处 file: 目标", () => {
  const targets = overrideTargets(
    { overrides: { bad: "file:./local/bad" } },
    "overrides:\n  other: file:E:/elsewhere/other\n",
  );
  assert.equal(targets.length, 2);
  assert.ok(targets.some(t => t.value === "file:./local/bad" && t.source === "package.json overrides"));
  assert.ok(targets.some(t => t.value === "file:E:/elsewhere/other"));
});

test("listInstalled 盘点顶层与 scoped 包，跳过内部目录", () => {
  const dir = makeProfile(d => {
    const nm = path.join(d, "node_modules");
    for (const p of ["alpha", "@scope/beta"]) {
      mkdirSync(path.join(nm, ...p.split("/")), { recursive: true });
      writeFileSync(path.join(nm, ...p.split("/"), "package.json"), JSON.stringify({ name: p, version: "1.0.0" }));
    }
    mkdirSync(path.join(nm, ".pnpm"), { recursive: true });
    mkdirSync(path.join(nm, ".ignored", "junk"), { recursive: true });
  });
  const installed = listInstalled(dir);
  assert.deepEqual([...installed.keys()].sort(), ["@scope/beta", "alpha"]);
  rmSync(dir, { recursive: true, force: true });
});

test("listResidue 找出 *.bak-* 与 node_modules 内备份", () => {
  const dir = makeProfile(d => {
    writeFileSync(path.join(d, "package.json.bak-20261105"), "x");
    const nm = path.join(d, "node_modules");
    mkdirSync(nm, { recursive: true });
    writeFileSync(path.join(nm, "alpha.bak-old"), "x");
  });
  const residue = listResidue(dir);
  assert.deepEqual(residue.top, ["package.json.bak-20261105"]);
  assert.deepEqual(residue.inNodeModules, ["alpha.bak-old"]);
  rmSync(dir, { recursive: true, force: true });
});
