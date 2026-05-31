@echo off
cd /d "%~dp0"

if not exist node_modules (
    echo Установка зависимостей, подожди...
    call npm install
    echo.
)

echo Запуск Stockfish Bot...
npx electron .
