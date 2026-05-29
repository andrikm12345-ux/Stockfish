const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const dest = path.join(root, 'public', 'stockfish.js')

if (fs.existsSync(dest)) {
  console.log('stockfish.js already present, skipping copy')
  process.exit(0)
}

const pkgDir = path.join(root, 'node_modules', 'stockfish')

const candidates = [
  path.join(pkgDir, 'stockfish.js'),
  path.join(pkgDir, 'src', 'stockfish.js'),
  path.join(pkgDir, 'dist', 'stockfish.js'),
]

fs.mkdirSync(path.join(root, 'public'), { recursive: true })

for (const src of candidates) {
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest)
    console.log('Stockfish ready:', src, '->', dest)
    process.exit(0)
  }
}

console.error('Could not find stockfish.js. Tried:\n' + candidates.join('\n'))
process.exit(1)
