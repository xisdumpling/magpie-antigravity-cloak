// antigravity-cloak：Antigravity 429 问题中间件
//
// 根因（实测定位，比 issue #666 的结论更进一步）：
//   Antigravity 上游按请求文本里的特定指纹字符串拦截，并统一伪装成
//   "429 Resource has been exhausted"，实际并不是额度用完了。
//   实测确认的触发词有两类：
//   1. 计费头标记：Claude Code 会往 system 里塞一行
//      "x-anthropic-billing-header" 开头的计费信息（含 cc_version 等），
//      上游按这个字符串拦截。curl 手工构造的探测没有这行，
//      这是之前修复一直失败、排查一直"复现不出来"的原因。
//   2. 身份字样："Claude Code" / "Claude Agent SDK" 等
//      （issue #666 确认，cli-proxy-api PR #6280 的默认指纹）。
//
// 做法（参考 cli-proxy-api PR #6280 与 opencodex）：
//   1. 默认直接剥离系统提示词开头的 x-anthropic-billing-header 计费行（独立块整块移除），
//      既从源头消除 429，又避免每轮变化的 cch 参数破坏上游 Prefix Cache（前缀缓存）。
//   2. 在敏感词第一个字符后插入零宽空格（U+200B）。人眼看不出差别，模型基本不受影响，
//      但上游的关键字匹配即刻失效。
//   3. 自动补全工具定义（tools）中 type: "array" 缺失的 items 字段及元组 items 数组，
//      消除 Antigravity 因 MCP 工具 Schema 不完整返回的 400 (items: missing field) 报错。
//   4. 默认只处理系统提示词（system / systemInstruction / system_instruction / instructions，
//      以及 chat 协议 messages 与 responses 协议 input 中 role 为 system / developer 的消息）；
//      deep 选项会深度混淆整个请求体（用户消息、tools、thinking 也一起）。
//
// 安装：
//   magpie plugin add https://github.com/hexiaolv/magpie-antigravity-cloak
//   或本地目录：magpie plugin add /path/to/magpie-antigravity-cloak
//
// 可选配置（可在 Magpie「插件 → 已安装 → 选项」中编辑，或通过 CLI 设置）：
//   {
//     "extraWords": ["自定义敏感词"],
//     "stripBillingHeader": true,   // 直接剥离首行 x-anthropic-billing-header（防 429 且避免 cch 轮转破坏 Prefix Cache）
//     "fixToolSchema": true,        // 自动补全工具 Schema 中 array 缺失的 items 字段（防 400 items: missing field）
//     "deep": false,                // 深度混淆整个请求体（用户消息、tools、thinking 也一起）
//     "modelFilter": "antigravity", // 仅对匹配的模型启用（兼容 models 别名；支持子串、通配符、/正则/、数组；设 "" 或 "*" 不过滤）
//     "agentFilter": "",            // 仅对匹配的客户端 Agent 启用（兼容 agents 别名，如 "claude-desktop"、"claude-code"）
//     "off": false,                 // 设为 true 时完全放行
//     "debug": false,               // 输出命中词与耗时日志
//     "cloakChar": "\u200B"         // 自定义混淆字符（默认零宽空格 U+200B）
//   }
//
// Magpie 网关中间件规范对齐：
//   - 未命中过滤规则或请求未发生任何修改时返回 undefined，使 Magpie 网关直接复用原始 []byte（零序列化开销、byte-for-byte 无损直通）
//   - 即使未在 GUI 保存过 Options（ctx.options 为 {}），对带 "<provider>/" 前缀的非 antigravity 渠道请求也默认自动放行

// 默认零宽空格（U+200B），写成转义形式避免源码中出现不可见字符
const DEFAULT_CLOAK_CHAR = "\u200B"
const DEFAULT_MODEL_FILTER = "antigravity"

// 匹配系统提示词首行的 Claude Code 计费头（x-anthropic-billing-header: ...）
// 该行携带每轮变化的 cch 参数，直接剥离既可消除 429 触发源，又能防止上游 Prefix Cache 失效
const BILLING_HEADER_LEADING_RE = /^\s*x-anthropic-billing-header:[^\r\n]*(?:\r?\n)*/i

// 常见零宽/不可见字符集合（用于 buildNeedles 自动过滤，防止用户误贴造成脏匹配）
const INVISIBLE_CHARS = new Set([
  "\u200B", // Zero Width Space
  "\u200C", // Zero Width Non-Joiner
  "\u200D", // Zero Width Joiner
  "\u2060", // Word Joiner
  "\uFEFF", // Zero Width No-Break Space / BOM
])

// 默认敏感词，全部纯 ASCII。不要把零宽字符写进词表，会被 buildNeedles 过滤掉。
// 大小写不敏感。
const DEFAULT_WORDS = [
  "x-anthropic-billing-header",
  "Claude Agent SDK",
  "Claude Code",
  "Anthropic's official CLI",
  "system-conventions",
  "system_conventions",
  "system-directive",
  "system_directive",
  "RFC 2119",
]

// 正则表达式编译缓存，避免每次请求重复执行词表清洗、排序与正则构建
const regexCache = new Map()
const filterRegexCache = new Map()
const MAX_CACHE_SIZE = 256

function buildNeedles(extra, cloakChar = DEFAULT_CLOAK_CHAR) {
  const words = DEFAULT_WORDS.concat(Array.isArray(extra) ? extra : [])
  // 清理首尾空白，去掉已含混淆字符或不可见字符的词（如用户误贴混淆文本），去重，按长度从长到短，
  // 避免短词先匹配破坏长词
  const seen = new Set()
  const out = []
  for (const w of words) {
    if (!w || typeof w !== "string") continue
    const trimmed = w.trim()
    if (trimmed.length < 2) continue
    let hasInvisible = false
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i]
      if (ch === cloakChar || INVISIBLE_CHARS.has(ch)) {
        hasInvisible = true
        break
      }
    }
    if (hasInvisible) continue
    const k = trimmed.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(k)
  }
  out.sort((a, b) => b.length - a.length)
  return out
}

// 词表是纯文本不是正则，先转义特殊字符
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// 获取单条合并正则（连同 buildNeedles 一起缓存，常规请求 O(1) 直接命中）
function getCompiledRegex(extraWords, cloakChar = DEFAULT_CLOAK_CHAR) {
  const extraKey = Array.isArray(extraWords) && extraWords.length > 0
    ? JSON.stringify(extraWords)
    : ""
  const cacheKey = `${cloakChar}\0${extraKey}`
  if (regexCache.has(cacheKey)) {
    return regexCache.get(cacheKey)
  }

  const needles = buildNeedles(extraWords, cloakChar)
  let re = null
  if (needles.length > 0) {
    // 将所有敏感词合并为单条正则，单次线性扫描，天然保证长词优先命中
    const pattern = needles.map(escapeRegExp).join("|")
    re = new RegExp(pattern, "gi")
  }
  if (regexCache.size >= MAX_CACHE_SIZE) regexCache.clear()
  regexCache.set(cacheKey, re)
  return re
}

// 剥离字符串开头的 x-anthropic-billing-header 计费行（锚定开头，O(1) 判定）
function stripLeadingBillingHeader(text, state) {
  if (typeof text !== "string" || text.length === 0) return text
  const stripped = text.replace(BILLING_HEADER_LEADING_RE, "")
  if (stripped !== text && state) {
    state.changed = true
    state.strippedBilling++
  }
  return stripped
}

// 在 text 的每个敏感词第一个字符后插混淆字符。
// 使用单正则整体匹配，已混淆的词中间多了混淆字符，不再匹配，天然幂等。
function cloakText(text, regex, cloakChar, state) {
  if (typeof text !== "string" || text.length < 2 || !regex) return text
  return text.replace(regex, (m) => {
    if (state) {
      state.changed = true
      state.count++
      if (state.matches) state.matches.add(m.toLowerCase())
    }
    // Unicode Code Point 安全切分，防止 Emoji 或双字节字符代理对被截断
    const firstChar = String.fromCodePoint(m.codePointAt(0))
    return firstChar + cloakChar + m.slice(firstChar.length)
  })
}

// 递归遍历 JSON 值：对每个字符串混淆，并原地写回。
// 疑似 base64 / data URL 的超长无空格串不碰；签名、ID、协议枚举等元数据字段不碰。
const SKIP_KEYS = new Set([
  "signature",
  "thoughtSignature",
  "thought_signature",
  "encrypted_content",
  "id",
  "call_id",
  "tool_use_id",
  "tool_call_id",
  "session",
  "sessionId",
  "requestId",
  "prompt_cache_key",
  "previous_response_id",
  "model",
  "role",
  "type",
  "media_type",
  "mimeType",
  "mime_type",
])

function cloakDeep(value, regex, cloakChar, state) {
  if (value == null) return value
  const t = typeof value
  if (t === "string") {
    if (value.length > 4096 && !value.includes(" ")) return value
    return cloakText(value, regex, cloakChar, state)
  }
  if (t !== "object") return value
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = cloakDeep(value[i], regex, cloakChar, state)
    return value
  }
  const keys = Object.keys(value)
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]
    if (SKIP_KEYS.has(k)) continue
    value[k] = cloakDeep(value[k], regex, cloakChar, state)
  }
  return value
}

// 判断 chat / responses 协议下作为系统指令的消息（magpie 同时将 system 和 developer 合并进 r.System）
function isSystemRole(msg) {
  return (
    msg &&
    typeof msg === "object" &&
    !Array.isArray(msg) &&
    (msg.role === "system" || msg.role === "developer")
  )
}

// 混淆一个可能是字符串、块数组或嵌套对象的系统提示词字段，并按需剥离首行计费头
function cloakSystemField(sys, regex, cloakChar, stripBilling, state) {
  if (typeof sys === "string") {
    const cleaned = stripBilling ? stripLeadingBillingHeader(sys, state) : sys
    return cloakText(cleaned, regex, cloakChar, state)
  }
  if (Array.isArray(sys)) {
    for (let i = 0; i < sys.length; i++) {
      const item = sys[i]
      if (typeof item === "string") {
        const cleaned = stripBilling ? stripLeadingBillingHeader(item, state) : item
        sys[i] = cloakText(cleaned, regex, cloakChar, state)
      } else if (item && typeof item === "object") {
        if (stripBilling && typeof item.text === "string" && item.text.length > 0) {
          const stripped = stripLeadingBillingHeader(item.text, state)
          if (stripped.length === 0) {
            // 整块仅为计费头：直接移除该块，避免留下空 text 块触发上游校验错误
            sys.splice(i, 1)
            i--
            continue
          }
          item.text = stripped
        }
        cloakDeep(item, regex, cloakChar, state)
      }
    }
    return sys
  }
  if (sys && typeof sys === "object") {
    if (Array.isArray(sys.parts)) {
      cloakSystemField(sys.parts, regex, cloakChar, stripBilling, state)
      return sys
    }
    cloakDeep(sys, regex, cloakChar, state)
  }
  return sys
}

// 获取或编译过滤规则的正则表达式（带缓存）
function getFilterRegex(pattern, flags) {
  const key = `${pattern}\0${flags}`
  if (filterRegexCache.has(key)) return filterRegexCache.get(key)
  let re = null
  try {
    re = new RegExp(pattern, flags)
  } catch (_) {}
  if (filterRegexCache.size >= MAX_CACHE_SIZE) filterRegexCache.clear()
  filterRegexCache.set(key, re)
  return re
}

// 匹配目标字符串（model 或 agent）是否命中过滤规则
function isTargetMatched(target, filter) {
  if (!filter || (Array.isArray(filter) && filter.length === 0)) return true
  if (typeof target !== "string") return false

  const checkSingle = (rule) => {
    if (!rule) return false
    if (rule instanceof RegExp) return rule.test(target)
    if (typeof rule === "string") {
      const trimmedRule = rule.trim()
      if (!trimmedRule) return false
      if (trimmedRule === "*") return true
      // 支持正则字符串格式，如 "/^antigravity/i"
      if (trimmedRule.startsWith("/") && trimmedRule.lastIndexOf("/") > 0) {
        const lastSlash = trimmedRule.lastIndexOf("/")
        const pattern = trimmedRule.slice(1, lastSlash)
        const flags = trimmedRule.slice(lastSlash + 1)
        const re = getFilterRegex(pattern, flags)
        return re ? re.test(target) : false
      }
      // 支持通配符格式，如 "antigravity/*" 或 "*gemini*"
      if (trimmedRule.includes("*")) {
        const escaped = escapeRegExp(trimmedRule).replace(/\\\*/g, ".*")
        const re = getFilterRegex(`^${escaped}$`, "i")
        return re ? re.test(target) : false
      }
      return target.toLowerCase().includes(trimmedRule.toLowerCase())
    }
    return false
  }

  if (Array.isArray(filter)) {
    return filter.some(checkSingle)
  }
  return checkSingle(filter)
}

// 处理请求体中所有系统提示词位置（anthropic / gemini / chat / responses）
function processSystemPrompts(body, regex, cloakChar, stripBilling, state) {
  for (const key of ["system", "systemInstruction", "system_instruction", "instructions"]) {
    if (body[key] != null) {
      body[key] = cloakSystemField(body[key], regex, cloakChar, stripBilling, state)
    }
  }
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!isSystemRole(msg) || msg.content == null) continue
      msg.content = cloakSystemField(msg.content, regex, cloakChar, stripBilling, state)
    }
  }
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!isSystemRole(item) || item.content == null) continue
      item.content = cloakSystemField(item.content, regex, cloakChar, stripBilling, state)
    }
  }
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v)
}

// 解析与 Magpie plainSchema 严格对齐的有效 Schema 类型：
// Magpie plainSchema 对 type 数组取第一个非 "null" 的类型作为发往 Antigravity 的最终 type
function resolveEffectiveSchemaType(typeVal) {
  if (typeof typeVal === "string") return typeVal
  if (Array.isArray(typeVal)) {
    for (let i = 0; i < typeVal.length; i++) {
      const t = typeVal[i]
      if (typeof t === "string" && t !== "null" && t !== "") {
        return t
      }
    }
  }
  return ""
}

// 递归修复单个 JSON Schema 节点中会导致 Antigravity 报 400 的定义：
// 1. 有效 type 为 "array" 但缺失 items（如 mitan-mcp 的 candidates / credentials）：自动补全 items（优先取 prefixItems[0]，否则补 {}）
// 2. items 为数组（Draft-07 元组 Schema）：Antigravity Protobuf 要求 items 为单个 Schema 对象，收敛为首元素或 {}
// 3. 有效 type 明确为非 "array"（如 "string"、"object" 或 ["string", "array"]）却残留了 items：删除孤立 items，防止触发 Antigravity "field predicate failed: $type == Type.ARRAY" 400 错误
function sanitizeSchemaNode(node, state, depth = 0) {
  if (!isPlainObject(node) || depth > 32) return

  const effectiveType = resolveEffectiveSchemaType(node.type)

  if (effectiveType === "array") {
    if (Array.isArray(node.items)) {
      node.items = node.items.length > 0 && isPlainObject(node.items[0]) ? node.items[0] : {}
      state.changed = true
      state.fixedSchemas++
    } else if (!isPlainObject(node.items)) {
      const prefixFirst =
        Array.isArray(node.prefixItems) && node.prefixItems.length > 0 && isPlainObject(node.prefixItems[0])
          ? node.prefixItems[0]
          : null
      node.items = prefixFirst ? prefixFirst : {}
      state.changed = true
      state.fixedSchemas++
    }
  } else if (effectiveType === "") {
    if (isPlainObject(node.properties)) {
      // 未声明 type 但有 properties 时，Magpie plainSchema 会推导为 type: "object"，此时不能保留 items
      if (node.items !== undefined) {
        delete node.items
        state.changed = true
        state.fixedSchemas++
      }
    } else if (Array.isArray(node.items)) {
      // 未声明 type 但带了 items 数组时，Magpie plainSchema 会推导为 type: "array"
      node.items = node.items.length > 0 && isPlainObject(node.items[0]) ? node.items[0] : {}
      state.changed = true
      state.fixedSchemas++
    } else if (node.items === undefined && Array.isArray(node.prefixItems)) {
      // 未声明 type 且仅带 prefixItems 元组定义时，提升为 array + items
      node.type = "array"
      node.items = node.prefixItems.length > 0 && isPlainObject(node.prefixItems[0]) ? node.prefixItems[0] : {}
      state.changed = true
      state.fixedSchemas++
    }
  } else if (node.items !== undefined) {
    // 有效类型为非 array（例如 "string"、"object" 或 ["string", "array"]），剔除冲突的 items 字段
    delete node.items
    state.changed = true
    state.fixedSchemas++
  }

  if (isPlainObject(node.items)) {
    sanitizeSchemaNode(node.items, state, depth + 1)
  }

  if (isPlainObject(node.properties)) {
    const keys = Object.keys(node.properties)
    for (let i = 0; i < keys.length; i++) {
      sanitizeSchemaNode(node.properties[keys[i]], state, depth + 1)
    }
  }

  if (isPlainObject(node.additionalProperties)) {
    sanitizeSchemaNode(node.additionalProperties, state, depth + 1)
  }

  const defsBags = ["$defs", "definitions"]
  for (let b = 0; b < defsBags.length; b++) {
    const bag = node[defsBags[b]]
    if (isPlainObject(bag)) {
      const keys = Object.keys(bag)
      for (let i = 0; i < keys.length; i++) {
        sanitizeSchemaNode(bag[keys[i]], state, depth + 1)
      }
    }
  }

  const combinators = ["anyOf", "oneOf", "allOf"]
  for (let c = 0; c < combinators.length; c++) {
    const list = node[combinators[c]]
    if (Array.isArray(list)) {
      for (let i = 0; i < list.length; i++) {
        sanitizeSchemaNode(list[i], state, depth + 1)
      }
    }
  }
}

function sanitizeToolEntry(tool, state) {
  if (!isPlainObject(tool)) return
  if (isPlainObject(tool.input_schema)) {
    sanitizeSchemaNode(tool.input_schema, state, 0)
  }
  if (isPlainObject(tool.parameters)) {
    sanitizeSchemaNode(tool.parameters, state, 0)
  }
  if (isPlainObject(tool.function) && isPlainObject(tool.function.parameters)) {
    sanitizeSchemaNode(tool.function.parameters, state, 0)
  }
  if (Array.isArray(tool.tools)) {
    sanitizeToolList(tool.tools, state)
  }
  const declLists = [tool.functionDeclarations, tool.function_declarations]
  for (let d = 0; d < declLists.length; d++) {
    const decls = declLists[d]
    if (!Array.isArray(decls)) continue
    for (let i = 0; i < decls.length; i++) {
      const decl = decls[i]
      if (!isPlainObject(decl)) continue
      if (isPlainObject(decl.parameters)) sanitizeSchemaNode(decl.parameters, state, 0)
      if (isPlainObject(decl.parametersJsonSchema)) sanitizeSchemaNode(decl.parametersJsonSchema, state, 0)
      if (isPlainObject(decl.parameters_json_schema)) sanitizeSchemaNode(decl.parameters_json_schema, state, 0)
    }
  }
}

function sanitizeToolList(tools, state) {
  if (!Array.isArray(tools)) return
  for (let i = 0; i < tools.length; i++) {
    sanitizeToolEntry(tools[i], state)
  }
}

function sanitizeRequestToolSchemas(body, state) {
  if (Array.isArray(body.tools)) {
    sanitizeToolList(body.tools, state)
  }
  if (Array.isArray(body.input)) {
    for (let i = 0; i < body.input.length; i++) {
      const item = body.input[i]
      if (isPlainObject(item) && Array.isArray(item.tools)) {
        sanitizeToolList(item.tools, state)
      }
    }
  }
}

export function onRequest(body, ctx) {
  if (!body || typeof body !== "object") return undefined
  const opts = ctx?.options ?? {}
  if (opts.off) return undefined

  // 客户端 Agent 过滤（兼容 agentFilter 与 magpie 社区插件习惯的 agents 字段）
  const agentRule = opts.agentFilter !== undefined ? opts.agentFilter : opts.agents
  if (agentRule && !isTargetMatched(ctx?.agent || "", agentRule)) {
    return undefined
  }

  // 渠道/模型过滤（兼容 modelFilter 与 models 字段）
  // 注意：Magpie 在用户未保存 Options 前传入的 ctx.options 为 {}；
  // 此时若请求模型带有 "<provider>/<model>" 命名空间前缀，默认仅匹配 "antigravity" 渠道，避免干扰其他 Provider
  const model = body?.model || ctx?.model || ""
  const rawModelRule = opts.modelFilter !== undefined ? opts.modelFilter : opts.models
  const effectiveModelRule = rawModelRule !== undefined
    ? rawModelRule
    : (model.includes("/") ? DEFAULT_MODEL_FILTER : "")
  if (effectiveModelRule && !isTargetMatched(model, effectiveModelRule)) {
    return undefined
  }

  const cloakChar = typeof opts.cloakChar === "string" && opts.cloakChar.length > 0
    ? opts.cloakChar
    : DEFAULT_CLOAK_CHAR

  // 默认直接剥离首行 x-anthropic-billing-header（可设 stripBillingHeader: false 退回纯零宽混淆）
  const stripBilling = opts.stripBillingHeader !== false
  const fixSchema = opts.fixToolSchema !== false

  const regex = getCompiledRegex(opts.extraWords, cloakChar)
  if (!regex && !stripBilling && !fixSchema) return undefined

  const state = {
    changed: false,
    count: 0,
    strippedBilling: 0,
    fixedSchemas: 0,
    matches: opts.debug ? new Set() : null,
    startTime: opts.debug ? Date.now() : 0,
  }

  // deep：先仅剥离系统提示词首行计费头，再对全字段做单次深度混淆（避免系统提示词被重复扫描两次）
  if (opts.deep) {
    if (stripBilling) {
      processSystemPrompts(body, null, cloakChar, true, state)
    }
    if (regex) {
      cloakDeep(body, regex, cloakChar, state)
    }
  } else {
    // 默认：仅处理系统提示词（剥离首行 billing header + 混淆敏感词，对模型输出质量影响最小）
    processSystemPrompts(body, regex, cloakChar, stripBilling, state)
  }

  if (fixSchema) {
    sanitizeRequestToolSchemas(body, state)
  }

  if (opts.debug) {
    const elapsed = Date.now() - state.startTime
    const matchedList = Array.from(state.matches).join(", ") || "none"
    const meta = [
      ctx?.protocol ? `protocol: "${ctx.protocol}"` : "",
      ctx?.agent ? `agent: "${ctx.agent}"` : "",
      `model: "${model}"`,
    ].filter(Boolean).join(" | ")
    console.log(
      `[antigravity-cloak] ${meta} | strippedBilling: ${state.strippedBilling} | fixedSchemas: ${state.fixedSchemas} | cloaked: ${state.count} match(es) [${matchedList}] (${elapsed}ms)`
    )
  }

  // 遵循 Magpie 网关中间件规范：未发生实际改动时返回 undefined，网关直接复用原始 []byte 字节流
  return state.changed ? body : undefined
}
