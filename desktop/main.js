'use strict'

const { app, BrowserWindow, ipcMain } = require('electron')
const { spawn } = require('child_process')
const path = require('path')

let win = null
let botProcess = null

function createWindow() {
  win = new BrowserWindow({
    width: 560,
    height: 740,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Stockfish Bot',
    backgroundColor: '#0d1117',
  })
  win.loadFile('index.html')
  win.setMenuBarVisibility(false)
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (botProcess) botProcess.kill()
  app.quit()
})

// Запуск бота
ipcMain.handle('start-bot', (_, { site, depth, skill, autoDepth }) => {
  if (botProcess) return false

  const env = { ...process.env, SITE: site }
  if (!autoDepth) env.DEPTH = String(depth)

  botProcess = spawn(process.execPath, [path.join(__dirname, '..', 'bot', 'bot.js')], {
    env,
    cwd: path.join(__dirname, '..', 'bot'),
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  botProcess.stdout.on('data', d => win?.webContents.send('log', d.toString()))
  botProcess.stderr.on('data', d => win?.webContents.send('log', d.toString()))

  botProcess.on('close', () => {
    win?.webContents.send('log', '\n— Бот остановлен —\n')
    win?.webContents.send('bot-stopped')
    botProcess = null
  })

  // Авто ENTER для "Нажми ENTER для запуска"
  setTimeout(() => botProcess?.stdin.write('\n'), 800)

  // Отправляем скилл после инициализации движка (~6 сек)
  setTimeout(() => botProcess?.stdin.write(`s ${skill}\n`), 6000)

  return true
})

// Остановка бота
ipcMain.handle('stop-bot', () => {
  if (botProcess) { botProcess.kill(); botProcess = null }
})

// Отправка команды в stdin бота
ipcMain.handle('cmd', (_, text) => {
  botProcess?.stdin.write(text + '\n')
})
