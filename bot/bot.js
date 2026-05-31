/**
 * Lichess/Chess.com auto-play bot
 * Uses Playwright (installed Chrome) + Stockfish native binary.
 *
 * Setup:
 *   1. npm install
 *   2. Put stockfish.exe in this folder
 *   3. node bot.js
 *
 * Env vars:
 *   DEPTH=18   starting depth (default 18)
 *   SITE=lichess | chess (default lichess)
 *
 * Console commands while running:
 *   d 12       set depth to 12
 *   s 10       set skill level (0-20)
 */

'use strict'

const { chromium } = require('playwright')
const { Chess }    = require('chess.js')
const { spawn }    = require('child_process')
const readline     = require('readline')
const path         = require('path')

let DEPTH = parseInt(process.env.DEPTH || '18')
let SKILL = 20
const SITE = (process.env.SITE || 'lichess').toLowerCase()

// ─────────────────────────────────────────────────────────────────────────────
// Console commands handler
// ─────────────────────────────────────────────────────────────────────────────
function startCommandListener() {
  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    const [cmd, val] = line.trim().split(' ')
    if (cmd === 'd' && val) {
      DEPTH = parseInt(val)
      console.log(`\n→ Depth = ${DEPTH}`)
    } else if (cmd === 's' && val) {
      SKILL = Math.min(20, Math.max(0, parseInt(val)))
      console.log(`\n→ Skill = ${SKILL}`)
    } else if (line.trim()) {
      console.log('Команды: d <глубина>   s <скилл 0-20>')
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Human-like delay based on remaining time
// ─────────────────────────────────────────────────────────────────────────────
function humanDelay(remainingSecs) {
  // panic: < 10 sec
  if (remainingSecs !== null && remainingSecs < 10) {
    return 80 + Math.random() * 150
  }
  // bullet mode (< 30 sec left or < 60 sec total): super fast
  if (remainingSecs !== null && remainingSecs < 30) {
    return 150 + Math.random() * 300
  }

  // Random delay profile: sometimes instant, sometimes thinking
  const r = Math.random()
  if (r < 0.15) return 200  + Math.random() * 300   // quick reply
  if (r < 0.60) return 500  + Math.random() * 1000  // normal
  if (r < 0.85) return 1200 + Math.random() * 1500  // thinking
  return 2500 + Math.random() * 2500                 // long think
}

// ─────────────────────────────────────────────────────────────────────────────
// Read remaining clock time (seconds) for the bottom player
// ─────────────────────────────────────────────────────────────────────────────
async function readClockSecs(page) {
  return page.evaluate(() => {
    const el = document.querySelector(
      '.rclock-bottom .time, .rclock.rclock-bottom time, .clock__time'
    )
    if (!el) return null
    const text = el.textContent.trim().replace(/[^\d:.]/g, '')
    const parts = text.split(':')
    if (parts.length < 2) return null
    return parseFloat(parts[0]) * 60 + parseFloat(parts[1])
  }).catch(() => null)
}

// ─────────────────────────────────────────────────────────────────────────────
// Stockfish engine
// ─────────────────────────────────────────────────────────────────────────────
async function initEngine() {
  const sfExe = path.join(__dirname, 'stockfish.exe')
  const proc  = spawn(sfExe)

  let bestMoveCb = null
  let readyOkCb  = null
  let buf        = ''

  proc.on('error', (err) => {
    console.error('\nНе найден stockfish.exe:', err.message)
    process.exit(1)
  })

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
  send(`setoption name Skill Level value ${SKILL}`)

  console.log('Engine ready (Stockfish native)\n')
  console.log('Команды прямо здесь: d <глубина>  s <скилл 0-20>')
  console.log('Пример: d 12   или   s 8\n')

  return {
    getBestMove(fen) {
      return new Promise(res => {
        bestMoveCb = res
        send('stop')
        send(`setoption name Skill Level value ${SKILL}`)
        send(`position fen ${fen}`)
        send(`go depth ${DEPTH}`)
      })
    },
    quit() { send('quit') },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Read game state from DOM
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
// Click square
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
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔═══════════════════════════════╗')
  console.log('║    Stockfish 18 Chess Bot     ║')
  console.log(`║  Depth: ${String(DEPTH).padEnd(4)} Skill: ${String(SKILL).padEnd(6)}     ║`)
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

  const engine = await initEngine()
  startCommandListener()

  // Outer loop: новые партии
  while (true) {
    console.log('\nЖду партию...')
    await page.locator(boardSel).first().waitFor({ timeout: 0 })

    // Ждём пока страница полностью прогрузит новую игру
    await page.waitForTimeout(1500)

    // Проверяем что это активная игра, а не анализ/пазл
    let initialState
    try { initialState = await readState(page) } catch { await page.waitForTimeout(2000); continue }
    if (initialState.gameOver) { await page.waitForTimeout(2000); continue }

    const { isFlipped: fl } = initialState
    const myColor = fl ? 'b' : 'w'
    console.log(`Играю за: ${myColor === 'w' ? '♔ Белых' : '♚ Чёрных'} | Depth:${DEPTH} Skill:${SKILL}`)

    let lastFen = ''

    // Inner loop: игра
    while (true) {
      await page.waitForTimeout(250)

      let state
      try { state = await readState(page) } catch { break }  // навигация → выходим
      const { sanMoves, isFlipped: flipped, gameOver } = state
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
      process.stdout.write(`Ход ${moveNum} [d${DEPTH}s${SKILL}] | Думаю... `)

      const t0      = Date.now()
      const uciMove = await engine.getBestMove(fen)
      const ms      = Date.now() - t0

      if (!uciMove) { console.log('(нет хода)'); continue }

      const from  = uciMove.slice(0, 2)
      const to    = uciMove.slice(2, 4)
      const promo = uciMove[4] || null

      // Читаем оставшееся время и считаем задержку
      const secs  = isLichess ? await readClockSecs(page) : null
      const delay = humanDelay(secs)

      console.log(`${from}→${to} (думал:${ms}мс задержка:${Math.round(delay)}мс${secs !== null ? ` осталось:${Math.round(secs)}с` : ''})`)

      await page.waitForTimeout(delay)

      const boardBox = await page.locator(boardSel).first().boundingBox()
      if (!boardBox) { console.log('Доска исчезла'); break }

      await clickSquare(page, from, boardBox, flipped)
      await page.waitForTimeout(60 + Math.random() * 80)
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

    await page.waitForTimeout(2000)
  }
}

main().catch(err => { console.error('\nОшибка:', err.message); process.exit(1) })
