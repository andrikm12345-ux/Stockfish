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
let AUTO_DEPTH = true
let isBulletGame = false
let gameCategory = 'blitz'
let lastEngineScore = 0
let PAUSED = false
let lastPauseToggle = 0
let RESTART = false
let savedDepth = null
let savedSkill = null
let mousePos = { x: 0, y: 0 }
let gamesPlayed = 0
let fatigueGamesLeft = 0
let errorStreakLeft = 0

const STATS_FILE = path.join(__dirname, 'bot-stats.json')
function loadDailyCount() {
  try {
    const data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'))
    if (data.date === new Date().toISOString().slice(0, 10)) return data.count
  } catch {}
  return 0
}
function saveDailyCount(count) {
  fs.writeFileSync(STATS_FILE, JSON.stringify({ date: new Date().toISOString().slice(0, 10), count }))
}

const OPENING_MOVES = 10

const OPENINGS = [
  { name: 'Испанская (закрытый вариант)',    moves: ['e4','e5','Nf3','Nc6','Bb5','a6','Ba4','Nf6','O-O','Be7','Re1','b5','Bb3','d6','c3','O-O'] },
  { name: 'Испанская (берлинская защита)',   moves: ['e4','e5','Nf3','Nc6','Bb5','Nf6','O-O','Nxe4','d4','Nd6','Bxc6','dxc6','dxe5','Nf5'] },
  { name: 'Испанская (вариант Чигорина)',    moves: ['e4','e5','Nf3','Nc6','Bb5','a6','Ba4','Nf6','O-O','Be7','Re1','b5','Bb3','d6','c3','Na5','Bc2','c5','d4','Qc7'] },
  { name: 'Итальянская (джуоко пьяно)',      moves: ['e4','e5','Nf3','Nc6','Bc4','Bc5','c3','Nf6','d3','d6','O-O','O-O','Re1','a6'] },
  { name: 'Итальянская партия',              moves: ['e4','e5','Nf3','Nc6','Bc4','Nf6','d3','Be7','O-O','O-O','Re1','d6','a4','Nd4'] },
  { name: 'Гамбит Эванса',                  moves: ['e4','e5','Nf3','Nc6','Bc4','Bc5','b4','Bxb4','c3','Be7','d4','exd4','O-O','Nf6'] },
  { name: 'Сицилианская (Найдорф)',          moves: ['e4','c5','Nf3','d6','d4','cxd4','Nxd4','Nf6','Nc3','a6','Be2','e5','Nb3','Be7'] },
  { name: 'Сицилианская (дракон)',           moves: ['e4','c5','Nf3','d6','d4','cxd4','Nxd4','Nf6','Nc3','g6','Be3','Bg7','f3','O-O','Qd2','Nc6'] },
  { name: 'Сицилианская (шевенинген)',       moves: ['e4','c5','Nf3','e6','d4','cxd4','Nxd4','Nf6','Nc3','d6','Be2','Be7','O-O','O-O','f4','Nc6'] },
  { name: 'Сицилианская (Свешников)',        moves: ['e4','c5','Nf3','Nc6','d4','cxd4','Nxd4','e5','Nb5','d6','c4','Be7','Be3','Nf6','Nc3','O-O'] },
  { name: 'Сицилианская (Паулсен-Кан)',      moves: ['e4','c5','Nf3','e6','d4','cxd4','Nxd4','a6','Nc3','Qc7','Be2','Nf6','O-O','Bb4','f4','Nc6'] },
  { name: 'Сицилианская (Тайманов)',         moves: ['e4','c5','Nf3','e6','d4','cxd4','Nxd4','Nc6','Nc3','Qc7','Be3','a6','Bd3','b5','O-O','Bb7'] },
  { name: 'Французская (классическая)',      moves: ['e4','e6','d4','d5','Nc3','Nf6','Bg5','Be7','e5','Nfd7','Bxe7','Qxe7'] },
  { name: 'Французская (продвижение)',       moves: ['e4','e6','d4','d5','e5','c5','c3','Nc6','Nf3','Qb6','Be2','cxd4','cxd4','Nh6'] },
  { name: 'Французская (Тарраш)',            moves: ['e4','e6','d4','d5','Nd2','Nf6','e5','Nfd7','Bd3','c5','c3','Nc6','Ne2','cxd4','cxd4','f6'] },
  { name: 'Каро-Канн (классическая)',        moves: ['e4','c6','d4','d5','Nc3','dxe4','Nxe4','Bf5','Ng3','Bg6','h4','h6'] },
  { name: 'Каро-Канн (продвижение)',         moves: ['e4','c6','d4','d5','e5','Bf5','Nf3','e6','Be2','Ne7','O-O','c5','c3','Nbc6'] },
  { name: 'Ферзевый гамбит (ортодокс)',      moves: ['d4','d5','c4','e6','Nc3','Nf6','Bg5','Be7','e3','O-O','Nf3','h6'] },
  { name: 'Ферзевый гамбит (принят)',        moves: ['d4','d5','c4','dxc4','Nf3','Nf6','e3','e6','Bxc4','c5','O-O','a6','Qe2','b5','Bb3','Bb7'] },
  { name: 'Ферзевый гамбит (разменный)',     moves: ['d4','d5','c4','e6','Nc3','Nf6','cxd5','exd5','Bg5','Be7','e3','O-O','Bd3','Nbd7','Qc2','Re8'] },
  { name: 'Королевско-индийская защита',     moves: ['d4','Nf6','c4','g6','Nc3','Bg7','e4','d6','Nf3','O-O','Be2','e5','O-O','Nc6','d5','Ne7'] },
  { name: 'Нимцо-индийская защита',          moves: ['d4','Nf6','c4','e6','Nc3','Bb4','e3','O-O','Bd3','d5','Nf3','c5','O-O','dxc4','Bxc4','Nbd7'] },
  { name: 'Ферзевая индийская защита',       moves: ['d4','Nf6','c4','e6','Nf3','b6','g3','Bb7','Bg2','Be7','O-O','O-O','Nc3','Ne4','Qc2','Nxc3'] },
  { name: 'Защита Грюнфельда',               moves: ['d4','Nf6','c4','g6','Nc3','d5','cxd5','Nxd5','e4','Nxc3','bxc3','Bg7','Nf3','c5','Be3','Qa5'] },
  { name: 'Защита Бенони',                   moves: ['d4','Nf6','c4','c5','d5','e6','Nc3','exd5','cxd5','d6','e4','g6','Nf3','Bg7','Be2','O-O'] },
  { name: 'Английское начало',               moves: ['c4','e5','Nc3','Nf6','Nf3','Nc6','g3','d5','cxd5','Nxd5','Bg2','Nb6'] },
  { name: 'Славянская защита',               moves: ['d4','d5','c4','c6','Nf3','Nf6','Nc3','dxc4','a4','Bf5','e3','e6'] },
  { name: 'Скандинавская защита',            moves: ['e4','d5','exd5','Qxd5','Nc3','Qa5','d4','Nf6','Nf3','c6','Bc4','Bf5'] },
  { name: 'Каталонское начало',              moves: ['d4','Nf6','c4','e6','g3','d5','Bg2','Be7','Nf3','O-O','O-O','dxc4','Qc2','a6','Qxc4','b5'] },
  { name: 'Лондонская система',              moves: ['d4','d5','Nf3','Nf6','Bf4','e6','e3','Bd6','Bg3','O-O','Nbd2','c5','c3','Nc6','Bd3','Bxg3'] },
  { name: 'Дебют Рети',                      moves: ['Nf3','d5','g3','Nf6','Bg2','c6','O-O','Bg4','d3','e6','Nbd2','Be7','e4','dxe4','dxe4','O-O'] },
  { name: 'Защита Петрова',                  moves: ['e4','e5','Nf3','Nf6','Nxe5','d6','Nf3','Nxe4','d4','d5','Bd3','Nc6','O-O','Be7','Re1','Bg4'] },
  { name: 'Защита Пирца',                    moves: ['e4','d6','d4','Nf6','Nc3','g6','Nf3','Bg7','Be2','O-O','O-O','c6','Bg5','b5','Bb3','Bb7'] },
  { name: 'Защита Алехина',                  moves: ['e4','Nf6','e5','Nd5','d4','d6','Nf3','Bg4','Be2','e6','O-O','Be7','c4','Nb6','exd6','cxd6'] },
  { name: 'Венская партия',                  moves: ['e4','e5','Nc3','Nf6','Bc4','Nc6','d3','Bb4','Nge2','d5','exd5','Nxd5','O-O','Be6'] },
  { name: 'Голландская защита',              moves: ['d4','f5','Nf3','Nf6','g3','e6','Bg2','d5','O-O','Bd6','c4','c6','b3','Qe7','Bb2','O-O'] },
  { name: 'Испанская (четыре коня)',          moves: ['e4','e5','Nf3','Nc6','Nc3','Nf6','Bb5','Bb4','O-O','O-O','d3','d6','Bg5','Bxc3','bxc3','Ne7'] },
  { name: 'Современная защита (Пирц-Уфимцев)', moves: ['e4','g6','d4','Bg7','Nc3','d6','Nf3','Nf6','Be2','O-O','O-O','c6','h3','b5','Re1','Bb7'] },
]

function posKey(fen) {
  return fen.split(' ').slice(0, 4).join(' ')
}

function bookMove(chess) {
  const histLen = chess.history().length
  const curKey  = posKey(chess.fen())
  const candidates = []
  for (const { name, moves: line } of OPENINGS) {
    if (line.length <= histLen) continue
    const test = new Chess()
    let ok = true
    for (let i = 0; i < histLen; i++) {
      try { test.move(line[i]) } catch { ok = false; break }
    }
    if (!ok) continue
    if (posKey(test.fen()) !== curKey) continue
    try {
      const mv = test.move(line[histLen])
      if (mv) candidates.push({ move: mv, name })
    } catch {}
  }
  if (candidates.length === 0) return null
  return candidates[Math.floor(Math.random() * candidates.length)]
}

function isGameUrl(url) {
  return /lichess\.org\/[a-zA-Z0-9]{8,12}(\/(?:black|white))?([?#].*)?$/.test(url)
}

function startCommandListener(page) {
  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    const parts = line.trim().split(' ')
    const cmd = parts[0]
    const val = parts.slice(1).join(' ')
    if (cmd === 'd' && val) {
      DEPTH = parseInt(val); AUTO_DEPTH = false
      console.log(`\n→ Depth = ${DEPTH} (авто-подбор отключён)`)
    } else if (cmd === 's' && val) {
      SKILL = Math.min(20, Math.max(0, parseInt(val)))
      console.log(`\n→ Skill = ${SKILL}`)
    } else if (cmd === 'a') {
      AUTO_DEPTH = true
      console.log('\n→ Авто-глубина включена')
    } else if (cmd === 'p') {
      const now = Date.now()
      if (now - lastPauseToggle < 1000) return
      lastPauseToggle = now
      PAUSED = !PAUSED
      console.log(PAUSED ? '\n⏸  Бот на паузе' : '\n▶  Бот возобновлён')
    } else if (cmd === 'r') {
      RESTART = true; PAUSED = false
      console.log('\n→ Перезапуск игрового цикла...')
    } else if (cmd === 'n') {
      savedDepth = DEPTH; savedSkill = SKILL
      DEPTH = 1; SKILL = 1; AUTO_DEPTH = false
      console.log(`\n→ Режим тупого: d1 s1 (было d${savedDepth} s${savedSkill}) | b — вернуть`)
    } else if (cmd === 'b') {
      if (savedDepth !== null) {
        DEPTH = savedDepth; SKILL = savedSkill; AUTO_DEPTH = false
        savedDepth = savedSkill = null
        console.log(`\n→ Восстановлено: d${DEPTH} s${SKILL}`)
      } else {
        console.log('\n→ Нечего восстанавливать')
      }
    } else if (cmd === 'g' && val) {
      console.log(`\n→ Перехожу на: ${val}`)
      page.goto(val).catch(() => {})
    } else if (line.trim()) {
      console.log('Команды: d <глубина>   s <скилл 0-20>   a (авто-глубина)   p (пауза/продолжить)   r (рестарт)   n (тупой режим)   b (вернуть)   g <ссылка>')
    }
  })
}

function humanDelay(remainingSecs, moveNum, isFast, timeDelta = 0) {
  if (remainingSecs !== null) {
    if (remainingSecs < 6)  return { ms: 20  + Math.random() * 20,  isLongThink: false }
    if (remainingSecs < 10) return { ms: 130 + Math.random() * 170, isLongThink: false }
  }
  if (gameCategory === 'bullet') {
    if (isFast)                  return { ms: 80  + Math.random() * 170, isLongThink: false }
    if (moveNum <= OPENING_MOVES) return { ms: 250 + Math.random() * 450, isLongThink: false }
    if (remainingSecs !== null) {
      let ms = remainingSecs * (0.008 + Math.random() * 0.015) * 1000
      const thinkChance = timeDelta >= 15 ? 0.25 : 0.10
      const thinkMult   = timeDelta >= 15 ? (2.0 + Math.random() * 2.0) : (1.5 + Math.random() * 1.0)
      let isLongThink = false
      if (Math.random() < thinkChance) { ms *= thinkMult; isLongThink = true }
      return { ms: Math.max(120, Math.min(2000, ms)), isLongThink }
    }
  }
  if (gameCategory === 'blitz') {
    if (isFast)                  return { ms: 200 + Math.random() * 400,  isLongThink: false }
    if (moveNum <= OPENING_MOVES) return { ms: 600 + Math.random() * 1200, isLongThink: false }
    if (remainingSecs !== null) {
      let ms = remainingSecs * (0.01 + Math.random() * 0.025) * 1000
      let isLongThink = false
      if (Math.random() < 0.12) { ms *= 1.2 + Math.random() * 0.5; isLongThink = true }
      return { ms: Math.max(300, Math.min(15000, ms)), isLongThink }
    }
  }
  if (gameCategory === 'rapid') {
    if (isFast)                  return { ms: 300 + Math.random() * 600,  isLongThink: false }
    if (moveNum <= OPENING_MOVES) return { ms: 800 + Math.random() * 2000, isLongThink: false }
    if (remainingSecs !== null) {
      let ms = remainingSecs * (0.015 + Math.random() * 0.03) * 1000
      let isLongThink = false
      if (Math.random() < 0.18) { ms *= 1.3 + Math.random() * 0.7; isLongThink = true }
      return { ms: Math.max(300, Math.min(25000, ms)), isLongThink }
    }
  }
  const r = Math.random()
  if (r < 0.15) return { ms: 500  + Math.random() * 1000,  isLongThink: false }
  if (r < 0.55) return { ms: 2000 + Math.random() * 4000,  isLongThink: false }
  if (r < 0.80) return { ms: 5000 + Math.random() * 6000,  isLongThink: false }
  return { ms: 10000 + Math.random() * 15000, isLongThink: false }
}

function engineCmd() { return `go depth ${DEPTH}` }

async function readClockSecs(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.rclock-bottom .time, .rclock.rclock-bottom time, .clock__time')
    if (!el) return null
    const text = el.textContent.trim().replace(/[^\d:.]/g, '')
    const parts = text.split(':')
    if (parts.length < 2) return null
    return parseFloat(parts[0]) * 60 + parseFloat(parts[1])
  }).catch(() => null)
}

async function readBothClocks(page) {
  return page.evaluate(() => {
    function parse(el) {
      if (!el) return null
      const text = el.textContent.trim().replace(/[^\d:.]/g, '')
      const parts = text.split(':')
      if (parts.length < 2) return null
      return parseFloat(parts[0]) * 60 + parseFloat(parts[1])
    }
    const ourEl = document.querySelector('.rclock-bottom .time, .rclock.rclock-bottom time, .clock__time')
    const oppEl = document.querySelector('.rclock-top .time, .rclock.rclock-top time')
    return { our: parse(ourEl), opp: parse(oppEl) }
  }).catch(() => ({ our: null, opp: null }))
}

async function readTimeControlSecs(page) {
  return page.evaluate(() => {
    const selectors = ['.setup__title','a.setup','.game__meta .header','.game-infos','.header-game-infos']
    for (const sel of selectors) {
      const el = document.querySelector(sel)
      if (!el) continue
      const m = el.textContent.match(/\b(\d{1,2})\+(\d{1,2})\b/)
      if (m) {
        const base = parseInt(m[1]); const inc = parseInt(m[2])
        if (base >= 1 && base <= 60) return base * 60 + inc
      }
    }
    return null
  }).catch(() => null)
}

async function detectGameType(page) {
  let totalSecs = await readTimeControlSecs(page)
  const source  = totalSecs !== null ? 'заголовок' : 'часы'
  if (totalSecs === null) totalSecs = await readClockSecs(page)
  if (totalSecs === null) { isBulletGame = false; gameCategory = 'blitz'; return }
  isBulletGame = totalSecs < 180
  gameCategory = totalSecs < 180 ? 'bullet' : totalSecs < 600 ? 'blitz' : 'rapid'
  if (!AUTO_DEPTH) {
    console.log(`Контроль: ${Math.round(totalSecs)}с [${gameCategory}] (${source}) | Depth:${DEPTH} (вручную)`)
    return
  }
  if      (totalSecs < 180) DEPTH = 5
  else if (totalSecs < 600) DEPTH = 8
  else                      DEPTH = 12
  console.log(`Авто-глубина: ${Math.round(totalSecs)}с [${gameCategory}] (${source}) → depth ${DEPTH}`)
}

async function initEngine() {
  const sfExe = path.join(__dirname, 'stockfish.exe')
  const proc  = spawn(sfExe)
  let bestMoveCb = null, readyOkCb = null, multiMoves = {}, forceSuboptimal = false, lateGameMode = false, buf = ''

  proc.on('error', (err) => { console.error('\nНе найден stockfish.exe:', err.message); process.exit(1) })

  proc.stdout.on('data', (data) => {
    buf += data.toString()
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const raw of lines) {
      const line = raw.trim()
      if (line === 'readyok' && readyOkCb) { readyOkCb(); readyOkCb = null }
      if (line.startsWith('info') && line.includes('multipv') && line.includes(' pv ')) {
        const mpM = line.match(/multipv (\d+)/)
        const pvM = line.match(/ pv ([a-h][1-8][a-h][1-8][qrbn]?)/)
        const cpM = line.match(/score cp (-?\d+)/)
        if (mpM && pvM) multiMoves[parseInt(mpM[1])] = { move: pvM[1], score: cpM ? parseInt(cpM[1]) : 0 }
      }
      if (line.startsWith('bestmove') && bestMoveCb) {
        const best = line.split(' ')[1]
        const cb = bestMoveCb; bestMoveCb = null
        const m1 = multiMoves[1]?.move || best
        const m2 = multiMoves[2]?.move
        const m3 = multiMoves[3]?.move
        const s1 = multiMoves[1]?.score ?? 0
        const s2 = multiMoves[2]?.score ?? -9999
        const s3 = multiMoves[3]?.score ?? -9999
        multiMoves = {}
        const winning = s1 > 200, losing = s1 < -100, rnd = Math.random()
        lastEngineScore = s1
        const m2chance = lateGameMode ? 0.28 : 0.20
        const m3chance = lateGameMode ? 0.12 : 0.06
        lateGameMode = false
        if (forceSuboptimal && !winning && !losing) {
          forceSuboptimal = false
          cb(m3 && Math.random() < 0.4 ? m3 : (m2 || (best === '(none)' ? null : best)))
        } else {
          forceSuboptimal = false
          if (!winning && !losing && m3 && Math.abs(s1 - s3) < 120 && rnd < m3chance) cb(m3)
          else if (!winning && !losing && m2 && Math.abs(s1 - s2) < 200 && rnd < m2chance) cb(m2)
          else cb(best === '(none)' || !best ? null : best)
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
  console.log(`Команды: d <глубина>  s <скилл 0-20>  g <ссылка>`)
  console.log(`Depth: ${DEPTH} | Skill: ${SKILL}\n`)

  return {
    getBestMove(fen, suboptimal = false, lateGame = false) {
      return new Promise(res => {
        multiMoves = {}; forceSuboptimal = suboptimal; lateGameMode = lateGame; bestMoveCb = res
        send('stop')
        send(`setoption name Skill Level value ${SKILL}`)
        send(`position fen ${fen}`)
        send(engineCmd())
        const restartCheck = setInterval(() => {
          if (RESTART && bestMoveCb === res) { clearInterval(restartCheck); bestMoveCb = null; res(null) }
        }, 200)
        setTimeout(() => { clearInterval(restartCheck); if (bestMoveCb === res) { bestMoveCb = null; res(null) } }, 10000)
      })
    },
    getEval(fen, depth = 6) {
      return new Promise(res => {
        multiMoves = {}
        bestMoveCb = () => res(lastEngineScore)
        send('stop')
        send('setoption name Skill Level value 20')
        send(`position fen ${fen}`)
        send(`go depth ${depth}`)
        const rc = setInterval(() => {
          if (RESTART && bestMoveCb) { clearInterval(rc); bestMoveCb = null; res(0) }
        }, 200)
        setTimeout(() => { clearInterval(rc); if (bestMoveCb) { bestMoveCb = null; res(0) } }, 8000)
      })
    },
    quit() { send('quit') },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Maia (lc0) engine — основной движок, играет человекоподобно (~1900)
// Требует: lc0.exe + maia-1900.pb.gz в папке бота
// Если файлы не найдены — автоматически переходим на чистый Stockfish
// ─────────────────────────────────────────────────────────────────────────────
async function initMaiaEngine() {
  const lc0Exe  = path.join(__dirname, 'lc0.exe')
  const maiaNet = path.join(__dirname, 'maia-1900.pb.gz')

  if (!fs.existsSync(lc0Exe))  { console.log('lc0.exe не найден — режим чистого Stockfish'); return null }
  if (!fs.existsSync(maiaNet)) { console.log('maia-1900.pb.gz не найден — режим чистого Stockfish'); return null }

  const proc = spawn(lc0Exe, [`--weights=${maiaNet}`])
  let mBestMoveCb = null
  let mReadyOkCb  = null
  let mBuf        = ''

  proc.on('error', (err) => { console.error('Ошибка lc0:', err.message) })
  proc.stdout.on('data', (data) => {
    mBuf += data.toString()
    const lines = mBuf.split('\n')
    mBuf = lines.pop()
    for (const raw of lines) {
      const line = raw.trim()
      if (line === 'readyok' && mReadyOkCb) { mReadyOkCb(); mReadyOkCb = null }
      if (line.startsWith('bestmove') && mBestMoveCb) {
        const mv = line.split(' ')[1]
        const cb = mBestMoveCb; mBestMoveCb = null
        cb(mv === '(none)' || !mv ? null : mv)
      }
    }
  })
  proc.stderr.on('data', () => {})

  const mSend = (cmd) => proc.stdin.write(cmd + '\n')
  await new Promise(r => { mReadyOkCb = r; mSend('uci'); mSend('isready') })
  console.log('Maia (lc0) готова — основной движок\n')

  return {
    getBestMove(fen) {
      return new Promise(res => {
        mBestMoveCb = res
        mSend('stop')
        mSend(`position fen ${fen}`)
        mSend('go nodes 1')
        setTimeout(() => { if (mBestMoveCb === res) { mBestMoveCb = null; res(null) } }, 5000)
      })
    },
    quit() { mSend('quit') },
  }
}

async function readLichessState(page) {
  return page.evaluate(() => {
    const moveCandidates = [
      ...document.querySelectorAll('l4x kwdb'),
      ...document.querySelectorAll('kwdb'),
      ...document.querySelectorAll('.moves move san'),
      ...document.querySelectorAll('move san'),
    ]
    const seen = new Set(), sanMoves = []
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
      document.querySelector('.game__result') ||
      document.querySelector('div.result-wrap')
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

async function moveMousaBezier(page, fromX, fromY, toX, toY) {
  const steps = 6 + Math.floor(Math.random() * 8)
  const cpX = (fromX + toX) / 2 + (Math.random() - 0.5) * 120
  const cpY = (fromY + toY) / 2 + (Math.random() - 0.5) * 120
  for (let i = 1; i <= steps; i++) {
    const tRaw = i / steps
    const t = tRaw < 0.5 ? 2 * tRaw * tRaw : 1 - Math.pow(-2 * tRaw + 2, 2) / 2
    const bx = (1-t)*(1-t)*fromX + 2*(1-t)*t*cpX + t*t*toX
    const by = (1-t)*(1-t)*fromY + 2*(1-t)*t*cpY + t*t*toY
    try { await page.mouse.move(bx, by) } catch { break }
    await page.waitForTimeout(4 + Math.random() * 8)
  }
  mousePos.x = toX; mousePos.y = toY
}

async function thinkingWander(page, boardBox, durationMs, skipWander) {
  if (skipWander || durationMs < 200 || !boardBox) {
    await page.waitForTimeout(durationMs); return
  }
  const deadline = new Promise(r => setTimeout(r, durationMs + 3000))
  const work = async () => {
    const end = Date.now() + durationMs
    let cx = mousePos.x || boardBox.x + boardBox.width / 2
    let cy = mousePos.y || boardBox.y + boardBox.height / 2
    while (Date.now() < end - 150) {
      if (RESTART) return
      const tx = boardBox.x + 15 + Math.random() * (boardBox.width - 30)
      const ty = boardBox.y + 15 + Math.random() * (boardBox.height - 30)
      const dist = Math.hypot(tx - cx, ty - cy)
      const steps = Math.max(3, Math.floor(dist / 40))
      for (let i = 1; i <= steps; i++) {
        if (Date.now() >= end - 150 || RESTART) break
        const t = i / steps
        try { await page.mouse.move(cx + (tx - cx) * t, cy + (ty - cy) * t) } catch { return }
        await page.waitForTimeout(12 + Math.random() * 20)
      }
      if (RESTART) return
      cx = tx; cy = ty
      mousePos.x = cx; mousePos.y = cy
      const pause = 100 + Math.random() * 300
      if (Date.now() + pause < end - 150) await page.waitForTimeout(pause)
      else break
    }
    const left = end - Date.now()
    if (left > 0 && !RESTART) await page.waitForTimeout(left)
  }
  await Promise.race([work(), deadline])
}

async function clickSquare(page, square, boardBox, isFlipped, turbo = false) {
  const file = square.charCodeAt(0) - 97
  const rank = parseInt(square[1]) - 1
  const sz   = boardBox.width / 8
  const x    = boardBox.x + (isFlipped ? (7 - file) : file) * sz + sz / 2
  const y    = boardBox.y + (isFlipped ? rank : (7 - rank)) * sz + sz / 2
  const fromX = mousePos.x || x + (Math.random() - 0.5) * sz * 3
  const fromY = mousePos.y || y + (Math.random() - 0.5) * sz * 3
  if (!turbo && Math.random() < 0.60) {
    const dx = (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 0.9)
    const dy = (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 0.9)
    const hoverX = Math.max(boardBox.x + sz * 0.1, Math.min(boardBox.x + boardBox.width  - sz * 0.1, x + dx * sz))
    const hoverY = Math.max(boardBox.y + sz * 0.1, Math.min(boardBox.y + boardBox.height - sz * 0.1, y + dy * sz))
    await moveMousaBezier(page, fromX, fromY, hoverX, hoverY)
    await page.waitForTimeout(70 + Math.random() * 180)
    await moveMousaBezier(page, hoverX, hoverY, x, y)
  } else if (!turbo) {
    await moveMousaBezier(page, fromX, fromY, x, y)
  }
  await page.waitForTimeout(turbo ? 5 + Math.random() * 10 : 25 + Math.random() * 55)
  if (!turbo && Math.random() < 0.07) {
    try { await page.mouse.click(x + (Math.random() - 0.5) * 14, y + (Math.random() - 0.5) * 14) } catch {}
    await page.waitForTimeout(60 + Math.random() * 100)
  }
  try { await page.mouse.click(x, y) } catch {}
  mousePos.x = x; mousePos.y = y
}

function startClipboardWatcher(page, isLichess) {
  if (!isLichess) return
  let lastClip = ''
  page.context().grantPermissions(['clipboard-read']).catch(() => {})
  setInterval(async () => {
    try {
      const text = (await page.evaluate(() => navigator.clipboard.readText())).trim()
      if (!text || text === lastClip) return
      lastClip = text
      if (isGameUrl(text)) {
        console.log(`\nБуфер: игровая ссылка → ${text}`)
        await page.goto(text)
      }
    } catch {}
  }, 800)
}

async function waitForGamePage(page, isLichess) {
  if (isLichess) await page.waitForURL(/lichess\.org\/[a-zA-Z0-9]{8}/, { timeout: 0 })
  await page.locator(isLichess ? 'cg-board' : '.board').first().waitFor({ timeout: 0 })
}

async function openBrowser(siteUrl) {
  try {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 2000 })
    const ctx  = browser.contexts()[0] || await browser.newContext()
    const page = ctx.pages()[0]        || await ctx.newPage()
    if (!page.url().includes('lichess') && !page.url().includes('chess.com')) await page.goto(siteUrl)
    console.log('Подключился к Chrome бота (CDP)')
    return { browser, page }
  } catch {}

  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
  ]
  const chromeExe = chromePaths.find(p => fs.existsSync(p))
  if (!chromeExe) throw new Error('Google Chrome не найден — установи Chrome.')

  const debugProfile = path.join(__dirname, 'chrome-bot-profile')
  console.log('Запускаю отдельное окно Chrome для бота...')
  spawn(chromeExe, [
    '--remote-debugging-port=9222',
    `--user-data-dir=${debugProfile}`,
    '--no-first-run', '--no-default-browser-check', '--start-maximized',
    siteUrl,
  ], { detached: true, stdio: 'ignore' }).unref()

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

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  const ctx  = browser.contexts()[0] || await browser.newContext()
  const page = ctx.pages()[0]        || await ctx.newPage()
  if (!page.url().includes('lichess') && !page.url().includes('chess.com')) await page.goto(siteUrl)
  return { browser, page }
}

// ─────────────────────────────────────────────────────────────────────────────
// Комбо-ход: Maia делает ходы, Stockfish страхует от зевков (порог >400cp)
// Если maiaEngine = null — работает как чистый Stockfish (без изменений)
// ─────────────────────────────────────────────────────────────────────────────
async function getComboMove(fen, sfEngine, maiaEngine, suboptimal, lateGame) {
  if (!maiaEngine) {
    const uciMove = await sfEngine.getBestMove(fen, suboptimal, lateGame)
    return { uciMove, source: 'sf' }
  }

  // Maia и SF думают параллельно (разные процессы — нет конфликтов)
  const [maiaMove, sfMove] = await Promise.all([
    maiaEngine.getBestMove(fen),
    sfEngine.getBestMove(fen, false, false),
  ])
  const evalBefore = lastEngineScore  // оценка SF до хода Maia (наша сторона, +хорошо нам)

  if (!maiaMove) return { uciMove: sfMove, source: 'sf' }

  // Одинаковый ход у обоих — проверка не нужна
  if (maiaMove === sfMove) return { uciMove: maiaMove, source: 'maia' }

  // Применяем ход Maia и просим SF оценить получившуюся позицию
  const testChess = new Chess(fen)
  let applied = null
  try { applied = testChess.move({ from: maiaMove.slice(0,2), to: maiaMove.slice(2,4), promotion: maiaMove[4] || 'q' }) } catch {}
  if (!applied) return { uciMove: sfMove, source: 'sf' }

  const evalAfterMaia = await sfEngine.getEval(testChess.fen(), isBulletGame ? 3 : 6)
  // evalBefore: наша перспектива   (+хорошо нам)
  // evalAfterMaia: перспектива соперника (+хорошо им = плохо нам)
  // Падение нашей оценки = evalBefore + evalAfterMaia
  const drop = evalBefore + evalAfterMaia

  if (drop > 400) return { uciMove: sfMove, source: 'sf-override' }
  return { uciMove: maiaMove, source: 'maia' }
}

async function runSession(engine, maiaEngine, isLichess, siteUrl, boardSel, readState) {
  const { browser, page } = await openBrowser(siteUrl)
  console.log(`\nБраузер открыт: ${siteUrl}`)
  console.log('Скопируй ссылку на игру — бот перейдёт автоматически.\n')

  startCommandListener(page)
  startClipboardWatcher(page, isLichess)

  try {
    while (true) {
      console.log('\nЖду игровую страницу...')
      await waitForGamePage(page, isLichess)
      await page.waitForTimeout(1000)

      let initialState
      try { initialState = await readState(page) } catch { await page.waitForTimeout(2000); continue }
      if (initialState.gameOver) { await page.waitForTimeout(2000); continue }

      const { isFlipped: fl } = initialState
      const myColor = fl ? 'b' : 'w'
      errorStreakLeft = 0
      await detectGameType(page)
      const modeInfo = maiaEngine
        ? `Режим: Maia+SF (SF depth:${DEPTH} — страховка)`
        : `Depth:${DEPTH} Skill:${SKILL}${AUTO_DEPTH ? ' [авто]' : ''}`
      console.log(`Играю за: ${myColor === 'w' ? '♔ Белых' : '♚ Чёрных'} | ${modeInfo}`)

      let lastFen = ''
      let fastStreakLeft = 0
      let currentOpeningName = ''
      let openingLogged = false
      let stuckFen = ''
      let stuckSince = 0

      while (true) {
        await page.waitForTimeout(250)
        if (RESTART) { RESTART = false; console.log('↺ Цикл перезапущен'); break }
        if (isLichess && !isGameUrl(page.url())) { console.log('Игра окончена (редирект).'); break }

        let state
        try { state = await readState(page) } catch { break }
        const { sanMoves, isFlipped: flipped, gameOver } = state
        if (gameOver) { console.log('Игра окончена.'); break }
        if (PAUSED) continue

        const chess = new Chess()
        for (const san of sanMoves) { try { chess.move(san) } catch {} }
        const fen = chess.fen()
        if (fen === lastFen) {
          // Авто-рестарт: ход не зарегистрировался на Lichess за 6 секунд
          const stuckMs = isBulletGame ? 2000 : gameCategory === 'blitz' ? 4000 : 6000
          if (chess.turn() === myColor && stuckFen === fen && stuckSince > 0 && Date.now() - stuckSince > stuckMs) {
            console.log('[авто-рестарт] Ход не прошёл — перезапуск')
            RESTART = true
          }
          continue
        }
        lastFen = fen
        stuckFen = ''
        if (chess.turn() !== myColor) continue
        if (chess.isGameOver()) break

        const boardPart = fen.split(' ')[0]
        const ourPieceCount = myColor === 'w'
          ? (boardPart.match(/[KQRBNP]/g) || []).length
          : (boardPart.match(/[kqrbnp]/g) || []).length
        const hyperTurbo = ourPieceCount <= 2

        const moveNum    = Math.ceil(chess.history().length / 2) + 1
        const skipBook   = chess.history().length >= 6 && Math.random() < 0.15
        const bookResult = skipBook ? null : bookMove(chess)
        if (bookResult?.name) currentOpeningName = bookResult.name
        const book = bookResult?.move ?? null

        if (!book && !openingLogged && currentOpeningName) {
          console.log(`[дебют] ${currentOpeningName}`)
          openingLogged = true
        }

        if (!book && fastStreakLeft <= 0 && Math.random() < 0.18)
          fastStreakLeft = 2 + Math.floor(Math.random() * 4)
        const isFast = !book && fastStreakLeft > 0
        if (isFast) fastStreakLeft--

        const { our: secs, opp: oppSecs } = isLichess ? await readBothClocks(page) : { our: null, opp: null }
        const timeDelta = (secs !== null && oppSecs !== null) ? secs - oppSecs : 0
        let effSecs = secs
        if (secs !== null && isBulletGame && timeDelta < 0)
          effSecs = Math.max(1, Math.min(secs, secs + timeDelta * 0.5))
        const pressingOpp = isBulletGame && oppSecs !== null && oppSecs < 6 && timeDelta > 4

        let delay, isLongThink = false
        if (hyperTurbo) {
          delay = 5 + Math.random() * 10
        } else if (book) {
          delay = 200 + Math.random() * 400
        } else if (pressingOpp) {
          delay = 150 + Math.random() * 250
        } else {
          const result = humanDelay(effSecs, moveNum, isFast, timeDelta)
          delay = result.ms; isLongThink = result.isLongThink
          if (fatigueGamesLeft > 0 && !isLongThink) delay *= 1.3 + Math.random() * 0.3
        }

        const legalCount = !book ? chess.moves().length : 0
        const isComplex  = legalCount > 32
        const isLateGame = moveNum > 30

        // Серия ошибок — только в SF режиме, у Maia свои человеческие ошибки
        if (!maiaEngine && !book && !isLongThink && errorStreakLeft <= 0)
          if (Math.random() < (isLateGame ? 0.09 : 0.05))
            errorStreakLeft = 1 + Math.floor(Math.random() * 2)
        const inStreak = !maiaEngine && !book && !isLongThink && errorStreakLeft > 0
        if (inStreak) errorStreakLeft--

        let from, to, promo, tag, ms = 0, logTag = ''
        if (book) {
          from = book.from; to = book.to; promo = book.promotion || null
          tag = currentOpeningName ? `[книга: ${currentOpeningName}]` : '[книга]'
          process.stdout.write(`Ход ${moveNum} ${tag} | `)
        } else {
          const origDepth = DEPTH
          if (isLongThink) DEPTH = Math.min(DEPTH + 1, 20)
          else if (isComplex && Math.random() < 0.30) DEPTH = Math.max(1, DEPTH - 2)

          process.stdout.write(`Ход ${moveNum} | Думаю... `)
          const t0 = Date.now()
          const combo = await getComboMove(fen, engine, maiaEngine, inStreak, !isLongThink && isLateGame)
          ms = Date.now() - t0
          DEPTH = origDepth
          const uciMove = combo.uciMove
          if (!uciMove) { console.log('(нет хода)'); continue }
          from = uciMove.slice(0, 2); to = uciMove.slice(2, 4); promo = uciMove[4] || null

          const modeTag = isLongThink ? '★' : inStreak ? '⚡' : isComplex && DEPTH < origDepth ? '~' : ''
          tag = maiaEngine
            ? (combo.source === 'sf-override' ? `[maia→SF d${DEPTH}]` : `[maia d${DEPTH}]`)
            : (isFast ? `[быстро d${DEPTH}]` : `[d${DEPTH}s${SKILL}${modeTag}]`)
          logTag = tag + ' '
        }

        const effTag  = (secs !== null && Math.abs(effSecs - secs) >= 2) ? ` (эфф ${Math.round(effSecs)}с)` : ''
        const timeInfo = secs !== null
          ? `, ${Math.round(secs)}с${effTag}${oppSecs !== null ? ` | opp ${Math.round(oppSecs)}с` : ''}`
          : ''
        const extraTags = [fatigueGamesLeft > 0 ? '[устал]' : '', isLongThink ? '[★]' : ''].filter(Boolean).join(' ')
        console.log(`${logTag}${from}→${to} (${ms ? `${ms}мс думал, ` : ''}${Math.round(delay)}мс пауза${timeInfo}${extraTags ? ' ' + extraTags : ''})`)

        if (!book && isBulletGame && secs !== null && secs < 10 && timeDelta < -3 && lastEngineScore < 100 && Math.random() < 0.08) {
          console.log(`(флаг — наше ${Math.round(secs)}с | opp ${Math.round(oppSecs ?? 0)}с | Δ${Math.round(timeDelta)}с)`)
          await page.waitForTimeout((secs + 2) * 1000)
          continue
        }

        const boardBox = await page.locator(boardSel).first().boundingBox()
        if (!boardBox) { console.log('Доска исчезла'); break }

        const turbo = hyperTurbo || (effSecs !== null && effSecs < 6)
        await thinkingWander(page, boardBox, delay, turbo)

        await clickSquare(page, from, boardBox, flipped, turbo)
        await page.waitForTimeout(turbo ? 5 + Math.random() * 10 : pressingOpp ? 20 + Math.random() * 30 : 60 + Math.random() * 80)
        await clickSquare(page, to, boardBox, flipped, turbo)
        stuckFen = fen; stuckSince = Date.now()  // фиксируем попытку хода

        if (promo && boardBox) {
          await page.waitForTimeout(turbo ? 60 + Math.random() * 60 : 250 + Math.random() * 150)
          await clickSquare(page, to, boardBox, flipped, true)
          console.log('(превращение: ферзь)')
        }

        const pmMinSecs = isBulletGame ? 6 : 15
        const pmChance  = isBulletGame ? 0.28 : 0.20
        const pmAllowed = (isBulletGame || gameCategory === 'blitz')
        if (pmAllowed && !promo && !turbo && effSecs !== null && effSecs > pmMinSecs && Math.random() < pmChance) {
          const origDepth = DEPTH, origSkill = SKILL
          try {
            const chessAfter = new Chess()
            for (const san of sanMoves) { try { chessAfter.move(san) } catch {} }
            chessAfter.move({ from, to, promotion: 'q' })
            const fenAfterOur = chessAfter.fen()
            const oppMovesCurrent = chessAfter.moves({ verbose: true })
            const board = chessAfter.board()
            let ourQueenSq = null
            for (let r = 0; r < 8 && !ourQueenSq; r++)
              for (let f = 0; f < 8 && !ourQueenSq; f++) {
                const p = board[r][f]
                if (p && p.type === 'q' && p.color === myColor) ourQueenSq = 'abcdefgh'[f] + (8 - r)
              }
            if (ourQueenSq && oppMovesCurrent.some(m => m.to === ourQueenSq)) throw new Error('skip')
            SKILL = 20; DEPTH = isBulletGame ? 3 : 5
            const oppMove = await engine.getBestMove(fenAfterOur)
            if (!oppMove || oppMove.length < 4) throw new Error('skip')
            const oppApplied = chessAfter.move({ from: oppMove.slice(0,2), to: oppMove.slice(2,4), promotion: 'q' })
            if (!oppApplied) throw new Error('skip')
            const pmMove = await engine.getBestMove(chessAfter.fen())
            if (!pmMove || pmMove.length < 4) throw new Error('skip')
            const pmFrom = pmMove.slice(0, 2), pmTo = pmMove.slice(2, 4)
            await page.waitForTimeout(80 + Math.random() * 200)
            await clickSquare(page, pmFrom, boardBox, flipped, true)
            await page.waitForTimeout(30 + Math.random() * 50)
            await clickSquare(page, pmTo, boardBox, flipped, true)
            console.log(`[премув] ${pmFrom}→${pmTo}`)
          } catch {} finally { DEPTH = origDepth; SKILL = origSkill }
        }
      }

      gamesPlayed++
      if (fatigueGamesLeft > 0) fatigueGamesLeft--
      if (fatigueGamesLeft === 0 && gamesPlayed % (10 + Math.floor(Math.random() * 6)) === 0) {
        fatigueGamesLeft = 2 + Math.floor(Math.random() * 3)
        console.log(`[усталость] Замедляюсь на ${fatigueGamesLeft} игры (партия ${gamesPlayed})`)
      }

      const dailyCount = loadDailyCount() + 1
      saveDailyCount(dailyCount)
      if (dailyCount === 15)       console.log('\n⚠️  15 партий сегодня. Рекомендую сделать перерыв 15–20 мин.')
      else if (dailyCount === 20)  console.log('\n🔴  20 партий сегодня — повышенный риск!')
      else if (dailyCount >= 25)   console.log('\n🔴🔴 25+ партий — СТОП. Очень высокий риск бана.')
      else                         console.log(`[сегодня: ${dailyCount} партий]`)

      await page.waitForTimeout(1500)
    }
  } finally {
    try { await browser.close() } catch {}
  }
}

async function main() {
  console.log('╔══════════════════════════════════════════╗')
  console.log('║       Combo Engine Chess Bot (v2)        ║')
  console.log('║  Maia (основной) + Stockfish (страховка) ║')
  console.log(`║  Depth: ${String(DEPTH).padEnd(4)} Skill: ${String(SKILL).padEnd(4)} Opening: ${OPENING_MOVES}ходов     ║`)
  console.log('╚══════════════════════════════════════════╝\n')

  const isLichess = SITE === 'lichess'
  const siteUrl   = isLichess ? 'https://lichess.org' : 'https://www.chess.com'
  const boardSel  = isLichess ? 'cg-board' : '.board'
  const readState = isLichess ? readLichessState : readChessComState

  console.log('Нажми ENTER для запуска...')
  await new Promise(r => process.stdin.once('data', r))

  const maiaEngine = await initMaiaEngine()
  const engine = await initEngine()

  while (true) {
    try {
      await runSession(engine, maiaEngine, isLichess, siteUrl, boardSel, readState)
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
