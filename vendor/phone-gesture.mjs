/**
 * 手势路径构造 —— 纯函数，不碰网络、不碰设备。
 *
 * 为什么单独抽出来：连续事件注入真正的难点不在"发出去"，而在**算对坐标**。
 * 一个圆的顶点算错了，发出去照样"成功"，只是画出来是个歪的东西 —— 这种
 * 错误在真机上很难看出来，但在本地测坐标是几行断言的事。
 *
 * 所以：所有几何计算都放这里，用 `test-stroke.mjs` 在电脑上验证；
 * phone-agent.mjs 只负责把结果拼成 `points=x1,y1;x2,y2` 这种串。
 *
 * 坐标单位是手机屏幕像素。手机端收到的每个点都会按顺序连线（lineTo），
 * 平台在 `ms` 毫秒内匀速走完整条路径。
 */

/** 手机端 GestureDescription 的硬上限（平台限制，不是我们定的）。 */
export const MAX_GESTURE_MS = 55000
export const MAX_STROKES = 10

/**
 * 把点数组拼成手机端要的字符串。
 *
 * 分隔符是 `;`，对内是 `,` —— 因为整个串要走 URL 编码作为表单值，
 * 用逗号做分隔会和坐标对撞。
 */
export function toPointsParam(points) {
  if (!Array.isArray(points) || points.length === 0) return ''
  return points
    .map((p) => {
      const x = Math.round(Number(p[0]))
      const y = Math.round(Number(p[1]))
      if (!isFinite(x) || !isFinite(y)) throw new Error('坐标不是数字: ' + JSON.stringify(p))
      return x + ',' + y
    })
    .join(';')
}

/** 多条 stroke 拼成一个参数：stroke 之间用 `|`。 */
export function toStrokesParam(strokes) {
  if (!Array.isArray(strokes) || strokes.length === 0) return ''
  return strokes.map(toPointsParam).join('|')
}

/**
 * 合理的默认时长：点越多给的时间越长，但夹在平台允许的范围内。
 *
 * 每个点给 8ms 是实测手感：太短平台会让触点"瞬移"（画出来是折线，
 * 某些 canvas 应用会丢采样），太长则一次简单滑动要等好几秒。
 */
export function durationFor(points, override) {
  if (typeof override === 'number' && isFinite(override)) {
    return Math.min(Math.max(50, Math.round(override)), MAX_GESTURE_MS)
  }
  const n = Array.isArray(points) ? points.length : 2
  return Math.min(Math.max(120, n * 8), MAX_GESTURE_MS)
}

// ---------------------------------------------------------------- 几何

/** 圆：用于测试画图、以及验证"曲线不是直线"。 */
export function circle(cx, cy, r, steps = 36) {
  const n = Math.max(8, Math.min(steps, 240))
  const out = []
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r])
  }
  return out
}

/** 圆弧（终结点不回到起点，笔可以继续）。 */
export function arc(cx, cy, r, fromDeg, toDeg, steps = 24) {
  const n = Math.max(2, Math.min(steps, 240))
  const a0 = (fromDeg * Math.PI) / 180
  const a1 = (toDeg * Math.PI) / 180
  const out = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const a = a0 + (a1 - a0) * t
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r])
  }
  return out
}

/** 折线（用来验证多段直线）。 */
export function polyline(points) {
  return points.map((p) => [Number(p[0]), Number(p[1])])
}

/** 正弦波，用来画"明显不是直线"的东西。 */
export function wave(x0, y, width, amplitude, cycles = 2, steps = 40) {
  const n = Math.max(4, Math.min(steps, 200))
  const out = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    out.push([x0 + width * t, y + Math.sin(t * Math.PI * 2 * cycles) * amplitude])
  }
  return out
}

/**
 * 按屏幕尺寸把归一化路径缩放成像素坐标。
 *
 * 让任务可以在任何手机上描述同一条路径：写 0..1 的相对坐标，
 * 运行时乘上实际分辨率。跨设备复用才可能。
 */
export function scaleToScreen(points, width, height, margin = 0.06) {
  const w = Number(width)
  const h = Number(height)
  if (!(w > 0) || !(h > 0)) throw new Error('屏幕尺寸无效')
  const m = Math.max(0, Math.min(margin, 0.45))
  const usableW = w * (1 - m * 2)
  const usableH = h * (1 - m * 2)
  return points.map((p) => [
    Math.round(w * m + Number(p[0]) * usableW),
    Math.round(h * m + Number(p[1]) * usableH),
  ])
}

/** 路径的边界框，用来检查"画出来的东西在屏幕内"。 */
export function bounds(points) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    const x = Number(p[0])
    const y = Number(p[1])
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
}

/**
 * 路径总长度（像素）。用来估时长，也用来判断"这条路径够不够长"。
 */
export function pathLength(points) {
  let total = 0
  for (let i = 1; i < points.length; i++) {
    const dx = Number(points[i][0]) - Number(points[i - 1][0])
    const dy = Number(points[i][1]) - Number(points[i - 1][1])
    total += Math.sqrt(dx * dx + dy * dy)
  }
  return total
}

/**
 * 简化路径：把近似共线的点去掉。
 *
 * 为什么需要：一个圆用 240 个点画和用 40 个点画，肉眼几乎一样，但前者
 * 平台要插值 240 段、构建 Path 也更慢。手机上注入手势本来就有几十毫秒的
 * 开销，能省则省。
 *
 * 用的是 Douglas–Peucker 的简化版（按到弦的距离）。
 */
export function simplify(points, tolerance = 1.5) {
  if (!Array.isArray(points) || points.length <= 2) return points || []
  const tol = Math.max(0.1, Number(tolerance) || 1.5)
  const keep = new Array(points.length).fill(false)
  keep[0] = true
  keep[points.length - 1] = true

  const stack = [[0, points.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    if (b - a < 2) continue
    const [x1, y1] = points[a]
    const [x2, y2] = points[b]
    const dx = Number(x2) - Number(x1)
    const dy = Number(y2) - Number(y1)
    const denom = Math.sqrt(dx * dx + dy * dy)
    let far = -1
    let farDist = 0
    for (let i = a + 1; i < b; i++) {
      const px = Number(points[i][0]) - Number(x1)
      const py = Number(points[i][1]) - Number(y1)
      // 点到弦的距离；弦退化成点时退回点到点距离
      const d = denom < 1e-9
        ? Math.sqrt(px * px + py * py)
        : Math.abs(px * dy - py * dx) / denom
      if (d > farDist) {
        farDist = d
        far = i
      }
    }
    if (farDist > tol) {
      keep[far] = true
      stack.push([a, far], [far, b])
    }
  }
  return points.filter((_, i) => keep[i])
}

/** 校验一条路径是否可发：至少两点、坐标都是有限数。 */
export function validatePath(points) {
  if (!Array.isArray(points) || points.length < 2) {
    return '路径至少要两个点'
  }
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    // null/undefined must be rejected before Number() runs: Number(null) is 0,
    // which is a perfectly "valid" coordinate — a null vertex would silently
    // become (0,0) and drag the stroke to the top-left corner.
    if (!p || typeof p !== 'object') return '第 ' + (i + 1) + ' 个点不存在'
    const x = Number(p[0])
    const y = Number(p[1])
    if (!isFinite(x) || !isFinite(y)) return '第 ' + (i + 1) + ' 个点坐标无效'
  }
  return null
}
