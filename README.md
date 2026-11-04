# agent-plugin-qa

桌面 AI Agent 客户端「插件安装 / 更新 / 卸载」管线的 QA 套件：把一次真实测试过程沉淀的 12 条用例与 5 个缺陷，工程化为可重复执行的断言与诊断工具。零运行时依赖，Node 18+。

> 设计来源：所有检查项与建议文案都对应真实缺陷单。QA 工具自己不能成为新的故障源——命令缺失、网络超时一律返回结构化结果，绝不抛异常中断整轮体检。

## 它解决什么

插件管理管线的风险集中在**依赖解析**与**网络分层**两处，而现场故障最常见的形态是「报错文案掩盖真实原因」：

- 报「所有安装源都无法连接」，实际只有 github.com 超时（BUG-04）
- 报「版本不存在」，用户却去查代理，实际是镜像未同步（BUG-01/BUG-02）
- 一条坏依赖让**所有**插件安装失败，报错却完全不点名（BUG-03）
- 更新静默覆盖 node_modules 的本地定制，无提示无日志（BUG-05）

`agent-plugin-qa` 把这些问题变成两类能力：**体检**（check，对一个 profile 全量盘点）与**诊断**（why，对单个包逐源解析）。

## 安装 / 运行

```bash
node bin/agent-plugin-qa.js check --dir <profile 目录>
node bin/agent-plugin-qa.js why @scope/some-pkg@0.2.1
```

被测 profile 的形态：一个含 `package.json`（可含 `dsh.profile.bundles`）、lockfile（pnpm-lock.yaml 或 package-lock.json）、`node_modules/` 的目录——典型的桌面 Agent 插件根目录。

## 子命令

### check

```bash
agent-plugin-qa check --dir ~/.my-agent/profile [选项]

  --offline         跳过网络类检查（版本探测、分源连通性）
  --asserts-dir <p> 补丁断言目录，默认 <dir>/qa.asserts
  --only/--skip     按检查项 id 过滤（--list 查看全部）
  --json / --report <file>   JSON 输出 / 报告落盘
```

退出码：`0` 通过/警告，`1` 存在 fail，`2` 用法错误。

### why

```bash
agent-plugin-qa why @dsh-ops/bash-win32-x64@0.2.1
```

逐源列出可用版本并给出归类结论（`可解析` / `镜像滞后` / `各源均无此版本` / `网络不可达` / `声明畸形`），直接落地 BUG-01 的建议：「版本解析失败时附加已查询的源与各源可用版本」。

## 检查项与缺陷单/用例的映射

| 检查项 | 对应 |
|---|---|
| 清单与 bundles 一致性 | 404 修复案例「两处只删一处仍会加载失败」；宿主内置包（`@deepseek-ai/*`）的单边登记属正常形态，只对用户插件判 fail |
| override 指向可达性 | BUG-03 临时方案的回滚风险（file: 目录失效 → 重新 404） |
| lockfile 覆盖依赖声明 | 真实案例：lockfile 缺记录 → 每次安装重新解析撞镜像缺口 |
| node_modules 与 lockfile 对账 | TC-10 卸载残留（warn）、TC-11 一致性、BUG-05 的土壤（版本漂移） |
| 备份残留盘点 | TC-02 幂等残留；node_modules 内的备份判 fail（干扰包管理器自愈） |
| .npmrc 体格检查 | 缺等号的配置行被 npm 静默忽略——比没配置更危险 |
| 依赖版本可解析性 | BUG-02（optional + 精确锁 + 镜像滞后 → pnpm 硬失败）、BUG-03（坏条目点名）、TC-03/04 |
| 分源连通性 | BUG-04 的反例实现：npm 源与 github.com **分别**报告，存在 `github:` 依赖才探测 GitHub（TC-06/07/08） |
| 补丁断言 | BUG-05 的应对机制泛化：更新后重跑断言即可判定补丁在位或失效 |

## 补丁断言契约

对 node_modules 做过本地定制的 profile，建一个 `qa.asserts/` 目录，每个 `*.mjs` default 导出一个断言函数：

```js
// qa.asserts/truncate-patch.mjs
export default async function (ctx) {
  // ctx = { profileDir }
  // 推荐做法：从「已部署 bundle」里抽取真实函数再运行，
  // 测的是部署代码文本，不是抄写副本。
  return { name: "截断补丁在位", pass: true, detail: "keep=3 时窗口回退到 user 轮" };
}
```

每次插件更新后重跑 `check`，断言失败即补丁失效——这是 BUG-05 静默覆盖问题的可执行答案。

## 设计原则

- **零依赖**：只用 Node 内置模块；lockfile 解析是保守的定向提取，不做完整 YAML 解析。
- **宁少查不误报**：无法可靠判断的形态（不认识的版本声明、无 bundles 段）一律 skip 并说明，绝不硬凑结论。
- **可注入**：网络探测的 `fetchImpl` 可替换，全部诊断归类都有不联网的单元测试。
- **逐源报告**：绝不把「任一环节失败」聚合报成「全部失败」。

## 开发

```bash
npm test    # 28 项单元/夹具测试，含真实命令与注入式网络用例
```

CI 覆盖 Ubuntu / Windows × Node 20 / 22 / 24，并对仓库内夹具 profile（`test/fixtures/sample-profile`）做离线 CLI 冒烟。

## License

[MIT](LICENSE)
