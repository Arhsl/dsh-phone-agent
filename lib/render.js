/**
 * Turns the phone's node list into the indented tree the model reads best.
 *
 * Kept pure and separate because it is the piece that silently degrades: drop
 * the index and clicking becomes guesswork, drop the coordinate and every tap
 * turns into an extra round trip. Both failures look like "the tool is flaky".
 */

/** One line per node: #NNN  class  label  [id]  «flags»  @cx,cy */
export function renderScreen(d) {
  const nodes = Array.isArray(d && d.nodes) ? d.nodes : []
  const lines = [
    `Screen ${d.w}×${d.h}  foreground ${d.pkg || '?'}  ${nodes.length} nodes`,
    '',
  ]
  for (const n of nodes) {
    const tags = []
    if (n.clk) tags.push('clickable')
    if (n.edit) tags.push('editable')
    if (n.scroll) tags.push('scrollable')
    if (n.focus) tags.push('focused')
    if (n.off) tags.push('disabled')
    const label = n.t || (n.d ? '(' + n.d + ')' : '')
    const b = n.b || [0, 0, 0, 0]
    const cx = Math.round((b[0] + b[2]) / 2)
    const cy = Math.round((b[1] + b[3]) / 2)
    lines.push(
      ('#' + String(n.i).padStart(3) + ' ' + (n.c || '?')).padEnd(30)
      + (label ? ' ' + label : '')
      + (n.id ? `  [${n.id}]` : '')
      + (tags.length ? `  «${tags.join(',')}»` : '')
      + `  @${cx},${cy}`,
    )
  }
  if (nodes.length === 0) {
    lines.push('(no readable nodes: transparent surface, WebView not exposing '
      + 'content, or still loading)')
  }
  return lines.join('\n')
}
