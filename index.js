/**
 * dsh-phone-agent — drive a paired Android phone from DSH.
 *
 * The phone side is the DSH-phone.apk accessibility service: it listens on
 * TCP 8790 and answers one JSON object per request. This plugin wraps those
 * calls as tools, so the agent can read the screen and act on it without
 * going through a shell.
 *
 * Why a plugin rather than a shell script: the natural loop is
 *   screen → decide → act → screen → confirm
 * and every iteration through `node phone-agent.mjs …` costs a process spawn
 * plus output parsing. As a tool the round trip is one call and the result is
 * structured.
 *
 * `phone_task` is the exception: it delegates to the bundled runner, because a
 * multi-step run wants retries, failure capture and an automatic return to
 * DSH — all of which belong in one long-lived process rather than in a series
 * of tool calls that can be interrupted between steps.
 *
 * Security: the token grants control of the phone. It is read from disk at
 * call time, never logged, and requests only ever go to the configured host —
 * no tool argument can redirect them.
 */
import fs from 'node:fs'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveConfig, missingConfig } from './lib/config.js'
import { call, screenshot } from './lib/transport.js'
import { renderScreen } from './lib/render.js'
import { findTaskRunner, runTask } from './lib/runner.js'

export const name = 'dsh-phone-agent'

export const inject = ['tools']

/** Reads a field the caller may have left out. */
function str(v) {
  return typeof v === 'string' ? v : ''
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

const textOutput = {
  schema: { type: 'json' },
  render: (_a, v) => [{ type: 'text', text: v.message }],
}

export function apply(ctx, config) {
  const cfg = () => resolveConfig(config)

  /** Run `fn` only when credentials exist, else return the missing-config note. */
  async function guarded(fn) {
    const c = cfg()
    const bad = missingConfig(c)
    if (bad) return { ok: false, message: bad }
    return fn(c)
  }

  ctx.tools.register(defineTool({
    name: 'phone_ping',
    description: 'Check whether the phone agent is online, and report model, '
      + 'screen size, build version, process pid and uptime. First step when '
      + 'something is wrong: a changed pid means the system restarted the '
      + 'process, and a small uptimeMs means it restarted just now.',
    parameters: {},
    output: textOutput,
    async execute() {
      return guarded(async (c) => {
        const r = await call(c, 'ping', {})
        if (!r.ok) return { ok: false, message: r.error }
        const mins = Math.round((r.uptimeMs || 0) / 60000)
        return {
          ok: true,
          message: `Phone online: ${r.model} (Android sdk ${r.sdk}), screen ${r.w}×${r.h}`
            + `\nBuild ${r.build} | keep-alive notification ${r.foreground ? 'running' : 'not running'}`
            + `\nProcess pid ${r.pid}, up ${mins} min`
            + (r.err ? `\n⚠ ${r.err}` : ''),
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'phone_screen',
    description: 'Read the current phone screen as a readable node tree, with '
      + '#index, text, control class, clickability/editability and centre '
      + 'coordinates. This is the first step before acting: see what is there, '
      + 'then click. Indices are valid only for one read — re-read after the '
      + 'screen changes.',
    parameters: {
      raw: { type: 'boolean', description: 'Optional. true returns the raw JSON node array instead of the readable tree.' },
    },
    output: textOutput,
    async execute(args) {
      return guarded(async (c) => {
        const r = await call(c, 'screen', {})
        if (!r.ok) return { ok: false, message: r.error }
        return {
          ok: true,
          message: args && args.raw ? JSON.stringify(r, null, 2) : renderScreen(r),
          nodes: r.nodes,
          foreground: r.pkg,
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'phone_screenshot',
    description: 'Take a PNG of the current screen and save it to disk. '
      + 'Difference from phone_screen: phone_screen reads the control tree '
      + '(text, indices, clickability) while a screenshot reads pixels (images, '
      + 'colour, games, captchas). Use phone_screen to find a control, this to '
      + 'confirm it actually looks right.',
    parameters: {
      path: { type: 'string', description: 'Optional. Save path; defaults to phone-shot-<timestamp>.png in the current directory.' },
    },
    output: textOutput,
    async execute(args) {
      return guarded(async (c) => {
        const r = await screenshot(c)
        if (!r.ok) return { ok: false, message: r.error }

        const target = str(args && args.path)
          ? path.resolve(str(args && args.path))
          : path.join(process.cwd(), 'phone-shot-' + Date.now() + '.png')
        try {
          fs.writeFileSync(target, r.buffer)
        } catch (err) {
          return { ok: false, message: 'Got the screenshot but could not save it: ' + (err.message || err) }
        }
        return {
          ok: true,
          message: `Screenshot saved: ${target} (${(r.buffer.length / 1024).toFixed(0)} KB)`,
          path: target,
          bytes: r.buffer.length,
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'phone_wait',
    description: 'Wait until the UI reaches a state instead of sleeping and '
      + 'guessing. Typical use: phone_wait right after phone_click, to wait for '
      + 'loading to finish. Conditions combine (all must hold): text appears, '
      + 'gone disappears, pkg foreground. On timeout it returns false plus the '
      + 'current foreground package, so you can tell where the UI went.',
    parameters: {
      text: { type: 'string', description: 'Optional. Wait until this text or content description appears.' },
      gone: { type: 'string', description: 'Optional. Wait until this text or content description disappears.' },
      pkg: { type: 'string', description: 'Optional. Wait until the foreground package contains this string.' },
      timeout: { type: 'integer', description: 'Optional. Timeout in milliseconds, default 5000, max 30000.' },
    },
    output: textOutput,
    async execute(args) {
      const p = {}
      if (str(args && args.text)) p.text = str(args.text)
      if (str(args && args.gone)) p.gone = str(args.gone)
      if (str(args && args.pkg)) p.pkg = str(args.pkg)
      if (!p.text && !p.gone && !p.pkg) {
        return { ok: false, message: 'Give at least one of text / gone / pkg.' }
      }
      const timeout = num(args && args.timeout)
      if (timeout !== undefined) p.timeout = timeout

      return guarded(async (c) => {
        const r = await call(c, 'wait', p)
        if (!r.ok) {
          if (r.timeout) {
            return {
              ok: false,
              timeout: true,
              message: `Timed out after ${p.timeout || 5000}ms. Foreground now: ${r.pkg || 'unknown'}`
                + '. The UI may not have changed as expected — run phone_screen to look.',
            }
          }
          return { ok: false, message: r.error }
        }
        const conds = []
        if (p.text) conds.push(`「${p.text}」 appeared`)
        if (p.gone) conds.push(`「${p.gone}」 disappeared`)
        if (p.pkg) conds.push(`foreground is ${p.pkg}`)
        return { ok: true, message: `Waited for: ${conds.join(', ')} (${r.polls} polls)` }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'phone_click',
    description: 'Tap the phone screen. Prefer index (the #number from '
      + 'phone_screen, most reliable), then text (match by label or content '
      + 'description), then x/y coordinates. Set longclick for a long press. '
      + 'When the target is not found it reports that clearly instead of tapping '
      + 'blindly.',
    parameters: {
      index: { type: 'integer', description: 'Optional. Node index #N from phone_screen.' },
      text: { type: 'string', description: 'Optional. Label or content description to click (exact first, then fuzzy).' },
      x: { type: 'integer', description: 'Optional. x coordinate for a coordinate tap.' },
      y: { type: 'integer', description: 'Optional. y coordinate for a coordinate tap.' },
      longclick: { type: 'boolean', description: 'Optional. true for a ~0.7s long press.' },
    },
    output: textOutput,
    async execute(args) {
      const p = {}
      const index = num(args && args.index)
      if (index !== undefined) p.i = index
      if (str(args && args.text)) p.text = str(args.text)
      const x = num(args && args.x)
      const y = num(args && args.y)
      if (x !== undefined) p.x = x
      if (y !== undefined) p.y = y

      const hasTarget = p.i !== undefined || p.text !== undefined
        || (p.x !== undefined && p.y !== undefined)
      if (!hasTarget) {
        return { ok: false, message: 'Give index, text, or both x and y.' }
      }

      const op = args && args.longclick ? 'longclick' : 'click'
      return guarded(async (c) => {
        const r = await call(c, op, p)
        if (!r.ok) return { ok: false, message: r.error }
        const how = r.via === 'action' ? 'accessibility action' : 'touch gesture'
        const what = r.label ? `「${r.label}」` : (r.x !== undefined ? `(${r.x},${r.y})` : 'target')
        return { ok: true, message: `Tapped ${what} (${how})` }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'phone_text',
    description: 'Write text into the current input field on the phone '
      + '(replacing existing content). Focus the field first, or pass text to '
      + 'target one. May not work on custom-drawn inputs — tap each key in that '
      + 'case.',
    parameters: {
      value: { type: 'string', description: 'The text to write.' },
      text: { type: 'string', description: 'Optional. Target input identified by its label/description; omit to use the focused field.' },
    },
    output: textOutput,
    async execute(args) {
      const value = str(args && args.value)
      if (!value) return { ok: false, message: 'value must not be empty.' }
      const p = { value }
      if (str(args && args.text)) p.text = str(args.text)

      return guarded(async (c) => {
        const r = await call(c, 'text', p)
        if (!r.ok) return { ok: false, message: r.error }
        return { ok: true, message: `Wrote ${value.length} characters` }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'phone_swipe',
    description: 'Swipe on the phone. Common use: scroll a list up with '
      + 'y1 > y2 (e.g. 630,2000 → 630,800) and down the other way. Coordinates '
      + 'are pixels — confirm the screen size with phone_ping or phone_screen '
      + 'first.',
    parameters: {
      x1: { type: 'integer', description: 'Start x.' },
      y1: { type: 'integer', description: 'Start y.' },
      x2: { type: 'integer', description: 'End x.' },
      y2: { type: 'integer', description: 'End y.' },
      ms: { type: 'integer', description: 'Optional. Swipe duration in milliseconds, default 300.' },
    },
    output: textOutput,
    async execute(args) {
      for (const k of ['x1', 'y1', 'x2', 'y2']) {
        if (num(args && args[k]) === undefined) return { ok: false, message: `Missing parameter ${k}` }
      }
      const p = { x1: args.x1, y1: args.y1, x2: args.x2, y2: args.y2 }
      const ms = num(args.ms)
      if (ms !== undefined) p.ms = ms

      return guarded(async (c) => {
        const r = await call(c, 'swipe', p)
        if (!r.ok) return { ok: false, message: r.error }
        return { ok: true, message: `Swiped (${args.x1},${args.y1}) → (${args.x2},${args.y2})` }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'phone_key',
    description: 'Press a global navigation key: back, home, recents or '
      + 'notifications.',
    parameters: {
      key: { type: 'string', enum: ['back', 'home', 'recents', 'notifications'], description: 'The key to press.' },
    },
    output: textOutput,
    async execute(args) {
      const allowed = ['back', 'home', 'recents', 'notifications']
      const key = str(args && args.key)
      if (allowed.indexOf(key) < 0) {
        return { ok: false, message: 'key must be one of ' + allowed.join(' / ') }
      }
      const label = { back: 'Back', home: 'Home', recents: 'Recents', notifications: 'Notifications' }[key]

      return guarded(async (c) => {
        const r = await call(c, key, {})
        if (!r.ok) return { ok: false, message: r.error }
        return { ok: true, message: 'Pressed 「' + label + '」' }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'phone_apps',
    description: 'List launchable apps on the phone (package + label). Use this '
      + 'to find out what to pass to phone_open.',
    parameters: {},
    output: textOutput,
    async execute() {
      return guarded(async (c) => {
        const r = await call(c, 'apps', {})
        if (!r.ok) return { ok: false, message: r.error }
        const apps = Array.isArray(r.apps) ? r.apps : []
        const lines = apps.map((a) => `${a.label}  (${a.package})`)
        return {
          ok: true,
          message: `${apps.length} launchable apps:\n` + lines.join('\n'),
          apps,
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'phone_open',
    description: 'Launch an app on the phone. Pass package (exact, best) or '
      + 'name (label, partial match). Call phone_apps first if unsure.',
    parameters: {
      package: { type: 'string', description: 'Optional. Android package name, e.g. com.tencent.mm' },
      name: { type: 'string', description: 'Optional. App label, e.g. WeChat' },
    },
    output: textOutput,
    async execute(args) {
      const pkg = str(args && args.package)
      const label = str(args && args.name)
      if (!pkg && !label) return { ok: false, message: 'Give package or name.' }
      const p = {}
      if (pkg) p.package = pkg
      if (label) p.name = label

      return guarded(async (c) => {
        const r = await call(c, 'open', p)
        if (!r.ok) return { ok: false, message: r.error }
        return { ok: true, message: `Launched ${r.package}` }
      })
    },
  }))

  /**
   * Runs a whole multi-step task in one go.
   *
   * Why this exists next to the single-action tools: the chosen mode is
   * "describe the task, go away, come back to a report". As a chain of
   * individual tool calls that has three problems this avoids:
   *
   *   · an interruption between steps leaves the phone parked mid-flow with
   *     nothing to explain why;
   *   · transport hiccups (hotspot packet loss, the ROM scheduling the
   *     process away) would abort the run instead of retrying;
   *   · nothing captures what the screen looked like at the moment of failure.
   *
   * The bundled runner handles all three and returns the phone to the DSH
   * interface when it finishes.
   */
  ctx.tools.register(defineTool({
    name: 'phone_task',
    description: 'Run a sequence of actions on the phone in one go and return '
      + 'a report. Built for "say the task and walk away": all steps are '
      + 'submitted at once, nothing interrupts you, a failure leaves the scene '
      + '(screenshot + UI tree) behind, and the phone returns to the DSH '
      + 'interface at the end. Each step\'s op is one of: open / click / '
      + 'longclick / text / swipe / key / wait / assertText / screen / shot / '
      + 'sleep. Prefer wait over sleep: wait returns as soon as the condition '
      + 'holds.',
    parameters: {
      steps: {
        type: 'array',
        description: 'Step array. Each step is {op, ...params}. Example: '
          + '{"op":"open","name":"WeChat"}, {"op":"wait","pkg":"com.tencent.mm"}, '
          + '{"op":"click","text":"Send"}, {"op":"text","value":"hello"}, '
          + '{"op":"assertText","text":"sent"}, {"op":"shot","path":"done.png"}',
      },
      name: { type: 'string', description: 'Optional. Task name, used in the report.' },
      restore: { type: 'boolean', description: 'Optional. Return to the DSH interface at the end, default true.' },
      stopOnFail: { type: 'boolean', description: 'Optional. Stop at the first failing step, default true; false runs to the end.' },
    },
    output: textOutput,
    async execute(args) {
      const steps = args && Array.isArray(args.steps) ? args.steps : []
      if (steps.length === 0) {
        return { ok: false, message: 'steps must not be empty; each step needs at least an op.' }
      }

      const c = cfg()
      const bad = missingConfig(c)
      if (bad) return { ok: false, message: bad }

      const task = { name: str(args && args.name) || 'unnamed task', steps }
      if (args && args.restore === false) task.restore = false
      if (args && args.stopOnFail === false) task.stopOnFail = false

      const runner = findTaskRunner(config, { workspaceRoot: c.workspaceRoot })
      if (!runner) {
        return {
          ok: false,
          message: 'Could not find the task runner (vendor/phone-task.mjs). '
            + 'The package looks incomplete; reinstall dsh-phone-agent. '
            + 'Meanwhile phone_screen + phone_click still work step by step.',
        }
      }

      return runTask(runner, task, {
        restore: args && args.restore === false ? false : undefined,
      })
    },
  }))
}
