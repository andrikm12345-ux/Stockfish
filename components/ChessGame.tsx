'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Chessboard } from 'react-chessboard'
import { Chess } from 'chess.js'

const LEVELS = [
  { name: 'Новичок',  skill: 0,  depth: 1  },
  { name: 'Лёгкий',   skill: 5,  depth: 5  },
  { name: 'Средний',  skill: 10, depth: 10 },
  { name: 'Сложный',  skill: 15, depth: 15 },
  { name: 'Эксперт',  skill: 20, depth: 20 },
]

export default function ChessGame() {
  const [fen, setFen] = useState('start')
  const [orientation, setOrientation] = useState<'white' | 'black'>('white')
  const [playerColor, setPlayerColor] = useState<'w' | 'b'>('w')
  const [levelIdx, setLevelIdx] = useState(2)
  const [thinking, setThinking] = useState(false)
  const [statusMsg, setStatusMsg] = useState('Ход белых')
  const [gameOver, setGameOver] = useState(false)
  const [inCheck, setInCheck] = useState(false)
  const [history, setHistory] = useState<string[]>([])
  const [boardWidth, setBoardWidth] = useState(480)

  const chess = useRef(new Chess())
  const sfWorker = useRef<Worker | null>(null)
  const sfResolve = useRef<((m: string) => void) | null>(null)
  const thinkingRef = useRef(false)
  const playerColorRef = useRef<'w' | 'b'>('w')
  const levelIdxRef = useRef(2)
  const historyEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => { thinkingRef.current = thinking }, [thinking])
  useEffect(() => { playerColorRef.current = playerColor }, [playerColor])
  useEffect(() => { levelIdxRef.current = levelIdx }, [levelIdx])

  useEffect(() => {
    const resize = () => setBoardWidth(Math.min(500, window.innerWidth - 32))
    resize()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  useEffect(() => {
    const w = new Worker('/stockfish.js')
    sfWorker.current = w
    w.postMessage('uci')
    w.postMessage('isready')
    w.onmessage = ({ data }: MessageEvent<string>) => {
      if (data.startsWith('bestmove') && sfResolve.current) {
        const raw = data.split(' ')[1]
        sfResolve.current(raw === '(none)' || !raw ? '' : raw)
        sfResolve.current = null
      }
    }
    return () => w.terminate()
  }, [])

  useEffect(() => {
    historyEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [history])

  const syncState = useCallback((g: Chess) => {
    const t = g.turn()
    const side = t === 'w' ? 'белых' : 'чёрных'
    const sideCap = t === 'w' ? 'Белые' : 'Чёрные'
    setFen(g.fen())
    setHistory(g.history())
    setGameOver(g.isGameOver())
    setInCheck(g.isCheck() && !g.isCheckmate())
    if      (g.isCheckmate())  setStatusMsg(`Мат! ${sideCap} проиграли.`)
    else if (g.isStalemate())  setStatusMsg('Пат — ничья.')
    else if (g.isDraw())       setStatusMsg('Ничья.')
    else if (g.isCheck())      setStatusMsg(`Шах! Ход ${side}.`)
    else                       setStatusMsg(`Ход ${side}`)
  }, [])

  const doEngineMove = useCallback(async (g: Chess) => {
    if (g.isGameOver()) return
    const { skill, depth } = LEVELS[levelIdxRef.current]
    setThinking(true)

    const best = await new Promise<string>(res => {
      sfResolve.current = res
      sfWorker.current?.postMessage('stop')
      sfWorker.current?.postMessage(`setoption name Skill Level value ${skill}`)
      sfWorker.current?.postMessage(`position fen ${g.fen()}`)
      sfWorker.current?.postMessage(`go depth ${depth}`)
    })

    setThinking(false)
    if (!best) return

    try {
      g.move({
        from: best.slice(0, 2),
        to: best.slice(2, 4),
        promotion: (best[4] ?? 'q') as 'q' | 'r' | 'b' | 'n',
      })
      syncState(g)
    } catch {
      // ignore rare edge cases
    }
  }, [syncState])

  const onPieceDrop = useCallback((from: string, to: string, piece: string): boolean => {
    const g = chess.current
    if (g.isGameOver() || thinkingRef.current || g.turn() !== playerColorRef.current) return false

    const promo = piece[1]?.toLowerCase() as 'q' | 'r' | 'b' | 'n' | undefined

    try {
      g.move({ from, to, promotion: promo ?? 'q' })
    } catch {
      return false
    }

    syncState(g)
    if (!g.isGameOver()) setTimeout(() => doEngineMove(g), 150)
    return true
  }, [syncState, doEngineMove])

  const newGame = useCallback(() => {
    sfWorker.current?.postMessage('stop')
    sfResolve.current = null
    const g = new Chess()
    chess.current = g
    thinkingRef.current = false
    setThinking(false)
    setGameOver(false)
    setInCheck(false)
    setHistory([])
    setFen('start')
    setStatusMsg('Ход белых')
    if (playerColorRef.current === 'b') setTimeout(() => doEngineMove(g), 500)
  }, [doEngineMove])

  const toggleColor = (c: 'w' | 'b') => {
    setPlayerColor(c)
    playerColorRef.current = c
    setOrientation(c === 'w' ? 'white' : 'black')
  }

  const pairs: Array<[string, string?]> = []
  for (let i = 0; i < history.length; i += 2) pairs.push([history[i], history[i + 1]])

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-900 via-gray-900 to-slate-800 flex flex-col items-center justify-center p-4 gap-6">
      {/* Header */}
      <div className="text-center">
        <h1 className="text-2xl md:text-3xl font-bold text-white tracking-tight">
          <span className="text-emerald-400">♟</span> Шахматы
        </h1>
        <p className="text-slate-400 text-sm mt-0.5">Powered by Stockfish</p>
      </div>

      <div className="flex flex-col lg:flex-row gap-5 items-start w-full max-w-5xl">
        {/* Board */}
        <div className="flex-shrink-0 mx-auto lg:mx-0">
          <Chessboard
            position={fen}
            onPieceDrop={onPieceDrop}
            boardOrientation={orientation}
            boardWidth={boardWidth}
            arePiecesDraggable={!gameOver && !thinking && chess.current.turn() === playerColorRef.current}
            customBoardStyle={{
              borderRadius: '10px',
              boxShadow: '0 24px 48px rgba(0,0,0,0.6)',
            }}
            customDarkSquareStyle={{ backgroundColor: '#769656' }}
            customLightSquareStyle={{ backgroundColor: '#eeeed2' }}
          />
        </div>

        {/* Sidebar */}
        <div className="flex flex-col gap-3 w-full lg:w-64 xl:w-72 flex-shrink-0">

          {/* Status */}
          <div className={`rounded-xl p-4 border transition-colors ${
            gameOver ? 'bg-red-950/60 border-red-700' :
            inCheck  ? 'bg-amber-950/60 border-amber-700' :
                       'bg-slate-800/80 border-slate-700'
          }`}>
            <p className="text-xs font-medium text-slate-400 uppercase tracking-widest mb-1">Статус</p>
            <p className="font-semibold text-white">{statusMsg}</p>
            {thinking && (
              <div className="mt-2 flex items-center gap-2 text-slate-400 text-sm">
                <span className="w-3 h-3 border-2 border-t-emerald-400 border-slate-600 rounded-full animate-spin inline-block" />
                Stockfish думает...
              </div>
            )}
          </div>

          {/* Play as */}
          <div className="rounded-xl p-4 bg-slate-800/80 border border-slate-700">
            <p className="text-xs font-medium text-slate-400 uppercase tracking-widest mb-2">Играть за</p>
            <div className="grid grid-cols-2 gap-2">
              {(['w', 'b'] as const).map(c => (
                <button
                  key={c}
                  onClick={() => toggleColor(c)}
                  className={`py-2.5 rounded-lg text-sm font-semibold transition-all ${
                    playerColor === c
                      ? c === 'w'
                        ? 'bg-white text-gray-900 ring-2 ring-white/40 shadow-md'
                        : 'bg-slate-950 text-white border border-slate-500 ring-2 ring-slate-400/30 shadow-md'
                      : 'bg-slate-700 text-slate-400 hover:bg-slate-600 hover:text-slate-200'
                  }`}
                >
                  {c === 'w' ? '♔ Белых' : '♚ Чёрных'}
                </button>
              ))}
            </div>
          </div>

          {/* Difficulty */}
          <div className="rounded-xl p-4 bg-slate-800/80 border border-slate-700">
            <p className="text-xs font-medium text-slate-400 uppercase tracking-widest mb-2">Сложность</p>
            <div className="flex flex-col gap-1.5">
              {LEVELS.map((d, i) => (
                <button
                  key={i}
                  onClick={() => setLevelIdx(i)}
                  className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium text-left transition-all ${
                    levelIdx === i
                      ? 'bg-emerald-700 text-white shadow-sm'
                      : 'bg-slate-700/50 text-slate-400 hover:bg-slate-600/50 hover:text-slate-200'
                  }`}
                >
                  <span>{d.name}</span>
                  {levelIdx === i && <span className="text-emerald-300 text-xs">●</span>}
                </button>
              ))}
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-2">
            <button
              onClick={newGame}
              className="flex-1 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 font-semibold text-white transition-colors shadow-lg shadow-emerald-900/30"
            >
              Новая игра
            </button>
            <button
              onClick={() => setOrientation(o => o === 'white' ? 'black' : 'white')}
              className="p-3 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-300 text-xl transition-colors"
              title="Перевернуть доску"
            >
              ↕
            </button>
          </div>

          {/* Move history */}
          <div className="rounded-xl bg-slate-800/80 border border-slate-700 overflow-hidden">
            <div className="px-4 pt-4 pb-2">
              <p className="text-xs font-medium text-slate-400 uppercase tracking-widest">
                Ходы {history.length > 0 && <span className="text-slate-500">({history.length})</span>}
              </p>
            </div>
            <div className="max-h-52 overflow-y-auto px-4 pb-4 text-sm font-mono">
              {pairs.length === 0 ? (
                <p className="text-slate-600 text-center py-6 text-xs">Ходов нет</p>
              ) : (
                pairs.map(([w, b], i) => (
                  <div
                    key={i}
                    className={`flex py-0.5 px-1 rounded ${
                      i === pairs.length - 1 ? 'bg-slate-700/40' : ''
                    }`}
                  >
                    <span className="text-slate-600 w-6 select-none">{i + 1}.</span>
                    <span className="text-slate-200 w-16">{w}</span>
                    {b && <span className="text-slate-300">{b}</span>}
                  </div>
                ))
              )}
              <div ref={historyEndRef} />
            </div>
          </div>

          {/* Info */}
          <p className="text-xs text-slate-600 text-center">
            Stockfish 10 · UCI · Web Worker
          </p>
        </div>
      </div>
    </main>
  )
}
