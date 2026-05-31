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
 *   d 12          set depth to 12
 *   s 10          set skill level (0-20)
 *   g <url>       перейти на игру по ссылке
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

// Количество ходов которые считаются дебютом (быстрая игра)
const OPENING_MOVES = 14

// ─────────────────────────────────────────────────────────────────────────────
// Книга дебютов — 10 популярных дебютов (SAN, ходы обеих сторон)
// Бот следует им мгновенно, выбирая случайно подходящие линии
// ─────────────────────────────────────────────────────────────────────────────
const OPENINGS = [
  // 1. Испанская партия (Ruy Lopez)
  ['e4','e5','Nf3','Nc6','Bb5','a6','Ba4','Nf6','O-O','Be7','Re1','b5','Bb3','d6','c3','O-O'],
  // 2. Итальянская партия
  ['e4','e5','Nf3','Nc6','Bc4','Bc5','c3','Nf6','d3','d6','O-O','O-O','Re1','a6'],
  // 3. Сицилианская защита (Найдорф)
  ['e4','c5','Nf3','d6','d4','cxd4','Nxd4','Nf6','Nc3','a6','Be2','e5','Nb3','Be7'],
  // 4. Французская защита
  ['e4','e6','d4','d5','Nc3','Nf6','Bg5','Be7','e5','Nfd7','Bxe7','Qxe7'],
  // 5. Защита Каро-Канн
  ['e4','c6','d4','d5','Nc3','dxe4','Nxe4','Bf5','Ng3','Bg6','h4','h6'],
  // 6. Ферзевый гамбит отказанный
  ['d4','d5','c4','e6','Nc3','Nf6','Bg5','Be7','e3','O-O','Nf3','h6'],
  // 7. Староиндийская защита
  ['d4','Nf6','c4','g6','Nc3','Bg7','e4','d6','Nf3','O-O','Be2','e5'],
  // 8. Английское начало
  ['c4','e5','Nc3','Nf6','Nf3','Nc6','g3','d5','cxd5','Nxd5','Bg2','Nb6'],
  // 9. Славянская защита
  ['d4','d5','c4','c6','Nf3','Nf6','Nc3','dxc4','a4','Bf5','e3','e6'],
  // 10. Скандинавская защита
  ['e4','d5','exd5','Qxd5','Nc3','Qa5','d4','Nf6','Nf3','c6','Bc4','Bf5'],
]

// Сравниваем позиции по расстановке/очереди/рокировкам/взятию на проходе
function posKey(fen) {
  return fen.split(' ').slice(0, 4).join(' ')
}

// Подбираем книжный ход для текущей позиции (или null)
function bookMove(chess) {
  const histLen = chess.history().length
  const curKey  = posKey(chess.fen())
  const candidates = []

  for (const line of OPENINGS) {
    if (line.length <= histLen) continue

    // Проигрываем линию до текущего момента
    const test = new Chess()
    let ok = true
    for (let i = 0; i < histLen; i++) {
      try { test.move(line[i]) } catch { ok = false; break }
    }
    if (!ok) continue
    if (posKey(test.fen()) !== curKey) continue   // позиция не совпала

    // Следующий ход линии — наш книжный ход
    try {
      const mv = test.move(line[histLen])
      if (mv) candidates.push(mv)
    } catch { /* пропускаем */ }
  }

  if (candidates.length === 0) return null
  return candidates[Math.floor(Math.random() * candidates.length)]
}

// ─────────────────────────────────────────────────────────────────────────────
// Проверка: URL является активной игрой Lichess
// ─────────────────────────────────────────────────────────────────────────────
function isGameUrl(url) {
  // Игровой URL: 8 символов (наблюдатель) или 12 (играющий, с секретной частью)
  return /lichess\.org\/[a-zA-Z0-9]{8,12}(\/(?:black|white))?([?#].*)?$/.test(url)
}

// ─────────────────────────────────────────────────────────────────────────────
// Console commands
// ─────────────────────────────────────────────────────────────────────────────
function startCommandListener(page) {
  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    const parts = line.trim().split(' ')
    const cmd = parts[0]
    const val = parts.slice(1).join(' ')

    if (cmd === 'd' && val) {
      DEPTH = parseInt(val)
      console.log(`\n→ Depth = ${DEPTH}`)
    } else if (cmd === 's' && val) {
      SKILL = Math.min(20, Math.max(0, parseInt(val)))
      console.log(`\n→ Skill = ${SKILL}`)
    } else if (cmd === 'g' && val) {
      console.log(`\n→ Перехожу на: ${val}`)
      page.goto(val).catch(() => {})
    } else if (line.trim()) {
      console.log('Команды: d <глубина>   s <скилл 0-20>   g <ссылка на игру>')
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Задержка перед ходом
// ─────────────────────────────────────────────────────────────────────────────
function humanDelay(remainingSecs, moveNum) {
  // Дебют: первые OPENING_MOVES ходов — быстро как по теории
  if (moveNum <= OPENING_MOVES) {
    return 150 + Math.random() * 350
  }

  // Паник-режим: < 10 сек
  if (remainingSecs !== null && remainingSecs < 10) {
    return 80 + Math.random() * 150
  }
  // Мало времени: < 30 сек
  if (remainingSecs !== null && remainingSecs < 30) {
    return 150 + Math.random() * 300
  }

  // Обычная игра — случайные профили
  const r = Math.random()
  if (r < 0.15) return 200  + Math.random() * 300
  if (r < 0.60) return 500  + Math.random() * 1000
  if (r < 0.85) return 1200 + Math.random() * 1500
  return 2500 + Math.random() * 2500
}

// ─────────────────────────────────────────────────────────────────────────────
// Время на движок (дебют — быстрее)
// ─────────────────────────────────────────────────────────────────────────────
function engineCmd(moveNum) {
  if (moveNum <= OPENING_MOVES) return 'go movetime 500'
  return `go depth ${DEPTH}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Оставшееся время на часах
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
  console.log('Команды: d <глубина>  s <скилл 0-20>  g <ссылка на игру>')
  console.log(`Дебют (первые ${OPENING_MOVES} ходов): movetime 500мс | Миттельшпиль: depth ${DEPTH}\n`)

  return {
    getBestMove(fen, moveNum) {
      return new Promise(res => {
        bestMoveCb = res
        send('stop')
        send(`setoption name Skill Level value ${SKILL}`)
        send(`position fen ${fen}`)
        send(engineCmd(moveNum))
      })
    },
    quit() { send('quit') },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Читаем состояние игры из DOM
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
// Кликаем по клетке
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
// Ждём активную игровую страницу
// ─────────────────────────────────────────────────────────────────────────────
async function waitForGamePage(page, isLichess) {
  if (isLichess) {
    // Ждём пока URL станет игровым (lichess.org/XXXXXXXX)
    await page.waitForURL(/lichess\.org\/[a-zA-Z0-9]{8}/, { timeout: 0 })
  }
  // Ждём доску
  await page.locator(isLichess ? 'cg-board' : '.board').first().waitFor({ timeout: 0 })
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔════════════════════════════════════╗')
  console.log('║      Stockfish 18 Chess Bot        ║')
  console.log(`║  Depth: ${String(DEPTH).padEnd(4)} Skill: ${String(SKILL).padEnd(4)} Opening: ${OPENING_MOVES}ходов ║`)
  console.log('╚════════════════════════════════════╝\n')

  const isLichess = SITE === 'lichess'
  const siteUrl   = isLichess ? 'https://lichess.org' : 'https://www.chess.com'
  const boardSel  = isLichess ? 'cg-board' : '.board'
  const readState = isLichess ? readLichessState : readChessComState

  const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--start-maximized'] })
  const page    = await browser.newPage()
  await page.goto(siteUrl)

  console.log(`Открыт ${siteUrl}`)
  console.log('Войди в аккаунт и нажми ENTER — бот будет следить за играми сам.\n')
  console.log('Или вставь ссылку на приглашение командой:  g <url>\n')
  await new Promise(r => process.stdin.once('data', r))

  const engine = await initEngine()
  startCommandListener(page)

  // Внешний цикл: следим за игровыми страницами
  while (true) {
    console.log('\nЖду игровую страницу...')
    await waitForGamePage(page, isLichess)
    await page.waitForTimeout(1000)

    let initialState
    try { initialState = await readState(page) } catch { await page.waitForTimeout(2000); continue }
    if (initialState.gameOver) { await page.waitForTimeout(2000); continue }

    const { isFlipped: fl } = initialState
    const myColor = fl ? 'b' : 'w'
    console.log(`Играю за: ${myColor === 'w' ? '♔ Белых' : '♚ Чёрных'} | Depth:${DEPTH} Skill:${SKILL}`)

    let lastFen = ''

    // Игровой цикл
    while (true) {
      await page.waitForTimeout(250)

      // Выходим если URL сменился (игра закончилась / редирект)
      if (isLichess && !isGameUrl(page.url())) { console.log('Игра окончена (редирект).'); break }

      let state
      try { state = await readState(page) } catch { break }
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

      // Сначала пробуем книгу дебютов — мгновенный книжный ход
      const book = bookMove(chess)

      let from, to, promo, tag, ms = 0
      if (book) {
        from  = book.from
        to    = book.to
        promo = book.promotion || null
        tag   = '[книга]'
        process.stdout.write(`Ход ${moveNum} ${tag} | `)
      } else {
        const isOpening = moveNum <= OPENING_MOVES
        tag = isOpening ? '[дебют]' : `[d${DEPTH}s${SKILL}]`
        process.stdout.write(`Ход ${moveNum} ${tag} | Думаю... `)
        const t0      = Date.now()
        const uciMove = await engine.getBestMove(fen, moveNum)
        ms            = Date.now() - t0
        if (!uciMove) { console.log('(нет хода)'); continue }
        from  = uciMove.slice(0, 2)
        to    = uciMove.slice(2, 4)
        promo = uciMove[4] || null
      }

      const secs  = isLichess ? await readClockSecs(page) : null
      // Книжные ходы — с небольшой человеческой паузой
      const delay = book ? (200 + Math.random() * 400) : humanDelay(secs, moveNum)

      console.log(`${from}→${to} (${ms ? `${ms}мс думал, ` : ''}${Math.round(delay)}мс пауза${secs !== null ? `, ${Math.round(secs)}с осталось` : ''})`)

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

    await page.waitForTimeout(1500)
  }
}

main().catch(err => { console.error('\nОшибка:', err.message); process.exit(1) })
