import path from "node:path";
import fs from "node:fs";
import { declaredDeps, overrideTargets, parseProfileNpmrc } from "./profile.js";
import { getCurrentRegistry, fetchPackument, OFFICIAL_REGISTRY } from "./registry.js";
import { fetchWithTimeout } from "./util.js";
import { isValidRange, isExactPin, maxSatisfying } from "./semver.js";

// 探测上限：真实 profile 依赖可能几十上百条，逐条 packument 请求要有闸门。
const MAX_PROBES = 60;

export const checks = [
  {
    id: "manifest-bundles-consistency",
    title: "清单与 bundles 一致性",
    async run(ctx) {
      const pkg = ctx.profile.packageJson;
      const bundles = pkg?.dsh?.profile?.bundles;
      if (!Array.isArray(bundles)) {
        return { level: "skip", detail: "package.json 无 dsh.profile.bundles 段，非目标形态的 profile，跳过" };
      }
      const depNames = new Set(declaredDeps(pkg).map(d => d.name));
      const bundleNames = new Set(bundles);
      // 真实案例：从 dependencies 与 bundles 两处「只删一处」仍会加载失败（404 修复记录）。
      // 但 @deepseek-ai/* 等宿主内置命名空间的包由宿主层提供、本就不写进 dependencies，
      // 只对用户插件命名空间的单边登记判 fail，内置包降级为提示。
      const isBuiltin = name => name.startsWith("@deepseek-ai/");
      const unregistered = bundles.filter(b => !depNames.has(b));
      const unregisteredUser = unregistered.filter(b => !isBuiltin(b));
      const unregisteredBuiltin = unregistered.filter(isBuiltin);
      const unloaded = [...depNames].filter(n => !bundleNames.has(n));
      if (unregisteredUser.length > 0) {
        return {
          level: "fail",
          detail: `bundles 登记了 ${unregisteredUser.length} 个未声明依赖的用户插件：${unregisteredUser.join(", ")}`,
          advice: "登记在 bundles 但 dependencies 缺失 → 更新/校验流程会加载失败。两处必须同步增删",
        };
      }
      if (unregisteredBuiltin.length > 0 || unloaded.length > 0) {
        const parts = [];
        if (unregisteredBuiltin.length) parts.push(`${unregisteredBuiltin.length} 个宿主内置包在 bundles（正常形态）：${unregisteredBuiltin.slice(0, 3).join(", ")}${unregisteredBuiltin.length > 3 ? " …" : ""}`);
        if (unloaded.length) parts.push(`${unloaded.length} 个已声明依赖未登记进 bundles：${unloaded.join(", ")}`);
        return { level: "pass", detail: parts.join("；") };
      }
      if (unloaded.length > 0) {
        return {
          level: "warn",
          detail: `${unloaded.length} 个已声明依赖未登记进 bundles：${unloaded.join(", ")}`,
          advice: "装了但不加载。若是有意为之（如仅作为传递依赖补位）可忽略，否则补登记",
        };
      }
      return { level: "pass", detail: `${bundleNames.size} 个 bundles 与依赖声明一一对应` };
    },
  },
  {
    id: "override-targets",
    title: "override 指向可达性",
    async run(ctx) {
      const targets = overrideTargets(ctx.profile.packageJson, ctx.profile.workspaceYaml);
      if (targets.length === 0) {
        return { level: "pass", detail: "无 file: 形态的 override" };
      }
      const missing = [];
      for (const t of targets) {
        const p = t.value.slice("file:".length);
        const abs = path.resolve(ctx.profile.dir, p);
        if (!fs.existsSync(abs)) missing.push(`${t.value}（来自 ${t.source}）`);
      }
      if (missing.length > 0) {
        return {
          level: "fail",
          detail: `${missing.length} 个 override 指向不存在的本地路径：${missing.join("；")}`,
          advice: "真实案例：坏依赖靠 file: override 重定向才恢复安装（E 盘目录不可达时全部安装失败）。目标路径失效会让依赖解析重新回到 404",
        };
      }
      return { level: "pass", detail: `${targets.length} 个 file: override 指向均存在` };
    },
  },
  {
    id: "lockfile-covers-deps",
    title: "lockfile 覆盖依赖声明",
    async run(ctx) {
      const deps = declaredDeps(ctx.profile.packageJson);
      if (deps.length === 0) {
        return { level: "skip", detail: "无 package.json 或无依赖声明，跳过" };
      }
      const lock = ctx.profile.lockfile;
      if (!lock) {
        return { level: "warn", detail: "没有任何 lockfile（pnpm-lock.yaml / package-lock.json）", advice: "提交 lockfile：缺它则每次安装都重新解析，镜像缺口类的偶发失败会重演" };
      }
      const missing = deps.filter(d => !lock.packages.has(d.name)).map(d => d.name);
      if (missing.length > 0) {
        return {
          level: "fail",
          detail: `${lock.kind}-lockfile 缺少 ${missing.length} 个已声明依赖的记录：${missing.slice(0, 5).join(", ")}`,
          advice: "lockfile 与清单脱节 → 每次安装重新解析（真实案例：lockfile 缺 @dsh-ops 记录导致撞镜像缺口）。跑一次安装让 lockfile 补齐",
        };
      }
      return { level: "pass", detail: `${lock.kind}-lockfile 覆盖全部 ${deps.length} 个已声明依赖` };
    },
  },
  {
    id: "node-modules-vs-lockfile",
    title: "node_modules 与 lockfile 对账",
    async run(ctx) {
      const lock = ctx.profile.lockfile;
      if (!lock) return { level: "skip", detail: "无 lockfile，跳过对账" };
      const installed = ctx.profile.installed;
      if (installed.size === 0) return { level: "skip", detail: "node_modules 不存在或为空，跳过" };
      const declared = new Set(declaredDeps(ctx.profile.packageJson).map(d => d.name));

      const orphans = [...installed.keys()].filter(n => !lock.packages.has(n));
      const missing = [...lock.packages.keys()].filter(n => declared.has(n) && !installed.has(n));
      const drifted = [...installed.entries()]
        .filter(([n, v]) => lock.packages.has(n) && !lock.packages.get(n).has(v))
        .map(([n, v]) => `${n}@${v}`);

      if (missing.length > 0) {
        return {
          level: "fail",
          detail: `lockfile 声明但未安装：${missing.slice(0, 5).join(", ")}`,
          advice: "半安装状态（装到一半失败/手工删过）。重新执行安装",
        };
      }
      if (drifted.length > 0) {
        return {
          level: "warn",
          detail: `node_modules 版本与 lockfile 记录不一致：${drifted.slice(0, 5).join("；")}`,
          advice: "常见于更新覆盖后 lockfile 未同步（缺陷单 BUG-05 的土壤）。重跑安装让二者对齐",
        };
      }
      if (orphans.length > 0) {
        return {
          level: "warn",
          detail: `${orphans.length} 个 lockfile 之外的安装残留（卸载未清干净）：${orphans.slice(0, 5).join(", ")}`,
          advice: "对应 TC-10 卸载残留场景。确认无用后删除，或重装插件让记录闭合",
        };
      }
      return { level: "pass", detail: `${installed.size} 个顶层安装包与 lockfile 完全对账` };
    },
  },
  {
    id: "residue-inventory",
    title: "备份残留盘点",
    async run(ctx) {
      const { top, inNodeModules } = ctx.profile.residue;
      if (inNodeModules.length > 0) {
        return {
          level: "fail",
          detail: `node_modules 内发现 ${inNodeModules.length} 个备份形态文件/目录：${inNodeModules.slice(0, 5).join(", ")}`,
          advice: "包管理器的自愈与去重会被这些内容干扰，备份不要放在 node_modules 里（移到 profile 顶层或仓库外）",
        };
      }
      if (top.length > 0) {
        return {
          level: "pass",
          detail: `profile 顶层有 ${top.length} 个 *.bak-* 备份（${top.slice(0, 3).join(", ")}${top.length > 3 ? " …" : ""}）。属回滚机制的一部分，注意定期归档`,
        };
      }
      return { level: "pass", detail: "无备份残留" };
    },
  },
  {
    id: "npmrc-sanity",
    title: ".npmrc 体格检查",
    async run(ctx) {
      const parsed = parseProfileNpmrc(ctx.profile);
      if (!parsed) {
        return { level: "pass", detail: "profile 无 .npmrc（全部走默认源与用户级配置）" };
      }
      const raw = ctx.profile.npmrc.split(/\r?\n/);
      const malformed = raw.filter(l => {
        const t = l.trim();
        return t && !t.startsWith("#") && !t.startsWith(";") && !t.includes("=");
      });
      const scopes = Object.keys(parsed).filter(k => k.endsWith(":registry"));
      if (malformed.length > 0) {
        return {
          level: "warn",
          detail: `${malformed.length} 行缺少等号，npm 会静默忽略：${malformed.slice(0, 3).join(" | ")}`,
          advice: "静默失效的配置行比没有配置更危险——它让人以为配置过了",
        };
      }
      const desc = [
        Object.keys(parsed).length + " 个配置项",
        scopes.length ? `scope 源覆盖：${scopes.join(", ")}` : "无 scope 源覆盖",
      ].join("，");
      return { level: "pass", detail: desc };
    },
  },
  {
    id: "version-resolution",
    title: "依赖版本可解析性（逐源探测）",
    async run(ctx) {
      if (ctx.offline) return { level: "skip", detail: "离线模式（--offline），跳过版本探测" };
      const deps = declaredDeps(ctx.profile.packageJson);
      const overridable = new Set(Object.keys(ctx.profile.packageJson?.overrides ?? {}));
      const probeable = deps.filter(d =>
        !d.spec.startsWith("github:") && !d.spec.startsWith("link:") &&
        !d.spec.startsWith("file:") && !d.spec.startsWith("workspace:") &&
        !overridable.has(d.name),
      );
      const skippedCount = deps.length - probeable.length;

      const current = ctx.currentRegistry ??= await getCurrentRegistry(ctx.profile.dir, ctx.timeoutMs);
      const registries = [];
      if (current) registries.push(current);
      if (!registries.includes(OFFICIAL_REGISTRY)) registries.push(OFFICIAL_REGISTRY);

      const findings = [];
      let probed = 0;
      let networkFailures = 0;
      for (const dep of probeable) {
        if (probed >= MAX_PROBES) break;
        probed++;
        if (!isValidRange(dep.spec)) {
          findings.push({ name: dep.name, spec: dep.spec, cls: "INVALID_SPEC", optional: dep.optional });
          continue;
        }
        const primary = await fetchPackument(registries[0], dep.name, { timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl });
        if (!primary.reachable && primary.aborted) { networkFailures++; continue; }
        if (!primary.reachable && primary.status !== 404 && primary.status !== 200) { networkFailures++; continue; }

        const hit = maxSatisfying(primary.versions, dep.spec);
        if (hit) {
          findings.push({ name: dep.name, spec: dep.spec, cls: "OK", optional: dep.optional, resolved: hit });
          continue;
        }
        // 主源无命中：如果主源是镜像，问一下官方源，区分「镜像滞后」与「哪里都没有」
        if (registries.length > 1) {
          const official = await fetchPackument(OFFICIAL_REGISTRY, dep.name, { timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl });
          if (official.reachable && maxSatisfying(official.versions, dep.spec)) {
            findings.push({ name: dep.name, spec: dep.spec, cls: "MIRROR_LAG", optional: dep.optional });
            continue;
          }
        }
        findings.push({ name: dep.name, spec: dep.spec, cls: "MISSING", optional: dep.optional });
      }

      const mirrorLag = findings.filter(f => f.cls === "MIRROR_LAG");
      const missing = findings.filter(f => f.cls === "MISSING");
      const invalid = findings.filter(f => f.cls === "INVALID_SPEC");
      // BUG-02 的定性：optional + 精确锁 + 镜像滞后 → pnpm 硬失败，不是警告级
      const hardMirror = mirrorLag.filter(f => f.optional && isExactPin(f.spec));
      const softMirror = mirrorLag.filter(f => !(f.optional && isExactPin(f.spec)));
      const hardMissing = missing.filter(f => !f.optional);
      const softMissing = missing.filter(f => f.optional);

      if (probed === 0 && skippedCount === 0) {
        return { level: "skip", detail: "没有可探测的依赖" };
      }
      if (networkFailures > 0 && probed === networkFailures) {
        return {
          level: "warn",
          detail: `${networkFailures} 个依赖探测全部超时/失败——无法区分「网络不通」与「版本不存在」（缺陷单 BUG-04 的土壤）`,
          advice: "先确认网络与代理，再用 agent-plugin-qa why <pkg>@<spec> 单独诊断单个包",
        };
      }
      if (hardMirror.length > 0 || hardMissing.length > 0 || invalid.length > 0) {
        const parts = [
          hardMirror.length && `镜像滞后且为 optional 精确锁（pnpm 会硬失败）：${fmt(hardMirror)}`,
          hardMissing.length && `任何源都解析不到：${fmt(hardMissing)}`,
          invalid.length && `声明畸形：${fmt(invalid)}`,
        ].filter(Boolean).join("；");
        return {
          level: "fail",
          detail: parts,
          advice: "镜像滞后 → 给该 scope 单独配官方源（.npmrc 写 @scope:registry=…）；坏条目 → 修正版本或用 override 重定向（真实案例：dsh-review-loop 0.1.0 → 本地目录）",
        };
      }
      const notes = [];
      if (softMirror.length) notes.push(`镜像滞后（可降级/非关键）：${fmt(softMirror)}`);
      if (softMissing.length) notes.push(`optional 依赖缺失（pnpm 会跳过）：${fmt(softMissing)}`);
      if (networkFailures > 0) notes.push(`${networkFailures} 个探测网络失败`);
      if (skippedCount > 0) notes.push(`${skippedCount} 个非 registry 声明（github:/file:/override）未探测`);
      if (probed >= MAX_PROBES) notes.push(`依赖超过 ${MAX_PROBES} 条，超出部分未探测`);
      if (notes.length > 0) {
        return { level: "warn", detail: notes.join("；") };
      }
      return { level: "pass", detail: `${probed} 个依赖在当前源全部可解析` };
    },
  },
  {
    id: "source-reachability",
    title: "分源连通性（npm / GitHub 分别报告）",
    async run(ctx) {
      if (ctx.offline) return { level: "skip", detail: "离线模式（--offline），跳过连通性检查" };
      const deps = declaredDeps(ctx.profile.packageJson);
      const sources = [];
      const current = ctx.currentRegistry ??= await getCurrentRegistry(ctx.profile.dir, ctx.timeoutMs);
      const registryUrl = current ?? OFFICIAL_REGISTRY;
      sources.push({ name: `npm registry ${registryUrl}`, kind: "registry", url: registryUrl.replace(/\/$/, "") + "/npm" });
      if (current && !/registry\.npmjs\.org/.test(current)) {
        sources.push({ name: "npm 官方源 registry.npmjs.org", kind: "registry", url: OFFICIAL_REGISTRY + "npm" });
      }
      // 只有真的存在 github: 依赖才探测 github.com（TC-08）
      const hasGithubDep = deps.some(d => d.spec.startsWith("github:"));
      if (hasGithubDep) {
        sources.push({ name: "github.com（存在 github: 形态依赖）", kind: "github", url: "https://github.com/" });
      }

      // 逐源探测、逐源报告——反例是 BUG-04：「任一环节失败」被聚合报成「所有源都无法连接」
      const doFetch = ctx.fetchImpl ?? fetchWithTimeout;
      const results = await Promise.all(sources.map(async s => {
        const r = await doFetch(s.url, { timeoutMs: ctx.timeoutMs, method: "HEAD" });
        return { source: s, reachable: r.ok && r.status >= 200 && r.status < 400, aborted: Boolean(r.aborted), status: r.status };
      }));

      const down = results.filter(r => !r.reachable);
      const detail = results.map(r => `${r.source.name} → ${r.reachable ? "可达" : r.aborted ? "超时" : `失败(HTTP ${r.status ?? "?"})`}`).join("；");
      if (down.length === 0) {
        return { level: "pass", detail };
      }
      return {
        level: "warn",
        detail,
        advice: down.some(r => r.source.kind === "github")
          ? "GitHub 超时常见根因：代理进程没起（先看端口是否监听）或环境变量没传给该进程——与 npm 源的状态分开判断，别被「全部连不上」的聚合文案带偏（缺陷单 BUG-04）"
          : "registry 不可达：先查代理与网络，再查 .npmrc 源地址拼写",
      };
    },
  },
  {
    id: "patch-assertions",
    title: "补丁断言（qa.asserts）",
    async run(ctx) {
      const dir = ctx.assertsDir ?? path.join(ctx.profile.dir, "qa.asserts");
      let files;
      try {
        files = fs.readdirSync(dir).filter(f => f.endsWith(".mjs")).sort();
      } catch {
        return { level: "skip", detail: `无断言目录 ${dir}（对 node_modules 做过本地定制的 profile 强烈建议建立，见 README）` };
      }
      if (files.length === 0) {
        return { level: "skip", detail: "断言目录存在但没有 *.mjs" };
      }
      const results = [];
      for (const f of files) {
        const file = path.join(dir, f);
        try {
          const mod = await import("file://" + file.replace(/\\/g, "/"));
          if (typeof mod.default !== "function") {
            results.push({ name: f, pass: false, detail: "必须 default 导出 async 函数" });
            continue;
          }
          const r = await mod.default({ profileDir: ctx.profile.dir });
          results.push({ name: r?.name ?? f, pass: Boolean(r?.pass), detail: String(r?.detail ?? "") });
        } catch (err) {
          results.push({ name: f, pass: false, detail: `断言执行异常：${err.message}` });
        }
      }
      const failed = results.filter(r => !r.pass);
      if (failed.length > 0) {
        return {
          level: "fail",
          detail: `${failed.length}/${results.length} 条断言未通过：${failed.map(r => `${r.name}（${r.detail}）`).join("；")}`,
          advice: "对应缺陷单 BUG-05：更新会静默覆盖 node_modules 的本地定制，断言失败即补丁失效，按 detail 定位",
        };
      }
      return { level: "pass", detail: `${results.length} 条补丁断言全部通过` };
    },
  },
];

function fmt(list) {
  return list.map(f => `${f.name}@${f.spec}`).join(", ");
}
