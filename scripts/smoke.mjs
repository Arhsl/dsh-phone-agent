#!/usr/bin/env node
/**
 * Against a real device. Not part of `npm test` on purpose.
 *
 * The offline suite proves the logic; this proves the protocol. Run it after
 * building a new APK, or when a tool "works but returns the wrong thing" —
 * which is the failure mode a unit test cannot see.
 *
 *   node scripts/smoke.mjs            # needs $DSH_HOME/.phone-agent.json
 *   node scripts/smoke.mjs --screen   # also dump a screen tree
 *
 * Every step is read-only. Nothing here taps or types.
 */
import { resolveConfig, missingConfig } from '../lib/config.js'
import { call } from '../lib/transport.js'
import { renderScreen } from '../lib/render.js'

const wantScreen = process.argv.includes('--screen')
let failures = 0

function ok(label, detail) {
  console.log(`✔ ${label}${detail ? ' — ' + detail : ''}`)
}

function bad(label, detail) {
  failures++
  console.log(`✖ ${label}${detail ? ' — ' + detail : ''}`)
}

async function main() {
  const cfg = resolveConfig()
  const missing = missingConfig(cfg)
  if (missing) {
    console.error(missing)
    process.exit(2)
  }

  console.log(`phone: ${cfg.host}:${cfg.port}`)
  console.log('')

  const ping = await call(cfg, 'ping', {}, { timeoutMs: 12000 })
  if (!ping.ok) {
    bad('ping', ping.error)
    console.log('\nthe phone is unreachable; the remaining checks need it')
    process.exit(1)
  }
  ok('ping', `${ping.model} sdk ${ping.sdk} ${ping.w}×${ping.h} build ${ping.build}`)

  if (!ping.foreground) {
    bad('keep-alive', 'the foreground notification is not running — the process may be reclaimed')
  } else {
    ok('keep-alive', 'running')
  }

  const apps = await call(cfg, 'apps', {})
  if (apps.ok && Array.isArray(apps.apps) && apps.apps.length > 0) {
    ok('apps', `${apps.apps.length} launchable`)
  } else {
    bad('apps', apps.error || 'empty list')
  }

  const screen = await call(cfg, 'screen', {})
  if (!screen.ok) {
    bad('screen', screen.error)
  } else if (!Array.isArray(screen.nodes) || screen.nodes.length === 0) {
    bad('screen', 'no nodes — is the accessibility service actually connected?')
  } else {
    ok('screen', `${screen.nodes.length} nodes, foreground ${screen.pkg}`)
    if (wantScreen) {
      console.log('')
      console.log(renderScreen(screen))
      console.log('')
    }
  }

  // Screenshot support depends on API 30+, so a failure here is informational
  // rather than fatal: everything else still works on older Android.
  const shot = await call(cfg, 'screenshot', {}, { timeoutMs: 30000 })
  if (shot.ok) {
    ok('screenshot', 'endpoint answered')
  } else {
    console.log(`… screenshot: ${shot.error}`)
    console.log('  (expected below Android 11; the other tools do not depend on it)')
  }

  console.log('')
  if (failures) {
    console.log(`${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('all checks passed')
}

main()
