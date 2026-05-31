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
const os           = require('os')
const fs           = require('fs')

let DEPTH = parseInt(process.env.DEPTH || '18')
let SKILL = 20
const SITE = (process.env.SITE || 'lichess').toLowerCase()
let AUTO_DEPTH = true    // автоподбор глубины по контролю времени
let isBulletGame = false // текущая игра — пуля?
let lastEngineScore = 0  // последняя оценка движка (cp)

// Количество ходов которые считаются дебютом (быстрая игра)
const OPENING_MOVES = 14

// ─────────────────────────────────────────────────────────────────────────────
// Книга дебютов — 37 дебютов с вариациями (SAN, ходы обеих сторон)
// Бот следует им мгновенно, выбирая случайно подходящие линии
// ─────────────────────────────────────────────────────────────────────────────
const OPENINGS = [
  // ── Испанская (Ruy Lopez) ─────────────────────────────────────────────────
  ['e4','e5','Nf3','Nc6','Bb5','a6','Ba4','Nf6','O-O','Be7','Re1','b5','Bb3','d6','c3','O-O'],
  ['e4','e5','Nf3','Nc6','Bb5','Nf6','O-O','Nxe4','d4','Nd6','Bxc6','dxc6','dxe5','Nf5'],
  ['e4','e5','Nf3','Nc6','Bb5','a6','Ba4','Nf6','O-O','Be7','Re1','b5','Bb3','d6','c3','Na5','Bc2','c5','d4','Qc7'],
  // ── Итальянская ───────────────────────────────────────────────────────────
  ['e4','e5','Nf3','Nc6','Bc4','Bc5','c3','Nf6','d3','d6','O-O','O-O','Re1','a6'],
  ['e4','e5','Nf3','Nc6','Bc4','Nf6','d3','Be7','O-O','O-O','Re1','d6','a4','Nd4'],
  ['e4','e5','Nf3','Nc6','Bc4','Bc5','b4','Bxb4','c3','Be7','d4','exd4','O-O','Nf6'],
  // ── Сицилианская ──────────────────────────────────────────────────────────
  ['e4','c5','Nf3','d6','d4','cxd4','Nxd4','Nf6','Nc3','a6','Be2','e5','Nb3','Be7'],
  ['e4','c5','Nf3','d6','d4','cxd4','Nxd4','Nf6','Nc3','g6','Be3','Bg7','f3','O-O','Qd2','Nc6'],
  ['e4','c5','Nf3','e6','d4','cxd4','Nxd4','Nf6','Nc3','d6','Be2','Be7','O-O','O-O','f4','Nc6'],
  ['e4','c5','Nf3','Nc6','d4','cxd4','Nxd4','e5','Nb5','d6','c4','Be7','Be3','Nf6','Nc3','O-O'],
  ['e4','c5','Nf3','e6','d4','cxd4','Nxd4','a6','Nc3','Qc7','Be2','Nf6','O-O','Bb4','f4','Nc6'],
  ['e4','c5','Nf3','e6','d4','cxd4','Nxd4','Nc6','Nc3','Qc7','Be3','a6','Bd3','b5','O-O','Bb7'],
  // ── Французская ───────────────────────────────────────────────────────────
  ['e4','e6','d4','d5','Nc3','Nf6','Bg5','Be7','e5','Nfd7','Bxe7','Qxe7'],
  ['e4','e6','d4','d5','e5','c5','c3','Nc6','Nf3','Qb6','Be2','cxd4','cxd4','Nh6'],
  ['e4','e6','d4','d5','Nd2','Nf6','e5','Nfd7','Bd3','c5','c3','Nc6','Ne2','cxd4','cxd4','f6'],
  // ── Каро-Канн ─────────────────────────────────────────────────────────────
  ['e4','c6','d4','d5','Nc3','dxe4','Nxe4','Bf5','Ng3','Bg6','h4','h6'],
  ['e4','c6','d4','d5','e5','Bf5','Nf3','e6','Be2','Ne7','O-O','c5','c3','Nbc6'],
  // ── Ферзевый гамбит ───────────────────────────────────────────────────────
  ['d4','d5','c4','e6','Nc3','Nf6','Bg5','Be7','e3','O-O','Nf3','h6'],
  ['d4','d5','c4','dxc4','Nf3','Nf6','e3','e6','Bxc4','c5','O-O','a6','Qe2','b5','Bb3','Bb7'],
  ['d4','d5','c4','e6','Nc3','Nf6','cxd5','exd5','Bg5','Be7','e3','O-O','Bd3','Nbd7','Qc2','Re8'],
  // ── Индийские ─────────────────────────────────────────────────────────────
  ['d4','Nf6','c4','g6','Nc3','Bg7','e4','d6','Nf3','O-O','Be2','e5','O-O','Nc6','d5','Ne7'],
  ['d4','Nf6','c4','e6','Nc3','Bb4','e3','O-O','Bd3','d5','Nf3','c5','O-O','dxc4','Bxc4','Nbd7'],
  ['d4','Nf6','c4','e6','Nf3','b6','g3','Bb7','Bg2','Be7','O-O','O-O','Nc3','Ne4','Qc2','Nxc3'],
  ['d4','Nf6','c4','g6','Nc3','d5','cxd5','Nxd5','e4','Nxc3','bxc3','Bg7','Nf3','c5','Be3','Qa5'],
  ['d4','Nf6','c4','c5','d5','e6','Nc3','exd5','cxd5','d6','e4','g6','Nf3','Bg7','Be2','O-O'],
  // ── Другие дебюты ─────────────────────────────────────────────────────────
  ['c4','e5','Nc3','Nf6','Nf3','Nc6','g3','d5','cxd5','Nxd5','Bg2','Nb6'],
  ['d4','d5','c4','c6','Nf3','Nf6','Nc3','dxc4','a4','Bf5','e3','e6'],
  ['e4','d5','exd5','Qxd5','Nc3','Qa5','d4','Nf6','Nf3','c6','Bc4','Bf5'],
  ['d4','Nf6','c4','e6','g3','d5','Bg2','Be7','Nf3','O-O','O-O','dxc4','Qc2','a6','Qxc4','b5'],
  ['d4','d5','Nf3','Nf6','Bf4','e6','e3','Bd6','Bg3','O-O','Nbd2','c5','c3','Nc6','Bd3','Bxg3'],
  ['Nf3','d5','g3','Nf6','Bg2','c6','O-O','Bg4','d3','e6','Nbd2','Be7','e4','dxe4','dxe4','O-O'],
  ['e4','e5','Nf3','Nf6','Nxe5','d6','Nf3','Nxe4','d4','d5','Bd3','Nc6','O-O','Be7','Re1','Bg4'],
  ['e4','d6','d4','Nf6','Nc3','g6','Nf3','Bg7','Be2','O-O','O-O','c6','Bg5','b5','Bb3','Bb7'],
  ['e4','Nf6','e5','Nd5','d4','d6','Nf3','Bg4','Be2','e6','O-O','Be7','c4','Nb6','exd6','cxd6'],
  ['e4','e5','Nc3','Nf6','Bc4','Nc6','d3','Bb4','Nge2','d5','exd5','Nxd5','O-O','Be6'],
  ['d4','f5','Nf3','Nf6','g3','e6','Bg2','d5','O-O','Bd6','c4','c6','b3','Qe7','Bb2','O-O'],
  ['e4','e5','Nf3','Nc6','Nc3','Nf6','Bb5','Bb4','O-O','O-O','d3','d6','Bg5','Bxc3','bxc3','Ne7'],
  ['e4','g6','d4','Bg7','Nc3','d6','Nf3','Nf6','Be2','O-O','O-O','c6','h3','b5','Re1','Bb7'],
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
      AUTO_DEPTH = false
      console.log(`\n→ Depth = ${DEPTH} (авто-подбор отключён)`)
    } else if (cmd === 's' && val) {
      SKILL = Math.min(20, Math.max(0, parseInt(val)))
      console.log(`\n→ Skill = ${SKILL}`)
    } else if (cmd === 'a') {
      AUTO_DEPTH = true
      console.log('\n→ Авто-глубина включена (вступит в силу с начала следующей игры)')
    } else if (cmd === 'g' && val) {
      console.log(`\n→ Перехожу на: ${val}`)
      page.goto(val).catch(() => {})
    } else if (line.trim()) {
      console.log('Команды: d <глубина>   s <скилл 0-20>   a (авто-глубина)   g <ссылка на игру>')
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Задержка перед ходом — имитирует живого человека
// ─────────────────────────────────────────────────────────────────────────────
function humanDelay(remainingSecs, moveNum, isFast) {
  if (isFast) return 300 + Math.random() * 600
  if (moveNum <= OPENING_MOVES) return 800 + Math.random() * 2000

  if (remainingSecs !== null) {
    // Жёсткий цейтнот — фиксированно быстро
    if (remainingSecs < 5)  return 80  + Math.random() * 120
    if (remainingSecs < 10) return 130 + Math.random() * 170

    // Всё остальное — строго % от остатка времени
    // При 10 мин: 12–42 сек | При 1 мин: 1.2–4.2 сек | При 15 сек: 300мс–1 сек
    const pct = 0.02 + Math.random() * 0.05
    let ms = remainingSecs * pct * 1000
    if (Math.random() < 0.18) ms *= 1.3 + Math.random() * 1.0  // иногда думает дольше
    return Math.max(300, Math.min(45000, ms))
  }

  // Нет часов — случайные профили
  const r = Math.random()
  if (r < 0.15) return 500  + Math.random() * 1000
  if (r < 0.55) return 2000 + Math.random() * 4000
  if (r < 0.80) return 5000 + Math.random() * 6000
  return 10000 + Math.random() * 15000
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
// Определяем тип контроля и авто-выставляем глубину
// ─────────────────────────────────────────────────────────────────────────────
async function detectGameType(page) {
  const secs = await readClockSecs(page)
  if (secs === null) return
  isBulletGame = secs < 180
  if (!AUTO_DEPTH) {
    const label = secs < 180 ? 'пуля' : secs < 600 ? 'блиц' : 'рапид'
    console.log(`Контроль: ~${Math.round(secs)}с [${label}] | Depth:${DEPTH} (вручную)`)
    return
  }
  if      (secs < 180) DEPTH = 5
  else if (secs < 600) DEPTH = 8
  else                 DEPTH = 12
  const label = secs < 180 ? 'пуля' : secs < 600 ? 'блиц' : 'рапид'
  console.log(`Авто-глубина: ~${Math.round(secs)}с → depth ${DEPTH} [${label}]`)
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
        const m3 = multiMoves[3]?.move
        const s1 = multiMoves[1]?.score ?? 0
        const s2 = multiMoves[2]?.score ?? -9999
        const s3 = multiMoves[3]?.score ?? -9999
        multiMoves = {}

        // Не зеваем когда выигрываем (счёт > 200cp) или проигрываем (< -100cp)
        // В равных/слегка лучших позициях — иногда играем не лучший ход
        const winning = s1 > 200
        const losing  = s1 < -100
        const rnd = Math.random()
        lastEngineScore = s1

        if (!winning && !losing && m3 && Math.abs(s1 - s3) < 50 && rnd < 0.06) {
          cb(m3)  // 3-й ход — только если позиция примерно равная
        } else if (!winning && m2 && Math.abs(s1 - s2) < 80 && rnd < 0.20) {
          cb(m2)  // 2-й ход — 20%, только не в выигранной позиции
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
// Открываем браузер:
//   1. Пробуем CDP (Chrome уже запущен с портом 9222)
//   2. Если нет — запускаем ОТДЕЛЬНЫЙ Chrome бота с портом отладки.
//      ВАЖНО: используем отдельную папку профиля (--user-data-dir), потому что
//      Chrome 136+ запрещает порт отладки на стандартном профиле.
//      Это настоящий Chrome (не Playwright) → Cloudflare пропускает вход.
//      Твой обычный Chrome НЕ закрывается — у бота своё отдельное окно.
// ─────────────────────────────────────────────────────────────────────────────
async function openBrowser(siteUrl) {
  // Пробуем подключиться к уже открытому Chrome с портом
  try {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 2000 })
    const ctx  = browser.contexts()[0] || await browser.newContext()
    const page = ctx.pages()[0]        || await ctx.newPage()
    if (!page.url().includes('lichess') && !page.url().includes('chess.com')) {
      await page.goto(siteUrl)
    }
    console.log('Подключился к Chrome бота (CDP)')
    return { browser, page }
  } catch { /* CDP недоступен — запускаем сами */ }

  // Находим Chrome
  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
  ]
  const chromeExe = chromePaths.find(p => fs.existsSync(p))
  if (!chromeExe) throw new Error('Google Chrome не найден — установи Chrome.')

  // Отдельная папка профиля бота (логин в Lichess сохраняется здесь между запусками)
  const debugProfile = path.join(__dirname, 'chrome-bot-profile')

  console.log('Запускаю отдельное окно Chrome для бота...')
  // Открываем сразу Lichess в самом Chrome (через аргумент), а не через Playwright —
  // пока Playwright не подключён, Cloudflare видит обычный Chrome и пропускает вход.
  spawn(chromeExe, [
    '--remote-debugging-port=9222',
    `--user-data-dir=${debugProfile}`,   // отдельный профиль → порт откроется (Chrome 136+)
    '--no-first-run',
    '--no-default-browser-check',
    '--start-maximized',
    siteUrl,
  ], { detached: true, stdio: 'ignore' }).unref()

  // Ждём пока Chrome поднимет порт (до 20 попыток по 1 сек)
  console.log('Жду запуска Chrome...')
  const http = require('http')
  let portUp = false
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000))
    portUp = await new Promise(r => {
      const req = http.get('http://127.0.0.1:9222/json/version', res => r(res.statusCode === 200))
      req.on('error', () => r(false))
      req.setTimeout(800, () => { req.destroy(); r(false) })
    })
    if (portUp) break
  }
  if (!portUp) throw new Error('Chrome не открыл порт 9222 — закрой все окна Chrome и попробуй снова.')

  console.log('\n══════════════════════════════════════════════════════════')
  console.log(' Если ты УЖЕ вошёл в Lichess — просто нажми ENTER.')
  console.log(' Если НЕТ — войди в аккаунт в окне Chrome (капча пройдёт,')
  console.log(' потому что бот пока НЕ подключён к странице), потом ENTER.')
  console.log('══════════════════════════════════════════════════════════\n')
  await new Promise(r => process.stdin.once('data', r))
  console.log('Подключаюсь к Chrome...\n')

  // Подключаемся (после входа — Cloudflare уже пройден)
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  const ctx  = browser.contexts()[0] || await browser.newContext()
  const page = ctx.pages()[0]        || await ctx.newPage()
  if (!page.url().includes('lichess') && !page.url().includes('chess.com')) {
    await page.goto(siteUrl)
  }
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
      await detectGameType(page)
      console.log(`Играю за: ${myColor === 'w' ? '♔ Белых' : '♚ Чёрных'} | Depth:${DEPTH} Skill:${SKILL}${AUTO_DEPTH ? ' [авто]' : ''}`)

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

        const moveNum  = Math.ceil(chess.history().length / 2) + 1
        const skipBook = chess.history().length >= 6 && Math.random() < 0.15
        const book     = skipBook ? null : bookMove(chess)

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

        // Иногда флагуем в пуле — как живой человек в цейтноте
        if (!book && isBulletGame && secs !== null && secs < 8 && lastEngineScore < 200 && Math.random() < 0.07) {
          console.log(`(флаг — ${Math.round(secs)}с → намеренная просрочка)`)
          await page.waitForTimeout((secs + 2) * 1000)
          continue
        }

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
