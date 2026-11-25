/**
 * skill-cleanup — 归档 R45 遗留的「工具序列壳子」skill（R48）。
 *
 * - 只归档 source=sequence 且名字/描述是工具序列的 skill；
 * - 移到 <skills 根>-archive/<name>（兄弟目录，不删除），写 manifest.json；
 * - 人工 register（source=manual）与 capability/task skill 一律不动；
 * - 可重复执行：第二次运行归档 0 条。
 *
 * Usage:
 *   node --experimental-transform-types scripts/skill-cleanup.mjs [--dry-run]
 *         [--dsh-home <dir>] [--root <skills-dir> ...]
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

if (!process.execArgv.includes('--experimental-transform-types')) {
  const { spawnSync } = await import('node:child_process')
  const child = spawnSync(process.execPath, ['--experimental-transform-types', process.argv[1], ...process.argv.slice(2)], { stdio: 'inherit' })
  process.exit(child.status ?? 1)
}

const { archiveShellSkills, discoverSkillRoots } = await import('../src/skill-forge.ts')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const roots = []
let dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg === '--root') {
    const value = args[index + 1]
    if (!value) { console.error('--root 需要目录参数'); process.exit(2) }
    roots.push(resolve(value))
    index += 1
  } else if (arg === '--dsh-home') {
    const value = args[index + 1]
    if (!value) { console.error('--dsh-home 需要目录参数'); process.exit(2) }
    dshHome = resolve(value)
    index += 1
  }
}

if (roots.length === 0) {
  roots.push(...discoverSkillRoots({ dshHome, cwd: process.cwd() }))
}
if (roots.length === 0) {
  console.log(JSON.stringify({ dryRun, dshHome, roots: [], totalScanned: 0, totalArchived: 0, archived: [] }, null, 2))
  process.exit(0)
}
const result = await archiveShellSkills({ roots, now: Date.now(), dryRun })
console.log(JSON.stringify({ dryRun, dshHome, ...result }, null, 2))
