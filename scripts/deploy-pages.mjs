// Builds the app and pushes dist/ to the gh-pages branch (GitHub Pages hosting).
// Usage: node scripts/deploy-pages.mjs
import { execSync } from 'child_process'
import { writeFileSync, rmSync } from 'fs'

const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts })

run('npm run build')
writeFileSync('dist/.nojekyll', '')
rmSync('dist/.git', { recursive: true, force: true })
run('git init -q', { cwd: 'dist' })
run('git checkout -qb gh-pages', { cwd: 'dist' })
run('git add -A', { cwd: 'dist' })
run('git -c user.name=Pusher056 -c user.email=Ra1s3n056@hotmail.com commit -qm "Deploy build"', { cwd: 'dist' })
run('git push -f https://github.com/Pusher056/mgce-inventory.git gh-pages', { cwd: 'dist' })
rmSync('dist/.git', { recursive: true, force: true })
console.log('\nDeployed: https://pusher056.github.io/mgce-inventory/')
