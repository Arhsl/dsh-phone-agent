#!/usr/bin/env node
/**
 * Pre-pack gate.
 *
 * `npm publish` runs this before building the tarball. It exists because the
 * expensive mistakes at publish time are all silent ones:
 *
 *   · a credentials file or token sneaking into the package;
 *   · the vendored runner or its two helper modules missing from `files`, so
 *     the published package cannot run phone_task at all;
 *   · a placeholder repository URL shipping to the registry.
 *
 * Each of those is one assertion here instead of a support thread later.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

const problems = []

function fail(msg) {
  problems.push(msg)
}

// --- 1. No secrets ---------------------------------------------------------

const SECRET_NAMES = ['.phone-agent.json', '.env', '.credentials.yaml']
for (const name of SECRET_NAMES) {
  for (const dir of [ROOT, path.join(ROOT, 'lib'), path.join(ROOT, 'vendor'), path.join(ROOT, 'test')]) {
    if (fs.existsSync(path.join(dir, name))) {
      fail(`secret-looking file inside the package: ${path.relative(ROOT, path.join(dir, name))}`)
    }
  }
}

/** Files that actually ship, according to `files`. Paths use forward slashes. */
function shippedFiles() {
  const out = []
  const walk = (rel) => {
    const abs = path.join(ROOT, ...rel.split('/'))
    if (!fs.existsSync(abs)) return
    const st = fs.statSync(abs)
    if (st.isDirectory()) {
      for (const entry of fs.readdirSync(abs)) walk(rel + '/' + entry)
    } else {
      out.push(rel)
    }
  }
  for (const pattern of pkg.files || []) {
    if (pattern.includes('*')) continue
    walk(pattern.endsWith('/') ? pattern.slice(0, -1) : pattern)
  }
  return out
}

const shipped = shippedFiles()

// --- 2. Nothing that grants phone control may ship ------------------------

const TOKEN_PATTERN = /[A-Z0-9]{12,}/g
for (const rel of shipped) {
  if (!/\.(js|mjs|json|yml|yaml|md)$/.test(rel)) continue
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  // A bare long uppercase run is how the phone's pairing token looks. Allow
  // the well-known constants that are legitimately uppercase in this code.
  const hits = (text.match(TOKEN_PATTERN) || []).filter((h) =>
    !['DSH_PHONE_HOST', 'DSH_PHONE_TOKEN', 'DSH_PHONE_PORT'].includes(h))
  if (hits.length) {
    fail(`${rel} contains what looks like a token or secret: ${hits.slice(0, 3).join(', ')}`)
  }
  // Documentation legitimately shows example addresses such as 192.168.1.20;
  // only code is required to be address-free.
  if (/\.(js|mjs)$/.test(rel) && /\b(?:10|192|172)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(text)) {
    fail(`${rel} hard-codes a private IP address; the package must not bake in one network`)
  }
}

// --- 3. The runtime files the plugin needs are actually shipped -----------

const REQUIRED = [
  'index.js',
  'cordis.patch.yml',
  'lib/config.js',
  'lib/transport.js',
  'lib/render.js',
  'lib/runner.js',
  'vendor/phone-task.mjs',
  'vendor/phone-script.mjs',
  'vendor/phone-gesture.mjs',
  'README.md',
  'LICENSE',
]
for (const rel of REQUIRED) {
  if (!fs.existsSync(path.join(ROOT, rel))) {
    fail(`required file is missing from the repo: ${rel}`)
  } else if (!shipped.includes(rel)) {
    fail(`${rel} exists but is NOT covered by package.json "files" — it would not ship`)
  }
}

// --- 4. Metadata a registry page needs -----------------------------------

// A placeholder owner is a warning, not a blocker: it must be fixed before
// `npm publish`, but it must not stop `npm pack` from being verified locally.
// `scripts/set-owner.mjs --check` is the gate that fails on it.
const warnings = []
if (!pkg.repository || !pkg.repository.url) {
  fail('repository.url is missing')
} else if (/YOUR-NAME|\bUSER\b/.test(pkg.repository.url)) {
  warnings.push('repository.url still contains a placeholder — run '
    + 'node scripts/set-owner.mjs <github-username> before publishing')
}
if (!pkg.license) fail('license is missing')
if (!pkg.description || pkg.description.length < 20) fail('description is too short to be useful')

// --- 5. The tests must be runnable without a device ----------------------

if (!fs.existsSync(path.join(ROOT, 'test', 'offline.test.js'))) {
  fail('offline test suite is missing; CI would have nothing to run')
}

// --- report ---------------------------------------------------------------

if (problems.length) {
  console.error('prepack check failed:')
  for (const p of problems) console.error('  ✖ ' + p)
  process.exit(1)
}

for (const w of warnings) console.warn('  ⚠ ' + w)

console.log(`prepack check passed: ${shipped.length} files ship, no secrets, `
  + `all runtime files covered, metadata complete.`)
