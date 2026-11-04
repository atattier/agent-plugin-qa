import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnoseVersion } from "../src/diagnose.js";
import { renderDiagnoseTerminal } from "../src/report.js";

const packument = versions => JSON.stringify({ versions: Object.fromEntries(versions.map(v => [v, {}])) });

function fakeFetch(responses) {
  // responses: Map<url, {status, body}>；未命中 url 视为超时
  return async (url) => {
    const hit = responses.get(url);
    if (!hit) return { ok: false, message: "abort", aborted: true };
    return { ok: true, status: hit.status ?? 200, body: hit.body ?? "" };
  };
}

test("镜像滞后：官方有、镜像没有 → MIRROR_LAG", async () => {
  const d = await diagnoseVersion("pkg@1.2.0", {
    registry: "https://registry.npmmirror.com/",
    fetchImpl: fakeFetch(new Map([
      ["https://registry.npmmirror.com/pkg", { status: 200, body: packument(["0.0.0-stage"]) }],
      ["https://registry.npmjs.org/pkg", { status: 200, body: packument(["0.0.0-stage", "1.2.0"]) }],
    ])),
  });
  assert.equal(d.classification, "MIRROR_LAG");
  assert.ok(d.advice.includes("@scope:registry"));
});

test("哪里都没有 → MISSING_EVERYWHERE", async () => {
  const d = await diagnoseVersion("pkg@0.1.0", {
    registry: "https://registry.npmmirror.com/",
    fetchImpl: fakeFetch(new Map([
      ["https://registry.npmmirror.com/pkg", { status: 404, body: "Not Found" }],
      ["https://registry.npmjs.org/pkg", { status: 404, body: "Not Found" }],
    ])),
  });
  assert.equal(d.classification, "MISSING_EVERYWHERE");
});

test("网络超时优先归类为网络问题而不是版本问题（BUG-04 反例）", async () => {
  const d = await diagnoseVersion("pkg@^1.0.0", {
    registry: "https://registry.npmmirror.com/",
    fetchImpl: fakeFetch(new Map()), // 全部超时
  });
  assert.equal(d.classification, "NETWORK_UNREACHABLE");
  assert.ok(d.advice.includes("网络"));
});

test("范围内无命中但同包有其他版本 → MISSING_EVERYWHERE 且带版本列表", async () => {
  const d = await diagnoseVersion("pkg@9.9.9", {
    registry: "https://registry.npmjs.org/",
    fetchImpl: fakeFetch(new Map([
      ["https://registry.npmjs.org/pkg", { status: 200, body: packument(["1.0.0", "1.2.0"]) }],
    ])),
  });
  assert.equal(d.classification, "MISSING_EVERYWHERE");
  const s = d.sources.find(x => x.registry === "https://registry.npmjs.org/");
  assert.equal(s.versionCount, 2);
  assert.equal(s.hit, null);
});

test("畸形 spec 不发网络请求直接判 INVALID_SPEC", async () => {
  let called = 0;
  const d = await diagnoseVersion("pkg@  ", {
    fetchImpl: async () => { called++; return { ok: true, status: 200, body: "{}" }; },
  });
  assert.equal(d.classification, "INVALID_SPEC");
  assert.equal(called, 0);
});

test("无法解析的入参返回 ok:false", async () => {
  const d = await diagnoseVersion("no-at-sign-here", {});
  assert.equal(d.ok, false);
});

test("终端渲染包含源与结论", async () => {
  const d = await diagnoseVersion("pkg@1.2.0", {
    registry: "https://registry.npmmirror.com/",
    fetchImpl: fakeFetch(new Map([
      ["https://registry.npmmirror.com/pkg", { status: 200, body: packument(["1.2.0"]) }],
      ["https://registry.npmjs.org/pkg", { status: 200, body: packument(["1.2.0"]) }],
    ])),
  });
  const text = renderDiagnoseTerminal(d);
  assert.ok(text.includes("registry.npmmirror.com"));
  assert.ok(text.includes("命中 1.2.0"));
  assert.ok(text.includes("可解析"));
});
