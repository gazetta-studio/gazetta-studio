import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

// Test files that start processes (the CLI, `gazetta dev`, npm, go). Those
// processes use CPU that Vitest's worker pool doesn't count, so run beside the
// in-process tests they slow them several times over on a 4-core CI runner,
// past the 5 s default (#1766). They run as their own group, after the rest.
const testsDir = join(import.meta.dirname, 'tests')
const spawning = readdirSync(testsDir)
  .filter(f => /\.test\.tsx?$/.test(f))
  .filter(f => /['"](node:)?child_process['"]/.test(readFileSync(join(testsDir, f), 'utf-8')))
  .map(f => `tests/${f}`)

export default defineConfig({
  test: {
    // The suite loads dist/templates-scan-worker.js and imports the built
    // package by name, so it cannot run before `npm run build`. Fail fast
    // with that message instead of an unrelated stack trace. See #1361.
    globalSetup: ['./tests/global-setup.ts'],
    projects: [
      {
        extends: true,
        test: { name: 'in-process', exclude: [...spawning, '**/node_modules/**'], sequence: { groupOrder: 0 } },
      },
      { extends: true, test: { name: 'processes', include: spawning, sequence: { groupOrder: 1 }, maxWorkers: '50%' } },
    ],
  },
})
