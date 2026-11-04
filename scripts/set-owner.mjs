#!/usr/bin/env node
/**
 * Sets the GitHub owner in every place the package mentions it.
 *
 *   node scripts/set-owner.mjs <github-username>
 *   node scripts/set-owner.mjs --check        # report what is still a placeholder
 *
 * Why a script instead of a find-and-replace note in the README: the owner
 * appears in package.json, both READMEs and the CI badge, and a single missed
 * spot means a published package pointing at a 404.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')

const PLACEHOLDER = 'YOUR-NAME'
const TARGETS = ['package.json', 'README.md', 'README.zh-CN.md']

const arg = process.argv[2]

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'))
}

function placesWithPlaceholder() {
  const hits = []
  for (const file of TARGETS) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
    if (text.includes(PLACEHOLDER)) hits.push(file)
  }
  return hits
}

if (!arg || arg === '--check') {
  const pkg = readJson('package.json')
  const owner = pkg.repository && pkg.repository.url
    ? pkg.repository.url.replace(/^git\+/, '').split('/').slice(-2)[0]
    : '(none)'
  const hits = placesWithPlaceholder()
  console.log(`repository: ${pkg.repository ? pkg.repository.url : '(missing)'}`)
  console.log(`owner: ${owner}`)
  if (hits.length) {
    console.log(`placeholder "${PLACEHOLDER}" still present in: ${hits.join(', ')}`)
    console.log('run: node scripts/set-owner.mjs <github-username>')
    process.exit(1)
  }
  console.log('no placeholders left')
  process.exit(0)
}

const owner = arg.replace(/^@/, '').trim()
if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
  console.error(`not a plausible GitHub username: ${owner}`)
  process.exit(1)
}

for (const file of TARGETS) {
  const abs = path.join(ROOT, file)
  if (!fs.existsSync(abs)) continue
  const before = fs.readFileSync(abs, 'utf8')
  const after = before.split(PLACEHOLDER).join(owner)
  if (after !== before) {
    fs.writeFileSync(abs, after)
    console.log(`updated ${file}`)
  }
}

const pkg = readJson('package.json')
console.log(`\nrepository.url: ${pkg.repository.url}`)
console.log('remember to also add the CI badge owner if you changed your mind later;')
console.log('this script is idempotent for the current owner.')
