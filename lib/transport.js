/**
 * Talks to the phone's accessibility service.
 *
 * The phone answers one JSON object per request over plain HTTP on 8790. Every
 * failure mode is translated into a sentence the agent can act on: unreachable
 * (phone asleep / agent off), bad token (re-pair), phone-side error (the op
 * itself failed). A raw "fetch failed" is useless inside a retry loop.
 */

/** Per-request ceiling. `wait` up to 30s, screenshots can be slow. */
const TIMEOUT_MS = 20000

export function buildUrl(cfg, op, params) {
  const qs = new URLSearchParams({ k: cfg.token })
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue
    qs.set(k, String(v))
  }
  return `http://${cfg.host}:${cfg.port}/${encodeURIComponent(op)}?${qs.toString()}`
}

/**
 * Calls one op.
 *
 * The token never appears in a returned message or a thrown error: URLs are
 * built here and errors are reconstructed, not echoed.
 */
export async function call(cfg, op, params, options) {
  const opts = options || {}
  const url = buildUrl(cfg, op, params)

  let res
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs || TIMEOUT_MS) })
  } catch (err) {
    return {
      ok: false,
      unreachable: true,
      error: 'Cannot reach the phone (' + messageOf(err) + '). Check: screen on, '
        + 'the DSH app keep-alive notification still present, and the accessibility '
        + 'service not disabled by the system.',
    }
  }

  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch (err) {
    return { ok: false, error: 'The phone returned non-JSON: ' + text.slice(0, 200) }
  }

  if (!res.ok || body.ok === false) {
    const reason = body && body.error ? body.error : 'HTTP ' + res.status
    if (res.status === 401) {
      return {
        ok: false,
        badToken: true,
        error: 'Token rejected (' + reason + '). It may have been reset on the '
          + 'phone; copy a fresh one from the 「手机 Agent」panel.',
      }
    }
    // Spread the phone's own fields through: `wait` reports timeout / polls /
    // pkg on failure, and the tool layer needs those to explain what happened.
    return { ...body, ok: false, error: String(reason) }
  }
  return body
}

/** Fetches a PNG from the screenshot endpoint. */
export async function screenshot(cfg, options) {
  const opts = options || {}
  const url = buildUrl(cfg, 'screenshot', {})

  let res
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs || 25000) })
  } catch (err) {
    return { ok: false, error: 'Cannot reach the phone (' + messageOf(err) + ')' }
  }
  if (!res.ok) {
    const t = await res.text()
    return { ok: false, error: 'Screenshot failed (HTTP ' + res.status + '): ' + t.slice(0, 200) }
  }
  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.length === 0) {
    return {
      ok: false,
      error: 'The phone returned no image. Likely causes: Android below 11 '
        + '(takeScreenshot needs API 30+), or the system denied the permission.',
    }
  }
  return { ok: true, buffer }
}

function messageOf(err) {
  return err && err.message ? err.message : String(err)
}
