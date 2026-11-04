import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVersion, compareVersions, isExactPin, isValidRange, satisfies, maxSatisfying } from "../src/semver.js";

test("parseVersion 基本形态", () => {
  assert.deepEqual(parseVersion("1.2.3"), { major: 1, minor: 2, patch: 3, pre: null });
  assert.equal(parseVersion("v1.2.3").major, 1);
  assert.equal(parseVersion("1.2.3-beta.1").pre, "beta.1");
  assert.equal(parseVersion("1.2"), null);
  assert.equal(parseVersion("abc"), null);
});

test("compareVersions 排序与 prerelease", () => {
  assert.ok(compareVersions("1.2.3", "1.2.4") < 0);
  assert.ok(compareVersions("2.0.0", "1.9.9") > 0);
  assert.ok(compareVersions("1.0.0", "1.0.0-rc.1") > 0);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
});

test("isExactPin 识别精确锁版本", () => {
  assert.equal(isExactPin("0.2.1"), true);
  assert.equal(isExactPin("^1.2.3"), false);
  assert.equal(isExactPin("latest"), false);
});

test("isValidRange 常见形态", () => {
  assert.equal(isValidRange("^1.8.24"), true);
  assert.equal(isValidRange("~2.0.1"), true);
  assert.equal(isValidRange("3.27.2"), true);
  assert.equal(isValidRange("1.x"), true);
  assert.equal(isValidRange("*"), true);
  assert.equal(isValidRange("latest"), true);
  assert.equal(isValidRange("^1.2.0 || ^2.0.0"), true);
  assert.equal(isValidRange("1.2.3 - 2.0.0"), true);
  assert.equal(isValidRange(""), false);
  assert.equal(isValidRange("   "), false);
});

test("satisfies 命中判断", () => {
  assert.equal(satisfies("1.8.24", "^1.8.24"), true);
  assert.equal(satisfies("1.9.0", "^1.8.24"), true);
  assert.equal(satisfies("2.0.0", "^1.8.24"), false);
  assert.equal(satisfies("2.0.1", "2.0.1"), true);
  assert.equal(satisfies("2.0.2", "2.0.1"), false);
  assert.equal(satisfies("1.4.0", "1.x"), true);
  assert.equal(satisfies("2.4.0", "1.x"), false);
  assert.equal(satisfies("1.2.9", "~1.2.3"), true);
  assert.equal(satisfies("1.3.0", "~1.2.3"), false);
  assert.equal(satisfies("1.5.0", "^1.2.0 || ^2.0.0"), true);
  assert.equal(satisfies("3.0.0", "^1.2.0 || ^2.0.0"), false);
  assert.equal(satisfies("1.5.0", "1.2.3 - 2.0.0"), true);
  assert.equal(satisfies("2.1.0", "1.2.3 - 2.0.0"), false);
  assert.equal(satisfies("0.0.1", "*"), true);
  assert.equal(satisfies("9.9.9", "latest"), true);
  // prerelease 不命中普通范围（npm 语义）
  assert.equal(satisfies("1.9.0-beta.1", "^1.8.24"), false);
});

test("maxSatisfying 取最大命中", () => {
  const versions = ["1.8.24", "1.9.0", "1.10.1", "2.0.0"];
  assert.equal(maxSatisfying(versions, "^1.8.0"), "1.10.1");
  assert.equal(maxSatisfying(versions, "2.0.0"), "2.0.0");
  assert.equal(maxSatisfying(versions, "^2.1.0"), null);
});
