/**
 * Lichess/Chess.com auto-play bot
 * Uses Playwright + Stockfish native binary.
 *
 * Setup:
 *   1. npm install
 *   2. Put stockfish.exe in this folder
 *   3. node bot.js
 *
 * Env vars:
 *   DEPTH=18      starting depth (default 18)
 *   SITE=lichess  lichess | chess (default lichess)
 *   CDP=1         подключиться к уже открытому Chrome (см. ниже)
 *
 * Режим CDP (свой браузер):
 *   Запусти Chrome с флагом:
 *     "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
 *   Затем: CDP=1 node bot.js
 *
 * Console commands:
 *   d 12    set depth
 *   s 10    set skill (0-20)
 *   g <url> перейти на игру
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
// Задержка перед ходом — имитирует живого человека
// ─────────────────────────────────────────────────────────────────────────────
function humanDelay(remainingSecs, moveNum, isFast) {
  // Режим быстрой серии (бот "видит план" и режет несколько ходов подряд)
  if (isFast) return 400 + Math.random() * 800

  // Дебютные ходы вне книги — чуть быстрее
  if (moveNum <= OPENING_MOVES) return 1000 + Math.random() * 2500

  // Паника: < 8 сек
  if (remainingSecs !== null && remainingSecs < 8)  return 300 + Math.random() * 600
  // Мало времени: < 20 сек
  if (remainingSecs !== null && remainingSecs < 20) return 700 + Math.random() * 1800
  // Цейтнот: < 45 сек
  if (remainingSecs !== null && remainingSecs < 45) return 1500 + Math.random() * 3500

  // Основной режим — % от оставшегося времени (как живой игрок)
  if (remainingSecs !== null) {
    const pct = 0.015 + Math.random() * 0.045   // 1.5% – 6% от остатка
    let ms = remainingSecs * pct * 1000
    // 20% шанс: "глубокий расчёт" — удвоить время на ход
    if (Math.random() < 0.20) ms *= 1.4 + Math.random() * 1.2
    return Math.max(1200, Math.min(55000, ms))
  }

  // Нет часов (без инкремента, оффлайн) — случайные профили
  const r = Math.random()
  if (r < 0.15) return 600  + Math.random() * 1200
  if (r < 0.55) return 2500 + Math.random() * 5000
  if (r < 0.80) return 6000 + Math.random() * 7000
  return 12000 + Math.random() * 18000
}

// ─────────────────────────────────────────────────────────────────────────────
// Время на движок — всегда глубина, которую установил пользователь
// ─────────────────────────────────────────────────────────────────────────────
function engineCmd() {
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
// Stockfish engine (MultiPV=3, иногда играем не лучший ход)
// ─────────────────────────────────────────────────────────────────────────────
async function initEngine() {
  const sfExe = path.join(__dirname, 'stockfish.exe')
  const proc  = spawn(sfExe)

  let bestMoveCb = null
  let readyOkCb  = null
  let multiMoves = {}   // { 1: {move,score}, 2: {move,score}, 3: {move,score} }
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

      // Собираем топ-3 хода из info-строк
      if (line.startsWith('info') && line.includes('multipv') && line.includes(' pv ')) {
        const mpM = line.match(/multipv (\d+)/)
        const pvM = line.match(/ pv ([a-h][1-8][a-h][1-8][qrbn]?)/)
        const cpM = line.match(/score cp (-?\d+)/)
        if (mpM && pvM) {
          multiMoves[parseInt(mpM[1])] = {
            move:  pvM[1],
            score: cpM ? parseInt(cpM[1]) : 0,
          }
        }
      }

      if (line.startsWith('bestmove') && bestMoveCb) {
        const best = line.split(' ')[1]
        const cb   = bestMoveCb
        bestMoveCb = null

        const m1 = multiMoves[1]?.move || best
        const m2 = multiMoves[2]?.move
        const s1 = multiMoves[1]?.score ?? 0
        const s2 = multiMoves[2]?.score ?? -9999
        multiMoves = {}

        // 13% шанс сыграть 2-й по качеству ход — если разница < 80cp (не зевок)
        if (m2 && Math.abs(s1 - s2) < 80 && Math.random() < 0.13) {
          cb(m2)
        } else {
          cb(best === '(none)' || !best ? null : best)
        }
      }
    }
  })

  proc.stderr.on('data', () => {})

  const send = (cmd) => proc.stdin.write(cmd + '\n')

  await new Promise(res => { readyOkCb = res; send('uci'); send('isready') })
  send('setoption name MultiPV value 3')
  send(`setoption name Skill Level value ${SKILL}`)

  console.log('Engine ready (Stockfish native)\n')
  console.log('Команды: d <глубина>  s <скилл 0-20>  g <ссылка на игру>')
  console.log(`Depth: ${DEPTH} | Skill: ${SKILL}\n`)

  return {
    getBestMove(fen) {
      return new Promise(res => {
        multiMoves = {}
        bestMoveCb = res
        send('stop')
        send(`setoption name Skill Level value ${SKILL}`)
        send(`position fen ${fen}`)
        send(engineCmd())
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
// Кликаем по клетке — с имитацией движения мыши как у человека
// ─────────────────────────────────────────────────────────────────────────────
async function clickSquare(page, square, boardBox, isFlipped) {
  const file = square.charCodeAt(0) - 97
  const rank = parseInt(square[1]) - 1
  const sz   = boardBox.width / 8
  const x    = boardBox.x + (isFlipped ? (7 - file) : file) * sz + sz / 2
  const y    = boardBox.y + (isFlipped ? rank : (7 - rank)) * sz + sz / 2

  // 60% шанс: навести мышь на соседнее поле, потом на нужное (имитация взгляда)
  if (Math.random() < 0.60) {
    const dx = (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 0.9)
    const dy = (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 0.9)
    await page.mouse.move(x + dx * sz, y + dy * sz)
    await page.waitForTimeout(70 + Math.random() * 180)
  }
  await page.mouse.move(x, y)
  await page.waitForTimeout(25 + Math.random() * 55)
  await page.mouse.click(x, y)
}

// ─────────────────────────────────────────────────────────────────────────────
// Мониторинг буфера обмена — переходит только на игровые ссылки Lichess
// ─────────────────────────────────────────────────────────────────────────────
function startClipboardWatcher(page, isLichess) {
  if (!isLichess) return
  let lastClip = ''

  // Разрешаем чтение буфера обмена в браузере
  page.context().grantPermissions(['clipboard-read']).catch(() => {})

  setInterval(async () => {
    try {
      const text = (await page.evaluate(() => navigator.clipboard.readText())).trim()
      if (!text || text === lastClip) return
      lastClip = text

      // Проверяем строго: это должна быть именно ссылка на игру Lichess
      if (isGameUrl(text)) {
        console.log(`\nБуфер: игровая ссылка → ${text}`)
        await page.goto(text)
      }
    } catch { /* нет прав или буфер недоступен */ }
  }, 800)
}


async function waitForGamePage(page, isLichess) {
  if (isLichess) {
    // Ждём пока URL станет игровым (lichess.org/XXXXXXXX)
    await page.waitForURL(/lichess\.org\/[a-zA-Z0-9]{8}/, { timeout: 0 })
  }
  // Ждём доску
  await page.locator(isLichess ? 'cg-board' : '.board').first().waitFor({ timeout: 0 })
}

// ─────────────────────────────────────────────────────────────────────────────
// Открываем браузер (или подключаемся к существующему через CDP)
// ─────────────────────────────────────────────────────────────────────────────
async function openBrowser(siteUrl) {
  if (process.env.CDP === '1') {
    console.log('Подключаюсь к существующему Chrome на порту 9222...')
    const browser = await chromium.connectOverCDP('http://localhost:9222')
    const ctx  = browser.contexts()[0] || await browser.newContext()
    const page = ctx.pages()[0]       || await ctx.newPage()
    const url  = page.url()
    if (!url.includes('lichess') && !url.includes('chess.com')) {
      await page.goto(siteUrl)
    }
    return { browser, page }
  }
  const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--start-maximized'] })
  const page    = await browser.newPage()
  await page.goto(siteUrl)
  return { browser, page }
}

// ─────────────────────────────────────────────────────────────────────────────
// Одна браузерная сессия (игровой цикл)
// ─────────────────────────────────────────────────────────────────────────────
async function runSession(engine, isLichess, siteUrl, boardSel, readState) {
  const { browser, page } = await openBrowser(siteUrl)
  console.log(`\nБраузер открыт: ${siteUrl}`)
  console.log('Войди в аккаунт — бот следит за страницей сам.')
  console.log('Скопируй ссылку на игру — бот перейдёт автоматически.\n')

  startCommandListener(page)
  startClipboardWatcher(page, isLichess)

  try {
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
      let fastStreakLeft = 0  // сколько ходов ещё в "быстрой серии"

      // Игровой цикл
      while (true) {
        await page.waitForTimeout(250)
        if (isLichess && !isGameUrl(page.url())) { console.log('Игра окончена (редирект).'); break }

        let state
        try { state = await readState(page) } catch { break }
        const { sanMoves, isFlipped: flipped, gameOver } = state
        if (gameOver) { console.log('Игра окончена.'); break }

        const chess = new Chess()
        for (const san of sanMoves) { try { chess.move(san) } catch {} }

        const fen = chess.fen()
        if (fen === lastFen) continue
        lastFen = fen

        if (chess.turn() !== myColor) continue
        if (chess.isGameOver()) break

        const moveNum = Math.ceil(chess.history().length / 2) + 1
        const book    = bookMove(chess)

        // Fast streak: иногда бот "видит план" и режет несколько ходов быстро
        if (!book && fastStreakLeft <= 0 && Math.random() < 0.18) {
          fastStreakLeft = 2 + Math.floor(Math.random() * 4)  // 2-5 быстрых ходов
        }
        const isFast = !book && fastStreakLeft > 0
        if (isFast) fastStreakLeft--

        let from, to, promo, tag, ms = 0
        if (book) {
          from = book.from; to = book.to; promo = book.promotion || null; tag = '[книга]'
          process.stdout.write(`Ход ${moveNum} ${tag} | `)
        } else {
          tag = isFast ? `[быстро d${DEPTH}]` : `[d${DEPTH}s${SKILL}]`
          process.stdout.write(`Ход ${moveNum} ${tag} | Думаю... `)
          const t0 = Date.now()
          const uciMove = await engine.getBestMove(fen)
          ms = Date.now() - t0
          if (!uciMove) { console.log('(нет хода)'); continue }
          from = uciMove.slice(0, 2); to = uciMove.slice(2, 4); promo = uciMove[4] || null
        }

        const secs  = isLichess ? await readClockSecs(page) : null
        const delay = book ? (200 + Math.random() * 400) : humanDelay(secs, moveNum, isFast)
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
          if (await qBtn.isVisible({ timeout: 1000 }).catch(() => false)) await qBtn.click()
        }
      }
      await page.waitForTimeout(1500)
    }
  } finally {
    try { await browser.close() } catch {}
  }
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

  console.log('Нажми ENTER для запуска...')
  await new Promise(r => process.stdin.once('data', r))

  const engine = await initEngine()

  // Авто-рестарт: если браузер закрыт — открываем снова
  while (true) {
    try {
      await runSession(engine, isLichess, siteUrl, boardSel, readState)
    } catch (err) {
      if (err.message?.includes('closed') || err.message?.includes('Target page')) {
        console.log('\nБраузер закрыт — перезапускаю через 3 сек...')
        await new Promise(r => setTimeout(r, 3000))
      } else {
        console.error('\nОшибка сессии:', err.message)
        await new Promise(r => setTimeout(r, 2000))
      }
    }
  }
}

main().catch(err => { console.error('\nФатальная ошибка:', err.message); process.exit(1) })
