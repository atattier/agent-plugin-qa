import { test } from "node:test";
import assert from "node:assert/strict";
import { extractLockPackages } from "../src/lockfile.js";

test("pnpm-lock v9：提取 packages 段顶层键", () => {
  const text = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      alpha-core:
        specifier: ^1.2.0
        version: 1.2.5

packages:
  'alpha-core@1.2.5':
    resolution: {integrity: sha512-x}

  '@dsh-ops/bash-win32-x64@0.2.1':
    resolution: {integrity: sha512-y}

  'peerful@1.0.0(peerhost@2.0.0)':
    resolution: {integrity: sha512-z}

snapshots:
  'alpha-core@1.2.5': {}
`;
  const map = extractLockPackages(text);
  assert.deepEqual([...map.keys()].sort(), ["@dsh-ops/bash-win32-x64", "alpha-core", "peerful"]);
  assert.ok(map.get("alpha-core").has("1.2.5"));
  assert.ok(map.get("peerful").has("1.0.0"), "peer 后缀应被剥掉");
  assert.equal(map.has("specifier"), false, "importers 段不应混入");
});

test("package-lock v3：提取 node_modules 顶层键", () => {
  const text = JSON.stringify({
    name: "x",
    lockfileVersion: 3,
    packages: {
      "": { name: "x" },
      "node_modules/alpha-core": { version: "1.2.5" },
      "node_modules/@scope/beta": { version: "2.0.0" },
      "node_modules/alpha-core/node_modules/nested": { version: "0.9.0" },
    },
  });
  const map = extractLockPackages(text);
  assert.deepEqual([...map.keys()].sort(), ["@scope/beta", "alpha-core"]);
  assert.ok(map.get("alpha-core").has("1.2.5"));
});

test("空/坏输入返回空 Map", () => {
  assert.equal(extractLockPackages("").size, 0);
  assert.equal(extractLockPackages("{ not json").size, 0);
});
