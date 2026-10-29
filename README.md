# magpie-antigravity-cloak

解决 Antigravity 渠道恒定 429 的 [magpie](https://usemagpie.ai) 网关中间件。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-green)](https://nodejs.org)

## 问题现象

在 magpie 里用 antigravity 供应商的模型（如 `antigravity/gemini-3.7-flash-tiered`）时，Claude Desktop / Claude Code 发出的请求**恒定返回 429**：

```
API Error: Request rejected (429) · Antigravity: Resource has been exhausted (e.g. check quota).
```

换账号、等额度恢复都无效，而标题生成等后台请求和 Codex 请求却正常。

## 根因

Antigravity 上游**按请求文本里的特定指纹字符串拦截**，并统一伪装成 `429 Resource has been exhausted`，实际并不是额度问题。见 [magpie#666](https://github.com/yetone/magpie/issues/666)。

通过抓取真实请求体逐层裁剪回放，实测确认的触发词有两类：

| 触发词 | 来源 | 说明 |
|---|---|---|
| `x-anthropic-billing-header` | Claude Code 塞进 system 的计费标记行 | **关键发现**。curl 手工构造的探测没有这行，所以怎么测都是 200、复现不出来；真实请求必带，所以 100% 触发 |
| `Claude Code` / `Claude Agent SDK` 等 | Claude Code 的系统提示词身份行 | issue #666 确认，与 [cli-proxy-api PR #6280](https://github.com/router-for-me/CLIProxyAPI/pull/6280) 的默认指纹一致 |

这也解释了为什么之前所有"在 system 里混淆 Claude Code 字样"的修复都无效——词表里没有计费头这个词。

## 解决方案

在敏感词第一个字符后插入零宽空格（U+200B）：

```
输入: x-anthropic-billing-header: cc_version=2.1.295;
输出: x-anthropic-billing-header: cc_version=2.1.295;
      ^ "x" 之后有一个肉眼不可见的零宽空格
```

上游的关键字匹配失效，请求正常通过；人眼看不出差别，模型效果基本不受影响。此思路来自 [cli-proxy-api PR #6280](https://github.com/router-for-me/CLIProxyAPI/pull/6280) 与 [opencodex](https://github.com/lidge-jun/opencodex)，本插件在其基础上：

- **首行计费头直接剥离（默认开启）**：自动剥离系统提示词开头的 `x-anthropic-billing-header:` 计费行（独立块整块移除，避免留下空块触发上游校验报错）。既从源头消除 429，又避免其中每轮轮转的 `cch` 参数破坏上游 Prefix Cache（前缀缓存）；非首行引用或关闭剥离时自动由零宽空格混淆兜底
- **全协议系统提示词覆盖**：默认覆盖所有系统提示词位置（`system` / `systemInstruction` / `system_instruction` / `instructions`，chat 协议 `messages` 里 `role` 为 `"system"` 或 `"developer"` 的消息，以及 responses 协议 `input` 数组里 `role` 为 `"system"` 或 `"developer"` 的消息）
- **MCP 工具 Schema 自动修复（默认开启）**：自动为 `tools` 中 `type: "array"` 但缺失 `items` 的参数补全 `items`（以及收敛 Draft-07 元组 `items` 数组），消除第三方 MCP 工具（如 `mitan-mcp`）在 Antigravity 下触发 `400 ... items: missing field` 报错
- 可选 `deep` 模式，把用户消息、工具描述、thinking 块也一起混淆

## 安装

两种方式任选其一：

### 方式一：magpie 插件页面直接装（推荐）

打开 magpie 的 **插件** 页 → 切到 **发现** 标签 → 拉到最底部 **「已有想装的？」** 输入框，填入仓库地址后点 **安装**：

```
https://github.com/hexiaolv/magpie-antigravity-cloak
```

### 方式二：clone 到本地再装

```sh
git clone https://github.com/hexiaolv/magpie-antigravity-cloak.git
cd magpie-antigravity-cloak
npm test   # 可选：先跑一遍单测确认环境正常
magpie plugin add "$(pwd)"
```

本地安装的好处：插件文件每秒热加载，改 `antigravity-cloak.middleware.js` 立即生效，方便自定义词表或调试。

## 配置（可选）

开箱即用，无需手动配置（基于 Magpie v0.1.1283+ 的 `onProvider` 钩子，默认仅针对发往 `antigravity` 账号的请求生效，其他 Provider 请求自动返回 `undefined` 零拷贝直通）。

如需自定义选项，可在 magpie 的 **「插件 → 已安装」** 页面点击本插件右侧的 **「选项（Options）」** 按钮直接编辑 JSON 保存；或通过命令行设置：

```sh
# 方式一（GitHub 仓库安装）：直接用包名
magpie plugin options magpie-antigravity-cloak '{"accounts": ["antigravity"], "extraWords": ["自定义词"], "stripBillingHeader": true, "fixToolSchema": true, "deep": false, "modelFilter": "", "agentFilter": "", "debug": false}'

# 方式二（本地目录安装）：传入完整目录路径
magpie plugin options "$(pwd)" '{"accounts": ["antigravity"], "extraWords": ["自定义词"], "stripBillingHeader": true, "fixToolSchema": true, "deep": false, "modelFilter": "", "agentFilter": "", "debug": false}'
```

| 选项 | 默认 | 说明 |
|---|---|---|
| `accounts` | `["antigravity"]` | 生效的目标渠道账号列表（字符串或数组；默认仅匹配 `antigravity` 账号；可设 `"*"` 对所有账号生效）。天然保障 Routing Group 回退与多渠道共存时非 Antigravity 渠道完全不受污染 |
| `extraWords` | `[]` | 追加自定义敏感词（纯文本，大小写不敏感） |
| `stripBillingHeader` | `true` | 直接剥离系统提示词首行的 `x-anthropic-billing-header:` 计费标记（防 429 且避免 `cch` 轮转导致上游 Prefix Cache 失效）；设为 `false` 时回退为零宽空格混淆 |
| `fixToolSchema` | `true` | 自动补全工具 Schema 中 `type: "array"` 缺失的 `items` 字段及收敛元组 `items` 数组，避免 Antigravity 返回 `400 ... items: missing field` |
| `deep` | `false` | 设为 `true` 时深度混淆整个请求体（用户消息、tools、thinking 也一起），覆盖面更大但更激进，可能影响模型效果 |
| `modelFilter` | `""` | 目标渠道/模型匹配过滤（兼容 `models` 别名；支持子串、通配符如 `"antigravity/*"` 或 `"*"`、正则字符串如 `"/^antigravity/i"`、或字符串数组）。默认为空不额外限制（已有 `accounts` 过滤） |
| `agentFilter` | `""` | 客户端 Agent 过滤（兼容 `agents` 别名；支持字符串、通配符、正则或数组，如 `["claude-desktop", "claude-code"]`），默认为空不限制 |
| `off` | `false` | 设为 `true` 时完全放行，不混淆（也可直接在 magpie 插件列表切换插件开关） |
| `debug` | `false` | 设为 `true` 时在控制台输出目标账号、协议、客户端、计费头剥离数、混淆匹配词、命中次数及耗时日志，方便调试 |
| `cloakChar` | `"\u200B"` | 自定义混淆字符（默认零宽空格 `U+200B`，可选 `U+200C` ZWNJ 等） |

默认词表：`x-anthropic-billing-header`、`Claude Agent SDK`、`Claude Code`、`Anthropic's official CLI`、`system-conventions`、`system_conventions`、`system-directive`、`system_directive`、`RFC 2119`。

插件文件每秒热加载，改完 `antigravity-cloak.middleware.js` 立即生效，无需重启 magpie。

## 验证

```sh
npm test
```

跑 37 组单测（涵盖 onProvider 渠道账号精准隔离、Claude 官方订阅及 API Key 零拷贝直通、Routing Group 故障回退请求纯净性保护、各协议 system / developer / responses.input 形态、首行计费头独立块与内联剥离、深度模式、幂等、还原等价、base64 跳过、正则特殊字符、重叠匹配、modelFilter 与 agentFilter 通配符过滤、Unicode Code Point 安全切分、cloakChar 自定义混淆字符、debug 统计日志等）。

端到端验证（用真实 Claude Code 打 magpie，因为手工 curl 复现不出计费头触发词）：

```sh
ANTHROPIC_BASE_URL=http://localhost:3425 ANTHROPIC_AUTH_TOKEN=<你的 magpie key> \
  claude -p "回复一个字：好" --model antigravity/gemini-3.7-flash-tiered
```

预期输出 `好`，magpie 路由记录（`~/.config/magpie/routing/`）里该请求状态为 200。

## 工作原理

```
Claude Desktop / Claude Code
        │ 真实请求（system 带计费头与身份字样）
        ▼
magpie 网关 (localhost:3425)
        │ 路由分发 (Routing)
        ├── 若尝试 Antigravity 渠道 ──► onProvider(body, ctx) ──► 剥离首行计费头 + 敏感词插 U+200B + 修复 Schema ──► Antigravity 上游 (200 OK)
        └── 若尝试 Claude 官方或回退 ─► onProvider 返回 undefined ──► 原封不动直通 (零拷贝无损) ──────────────────► Claude 官方上游 (200 OK)
```

实现要点：

- **onProvider 路由级精准隔离（Magpie v0.1.1283+）**：通过 Magpie 的 `onProvider` 钩子在每次具体 Provider 尝试（try）时介入，结合 `ctx.provider.account` 精准识别目标。天然支持 Claude Desktop（模型名不带前缀）与多渠道轮询 / 故障回退（Routing Group），仅对发往 Antigravity 的尝试生效，其他 Provider 彻底免受混淆污染
- **Magpie 零拷贝契约对齐**：未命中过滤规则或请求未发生任何修改时返回 `undefined`，使 Magpie 网关 `moejs` 引擎直接复用原始请求 `[]byte` 字节流（零 JSON 重序列化开销，byte-for-byte 无损直通）
- **幂等**：已混淆的词中间多了零宽空格，不再匹配，重复处理结果一致
- **可还原**：去掉零宽空格即还原原文
- **保守跳过**：`signature` 等字段、超长无空格疑似 base64 的字符串不碰
- **大小写不敏感**，按词长从长到短单正则线性扫描，避免短词破坏长词

## 文件结构

```
magpie-antigravity-cloak/
├── antigravity-cloak.middleware.js   # 中间件主体（onProvider 入口）
├── test.mjs                          # 本地单测
├── package.json                      # magpie 插件清单
├── LICENSE
└── README.md
```

## 排查记录（为什么这个 bug 难找）

这个问题的狡猾之处在于**所有手工探测都复现不出来**：

1. curl 构造请求 → 200，一切正常
2. 只混淆 `Claude Code` 等身份字样 → 真实请求依然 429
3. 抓取真实 Claude Code 请求体（95KB）回放 → 429，终于复现
4. 逐层裁剪：去掉 tools → 仍 429；只留 system → 429；二分 system 三块 → 第一块（仅 84 字符的计费标记行）单独触发
5. 在块内继续二分 → `x-anthropic-billing-header:` 是确切的触发字符串
6. 词表加上它 → 完整真实请求回放 200 ✓

教训：**根因探测必须用真实客户端流量**，手工构造的请求少一行计费标记就永远复现不出来。

## 注意

维护者提醒：改写这些字样绕过上游拦截，理论上存在账号被 Google 风控的风险，请自行权衡。

## 致谢

- [yetone/magpie](https://github.com/yetone/magpie) — issue [#666](https://github.com/yetone/magpie/issues/666) 的根因分析、`onProvider` 网关中间件机制与社区官方版实现
- [magpie-community/plugins](https://github.com/magpie-community/plugins/tree/main/packages/antigravity-cloak) — 社区官方插件提供的 `onProvider` 路由级隔离范式
- [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) — [PR #6280](https://github.com/router-for-me/CLIProxyAPI/pull/6280) 的零宽空格混淆思路与计费块剥离实践
- [lidge-jun/opencodex](https://github.com/lidge-jun/opencodex) — 首行计费头剥离保 Prefix Cache 的适配思路

## License

[MIT](LICENSE)
