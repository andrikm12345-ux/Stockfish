@echo off
echo ==========================================
echo       Stockfish Chess Bot - Запуск
echo ==========================================
echo.

echo [1/3] Закрываю Chrome...
taskkill /F /IM chrome.exe 2>nul
timeout /t 2 /nobreak >nul

echo [2/3] Открываю Chrome с твоим аккаунтом...
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
) else if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
    start "" "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
) else (
    echo Не найден Chrome! Установи Google Chrome.
    pause
    exit
)

echo [3/3] Жду пока Chrome загрузится...
timeout /t 4 /nobreak >nul

echo.
echo Запускаю бота...
echo.
node bot.js
