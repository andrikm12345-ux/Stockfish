/**
 * Lichess/Chess.com auto-play bot
 * Uses Playwright (your installed Chrome) + Stockfish native binary.
 *
 * Setup:
 *   1. npm install
 *   2. Download stockfish.exe from https://stockfishchess.org/download/
 *      and place it in this folder (next to bot.js)
 *   3. node bot.js
 *
 * Optional env vars:
 *   DEPTH=18        Stockfish search depth (default 18)
 *   DELAY=600       Min ms delay before playing (default 600)
 *   SITE=lichess    Target site: lichess | chess (default lichess)
 */

'use strict'

const { chromium } = require('playwright')
const { Chess }    = require('chess.js')
const { spawn }    = require('child_process')
const path         = require('path')

const DEPTH = parseInt(process.env.DEPTH || '18')
const DELAY = parseInt(process.env.DELAY || '600')
const SITE  = (process.env.SITE || 'lichess').toLowerCase()

// ─────────────────────────────────────────────────────────────────────────────
// Stockfish engine (native exe via child_process)
// ─────────────────────────────────────────────────────────────────────────────
async function initEngine() {
  const sfExe = path.join(__dirname, 'stockfish.exe')
  const proc  = spawn(sfExe)

  let bestMoveCb = null
  let readyOkCb  = null
  let buf        = ''

  proc.stdout.on('data', (data) => {
    buf += data.toString()
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const raw of lines) {
      const line = raw.trim()
      if (line === 'readyok' && readyOkCb) { readyOkCb(); readyOkCb = null }
      if (line.startsWith('bestmove') && bestMoveCb) {
        const move = line.split(' ')[1]
        const cb = bestMoveCb
        bestMoveCb = null
        cb(move === '(none)' || !move ? null : move)
      }
    }
  })

  proc.stderr.on('data', () => {})

  const send = (cmd) => proc.stdin.write(cmd + '\n')

  await new Promise(res => { readyOkCb = res; send('uci'); send('isready') })
  send('setoption name Skill Level value 20')

  console.log('Engine ready (Stockfish native)\n')

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
    const moveCandidates = [
      ...document.querySelectorAll('l4x kwdb'),
      ...document.querySelectorAll('kwdb'),
      ...document.querySelectorAll('.moves move san'),
      ...document.querySelectorAll('move san'),
    ]
    const seen = new Set()
    const sanMoves = []
    for (const el of moveCandidates) {
      if (!seen.has(el)) {
        seen.add(el)
        const text = el.textContent.replace(/[?!]+/g, '').trim()
        if (text) sanMoves.push(text)
      }
    }
    const isFlipped = !!document.querySelector('.cg-wrap.orientation-black')
    const gameOver  = !!(
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
    const sanMoves  = Array.from(document.querySelectorAll('[data-ply]'))
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
async function clickSquare(page, square, boardBox, isFlipped) {
  const file = square.charCodeAt(0) - 97
  const rank = parseInt(square[1]) - 1
  const sz   = boardBox.width / 8
  const x    = boardBox.x + (isFlipped ? (7 - file) : file)        * sz + sz / 2
  const y    = boardBox.y + (isFlipped ? rank        : (7 - rank)) * sz + sz / 2
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

  const isLichess = SITE === 'lichess'
  const siteUrl   = isLichess ? 'https://lichess.org' : 'https://www.chess.com'
  const boardSel  = isLichess ? 'cg-board' : '.board'
  const readState = isLichess ? readLichessState : readChessComState

  const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--start-maximized'] })
  const page    = await browser.newPage()
  await page.goto(siteUrl)

  console.log(`Opened ${siteUrl}`)
  console.log('Войди в аккаунт, начни игру, потом нажми ENTER здесь...\n')
  await new Promise(r => process.stdin.once('data', r))

  await page.waitForSelector(boardSel, { timeout: 60_000 })

  const { isFlipped } = await readState(page)
  const myColor = isFlipped ? 'b' : 'w'
  console.log(`Играю за: ${myColor === 'w' ? '♔ Белых' : '♚ Чёрных'}`)
  console.log('Бот запущен. Ctrl+C для остановки.\n')

  const engine  = await initEngine()
  let   lastFen = ''

  while (true) {
    await page.waitForTimeout(300)

    const { sanMoves, isFlipped: flipped, gameOver } = await readState(page)

    if (gameOver) { console.log('Игра окончена.'); break }

    const chess = new Chess()
    for (const san of sanMoves) {
      try { chess.move(san) } catch {}
    }

    const fen = chess.fen()
    if (fen === lastFen) continue
    lastFen = fen

    if (chess.turn() !== myColor) continue
    if (chess.isGameOver()) break

    const moveNum = Math.ceil(chess.history().length / 2) + 1
    process.stdout.write(`Ход ${moveNum} | Думаю... `)

    const t0      = Date.now()
    const uciMove = await engine.getBestMove(fen)
    const ms      = Date.now() - t0

    if (!uciMove) { console.log('(нет хода)'); continue }

    const from  = uciMove.slice(0, 2)
    const to    = uciMove.slice(2, 4)
    const promo = uciMove[4] || null

    console.log(`${from}→${to} (${ms}мс)`)

    await page.waitForTimeout(DELAY + Math.random() * 400)

    const boardBox = await page.locator(boardSel).boundingBox()
    if (!boardBox) { console.log('Доска исчезла'); continue }

    await clickSquare(page, from, boardBox, flipped)
    await page.waitForTimeout(80 + Math.random() * 60)
    await clickSquare(page, to, boardBox, flipped)

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
  console.log('\nБот остановлен.')
}

main().catch(err => { console.error('\nОшибка:', err.message); process.exit(1) })
