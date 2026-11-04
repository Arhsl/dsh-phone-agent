/**
 * Locates the bundled task runner and runs a task through it.
 *
 * Why this is its own module: `phone_task` spawns a child process, and the
 * path to that file is the one thing that breaks when the plugin moves from a
 * checkout into node_modules. Resolving it next to this module — instead of by
 * walking up from the plugin directory or trusting cwd — makes the packaged
 * layout work with no configuration at all.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** The runner ships inside the package under vendor/. */
export function defaultRunnerPath() {
  return path.join(HERE, '..', 'vendor', 'phone-task.mjs')
}

/**
 * Candidate paths, most explicit first:
 *   1. config.taskRunner   — an absolute override, for development
 *   2. vendor/phone-task.mjs next to this package
 *   3. a workspaceRoot recorded beside the credentials
 *
 * The workspaceRoot entry survives from the pre-packaged layout, where the
 * runner lived in the workspace rather than in the package. Keeping it means
 * an existing install keeps working; new installs never need it.
 */
export function findTaskRunner(config, options) {
  const candidates = []
  const explicit = config && config.taskRunner
  if (explicit) candidates.push(path.resolve(String(explicit)))
  candidates.push(defaultRunnerPath())

  const root = options && options.workspaceRoot
  if (root) candidates.push(path.join(path.resolve(String(root)), 'phone-task.mjs'))

  const cwd = (options && options.cwd) || process.cwd()
  candidates.push(path.join(cwd, 'phone-task.mjs'))

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p
    } catch (err) {}
  }
  return null
}

/**
 * Runs the task file through node and summarises the result.
 *
 * The runner prints a human-readable log; that text is what gets surfaced,
 * because the point of this mode is that the user reads a report rather than
 * replaying the steps. The last lines carry the failing step and the artifact
 * paths, so they are passed through rather than re-summarised.
 */
export function runTask(runner, task, options) {
  const opts = options || {}
  return new Promise((resolve) => {
    const inline = JSON.stringify(task)
    const childArgs = [runner, '--inline', inline]
    if (opts.restore === false) childArgs.push('--no-restore')
    if (opts.batch === false) childArgs.push('--no-batch')

    let child
    try {
      child = spawn(process.execPath, childArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: opts.env || process.env,
        cwd: opts.cwd,
      })
    } catch (err) {
      resolve({ ok: false, message: 'Failed to start the runner: ' + (err.message || err) })
      return
    }

    let out = ''
    let err = ''
    const cap = 200 * 1024
    child.stdout.on('data', (d) => {
      if (out.length < cap) out += d.toString()
    })
    child.stderr.on('data', (d) => {
      if (err.length < cap) err += d.toString()
    })

    // The runner enforces its own 10-minute ceiling; this is the outer guard
    // for the case where it hangs before reaching that check.
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch (e) {}
    }, 11 * 60 * 1000)

    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, message: 'Runner error: ' + (e.message || e) })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      const log = out.trim()
      const tail = log.split('\n').slice(-12).join('\n')
      if (code === 0) {
        return resolve({
          ok: true,
          message: `Task finished: ${task.name}\n\n${tail}`,
          log,
        })
      }
      const why = err.trim() ? '\n' + err.trim().split('\n').slice(-4).join('\n') : ''
      resolve({
        ok: false,
        message: `Task did not complete: ${task.name}\n\n${tail}${why}`,
        log,
      })
    })
  })
}
