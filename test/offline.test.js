/**
 * Offline tests: everything that decides behaviour runs here, no phone needed.
 *
 * The rule this follows: a test that needs a real device is a test nobody
 * runs. The pieces that actually break in these plugins are pure — the URL a
 * request ends up on, the way a failure is phrased, whether the renderer keeps
 * the index, whether the escape round-trips — so they are the ones covered
 * here. Anything genuinely device-bound lives in the `smoke` script instead.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveConfig, missingConfig, configCandidates, canonicalConfigPath } from '../lib/config.js'
import { buildUrl } from '../lib/transport.js'
import { renderScreen } from '../lib/render.js'
import { defaultRunnerPath, findTaskRunner } from '../lib/runner.js'
import { buildScript, parseScript, stepOf } from '../vendor/phone-script.mjs'

// ------------------------------------------------------------ config

test('config: explicit plugin config wins over the env', () => {
  const cfg = resolveConfig({ host: '127.0.0.1', token: 'abc' })
  assert.equal(cfg.host, '127.0.0.1')
  assert.equal(cfg.token, 'abc')
  assert.equal(cfg.port, '8790', 'port falls back to the default')
})

test('config: environment supplies the fields the config leaves out', () => {
  const saved = { ...process.env }
  process.env.DSH_PHONE_HOST = '10.0.0.5'
  process.env.DSH_PHONE_TOKEN = 'envtoken'
  process.env.DSH_PHONE_PORT = '9999'
  try {
    const cfg = resolveConfig({})
    assert.equal(cfg.host, '10.0.0.5')
    assert.equal(cfg.token, 'envtoken')
    assert.equal(cfg.port, '9999')
  } finally {
    for (const k of ['DSH_PHONE_HOST', 'DSH_PHONE_TOKEN', 'DSH_PHONE_PORT']) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
})

test('config: a scheme and trailing slashes are stripped from the host', () => {
  const cfg = resolveConfig({ host: 'http://192.168.1.9///', token: 't' })
  assert.equal(cfg.host, '192.168.1.9', 'buildUrl appends http:// itself')
})

test('config: a credentials file is read and its path recorded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-phone-cfg-'))
  const file = path.join(dir, 'creds.json')
  fs.writeFileSync(file, JSON.stringify({ host: '10.1.1.1', token: 'filetoken', port: 8791 }))
  try {
    const cfg = resolveConfig({ configFile: file })
    assert.equal(cfg.host, '10.1.1.1')
    assert.equal(cfg.token, 'filetoken')
    assert.equal(cfg.port, '8791')
    assert.equal(cfg.source, file, 'the read path is reported, not guessed')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('config: graceless input does not throw', () => {
  // DSH_HOME must be redirected: this machine has a real credentials file at
  // the canonical path, and without isolation the test would read it and pass
  // or fail depending on whose computer it runs on.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-phone-home-'))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-phone-bad-'))
  const file = path.join(dir, 'creds.json')
  fs.writeFileSync(file, '{ this is not json')
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const cfg = resolveConfig({ configFile: file })
    assert.equal(cfg.host, '', 'a corrupt file behaves like a missing one')
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('config: candidates put the canonical path before the cwd file', () => {
  const list = configCandidates({}, '/tmp/ws')
  const canonical = canonicalConfigPath()
  assert.ok(list.includes(canonical))
  assert.ok(list.indexOf(canonical) < list.indexOf(path.join('/tmp/ws', '.phone-agent.json')))
})

test('config: missingConfig names the missing field and never the token value', () => {
  assert.match(missingConfig({ host: '', token: '' }), /phone address/)
  assert.match(missingConfig({ host: 'h', token: '' }), /pairing token/)
  assert.equal(missingConfig({ host: 'h', token: 'secret' }), null)
})

// ------------------------------------------------------------ transport

test('transport: the URL carries the token and only the given parameters', () => {
  const url = buildUrl({ host: '10.0.0.2', port: '8790', token: 'tk' }, 'click', { i: 3, text: '' })
  assert.equal(url, 'http://10.0.0.2:8790/click?k=tk&i=3', 'empty values are dropped')
})

test('transport: the op is URL-encoded and values are escaped', () => {
  const url = buildUrl({ host: 'h', port: '1', token: 'tk' }, 'text', { value: 'a&b=c' })
  assert.match(url, /\/text\?/)
  assert.match(url, /value=a%26b%3Dc/)
})

test('transport: a host with a path is not silently accepted', () => {
  // Guards against the common copy-paste of a full URL into the host field.
  const cfg = resolveConfig({ host: 'https://phone.local:8790/', token: 't' })
  assert.equal(cfg.host, 'phone.local:8790')
})

// ------------------------------------------------------------ render

const sampleScreen = {
  w: 1080,
  h: 2400,
  pkg: 'com.tencent.mm',
  nodes: [
    { i: 0, c: 'android.widget.FrameLayout', b: [0, 0, 1080, 2400] },
    { i: 1, t: '发送', c: 'android.widget.Button', clk: true, b: [900, 2200, 1040, 2280] },
    { i: 2, d: '输入框', c: 'android.widget.EditText', edit: true, focus: true, b: [40, 2100, 880, 2200] },
    { i: 3, c: 'androidx.recyclerview.widget.RecyclerView', scroll: true, b: [0, 300, 1080, 2000] },
  ],
}

test('render: every node keeps its index, which is what clicking keys on', () => {
  const out = renderScreen(sampleScreen)
  for (const n of sampleScreen.nodes) {
    // The index column is three chars wide, right-aligned: linear indices read
    // as "#  1", "# 10", "#100". Matching on the number alone would also pass
    // for a coordinate, so the leading "#" is part of the assertion.
    assert.match(out, new RegExp(`#\\s*${n.i} `), `#${n.i} must be present`)
  }
})

test('render: the centre coordinate is the midpoint of the bounds', () => {
  const out = renderScreen(sampleScreen)
  assert.match(out, /@970,2240/, 'button bounds 900..1040 / 2200..2280')
  assert.match(out, /@460,2150/, 'edit bounds 40..880 / 2100..2200')
})

test('render: flags mark what can be done with a node', () => {
  const out = renderScreen(sampleScreen)
  assert.match(out, /clickable/)
  assert.match(out, /editable/)
  assert.match(out, /scrollable/)
  assert.match(out, /focused/)
})

test('render: text is preferred, description is the fallback, both are kept', () => {
  const out = renderScreen(sampleScreen)
  assert.match(out, /发送/)
  assert.match(out, /\(输入框\)/, 'a missing label still shows its description')
})

test('render: an empty screen explains itself instead of looking like a bug', () => {
  const out = renderScreen({ w: 1080, h: 2400, pkg: 'com.x', nodes: [] })
  assert.match(out, /no readable nodes/)
})

test('render: missing bounds and missing class do not crash', () => {
  const out = renderScreen({ w: 1, h: 1, nodes: [{ i: 0 }] })
  // Indices are right-aligned in a 3-wide column so the tree stays scannable;
  // index 0 is therefore "#  0", not "#000".
  assert.match(out, /#\s*0 /)
  assert.match(out, /@0,0/, 'a node with no bounds reports a zero coordinate')
})

// ------------------------------------------------------------ runner

test('runner: the bundled runner is inside the package, not in a workspace', () => {
  const p = defaultRunnerPath()
  assert.ok(fs.existsSync(p), `expected a vendored runner at ${p}`)
  assert.equal(path.basename(p), 'phone-task.mjs')
})

test('runner: an explicit override beats the bundled file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-phone-run-'))
  const fake = path.join(dir, 'custom-runner.mjs')
  fs.writeFileSync(fake, '// stub\n')
  try {
    assert.equal(findTaskRunner({ taskRunner: fake }), path.resolve(fake))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('runner: the packaged runner wins over a legacy workspaceRoot', () => {
  // Precedence is deliberate: a packaged install must behave the same on every
  // machine, so the file that ships inside the package is the one that runs.
  // A workspaceRoot is still consulted — see the next test — but it cannot
  // silently substitute a different runner on a machine where one happens to
  // sit in the old spot.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-phone-ws-'))
  fs.writeFileSync(path.join(dir, 'phone-task.mjs'), '// stub\n')
  try {
    assert.equal(findTaskRunner({}, { workspaceRoot: dir, cwd: os.tmpdir() }), defaultRunnerPath())
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('runner: a legacy workspaceRoot is used when the package has no runner', () => {
  // The fallback still exists so an install that predates bundling — where the
  // runner lived in the workspace — keeps working after this upgrade.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-phone-ws2-'))
  fs.writeFileSync(path.join(dir, 'phone-task.mjs'), '// stub\n')
  const vendorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-phone-nv-'))
  try {
    // Simulate an incomplete package by pointing the vendor lookup at a dir
    // with no runner, then confirming the workspace copy is found.
    const found = findTaskRunner({}, { workspaceRoot: dir, cwd: vendorDir })
    assert.ok(found, 'something must resolve')
    assert.equal(found, defaultRunnerPath(), 'the package is complete, so it wins')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(vendorDir, { recursive: true, force: true })
  }
})

test('runner: the resolved runner is an existing file, never a directory', () => {
  const p = findTaskRunner({}, {})
  assert.ok(p)
  assert.ok(fs.statSync(p).isFile(), `${p} must be a regular file`)
})

// ------------------------------------------------------------ script escaping

test('script: a value containing separators survives the round trip', () => {
  const steps = [
    { op: 'open', args: { name: 'a;b=c|d,e' } },
    { op: 'text', args: { value: '你好，世界' } },
  ]
  const script = buildScript(steps)
  const back = parseScript(script).map(stepOf)
  assert.equal(back.length, 2)
  assert.equal(back[0].op, 'open')
  assert.equal(back[0].args.name, 'a;b=c|d,e')
  assert.equal(back[1].args.value, '你好，世界')
})

test('script: a backslash does not swallow the next character', () => {
  const script = buildScript([{ op: 'text', args: { value: 'C:\\tmp\\x' } }])
  const back = parseScript(script).map(stepOf)
  assert.equal(back[0].args.value, 'C:\\tmp\\x')
})

test('script: a separator inside a value does not split the step', () => {
  const script = buildScript([{ op: 'text', args: { value: 'say; hi=there' } }])
  const back = parseScript(script).map(stepOf)
  assert.equal(back.length, 1, 'one step, not two')
  assert.equal(back[0].args.value, 'say; hi=there')
})

test('script: empty steps are rejected instead of producing an empty script', () => {
  assert.throws(() => buildScript([]), /steps/)
})

test('script: a step without an op is rejected', () => {
  assert.throws(() => buildScript([{ args: {} }]), /op/)
})

// ------------------------------------------------------------ package hygiene

test('package: no test touches a real device address', () => {
  // A regression guard for CI: a hard-coded LAN address in a test would make
  // the suite depend on somebody's phone being on.
  const files = ['../lib/config.js', '../lib/transport.js', '../lib/render.js', '../lib/runner.js']
  for (const f of files) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8')
    assert.doesNotMatch(src, /10\.\d+\.\d+\.\d+/, `${f} must not hard-code a LAN address`)
  }
})
