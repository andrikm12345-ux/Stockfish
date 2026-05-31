/**
 * Lichess auto-play bot
 * Uses Playwright to control the browser + Stockfish 18 for moves.
 *
 * Usage:
 *   cd bot && npm install && npx playwright install chromium
 *   node bot.js
 *
 * Optional env vars:
 *   DEPTH=18        Stockfish search depth (default 18)
 *   DELAY=600       Min ms delay before playing (default 600)
 *   SITE=lichess    Target site: lichess | chess (default lichess)
 */

'use strict'

const { chromium } = require('playwright')
const { Chess }    = require('chess.js')

const DEPTH = parseInt(process.env.DEPTH  || '18')
const DELAY = parseInt(process.env.DELAY  || '600')
const SITE  = (process.env.SITE || 'lichess').toLowerCase()

// ─────────────────────────────────────────────────────────────────────────────
// Stockfish engine (runs in-process via WASM)
// ─────────────────────────────────────────────────────────────────────────────
async function initEngine() {
  const sf = require('stockfish')
  const module = await sf()               // wait for WASM to load

  let bestMoveCb = null
  let readyOkCb  = null

  // All output from stockfish comes through module.listener
  module.listener = (line) => {
    if (line === 'readyok' && readyOkCb) { readyOkCb(); readyOkCb = null }
    if (line.startsWith('bestmove') && bestMoveCb) {
      const move = line.split(' ')[1]
      const cb = bestMoveCb
      bestMoveCb = null
      cb(move === '(none)' ? null : move)
    }
  }

  const send = (cmd) => module.processCommand(cmd)

  // Warm up
  await new Promise(res => { readyOkCb = res; send('uci'); send('isready') })
  send('setoption name Skill Level value 20')

  console.log('Engine ready (Stockfish 18 WASM)\n')

  return {
    getBestMove(fen) {
      return new Promise(res => {
        bestMoveCb = res
        send('stop')
        send(`position fen ${fen}`)
        send(`go depth ${DEPTH}`)
      })
    },
    quit() { send('quit') },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Read game state from the page DOM
// ─────────────────────────────────────────────────────────────────────────────
async function readLichessState(page) {
  return page.evaluate(() => {
    // ── Move list ────────────────────────────────────────────────────────────
    // Try multiple selectors – Lichess changes its markup sometimes
    const moveCandidates = [
      ...document.querySelectorAll('l4x kwdb'),   // current Lichess
      ...document.querySelectorAll('kwdb'),
      ...document.querySelectorAll('.moves move san'),
      ...document.querySelectorAll('move san'),
    ]

    // Deduplicate and extract SAN text
    const seen = new Set()
    const sanMoves = []
    for (const el of moveCandidates) {
      if (!seen.has(el)) {
        seen.add(el)
        const text = el.textContent.replace(/[?!]+/g, '').trim()
        if (text) sanMoves.push(text)
      }
    }

    // ── Orientation ──────────────────────────────────────────────────────────
    const isFlipped = !!document.querySelector('.cg-wrap.orientation-black')

    // ── Game over ────────────────────────────────────────────────────────────
    const gameOver = !!(
      document.querySelector('.result-wrap .result') ||
      document.querySelector('[class*="endgame"]') ||
      document.querySelector('.game-over') ||
      document.querySelector('.status[class*="ended"]')
    )

    return { sanMoves, isFlipped, gameOver }
  })
}

async function readChessComState(page) {
  return page.evaluate(() => {
    const isFlipped = !!document.querySelector('.board.flipped, .board-layout-bottom .board-flipped')

    // Chess.com move list
    const moveCandidates = document.querySelectorAll(
      '.node.selected ~ .node .figurine-san, .move .node .san, [data-ply] .san'
    )

    const sanMoves = Array.from(document.querySelectorAll('[data-ply]'))
      .sort((a, b) => +a.dataset.ply - +b.dataset.ply)
      .map(el => el.querySelector('.san, figurine-san')?.textContent?.trim())
      .filter(Boolean)

    const gameOver = !!document.querySelector('.game-over-modal-content, .game-result')

    return { sanMoves, isFlipped, gameOver }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Click a square on the chessboard
// ─────────────────────────────────────────────────────────────────────────────
async function clickSquare(page, square, boardBox, isFlipped, boardSelector) {
  const file = square.charCodeAt(0) - 97  // a→0  h→7
  const rank = parseInt(square[1]) - 1    // 1→0  8→7
  const sz   = boardBox.width / 8

  const x = boardBox.x + (isFlipped ? (7 - file) : file)       * sz + sz / 2
  const y = boardBox.y + (isFlipped ? rank        : (7 - rank)) * sz + sz / 2

  await page.mouse.click(x, y)
}

// ─────────────────────────────────────────────────────────────────────────────
// Main loop
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔═══════════════════════════════╗')
  console.log('║    Stockfish 18 Chess Bot     ║')
  console.log(`║  Depth: ${String(DEPTH).padEnd(4)} Delay: ${String(DELAY).padEnd(5)}ms  ║`)
  console.log('╚═══════════════════════════════╝\n')

  const isLichess  = SITE === 'lichess'
  const siteUrl    = isLichess ? 'https://lichess.org' : 'https://www.chess.com'
  const boardSel   = isLichess ? 'cg-board' : '.board'
  const readState  = isLichess ? readLichessState : readChessComState

  const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--start-maximized'] })
  const page    = await browser.newPage()
  await page.goto(siteUrl)

  console.log(`Opened ${siteUrl}`)
  console.log('👉 Log in, start (or join) a game, then press ENTER here...\n')
  await new Promise(r => process.stdin.once('data', r))

  await page.waitForSelector(boardSel, { timeout: 60_000 })

  const { isFlipped } = await readState(page)
  const myColor = isFlipped ? 'b' : 'w'
  console.log(`Playing as: ${myColor === 'w' ? '♔ White' : '♚ Black'}`)
  console.log('Bot running. Ctrl+C to stop.\n')

  const engine  = await initEngine()
  let   lastFen = ''

  while (true) {
    await page.waitForTimeout(300)

    const { sanMoves, isFlipped: flipped, gameOver } = await readState(page)

    if (gameOver) { console.log('🏁 Game over.'); break }

    // Reconstruct position from move list
    const chess = new Chess()
    for (const san of sanMoves) {
      try { chess.move(san) } catch {}
    }

    const fen = chess.fen()
    if (fen === lastFen) continue
    lastFen = fen

    if (chess.turn() !== myColor) continue   // opponent's turn
    if (chess.isGameOver()) break

    const moveNum = Math.ceil(chess.history().length / 2) + 1
    process.stdout.write(`Move ${moveNum} | Thinking... `)

    const t0      = Date.now()
    const uciMove = await engine.getBestMove(fen)
    const ms      = Date.now() - t0

    if (!uciMove) { console.log('(no move)'); continue }

    const from  = uciMove.slice(0, 2)
    const to    = uciMove.slice(2, 4)
    const promo = uciMove[4] || null

    console.log(`${from}→${to} (${ms}ms)`)

    // Human-like delay
    await page.waitForTimeout(DELAY + Math.random() * 400)

    const boardBox = await page.locator(boardSel).boundingBox()
    if (!boardBox) { console.log('Board disappeared'); continue }

    await clickSquare(page, from, boardBox, flipped)
    await page.waitForTimeout(80 + Math.random() * 60)
    await clickSquare(page, to, boardBox, flipped)

    // Promotion: always queen
    if (promo) {
      await page.waitForTimeout(300)
      const qBtn = isLichess
        ? page.locator('.promotion-choice piece.queen').first()
        : page.locator('.promotion-piece[data-piece="q"]').first()
      if (await qBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await qBtn.click()
      }
    }
  }

  engine.quit()
  console.log('\nBot stopped. Browser stays open.')
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1) })
