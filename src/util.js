import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";

const execFileAsync = promisify(execFile);

/**
 * Windows 下 PATH 中的命令可能是 .exe / .cmd / 无扩展名脚本，
 * execFile 的 CreateProcess 语义只认 .exe，裸 spawn 会 ENOENT；
 * .cmd/.bat 必须经 cmd.exe /c 中转（Node 对直接 spawn .cmd 会 EINVAL）。
 * 用 where.exe 按 PATHEXT 解析出真实可执行文件再调用。
 */
async function resolveWindowsCommand(cmd) {
  try {
    const { stdout } = await execFileAsync("where.exe", [cmd], { timeout: 5000, windowsHide: true });
    const candidates = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const exec = candidates.find(p => p.toLowerCase().endsWith(".exe"));
    if (exec) return { path: exec, viaCmd: false };
    const cmdScript = candidates.find(p => p.toLowerCase().endsWith(".cmd") || p.toLowerCase().endsWith(".bat"));
    if (cmdScript) return { path: cmdScript, viaCmd: true };
    return null;
  } catch {
    return null;
  }
}

/**
 * 带超时与容错的命令执行。命令不存在/超时都返回结构化失败而不是抛错，
 * 因为被测环境本身就是"可能坏"的——QA 工具不能先于被测对象倒下。
 */
export async function runCmd(cmd, args, { timeoutMs = 10000, cwd } = {}) {
  try {
    let file = cmd;
    let cmdArgs = args;
    if (process.platform === "win32" && !existsSync(cmd)) {
      const resolved = await resolveWindowsCommand(cmd);
      if (!resolved) return { ok: false, code: "ENOENT", stdout: "", stderr: "", message: `spawn ${cmd} ENOENT（PATH 中无可执行形态）` };
      if (resolved.viaCmd) {
        file = "cmd.exe";
        cmdArgs = ["/d", "/s", "/c", resolved.path, ...args];
      } else {
        file = resolved.path;
      }
    }
    const { stdout, stderr } = await execFileAsync(file, cmdArgs, {
      timeout: timeoutMs,
      cwd,
      windowsHide: true,
      shell: false,
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    return { ok: false, code: err.code, stdout: err.stdout || "", stderr: err.stderr || "", message: err.message };
  }
}

export async function fetchWithTimeout(url, { timeoutMs = 8000, method = "GET" } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, method });
    return { ok: true, status: res.status, body: await res.text() };
  } catch (err) {
    return { ok: false, message: err.message, aborted: err.name === "AbortError" };
  } finally {
    clearTimeout(timer);
  }
}

export function parseNpmrc(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    result[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return result;
}
