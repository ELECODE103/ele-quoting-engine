@echo off
echo.
echo  ===================================
echo   Instant Quote - Starting App...
echo  ===================================
echo.
echo  Starting server + client...
echo  App will open at: http://localhost:3001
echo.
echo  Press Ctrl+C to stop.
echo.
start "" http://localhost:3001
npx concurrently "node server/index.js" "cd client && npx vite --port 3001"
