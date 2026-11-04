import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAllChecks } from "../src/runner.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "sample-profile");

function makeProfile(mutate) {
  const dir = mkdtempSync(path.join(tmpdir(), "apqc-"));
  mutate(dir);
  return dir;
}

function writeProfileBase(dir, { deps = {}, bundles = null } = {}) {
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "t",
    dependencies: deps,
    ...(bundles ? { dsh: { profile: { bundles } } } : {}),
  }));
}

test("fixture profile（离线）：全部检查可运行且无 fail", async () => {
  const report = await runAllChecks({ dir: FIXTURE, offline: true });
  const total = Object.values(report.summary).reduce((a, b) => a + b, 0);
  assert.equal(total, report.results.length);
  assert.equal(report.summary.fail, 0, `fixture 应无 fail：\n${report.results.filter(r => r.level === "fail").map(r => `${r.id}: ${r.detail}`).join("\n")}`);
  // 网络类两项应被离线跳过
  for (const id of ["version-resolution", "source-reachability"]) {
    assert.equal(report.results.find(r => r.id === id).level, "skip");
  }
  // 断言目录存在且有断言 → 应 pass
  assert.equal(report.results.find(r => r.id === "patch-assertions").level, "pass");
});

test("bundles 与 dependencies 不一致：单边删除被点名", async () => {
  const dir = makeProfile(d => {
    writeProfileBase(d, { deps: { "alpha-core": "^1.0.0" }, bundles: ["alpha-core", "ghost-plugin"] });
    mkdirSync(path.join(d, "node_modules"), { recursive: true });
  });
  const report = await runAllChecks({ dir, offline: true });
  const r = report.results.find(x => x.id === "manifest-bundles-consistency");
  assert.equal(r.level, "fail");
  assert.ok(r.detail.includes("ghost-plugin"));
  rmSync(dir, { recursive: true, force: true });
});

test("file: override 指向不存在路径：fail", async () => {
  const dir = makeProfile(d => {
    writeFileSync(path.join(d, "package.json"), JSON.stringify({
      name: "t",
      dependencies: { bad: "0.1.0" },
      overrides: { bad: "file:./no-such-dir" },
    }));
  });
  const report = await runAllChecks({ dir, offline: true });
  const r = report.results.find(x => x.id === "override-targets");
  assert.equal(r.level, "fail");
  assert.ok(r.detail.includes("file:./no-such-dir"));
  rmSync(dir, { recursive: true, force: true });
});

test("lockfile 缺条目：fail 点名缺失依赖", async () => {
  const dir = makeProfile(d => {
    writeProfileBase(d, { deps: { alpha: "^1.0.0", beta: "^2.0.0" } });
    writeFileSync(path.join(d, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n\npackages:\n  'alpha@1.0.0':\n    resolution: {integrity: sha512-x}\n");
    mkdirSync(path.join(d, "node_modules"), { recursive: true });
    mkdirSync(path.join(d, "node_modules", "alpha"), { recursive: true });
    writeFileSync(path.join(d, "node_modules", "alpha", "package.json"), JSON.stringify({ name: "alpha", version: "1.0.0" }));
  });
  const report = await runAllChecks({ dir, offline: true });
  const r = report.results.find(x => x.id === "lockfile-covers-deps");
  assert.equal(r.level, "fail");
  assert.ok(r.detail.includes("beta"));
  rmSync(dir, { recursive: true, force: true });
});

test("node_modules 里的孤儿包（卸载残留）：warn；node_modules 内备份：fail", async () => {
  const dir = makeProfile(d => {
    writeProfileBase(d, { deps: { alpha: "^1.0.0" } });
    writeFileSync(path.join(d, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n\npackages:\n  'alpha@1.0.0':\n    resolution: {integrity: sha512-x}\n");
    const nm = path.join(d, "node_modules");
    mkdirSync(path.join(nm, "alpha"), { recursive: true });
    writeFileSync(path.join(nm, "alpha", "package.json"), JSON.stringify({ name: "alpha", version: "1.0.0" }));
    mkdirSync(path.join(nm, "orphan-old"), { recursive: true });
    writeFileSync(path.join(nm, "orphan-old", "package.json"), JSON.stringify({ name: "orphan-old", version: "9.9.9" }));
    writeFileSync(path.join(nm, "alpha.bak-x"), "bak inside node_modules");
  });
  const report = await runAllChecks({ dir, offline: true });
  assert.equal(report.results.find(x => x.id === "node-modules-vs-lockfile").level, "warn");
  assert.equal(report.results.find(x => x.id === "residue-inventory").level, "fail", "node_modules 内备份必须是 fail");
  rmSync(dir, { recursive: true, force: true });
});

test("补丁断言失败：fail 且点名断言", async () => {
  const dir = makeProfile(d => {
    writeProfileBase(d, { deps: {} });
    const qa = path.join(d, "qa.asserts");
    mkdirSync(qa, { recursive: true });
    writeFileSync(path.join(qa, "always-fails.mjs"), "export default async () => ({ name: '补丁在位', pass: false, detail: '函数被覆盖还原' })");
  });
  const report = await runAllChecks({ dir, offline: true });
  const r = report.results.find(x => x.id === "patch-assertions");
  assert.equal(r.level, "fail");
  assert.ok(r.detail.includes("补丁在位"));
  rmSync(dir, { recursive: true, force: true });
});

test("only/skip 过滤与未知 id 报告", async () => {
  const { selectChecks } = await import("../src/runner.js");
  const all = selectChecks({}).list.length;
  assert.ok(all >= 9, `应有至少 9 个检查器，实际 ${all}`);
  const only = selectChecks({ only: "override-targets,no-such" });
  assert.deepEqual(only.list.map(c => c.id), ["override-targets"]);
  assert.deepEqual(only.unknown, ["no-such"]);
  const skip = selectChecks({ skip: "override-targets" });
  assert.equal(skip.list.length, all - 1);
});
