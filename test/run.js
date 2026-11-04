// 测试启动器：遍历 test/ 下所有 *.test.js，用 node:test 的 programmatic API 跑。
// 不直接写 `node --test <glob>` 是因为 glob 参数支持始于 Node 21，
// 18/20 只接受目录或文件路径；而目录形式在部分 Windows/npm 组合下
// 会退化为 CommonJS 模块解析报 MODULE_NOT_FOUND。显式列举文件最稳。
import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const testFiles = readdirSync(here).filter(f => f.endsWith(".test.js")).map(f => path.join(here, f));

if (testFiles.length === 0) {
  console.error("test/ 下没有找到任何 *.test.js");
  process.exit(1);
}

const nodeBin = process.platform === "win32" ? process.execPath : "node";
const result = spawnSync(nodeBin, ["--test", ...testFiles], {
  stdio: "inherit",
  windowsHide: true,
});
process.exit(result.status ?? 1);
