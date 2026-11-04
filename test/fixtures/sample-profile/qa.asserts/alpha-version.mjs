// 示例断言：验证 fixture 里 alpha-core 的 package.json 版本与 lockfile 声明一致。
// 真实环境的断言写法参见 README「补丁断言」一节（从已部署 bundle 抽取真实函数再运行，
// 测的是部署代码文本，不是抄写副本）。
export default async function assertAlphaVersion(ctx) {
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const pkgPath = path.join(ctx.profileDir, "node_modules", "alpha-core", "package.json");
  const installed = JSON.parse(readFileSync(pkgPath, "utf8"));
  const ok = installed.version === "1.2.5";
  return {
    name: "alpha-core 安装版本与 lockfile 一致",
    pass: ok,
    detail: ok ? "1.2.5" : `实际为 ${installed.version}`,
  };
}
