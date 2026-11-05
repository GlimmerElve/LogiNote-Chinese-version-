@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist ".ui-preview\community-local\runtime.json" if exist "apps\community-api\.env" goto local_service
cd /d "%~dp0apps\community-web"
call npm run dev
if errorlevel 1 pause
goto :eof
:local_service
node --require ./scripts/node-os-userinfo-fallback.cjs scripts/start-community-local.mjs
if errorlevel 1 pause
