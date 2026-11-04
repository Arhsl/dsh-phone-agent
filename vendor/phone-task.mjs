#!/usr/bin/env node
/**
 * phone-task.mjs —— 手机任务执行器（「你说完就去忙」模式）
 * ---------------------------------------------------------------------------
 * 为什么需要它：手工一步一调太碎，且中途网络抖一下整条链就断，人还得回来
 * 收拾。这个执行器把任务写成一份 JSON，一口气跑完：
 *
 *   · 每步都有明确成败，失败立刻停（或按配置继续）
 *   · 传输层抖动自动重试（实测手机热点偶发 fetch failed，重试一次就好）
 *   · 失败时自动留现场（截图 + 界面树），回来能查为什么
 *   · 结束时**自动切回 DSH 界面**，你不用自己找回来
 *   · 最后出一份可读报告
 *
 * 关键：等界面变化一律用 `wait`，不用 sleep 猜时间。Tailscale 中继下往返
 * 可能几百毫秒，瞎等要么不够要么浪费。
 *
 * 批处理：相邻的"目标已确定"步骤会合并成**一次请求**（见 BATCHABLE）。
 * 实测每步固定开销约 270ms，十来步的任务光开销就 2~3 秒；合并把它压掉。
 * 需要"读了屏再决定"的步骤不合并 —— 那正是模型推理所在的地方。
 *
 * 用法：
 *   node phone-task.mjs task.json
 *   node phone-task.mjs --inline '{"name":"...","steps":[...]}'
 *   node phone-task.mjs task.json --no-restore    # 结束时留在当前界面
 *   node phone-task.mjs task.json --no-batch      # 关闭合并（排障用）
 *
 * 任务文件格式见同目录 手机Agent-任务模式说明.md
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildScript } from './phone-script.mjs'
import { resolveConfig, missingConfig } from '../lib/config.js'
import {
  toPointsParam,
  durationFor,
  circle,
  arc,
  wave,
  scaleToScreen,
  simplify,
  validatePath,
} from './phone-gesture.mjs'

/** DSH 的包名：任务结束后切回它。 */
const DSH_PKG = 'com.dsh.phone'

/** 传输层重试：只对「连不上」重试，逻辑失败不重试（重试也没用）。 */
const TRANSPORT_RETRIES = 2
const TRANSPORT_BACKOFF_MS = 500

/** 硬上限，防止任务写错时无限跑。 */
const MAX_STEPS = 200
const MAX_TOTAL_MS = 10 * 60 * 1000

// ---------------------------------------------------------------- 配置

// 配置解析统一交给 ../lib/config.js：
//   * 插件与执行器必须读同一套来源顺序，否则「插件能连、命令行连不上」
//     这种分裂现象又会回来；
//   * 凭据只有一份，$DSH_HOME/.phone-agent.json，另外兼容当前目录下的同名文件。
function loadConfig() {
  return resolveConfig()
}

// ---------------------------------------------------------------- 传输

function makeTransport(cfg) {
  const base = `http://${cfg.host}:${cfg.port}`

  async function once(op, params) {
    const qs = new URLSearchParams({ k: cfg.token })
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null || v === '') continue
      qs.set(k, String(v))
    }
    let res
    try {
      res = await fetch(`${base}/${encodeURIComponent(op)}?${qs.toString()}`, {
        signal: AbortSignal.timeout(30000),
      })
    } catch (err) {
      return { ok: false, unreachable: true, error: err && err.message ? err.message : String(err) }
    }
    if (op === 'screenshot') {
      if (!res.ok) {
        const t = await res.text()
        return { ok: false, error: 'HTTP ' + res.status + ': ' + t.slice(0, 160) }
      }
      return { ok: true, buffer: Buffer.from(await res.arrayBuffer()) }
    }
    const text = await res.text()
    let body
    try {
      body = JSON.parse(text)
    } catch (err) {
      return { ok: false, error: '非 JSON: ' + text.slice(0, 160) }
    }
    if (!res.ok || body.ok === false) {
      return { ...body, ok: false, error: String(body.error || 'HTTP ' + res.status) }
    }
    return body
  }

  /**
   * 带重试的调用。
   *
   * 只重试「连不上」：热点切换、系统短暂调度都会让第一次 fetch 失败，
   * 隔半秒再来就通了。而「目标没找到」「令牌不对」这类重试一万次也一样，
   * 立刻返回让上层停手。
   */
  async function call(op, params) {
    let last = null
    for (let attempt = 0; attempt <= TRANSPORT_RETRIES; attempt++) {
      last = await once(op, params)
      if (!last.unreachable) return last
      if (attempt < TRANSPORT_RETRIES) {
        await new Promise((r) => setTimeout(r, TRANSPORT_BACKOFF_MS * (attempt + 1)))
      }
    }
    return last
  }

  /**
   * 一次请求跑多步。
   *
   * 为什么值得做：实测每步的固定开销约 270ms（pwsh 171ms + node 40ms +
   * 往返 60ms）。一个十来步的任务，光"什么都没干"的部分就 2~3 秒。
   * 批量把中间的往返全部省掉，手机端连着执行、一次回复。
   *
   * 只对「目标已经确定、不需要中途看结果」的步骤使用 —— 这是它唯一的
   * 正确用法。需要"读了屏再决定下一步"的地方必须留在客户端，
   * 因为那正是模型推理发生的地方。
   */
  async function callScript(script) {
    return call('script', { script })
  }

  return { call, callScript }
}

// ---------------------------------------------------------------- 执行

/**
 * 把一步手势描述展开成手机端要的点串。
 *
 * 支持两种写法：
 *   { points: [[x,y], …] }                      直接给像素点
 *   { shape: "circle"|"arc"|"wave", … }         给形状，这里算坐标
 *
 * 形状也接受 x/y/r 用 0..1 归一化并配 `rel: true`，由 ctx.screen（任务
 * 开始时可读一次屏幕尺寸）换算 —— 同一个任务换台手机仍然成立。
 */
function buildStrokePoints(step, ctx) {
  if (Array.isArray(step.points) && step.points.length >= 2) {
    const bad = validatePath(step.points)
    if (bad) return { error: 'points 无效：' + bad }
    const pts = simplify(step.points, 1.2)
    return {
      points: toPointsParam(pts),
      ms: durationFor(pts, typeof step.ms === 'number' ? step.ms : undefined),
      count: pts.length,
    }
  }

  const shape = String(step.shape || '')
  if (!shape) {
    return { error: 'stroke 需要 points:[[x,y],…] 或 shape:circle|arc|wave' }
  }

  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d)

  // 归一化模式：形状用 0..1 描述，按实际屏幕放大。
  if (step.rel) {
    const w = ctx.screen && ctx.screen.w ? ctx.screen.w : 1260
    const h = ctx.screen && ctx.screen.h ? ctx.screen.h : 2617
    let rel
    if (shape === 'circle') rel = circle(0.5, 0.5, num(step.r, 0.18), num(step.steps, 72))
    else if (shape === 'arc') rel = arc(0.5, 0.5, num(step.r, 0.18), num(step.from, 0), num(step.to, 180), num(step.steps, 48))
    else if (shape === 'wave') rel = wave(0.12, 0.5, 0.76, num(step.amp, 0.14), num(step.cycles, 2), num(step.steps, 60))
    else return { error: '不认识的 shape：' + shape }
    const px = scaleToScreen(rel, w, h, num(step.margin, 0.06))
    const pts = simplify(px, 1.2)
    return {
      points: toPointsParam(pts),
      ms: durationFor(pts, typeof step.ms === 'number' ? step.ms : undefined),
      count: pts.length,
    }
  }

  const cx = num(step.x, 0)
  const cy = num(step.y, 0)
  const r = num(step.r, 200)
  let pts
  if (shape === 'circle') pts = circle(cx, cy, r, num(step.steps, 72))
  else if (shape === 'arc') pts = arc(cx, cy, r, num(step.from, 0), num(step.to, 180), num(step.steps, 48))
  else if (shape === 'wave') pts = wave(cx, cy, num(step.len, 800), num(step.amp, 150), num(step.cycles, 2), num(step.steps, 60))
  else return { error: '不认识的 shape：' + shape }

  const bad = validatePath(pts)
  if (bad) return { error: bad }
  const simple = simplify(pts, 1.2)
  return {
    points: toPointsParam(simple),
    ms: durationFor(simple, typeof step.ms === 'number' ? step.ms : undefined),
    count: simple.length,
  }
}

/**
 * 把一步操作翻译成手机上显示的一句话。
 *
 * 这是「让用户看见代理在想什么」的落点：手机端只知道自己收到了什么请求，
 * 它没有上下文；只有任务器知道"这是第 3 步，目的是点发送"。所以这句话
 * 必须在这一层生成。
 *
 * 写法上刻意用「正在…」而不是「将要…」——用户看到时动作多半已经在做了，
 * 措辞要和实际时机一致。步数放前面，便于对照脚本。
 */
function describeIntent(step, index, total) {
  const n = `第 ${index}/${total} 步`
  const op = String(step.op || '')
  const what = step.text ? `「${clip(step.text, 18)}」`
    : step.name ? `「${clip(step.name, 18)}」`
      : step.package ? `「${clip(String(step.package).split('.').pop(), 18)}」`
        : ''
  switch (op) {
    case 'open':
      return `${n}：打开${what}`
    case 'click':
      return `${n}：点${what}`
    case 'longclick':
      return `${n}：长按${what}`
    case 'text':
      return `${n}：输入 ${clip(step.value || '', 20)}`
    case 'swipe':
      return `${n}：滑动屏幕`
    case 'stroke':
    case 'strokes':
      return `${n}：画手势`
    case 'pinch':
      return `${n}：缩放`
    case 'key':
      return `${n}：按 ${step.key || '键'}`
    case 'wait':
      return step.text ? `${n}：等「${clip(step.text, 16)}」出现`
        : step.gone ? `${n}：等它消失`
          : step.pkg ? `${n}：等应用切前台`
            : `${n}：等界面`
    case 'assertText':
      return `${n}：核对「${clip(step.text || '', 16)}」`
    case 'screen':
      return `${n}：看屏幕`
    case 'shot':
      return `${n}：截图`
    case 'sleep':
      return `${n}：等 ${step.ms || 1000}ms`
    default:
      return `${n}：${op}`
  }
}

function clip(s, max) {
  const t = String(s == null ? '' : s)
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

/**
 * 哪些步骤可以合并进一次请求。
 *
 * 判据只有一条：**执行前不需要看屏幕结果**。
 *
 *   可以合并：open / click / longclick / text / swipe / stroke / pinch /
 *            key / wait / assertText / notice
 *     这些都是"已经知道要做什么"，手机自己按顺序做完即可。
 *
 *   不可合并：screen / shot
 *     它们的**结果**就是下一步的依据（要么给人看，要么给模型判断）。
 *     把它们放进批量里，等于让手机替模型做决定。
 *
 *   不可合并：sleep
 *     手机端没有对应的等待原语；用 wait 的空条件代替会改变语义
 *     （等的是"条件"而不是"时间"）。留在客户端跑。
 *
 * 注意 `wait` 可以合并：它已经在手机端本地轮询（不会把往返成本翻倍），
 * 而且在批量中间用它可以"等界面稳住再点下一个"，这正是常见需求。
 */
const BATCHABLE = new Set([
  'open', 'click', 'longclick', 'text', 'swipe',
  'stroke', 'strokes', 'pinch', 'key', 'wait',
  'assertText', 'notice',
])

/** 一批最多几步：手机端上限 60，客户端留点余量。 */
const BATCH_MAX = 40

/**
 * 把任务步骤切成若干批次。
 *
 * 只合并**相邻**的可批处理步骤，遇到不可批处理的就断开 —— 顺序必须保持，
 * 否则"先看再点"的语义就被破坏了。
 */
function planBatches(steps) {
  const batches = []
  let cur = []
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const op = String(step.op || '')
    if (BATCHABLE.has(op) && cur.length < BATCH_MAX) {
      cur.push({ step, index: i })
    } else {
      if (cur.length) {
        batches.push({ kind: 'batch', items: cur })
        cur = []
      }
      batches.push({ kind: 'single', items: [{ step, index: i }] })
    }
  }
  if (cur.length) batches.push({ kind: 'batch', items: cur })
  return batches
}

/**
 * 把一步任务翻译成手机端脚本能懂的形式。
 *
 * 手势类步骤复用 {@link buildStrokePoints}，而不是在这里重新实现一遍：
 * 批处理和非批处理必须画出**同一条路径**，否则批处理会静默改变行为。
 */
function stepToScriptStep(step, ctx) {
  const op = String(step.op || '')
  const args = {}
  switch (op) {
    case 'open':
      if (step.package) args.package = step.package
      else if (step.name) args.name = step.name
      else throw new Error('open 需要 package 或 name')
      break
    case 'click':
    case 'longclick':
      if (step.i !== undefined) args.i = step.i
      if (step.text) args.text = step.text
      if (step.x !== undefined) args.x = step.x
      if (step.y !== undefined) args.y = step.y
      break
    case 'text':
      if (!step.value) throw new Error('text 需要 value')
      args.value = step.value
      if (step.text) args.text = step.text
      break
    case 'swipe':
      for (const k of ['x1', 'y1', 'x2', 'y2']) {
        if (typeof step[k] !== 'number') throw new Error('swipe 缺 ' + k)
      }
      args.x1 = step.x1
      args.y1 = step.y1
      args.x2 = step.x2
      args.y2 = step.y2
      if (step.ms) args.ms = step.ms
      break
    case 'stroke': {
      const built = buildStrokePoints(step, ctx)
      if (built.error) throw new Error(built.error)
      args.points = built.points
      if (built.ms) args.ms = built.ms
      break
    }
    case 'strokes': {
      const list = Array.isArray(step.strokes) ? step.strokes : null
      if (!list || list.length === 0) throw new Error('strokes 需要 strokes 数组')
      const built = list.map((one) => buildStrokePoints({ points: one }, ctx))
      const bad = built.find((b) => b.error)
      if (bad) throw new Error(bad.error)
      args.strokes = built.map((b) => b.points).join('|')
      if (step.ms) args.ms = step.ms
      if (step.start) args.start = step.start
      break
    }
    case 'pinch':
      if (step.x === undefined || step.y === undefined) {
        throw new Error('pinch 需要 x 和 y')
      }
      args.x = step.x
      args.y = step.y
      if (step.dir) args.dir = step.dir
      if (step.from) args.from = step.from
      if (step.to) args.to = step.to
      if (step.ms) args.ms = step.ms
      break
    case 'key':
      if (!step.key) throw new Error('key 需要 key')
      args.key = step.key
      break
    case 'wait':
      if (step.text) args.text = step.text
      if (step.gone) args.gone = step.gone
      if (step.pkg) args.pkg = step.pkg
      if (step.timeout) args.timeout = step.timeout
      break
    case 'assertText':
      if (!step.text) throw new Error('assertText 需要 text')
      args.text = step.text
      break
    case 'notice':
      if (step.text) args.text = step.text
      if (step.ttl) args.ttl = step.ttl
      break
    default:
      throw new Error('不能批处理的 op: ' + op)
  }
  return { op, args }
}

/**
 * 失败现场：截图 + 界面树。
 *
 * 单独抽成函数是因为批处理引入了第二条失败路径（整批没跑起来），
 * 两条路径都必须留证据 —— 否则"批处理失败"会变成一种查不了的故障。
 */
async function captureFailure(ctx, outDir) {
  try {
    const shot = await ctx.transport.call('screenshot', {})
    if (shot.ok && shot.buffer && shot.buffer.length > 0) {
      const p = join(outDir, 'FAILED.png')
      writeFileSync(p, shot.buffer)
      ctx.shots.push(p)
      console.log('      失败截图: ' + p)
    }
  } catch (err) {}
  try {
    const scr = await ctx.transport.call('screen', {})
    if (scr.ok) {
      const p = join(outDir, 'FAILED-screen.json')
      writeFileSync(p, JSON.stringify(scr, null, 1))
      console.log('      失败界面: ' + p)
    }
  } catch (err) {}
}

/** 一步一个动作，返回 { ok, detail }。 */
async function runStep(ctx, step, index) {
  const { call } = ctx.transport
  const op = String(step.op || '')

  switch (op) {
    case 'open': {
      const p = {}
      if (step.package) p.package = step.package
      if (step.name) p.name = step.name
      if (!p.package && !p.name) return { ok: false, detail: 'open 需要 package 或 name' }
      const r = await call('open', p)
      return r.ok ? { ok: true, detail: '启动 ' + (r.package || p.package || p.name) }
        : { ok: false, detail: r.error }
    }

    case 'click':
    case 'longclick': {
      const p = {}
      if (step.i !== undefined) p.i = step.i
      if (step.text) p.text = step.text
      if (step.x !== undefined) p.x = step.x
      if (step.y !== undefined) p.y = step.y
      if (p.i === undefined && !p.text && (p.x === undefined || p.y === undefined)) {
        return { ok: false, detail: 'click 需要 i、text 或 x+y' }
      }
      const r = await call(op, p)
      if (!r.ok) return { ok: false, detail: r.error }
      return {
        ok: true,
        detail: '点了 ' + (r.label ? '「' + r.label + '」' : r.x !== undefined ? `(${r.x},${r.y})` : '目标'),
      }
    }

    case 'text': {
      if (!step.value) return { ok: false, detail: 'text 需要 value' }
      const r = await call('text', { value: step.value, ...(step.text ? { text: step.text } : {}) })
      return r.ok ? { ok: true, detail: `写入 ${String(step.value).length} 字` }
        : { ok: false, detail: r.error }
    }

    case 'swipe': {
      const need = ['x1', 'y1', 'x2', 'y2']
      for (const k of need) {
        if (typeof step[k] !== 'number') return { ok: false, detail: 'swipe 缺 ' + k }
      }
      const r = await call('swipe', {
        x1: step.x1, y1: step.y1, x2: step.x2, y2: step.y2,
        ...(step.ms ? { ms: step.ms } : {}),
      })
      return r.ok ? { ok: true, detail: `滑动 (${step.x1},${step.y1})→(${step.x2},${step.y2})` }
        : { ok: false, detail: r.error }
    }

    // 连续事件注入：任意曲线 / 多指 / 多笔。
    // 任务里直接写点集，或写形状让本地展开（见 buildStrokePoints）。
    case 'stroke': {
      const built = buildStrokePoints(step, ctx)
      if (built.error) return { ok: false, detail: built.error }
      const r = await call('stroke', { points: built.points, ...(built.ms ? { ms: built.ms } : {}) })
      if (!r.ok) return { ok: false, detail: r.error }
      return { ok: true, detail: `画了 ${r.points || built.count} 个点的曲线（${r.ms || built.ms}ms）` }
    }

    case 'strokes': {
      const list = Array.isArray(step.strokes) ? step.strokes : null
      if (!list || list.length === 0) {
        return { ok: false, detail: 'strokes 需要 strokes: [[[x,y],…], …]' }
      }
      const built = list.map((one) => buildStrokePoints({ points: one }, ctx))
      const bad = built.find((b) => b.error)
      if (bad) return { ok: false, detail: bad.error }
      const r = await call('strokes', {
        strokes: built.map((b) => b.points).join('|'),
        ...(step.ms ? { ms: step.ms } : {}),
        ...(step.start ? { start: step.start } : {}),
      })
      if (!r.ok) return { ok: false, detail: r.error }
      return {
        ok: true,
        detail: `${r.strokes || list.length} 条笔触`
          + (r.truncated ? '（超过平台上限 10 条，已截断）' : ''),
      }
    }

    case 'pinch': {
      const p = {}
      if (typeof step.x === 'number') p.x = step.x
      if (typeof step.y === 'number') p.y = step.y
      if (step.dir) p.dir = step.dir
      if (step.from) p.from = step.from
      if (step.to) p.to = step.to
      if (step.ms) p.ms = step.ms
      if (p.x === undefined || p.y === undefined) {
        return { ok: false, detail: 'pinch 需要 x 和 y（中心点）' }
      }
      const r = await call('pinch', p)
      return r.ok ? { ok: true, detail: '捏合 ' + (r.dir || 'out') } : { ok: false, detail: r.error }
    }

    case 'key': {
      const allowed = ['back', 'home', 'recents', 'notifications']
      const key = String(step.key || '')
      if (allowed.indexOf(key) < 0) return { ok: false, detail: 'key 只能是 ' + allowed.join('/') }
      const r = await call(key, {})
      return r.ok ? { ok: true, detail: '按 ' + key } : { ok: false, detail: r.error }
    }

    case 'wait': {
      const p = {}
      if (step.text) p.text = step.text
      if (step.gone) p.gone = step.gone
      if (step.pkg) p.pkg = step.pkg
      if (!p.text && !p.gone && !p.pkg) return { ok: false, detail: 'wait 需要 text/gone/pkg 之一' }
      if (step.timeout) p.timeout = step.timeout
      const r = await call('wait', p)
      if (r.ok) return { ok: true, detail: `等到了（轮询 ${r.polls} 次）` }
      if (r.timeout) {
        return { ok: false, detail: `超时；当前前台 ${r.pkg || '未知'}` }
      }
      return { ok: false, detail: r.error }
    }

    case 'assertText': {
      const needle = String(step.text || '')
      if (!needle) return { ok: false, detail: 'assertText 需要 text' }
      const r = await call('screen', {})
      if (!r.ok) return { ok: false, detail: r.error }
      const hit = (r.nodes || []).some((n) =>
        String(n.t || '').includes(needle) || String(n.d || '').includes(needle))
      return hit ? { ok: true, detail: '界面上有「' + needle + '」' }
        : { ok: false, detail: '界面上没有「' + needle + '」' }
    }

    case 'screen': {
      const r = await call('screen', {})
      if (!r.ok) return { ok: false, detail: r.error }
      const n = (r.nodes || []).length
      return { ok: true, detail: `${r.pkg || '?'} ${n} 个节点` }
    }

    case 'shot': {
      const r = await call('screenshot', {})
      if (!r.ok) return { ok: false, detail: r.error }
      if (!r.buffer || r.buffer.length === 0) return { ok: false, detail: '空图' }
      const name = step.path || `step-${String(index).padStart(2, '0')}.png`
      const target = resolve(ctx.outDir, name)
      try {
        writeFileSync(target, r.buffer)
      } catch (err) {
        return { ok: false, detail: '存图失败: ' + (err.message || err) }
      }
      ctx.shots.push(target)
      return { ok: true, detail: `${name} ${(r.buffer.length / 1024).toFixed(0)}KB` }
    }

    case 'sleep': {
      const ms = Math.min(Number(step.ms) || 1000, 30000)
      await new Promise((r) => setTimeout(r, ms))
      return { ok: true, detail: `等 ${ms}ms` }
    }

    default:
      return { ok: false, detail: '未知 op: ' + op }
  }
}

// ---------------------------------------------------------------- 主流程

function parseArgs(argv) {
  const out = { file: '', inline: '', restore: true, batch: true }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--no-restore') out.restore = false
    else if (a === '--no-batch') out.batch = false
    else if (a === '--inline') out.inline = argv[++i] || ''
    else if (!a.startsWith('--')) out.file = a
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.file && !args.inline) {
    console.error('用法: node phone-task.mjs task.json  或  --inline \'{"steps":[...]}\'')
    process.exit(2)
  }

  let task
  try {
    task = args.inline ? JSON.parse(args.inline) : JSON.parse(readFileSync(args.file, 'utf8'))
  } catch (err) {
    console.error('任务文件解析失败: ' + (err.message || err))
    process.exit(2)
  }

  const steps = Array.isArray(task.steps) ? task.steps : []
  if (steps.length === 0) {
    console.error('任务里没有 steps')
    process.exit(2)
  }
  if (steps.length > MAX_STEPS) {
    console.error(`步骤太多（${steps.length} > ${MAX_STEPS}）`)
    process.exit(2)
  }

  const cfg = loadConfig()
  const bad = missingConfig(cfg)
  if (bad) {
    console.error(bad)
    process.exit(2)
  }

  // Millisecond precision plus a uniquifier: two runs started in the same
  // second would otherwise share a directory and silently overwrite each
  // other's failure artifacts — exactly when they matter most.
  //
  // Written under the caller's cwd, not under the package directory: a package
  // installed into node_modules is not a place to leave run output, and may not
  // even be writable.
  let stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23)
  let outDir = join(process.cwd(), 'phone-tasks', stamp)
  for (let n = 2; existsSync(outDir) && n < 100; n++) {
    outDir = join(process.cwd(), 'phone-tasks', stamp + '-' + n)
  }
  mkdirSync(outDir, { recursive: true })

  const ctx = {
    transport: makeTransport(cfg),
    outDir,
    shots: [],
    screen: null,
    // 意图推送：手机上那条浮窗的第三行。任务器自己推，用户就能看见
    // 「第 3 步：点发送」这类信息，而不用猜代理在干什么。
    taskName: task.name || '任务',
    announce: task.announce !== false,
  }
  const restore = args.restore && task.restore !== false
  const stopOnFail = task.stopOnFail !== false
  const started = Date.now()

  // 读一次屏幕尺寸：`rel` 归一化手势要靠它换算像素。
  // 失败不致命——真实的固定像素任务不需要它。
  try {
    const png = await ctx.transport.call('ping', {})
    if (png && png.ok && png.w > 0) ctx.screen = { w: png.w, h: png.h }
  } catch (err) {}

  console.log(`任务：${task.name || '(未命名)'}`)
  console.log(`手机：${cfg.host}:${cfg.port}`)
  console.log(`现场：${outDir}`)
  console.log('')

  const results = []
  let failed = null

  // 计划：把相邻的"目标已确定"步骤合并成一次请求。
  // --no-batch 时不合并，等价于旧行为（排障用：能立刻看出问题出在
  // 批处理本身，还是某个具体操作）。
  const batches = args.batch === false
    ? steps.map((step, index) => ({ kind: 'single', items: [{ step, index }] }))
    : planBatches(steps)

  let cursor = 0
  for (const group of batches) {
    if (Date.now() - started > MAX_TOTAL_MS) {
      failed = { index: cursor, detail: '总时长超限' }
      break
    }

    if (group.kind === 'single') {
      const { step, index } = group.items[0]
      cursor = index
      const label = `${String(index + 1).padStart(2, '0')}. ${step.op}`
      if (ctx.announce) {
        try {
          await ctx.transport.call('notice',
            { text: describeIntent(step, index + 1, steps.length), ttl: 60000 })
        } catch (err) {}
      }
      let r
      try {
        r = await runStep(ctx, step, index + 1)
      } catch (err) {
        r = { ok: false, detail: '异常: ' + (err.message || err) }
      }
      results.push({ label, ...r })
      console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${label} —— ${r.detail}`)
      if (!r.ok) {
        if (step.optional) {
          console.log('      （标记 optional，继续）')
        } else if (stopOnFail) {
          failed = { index, detail: r.detail }
          await captureFailure(ctx, outDir)
          break
        }
      }
      continue
    }

    // ---- 一次请求跑完整批 ----
    const items = group.items
    const firstIdx = items[0].index
    const lastIdx = items[items.length - 1].index
    cursor = lastIdx

    let script
    try {
      script = buildScript(items.map(({ step }) => stepToScriptStep(step, ctx)))
    } catch (err) {
      // 翻译失败就退化成逐步执行，而不是让整个任务失败：批处理是优化，
      // 不该成为"能不能跑"的开关。
      console.log(`      （第 ${firstIdx + 1}~${lastIdx + 1} 步无法合并：${err.message}，逐步执行）`)
      for (const { step, index } of items) {
        const label = `${String(index + 1).padStart(2, '0')}. ${step.op}`
        let r
        try {
          r = await runStep(ctx, step, index + 1)
        } catch (e2) {
          r = { ok: false, detail: '异常: ' + (e2.message || e2) }
        }
        results.push({ label, ...r })
        console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${label} —— ${r.detail}`)
        if (!r.ok && !step.optional && stopOnFail) {
          failed = { index, detail: r.detail }
          await captureFailure(ctx, outDir)
          break
        }
      }
      if (failed) break
      continue
    }

    if (ctx.announce) {
      try {
        await ctx.transport.call('notice', {
          text: `第 ${firstIdx + 1}~${lastIdx + 1} 步：${items.length} 个动作连续执行`,
          ttl: 60000,
        })
      } catch (err) {}
    }

    const r = await ctx.transport.callScript(script)
    const stepReports = Array.isArray(r && r.steps) ? r.steps : null
    if (!r.ok || !stepReports) {
      // 整批没跑起来（连接问题、语法错误）。如实报告，不要假装成功。
      const detail = r && r.error ? r.error : '批量执行没有返回结果'
      for (const { step, index } of items) {
        results.push({ label: `${String(index + 1).padStart(2, '0')}. ${step.op}`, ok: false, detail })
      }
      console.log(`FAIL ${String(firstIdx + 1).padStart(2, '0')}~${String(lastIdx + 1).padStart(2, '0')}. batch —— ${detail}`)
      failed = { index: firstIdx, detail }
      await captureFailure(ctx, outDir)
      break
    }

    // 逐步核对：手机端回报了每一步的成败，照它落账。
    let batchFailed = null
    for (let k = 0; k < items.length; k++) {
      const { step, index } = items[k]
      const report = stepReports[k] || { ok: false, error: '手机没有回报这一步' }
      const label = `${String(index + 1).padStart(2, '0')}. ${step.op}`
      const detail = report.ok ? batchDetail(step, report) : String(report.error || '失败')
      results.push({ label, ok: !!report.ok, detail })
      console.log(`${report.ok ? 'OK  ' : 'FAIL'} ${label} —— ${detail}`)
      if (!report.ok && !batchFailed && !step.optional) batchFailed = { index, detail }
    }
    if (batchFailed && stopOnFail) {
      failed = batchFailed
      await captureFailure(ctx, outDir)
      break
    }
  }

  function batchDetail(step, report) {
    // 批量里手机端只回报 ok/error，没有单步的详细文案；用任务里的描述
    // 补上，这样报告仍然可读。
    return describeIntent(step, report.i + 1, steps.length).replace(/^第 \d+\/\d+ 步：/, '')
  }

  // 结束时切回 DSH：用户在电脑前，手机停在别的 App 会莫名其妙。
  if (restore) {
    const back = await ctx.transport.call('open', { package: DSH_PKG })
    console.log('')
    console.log(back.ok ? '已切回 DSH 界面' : '切回 DSH 失败：' + back.error)
  }

  const okCount = results.filter((r) => r.ok).length
  console.log('')
  console.log('——— 报告 ———')
  console.log(`步骤：${okCount}/${results.length} 成功`)
  if (failed) console.log(`停在：第 ${failed.index + 1} 步（${failed.detail}）`)
  if (ctx.shots.length) console.log(`截图：${ctx.shots.length} 张，在 ${outDir}`)
  console.log(`耗时：${((Date.now() - started) / 1000).toFixed(1)} 秒`)

  process.exit(failed ? 1 : 0)
}

main()
