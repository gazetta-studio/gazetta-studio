// build: write agents/ from agents-src/ with this package's version in place
// of {{version}}. The skill and the AGENTS.md section carry the version so an
// agent can tell its installed copy is older (design-agent-access.md Q33, Q34).
// agents/ is generated and gitignored; agents-src/ is the source.
import { cpSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
const source = join(root, 'agents-src')
const target = join(root, 'agents')

rmSync(target, { recursive: true, force: true })
cpSync(source, target, { recursive: true })
const stamp = dir => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) stamp(path)
    else writeFileSync(path, readFileSync(path, 'utf-8').replaceAll('{{version}}', version))
  }
}
stamp(target)
