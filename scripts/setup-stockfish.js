const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const publicDir = path.join(root, 'public')
const destJs = path.join(publicDir, 'stockfish.js')
const destWasm = path.join(publicDir, 'stockfish.wasm')

fs.mkdirSync(publicDir, { recursive: true })

const bin = path.join(root, 'node_modules', 'stockfish', 'bin')

// Prefer lite-single (NNUE, 7MB wasm, no SharedArrayBuffer needed)
// Fall back to asm.js (pure JS, ~11MB, no wasm at all)
const candidates = [
  {
    js:   path.join(bin, 'stockfish-18-lite-single.js'),
    wasm: path.join(bin, 'stockfish-18-lite-single.wasm'),
    label: 'Stockfish 18 lite-single (NNUE WASM)',
  },
  {
    js:   path.join(bin, 'stockfish-18-lite.js'),
    wasm: path.join(bin, 'stockfish-18-lite.wasm'),
    label: 'Stockfish 18 lite (NNUE WASM multi)',
  },
  {
    js:   path.join(bin, 'stockfish-18-asm.js'),
    wasm: null,
    label: 'Stockfish 18 asm.js (pure JS fallback)',
  },
  // v10 fallback
  {
    js:   path.join(root, 'node_modules', 'stockfish', 'src', 'stockfish.js'),
    wasm: null,
    label: 'Stockfish 10 (legacy fallback)',
  },
  {
    js:   path.join(root, 'node_modules', 'stockfish', 'stockfish.js'),
    wasm: null,
    label: 'Stockfish (root fallback)',
  },
]

for (const { js, wasm, label } of candidates) {
  if (!fs.existsSync(js)) continue
  if (wasm && !fs.existsSync(wasm)) continue

  fs.copyFileSync(js, destJs)
  if (wasm) fs.copyFileSync(wasm, destWasm)

  console.log(`✓ ${label}`)
  console.log(`  JS   -> public/stockfish.js (${(fs.statSync(destJs).size / 1024).toFixed(0)} KB)`)
  if (wasm) console.log(`  WASM -> public/stockfish.wasm (${(fs.statSync(destWasm).size / 1024 / 1024).toFixed(1)} MB)`)
  process.exit(0)
}

console.error('✗ Could not find any stockfish build')
process.exit(1)
