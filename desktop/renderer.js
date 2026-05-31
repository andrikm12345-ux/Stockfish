'use strict'

let running = false
let paused  = false
let site    = 'lichess'
let skillTimer = null
let depthTimer = null

const startBtn    = document.getElementById('startBtn')
const pauseBtn    = document.getElementById('pauseBtn')
const enterBtn    = document.getElementById('enterBtn')
const clearBtn    = document.getElementById('clearBtn')
const depthSlider = document.getElementById('depth')
const skillSlider = document.getElementById('skill')
const depthVal    = document.getElementById('depthVal')
const skillVal    = document.getElementById('skillVal')
const autoDepth   = document.getElementById('autoDepth')
const logEl       = document.getElementById('log')
const statusEl    = document.getElementById('status')

// Выбор сайта
document.querySelectorAll('.site-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (running) return
    document.querySelectorAll('.site-btn').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    site = btn.dataset.site
  })
})

// Авто-глубина
autoDepth.addEventListener('change', () => {
  depthSlider.disabled = autoDepth.checked
  depthVal.textContent = autoDepth.checked ? 'авто' : depthSlider.value
  if (running) window.bot.cmd(autoDepth.checked ? 'a' : `d ${depthSlider.value}`)
})

// Слайдер глубины
depthSlider.addEventListener('input', () => {
  depthVal.textContent = depthSlider.value
  clearTimeout(depthTimer)
  depthTimer = setTimeout(() => {
    if (running) window.bot.cmd(`d ${depthSlider.value}`)
  }, 400)
})

// Слайдер скилла
skillSlider.addEventListener('input', () => {
  skillVal.textContent = skillSlider.value
  clearTimeout(skillTimer)
  skillTimer = setTimeout(() => {
    if (running) window.bot.cmd(`s ${skillSlider.value}`)
  }, 400)
})

// Старт / Стоп
startBtn.addEventListener('click', async () => {
  if (!running) {
    log('Запускаю бота...\n')
    const ok = await window.bot.start({
      site,
      depth:     parseInt(depthSlider.value),
      skill:     parseInt(skillSlider.value),
      autoDepth: autoDepth.checked,
    })
    if (ok !== false) {
      running = true
      paused  = false
      startBtn.textContent = '⏹ СТОП'
      startBtn.classList.add('stop')
      pauseBtn.disabled = false
      enterBtn.disabled = false
      setStatus('running', '● Работает')
    }
  } else {
    await window.bot.stop()
    setIdle()
  }
})

// Пауза / Продолжить
pauseBtn.addEventListener('click', () => {
  window.bot.cmd('p')
  paused = !paused
  pauseBtn.textContent = paused ? '▶ ПРОДОЛЖИТЬ' : '⏸ ПАУЗА'
  pauseBtn.classList.toggle('resume', paused)
  setStatus(paused ? 'paused' : 'running', paused ? '⏸ Пауза' : '● Работает')
})

// ENTER (для подтверждения входа в браузере)
enterBtn.addEventListener('click', () => {
  window.bot.cmd('')
  log('[↵ ENTER отправлен]\n')
})

// Очистить лог
clearBtn.addEventListener('click', () => { logEl.value = '' })

// Бот остановился сам
window.bot.onStop(setIdle)

// Входящий лог
window.bot.onLog(msg => log(msg))

function log(msg) {
  logEl.value += msg
  logEl.scrollTop = logEl.scrollHeight
}

function setIdle() {
  running = false
  paused  = false
  startBtn.textContent = '▶ СТАРТ'
  startBtn.classList.remove('stop')
  pauseBtn.disabled = true
  pauseBtn.textContent = '⏸ ПАУЗА'
  pauseBtn.classList.remove('resume')
  enterBtn.disabled = true
  setStatus('', 'Остановлен')
}

function setStatus(cls, text) {
  statusEl.className = 'status ' + cls
  statusEl.textContent = text
}
