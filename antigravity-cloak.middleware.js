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
// 做法（参考 cli-proxy-api PR #6280）：
//   在敏感词第一个字符后插入零宽空格。人眼看不出差别，
//   模型也基本不受影响，但上游的关键字匹配就失效了。
//   默认只混淆系统提示词（system / systemInstruction / instructions，
//   以及 chat 协议下 messages 里 role === "system" 的消息）；
//   deep 选项会混淆整个请求体（用户消息、tools、thinking 也一起）。
//
// 安装：magpie plugin add /Users/heguanghai/Code/magpie-antigravity-cloak
//   （短名不识别，options 操作也要用完整路径）
//
// 可选配置（magpie plugin options <完整路径> '<json>'）：
//   {
//     "extraWords": ["自定义敏感词"],
//     "off": false,
//     "deep": false,
//     "stripBillingHeader": true,   // 直接剥离首行 x-anthropic-billing-header（防 429 且避免 cch 轮转破坏 Prefix Cache）
//     "modelFilter": "antigravity", // 仅对匹配的模型启用（支持字符串、通配符、正则字符串、数组）
//     "debug": false,               // 输出命中词与耗时日志
//     "cloakChar": "​"         // 自定义混淆字符（默认零宽空格 U+200B）
//   }
//   off 设为 true 时完全放行；deep 设为 true 时深度混淆整个请求体，
//   覆盖面更大但更激进。

// 默认零宽空格（U+200B），写成转义形式避免源码中出现不可见字符
const DEFAULT_CLOAK_CHAR = "​"

// 匹配系统提示词首行的 Claude Code 计费头（x-anthropic-billing-header: ...）
// 该行携带每轮变化的 cch 参数，直接剥离既可消除 429 触发源，又能防止上游 Prefix Cache 失效
const BILLING_HEADER_LEADING_RE = /^\s*x-anthropic-billing-header:[^\r\n]*(?:\r?\n)*/i

// 常见零宽/不可见字符集合（用于 buildNeedles 自动过滤，防止用户误贴造成脏匹配）
const INVISIBLE_CHARS = new Set([
  "​", // Zero Width Space
  "‌", // Zero Width Non-Joiner
  "‍", // Zero Width Joiner
  "⁠", // Word Joiner
  "﻿", // Zero Width No-Break Space / BOM
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
function stripLeadingBillingHeader(text, stats) {
  if (typeof text !== "string" || text.length === 0) return text
  const stripped = text.replace(BILLING_HEADER_LEADING_RE, "")
  if (stripped !== text && stats) {
    stats.strippedBilling++
  }
  return stripped
}

// 在 text 的每个敏感词第一个字符后插混淆字符。
// 使用单正则整体匹配，已混淆的词中间多了混淆字符，不再匹配，天然幂等。
function cloakText(text, regex, cloakChar, stats) {
  if (typeof text !== "string" || text.length < 2 || !regex) return text
  return text.replace(regex, (m) => {
    if (stats) {
      stats.count++
      stats.matches.add(m.toLowerCase())
    }
    // Unicode Code Point 安全切分，防止 Emoji 或双字节字符代理对被截断
    const firstChar = String.fromCodePoint(m.codePointAt(0))
    return firstChar + cloakChar + m.slice(firstChar.length)
  })
}

// 递归遍历 JSON 值：对每个字符串混淆，并原地写回。
// 疑似 base64 / data URL 的超长无空格串不碰；签名等字段不碰。
const SKIP_KEYS = new Set(["signature", "id", "session", "sessionId", "requestId"])

function cloakDeep(value, regex, cloakChar, stats) {
  if (value == null) return value
  const t = typeof value
  if (t === "string") {
    if (value.length > 4096 && !value.includes(" ")) return value
    return cloakText(value, regex, cloakChar, stats)
  }
  if (t !== "object") return value
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = cloakDeep(value[i], regex, cloakChar, stats)
    return value
  }
  for (const k in value) {
    if (SKIP_KEYS.has(k)) continue
    value[k] = cloakDeep(value[k], regex, cloakChar, stats)
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
function cloakSystemField(sys, regex, cloakChar, stripBilling, stats) {
  if (typeof sys === "string") {
    const cleaned = stripBilling ? stripLeadingBillingHeader(sys, stats) : sys
    return cloakText(cleaned, regex, cloakChar, stats)
  }
  if (Array.isArray(sys)) {
    for (let i = 0; i < sys.length; i++) {
      const item = sys[i]
      if (typeof item === "string") {
        const cleaned = stripBilling ? stripLeadingBillingHeader(item, stats) : item
        sys[i] = cloakText(cleaned, regex, cloakChar, stats)
      } else if (item && typeof item === "object") {
        if (stripBilling && typeof item.text === "string" && item.text.length > 0) {
          const stripped = stripLeadingBillingHeader(item.text, stats)
          if (stripped.length === 0) {
            // 整块仅为计费头：直接移除该块，避免留下空 text 块触发上游校验错误
            sys.splice(i, 1)
            i--
            continue
          }
          item.text = stripped
        }
        cloakDeep(item, regex, cloakChar, stats)
      }
    }
    return sys
  }
  if (sys && typeof sys === "object") {
    if (Array.isArray(sys.parts)) {
      cloakSystemField(sys.parts, regex, cloakChar, stripBilling, stats)
      return sys
    }
    cloakDeep(sys, regex, cloakChar, stats)
  }
  return sys
}

// 获取或编译 modelFilter 的正则表达式（带缓存）
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

// 匹配模型是否命中过滤规则
function isModelMatched(model, filter) {
  if (!filter) return true
  if (typeof model !== "string") return false

  const checkSingle = (rule) => {
    if (!rule) return false
    if (rule instanceof RegExp) return rule.test(model)
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
        return re ? re.test(model) : false
      }
      // 支持通配符格式，如 "antigravity/*" 或 "*gemini*"
      if (trimmedRule.includes("*")) {
        const escaped = escapeRegExp(trimmedRule).replace(/\\\*/g, ".*")
        const re = getFilterRegex(`^${escaped}$`, "i")
        return re ? re.test(model) : false
      }
      return model.toLowerCase().includes(trimmedRule.toLowerCase())
    }
    return false
  }

  if (Array.isArray(filter)) {
    return filter.some(checkSingle)
  }
  return checkSingle(filter)
}

// 处理请求体中所有系统提示词位置（anthropic / gemini / chat / responses）
function processSystemPrompts(body, regex, cloakChar, stripBilling, stats) {
  for (const key of ["system", "systemInstruction", "system_instruction", "instructions"]) {
    if (body[key] != null) {
      body[key] = cloakSystemField(body[key], regex, cloakChar, stripBilling, stats)
    }
  }
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!isSystemRole(msg) || msg.content == null) continue
      msg.content = cloakSystemField(msg.content, regex, cloakChar, stripBilling, stats)
    }
  }
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!isSystemRole(item) || item.content == null) continue
      item.content = cloakSystemField(item.content, regex, cloakChar, stripBilling, stats)
    }
  }
}

export function onRequest(body, ctx) {
  if (!body || typeof body !== "object") return body
  const opts = ctx?.options ?? {}
  if (opts.off) return body

  // 渠道/模型过滤：未命中则直接放行，避免干扰其他 Provider
  const model = body?.model || ctx?.model || ""
  if (opts.modelFilter && !isModelMatched(model, opts.modelFilter)) {
    return body
  }

  const cloakChar = typeof opts.cloakChar === "string" && opts.cloakChar.length > 0
    ? opts.cloakChar
    : DEFAULT_CLOAK_CHAR

  // 默认直接剥离首行 x-anthropic-billing-header（可设 stripBillingHeader: false 退回纯零宽混淆）
  const stripBilling = opts.stripBillingHeader !== false

  const regex = getCompiledRegex(opts.extraWords, cloakChar)
  if (!regex && !stripBilling) return body

  const stats = opts.debug
    ? { count: 0, strippedBilling: 0, matches: new Set(), startTime: Date.now() }
    : null

  // 先处理系统提示词（含剥离首行 billing header 与系统提示词混淆）
  processSystemPrompts(body, regex, cloakChar, stripBilling, stats)

  // deep：全字段深度混淆，用户消息、tools、thinking 也一起（已混淆过的系统词天然幂等不会二次插入）
  if (opts.deep && regex) {
    cloakDeep(body, regex, cloakChar, stats)
  }

  if (stats) {
    const elapsed = Date.now() - stats.startTime
    const matchedList = Array.from(stats.matches).join(", ") || "none"
    console.log(
      `[antigravity-cloak] model: "${model}" | strippedBilling: ${stats.strippedBilling} | cloaked: ${stats.count} match(es) [${matchedList}] (${elapsed}ms)`
    )
  }

  return body
}
