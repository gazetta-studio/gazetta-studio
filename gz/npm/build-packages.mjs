// Builds the npm packages for gz from a goreleaser dist folder
// (design-agent-access.md Q39): one package per platform holding its binary
// (@gazetta/cli-darwin-arm64 and so on), and @gazetta/cli, which depends on
// them as optional dependencies and starts the one npm installed, the way
// esbuild and Biome ship. goreleaser's open-source edition has no npm
// publisher, so the release workflow runs this and publishes the output.
//
//   node gz/npm/build-packages.mjs <dist> <out> <version>
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [dist, out, version] = process.argv.slice(2)
if (!dist || !out || !version) {
  console.error('usage: node build-packages.mjs <dist> <out> <version>')
  process.exit(2)
}

const OS = { darwin: 'darwin', linux: 'linux', windows: 'win32' }
const CPU = { amd64: 'x64', arm64: 'arm64' }
const common = {
  version,
  license: 'MIT',
  homepage: 'https://gazetta.studio',
  repository: { type: 'git', url: 'git+https://github.com/gazetta-studio/gazetta-studio.git', directory: 'gz' },
}

const binaries = JSON.parse(readFileSync(join(dist, 'artifacts.json'), 'utf8')).filter(
  a => a.type === 'Binary' && a.extra?.ID === 'gz',
)
if (binaries.length === 0) throw new Error(`no gz binaries in ${dist}/artifacts.json`)

const optional = {}
for (const b of binaries) {
  const os = OS[b.goos]
  const cpu = CPU[b.goarch]
  if (!os || !cpu) throw new Error(`unexpected platform ${b.goos}/${b.goarch}`)
  const name = `@gazetta/cli-${os}-${cpu}`
  const exe = b.goos === 'windows' ? 'gz.exe' : 'gz'
  const dir = join(out, `cli-${os}-${cpu}`)
  mkdirSync(join(dir, 'bin'), { recursive: true })
  copyFileSync(b.path, join(dir, 'bin', exe))
  chmodSync(join(dir, 'bin', exe), 0o755)
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name, ...common, description: `gz for ${os} ${cpu}`, os: [os], cpu: [cpu], files: ['bin'] }, null, 2)}\n`,
  )
  optional[name] = version
}

const main = join(out, 'cli')
mkdirSync(join(main, 'bin'), { recursive: true })
writeFileSync(
  join(main, 'bin', 'gz.js'),
  `#!/usr/bin/env node
// Starts the gz binary from the platform package npm installed.
const { spawnSync } = require('node:child_process')
const pkg = \`@gazetta/cli-\${process.platform}-\${process.arch}\`
const exe = process.platform === 'win32' ? 'gz.exe' : 'gz'
let bin
try {
  bin = require.resolve(\`\${pkg}/bin/\${exe}\`)
} catch {
  console.error(\`gz: no build for \${process.platform} \${process.arch} (\${pkg} isn't installed)\`)
  process.exit(1)
}
const result = spawnSync(bin, process.argv.slice(2), { stdio: 'inherit' })
if (result.error) {
  console.error(\`gz: \${result.error.message}\`)
  process.exit(1)
}
process.exit(result.status ?? 1)
`,
)
chmodSync(join(main, 'bin', 'gz.js'), 0o755)
writeFileSync(
  join(main, 'package.json'),
  `${JSON.stringify(
    {
      name: '@gazetta/cli',
      ...common,
      description: 'Edit a Gazetta site through its admin',
      bin: { gz: 'bin/gz.js' },
      files: ['bin'],
      optionalDependencies: optional,
    },
    null,
    2,
  )}\n`,
)
console.log(`Wrote @gazetta/cli and ${binaries.length} platform packages to ${out}`)
