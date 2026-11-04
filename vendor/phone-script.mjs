/**
 * 批量脚本的构造端 —— 与手机端 ScriptParse.java 配对。
 *
 * 为什么需要这一层：手写 `open=package=com.x;click=text=发送` 这种串时，
 * 值的转义最容易漏。我在自己的测试里就漏了两次（URL 里的第一个 `=`、
 * 点列表中间的 `;`），两次都是"测试期望写错"而不是解析器错 —— 但提示了
 * 真实风险：**手写转义迟早会漏，而漏了不会报错，只会执行别的命令。**
 *
 * 所以电脑侧用这个模块生成脚本，调用方只描述"要做什么"，
 * 转义由 escape() 统一处理。
 */

/** 与 ScriptParse.java 一一对应的转义表。 */
const ESCAPES = [
  ['\\', '\\\\'],
  [';', '\\s'],
  ['=', '\\e'],
  ['|', '\\p'],
  [',', '\\b'],
]

/** 反转义：把 \s \e \p \b \\ 还原成原字符。 */
export function unescape(s) {
  const src = String(s == null ? '' : s)
  let out = ''
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c !== '\\' || i + 1 >= src.length) {
      out += c
      continue
    }
    const n = src[++i]
    if (n === 's') out += ';'
    else if (n === 'e') out += '='
    else if (n === 'p') out += '|'
    else if (n === 'b') out += ','
    else out += n
  }
  return out
}

/** 转义：让一个值能安全地放进脚本里。 */
export function escape(s) {
  let out = String(s == null ? '' : s)
  for (const [ch, rep] of ESCAPES) {
    out = out.split(ch).join(rep)
  }
  return out
}

/**
 * 构造一个脚本串。
 *
 * @param steps 形如 [{op:'open', args:{package:'com.x'}}, {op:'screen'}]
 *              也接受字符串（原样作为一个裸步骤）。
 * @returns 可直接放进 `script=` 表单字段的串
 */
export function buildScript(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('steps 不能为空')
  }
  return steps.map((s) => {
    if (typeof s === 'string') return escape(s)
    const op = String(s.op || '')
    if (!op) throw new Error('每个步骤都要有 op')
    let one = escape(op)
    const args = s.args || {}
    for (const [k, v] of Object.entries(args)) {
      if (v === undefined || v === null) continue
      one += '=' + escape(k) + '=' + escape(String(v))
    }
    return one
  }).join(';')
}

/**
 * 解析脚本 —— 测试用，与手机端保持同一个语义。
 *
 * 有意识地再实现一遍（而不是只在测试里相信手机端）：两边任何一侧写错，
 * 都能在本地对拍出来。
 */
export function parseScript(script) {
  const splitUnescaped = (s, sep) => {
    const out = []
    let cur = ''
    for (let i = 0; i < s.length; i++) {
      const c = s[i]
      if (c === '\\' && i + 1 < s.length) {
        cur += c + s[++i]
        continue
      }
      if (c === sep) {
        out.push(cur)
        cur = ''
        continue
      }
      cur += c
    }
    out.push(cur)
    return out
  }

  const steps = []
  for (const raw of splitUnescaped(String(script || ''), ';')) {
    const t = raw.trim()
    if (!t) continue
    const fields = splitUnescaped(t, '=')
    steps.push(fields.map((f) => unescape(f).trim()))
  }
  return steps
}

/** 一个步骤的 op 与参数，方便调用方判断手机跑了什么。 */
export function stepOf(fields) {
  const op = fields[0]
  const args = {}
  for (let i = 1; i + 1 < fields.length; i += 2) args[fields[i]] = fields[i + 1]
  return { op, args }
}
