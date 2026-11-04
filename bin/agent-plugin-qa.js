#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { runAllChecks, selectChecks } from "../src/runner.js";
import { checks } from "../src/cases.js";
import { diagnoseVersion } from "../src/diagnose.js";
import { renderTerminalReport, renderJsonReport, renderDiagnoseTerminal } from "../src/report.js";

const args = process.argv.slice(2);
const sub = args[0] && !args[0].startsWith("-") ? args[0] : "check";
const rest = sub === "check" || sub === "why" ? args.slice(1) : args;

function readFlagValue(name) {
  const idx = rest.indexOf(name);
  if (idx < 0) return null;
  const value = rest[idx + 1];
  if (!value || value.startsWith("--")) {
    console.error(`${name} 需要一个值`);
    process.exit(2);
  }
  return value;
}

const versionOf = () => JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

if (rest.includes("--version") || rest.includes("-v")) {
  console.log(versionOf());
  process.exit(0);
}

if (rest.includes("--list")) {
  for (const c of checks) console.log(`${c.id.padEnd(30)} ${c.title}`);
  process.exit(0);
}

if (rest.includes("--help") || rest.includes("-h") || sub === "help") {
  console.log(`agent-plugin-qa — 桌面 AI Agent 客户端插件管线 QA

用法:
  agent-plugin-qa check [选项]            对一个 profile 目录做全量体检（默认子命令）
  agent-plugin-qa why <pkg>@<spec> [选项]  单包版本解析诊断（逐源列出可用版本与结论）
  agent-plugin-qa --list                  列出全部检查项 id 与标题

check 选项:
  --dir <path>      被测 profile 目录（含 package.json / lockfile / node_modules），默认当前目录
  --offline         离线模式：跳过网络类检查（版本探测、分源连通性）
  --asserts-dir <p> 补丁断言目录，默认 <dir>/qa.asserts
  --only <ids>      只跑指定检查项（逗号分隔）
  --skip <ids>      跳过指定检查项
  --timeout <sec>   网络类检查超时秒数，默认 8
  --json            以 JSON 输出
  --report <file>   把 JSON 报告写入文件

why 选项:
  --registry <url>  指定主源（默认取 npm config，回退官方源）
  --timeout <sec>   默认 8
  --json            以 JSON 输出

退出码: 0 通过/警告，1 存在 fail 项，2 用法错误`);
  process.exit(0);
}

if (sub === "why") {
  // 位置参数 = rest 里排除「--flag 自身」和「--flag 的值」之后剩下的第一个
  const VALUE_FLAGS = new Set(["--registry", "--timeout"]);
  let spec = null;
  for (let i = 0; i < rest.length; i++) {
    if (VALUE_FLAGS.has(rest[i])) { i++; continue; }
    if (rest[i].startsWith("-")) continue;
    spec = rest[i];
    break;
  }
  if (!spec) {
    console.error("用法: agent-plugin-qa why <pkg>@<spec>");
    process.exit(2);
  }
  const timeoutValue = readFlagValue("--timeout");
  const d = await diagnoseVersion(spec, {
    registry: readFlagValue("--registry"),
    timeoutMs: timeoutValue ? Number(timeoutValue) * 1000 : 8000,
    cwd: process.cwd(),
  });
  if (rest.includes("--json")) {
    console.log(JSON.stringify(d, null, 2));
  } else {
    console.log(renderDiagnoseTerminal(d));
  }
  process.exit(d.ok && (d.classification === "OK") ? 0 : d.ok ? 1 : 2);
}

if (sub !== "check") {
  console.error(`未知子命令：${sub}（可用：check / why / --list）`);
  process.exit(2);
}

const only = readFlagValue("--only");
const skip = readFlagValue("--skip");
const { unknown } = selectChecks({ only, skip });
if (unknown.length > 0) {
  console.error(`未知的检查项 id：${unknown.join(", ")}（用 --list 查看全部）`);
  process.exit(2);
}

const dir = readFlagValue("--dir") ?? process.cwd();
const timeoutValue = readFlagValue("--timeout");
if (timeoutValue && (!Number.isFinite(Number(timeoutValue)) || Number(timeoutValue) <= 0)) {
  console.error("--timeout 需要一个正数（秒）");
  process.exit(2);
}
const reportFile = readFlagValue("--report");
const assertsDir = readFlagValue("--asserts-dir");

const report = await runAllChecks({
  dir,
  timeoutMs: timeoutValue ? Number(timeoutValue) * 1000 : 8000,
  offline: rest.includes("--offline"),
  only,
  skip,
  assertsDir,
});

if (reportFile) {
  try {
    writeFileSync(reportFile, renderJsonReport(report) + "\n", "utf8");
  } catch (err) {
    console.error(`无法写入报告文件 ${reportFile}：${err.message}`);
    process.exit(2);
  }
}

if (rest.includes("--json")) {
  console.log(renderJsonReport(report));
} else {
  console.log(renderTerminalReport(report));
}

process.exit(report.summary.fail > 0 ? 1 : 0);
