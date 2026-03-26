@echo off
cd /d "%~dp0"

echo.
echo  =============================================
echo   Instant Quote Engine - Starting Up...
echo  =============================================
echo.
echo  Current folder: %cd%
echo.

:: Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo  -----------------------------------------------
  echo   Node.js is not installed on your computer.
  echo   You need it to run this app. It's free and safe.
  echo.
  echo   Opening the download page now...
  echo   Install the LTS version, then double-click
  echo   this file again.
  echo  -----------------------------------------------
  echo.
  start https://nodejs.org
  echo  Press any key to close this window...
  pause >nul
  exit /b 1
)

for /f "tokens=*" %%i in ('node --version') do set NODE_VER=%%i
echo  [OK] Node.js %NODE_VER% found.
echo.

:: First-time Windows setup: remove Linux-built packages and reinstall
if not exist ".windows-ready" (
  echo  =============================================
  echo   First-time setup on this computer.
  echo   Cleaning up and installing fresh packages...
  echo   This will take 2-3 minutes. Please wait.
  echo  =============================================
  echo.

  if exist "node_modules" (
    echo  Removing old server packages...
    rmdir /s /q "node_modules" 2>nul
  )
  if exist "client\node_modules" (
    echo  Removing old client packages...
    rmdir /s /q "client\node_modules" 2>nul
  )

  echo.
  echo  Installing server dependencies...
  call npm install
  if %errorlevel% neq 0 (
    echo.
    echo  ERROR: Server dependency install failed.
    echo  Make sure you have an internet connection and try again.
    echo.
    echo  Press any key to close this window...
    pause >nul
    exit /b 1
  )
  echo  [OK] Server dependencies installed.
  echo.

  echo  Installing frontend dependencies...
  pushd client
  call npm install
  if %errorlevel% neq 0 (
    popd
    echo.
    echo  ERROR: Frontend dependency install failed.
    echo  Make sure you have an internet connection and try again.
    echo.
    echo  Press any key to close this window...
    pause >nul
    exit /b 1
  )
  popd
  echo  [OK] Frontend dependencies installed.
  echo.

  :: Mark as ready so we don't redo this next time
  echo ready > ".windows-ready"
  echo  [OK] Setup complete!
  echo.
)

echo  =============================================
echo.
echo   Starting the app...
echo   Your browser will open in a few seconds.
echo.
echo   When you're done, close this window to stop.
echo.
echo  =============================================
echo.

:: Store the app root path
set "APP_ROOT=%~dp0"

:: Start the backend server in a separate window
start "Instant Quote - Backend" cmd /k "cd /d "%APP_ROOT%" && node server/index.js"

:: Give the backend a moment to start
timeout /t 3 /nobreak >nul

:: Start the frontend dev server in a separate window
start "Instant Quote - Frontend" cmd /k "cd /d "%APP_ROOT%client" && node node_modules\vite\bin\vite.js --port 3001"

:: Wait for frontend to be ready, then open browser
timeout /t 6 /nobreak >nul
start http://localhost:3001

echo.
echo  =============================================
echo   Both servers are running in separate windows.
echo.
echo   App: http://localhost:3001
echo.
echo   To stop: close the two other terminal windows
echo   that appeared, then close this one.
echo  =============================================
echo.
echo  Press any key to close this window...
pause >nul
