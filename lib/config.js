/**
 * Where the phone credentials come from.
 *
 * Resolution order, first hit wins for each field independently:
 *
 *   1. plugin config      ({ host, token, port, configFile }) — set in the
 *                         profile's cordis.patch.yml
 *   2. environment        DSH_PHONE_HOST / DSH_PHONE_TOKEN / DSH_PHONE_PORT
 *   3. a JSON file        $DSH_HOME/.phone-agent.json, then ./.phone-agent.json
 *
 * One file that the plugin and the bundled task runner both read by an
 * explicit path beats two lookups that happen to agree.
 *
 * Security: the token grants control of the phone. It is read at call time
 * and never logged, and it is only ever sent to the configured host — no
 * tool argument can redirect the request.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_PORT = '8790'

/** Canonical credentials file, shared with the task runner. */
export function canonicalConfigPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, '.phone-agent.json')
}

/**
 * Files to try, in order. The canonical path is first on purpose: the plugin
 * lives in $DSH_HOME/profiles/<name>/node_modules/<pkg>, so walking up from it
 * reaches $DSH_HOME only by coincidence — four levels of coincidence.
 */
export function configCandidates(config, cwd) {
  const out = []
  const explicit = config && config.configFile
  if (explicit) out.push(path.resolve(String(explicit)))
  out.push(canonicalConfigPath())
  if (cwd) out.push(path.join(cwd, '.phone-agent.json'))
  return out.filter((p, i) => out.indexOf(p) === i)
}

function readJsonIfPresent(file) {
  try {
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    return null
  }
}

/**
 * Merges the four sources into one config object.
 *
 * `source` records which file supplied credentials, so a diagnostic can say
 * "the file I read" instead of "somewhere". It stays undefined when the values
 * came from config or the environment.
 */
export function resolveConfig(config, options) {
  const opts = options || {}
  const fromConfig = config || {}

  let host = String(fromConfig.host || process.env.DSH_PHONE_HOST || '')
  let token = String(fromConfig.token || process.env.DSH_PHONE_TOKEN || '')
  let port = String(fromConfig.port || process.env.DSH_PHONE_PORT || '')
  let source

  if (!host || !token || !port) {
    for (const file of configCandidates(config, opts.cwd)) {
      const j = readJsonIfPresent(file)
      if (!j) continue
      host = host || String(j.host || '')
      token = token || String(j.token || '')
      port = port || String(j.port || '')
      if (source === undefined) source = file
      if (host && token && port) break
    }
  }

  // workspaceRoot is carried through from the credentials file for installs
  // that predate the bundled runner: the task runner used to live in the
  // workspace, and an existing setup records where that was. New installs
  // never need it — vendor/phone-task.mjs is resolved next to this package.
  let workspaceRoot = fromConfig.workspaceRoot
  if (!workspaceRoot && source) {
    const j = readJsonIfPresent(source)
    if (j && j.workspaceRoot) workspaceRoot = String(j.workspaceRoot)
  }

  return {
    host: host.trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    token: token.trim(),
    port: String(port || DEFAULT_PORT).trim(),
    source,
    workspaceRoot,
  }
}

/** A sentence the agent can act on, or null when the config is complete. */
export function missingConfig(cfg) {
  if (!cfg.host) {
    return 'No phone address configured. Create $DSH_HOME/.phone-agent.json with '
      + '{"host":"…","token":"…"} (the address is the one the DSH app on the phone '
      + 'shows under 手机 Agent), or set DSH_PHONE_HOST.'
  }
  if (!cfg.token) {
    return 'No pairing token configured. On the phone: DSH app → back-key menu → '
      + '「手机 Agent」→ copy the token, then put it in $DSH_HOME/.phone-agent.json '
      + 'or set DSH_PHONE_TOKEN.'
  }
  return null
}
