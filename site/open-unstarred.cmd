@echo off
cd /d "%~dp0"
curl -s -o nul http://127.0.0.1:3210/ || start "Unstarred server" /min node --env-file-if-exists=.env.local --env-file-if-exists=.env server.js

rem The browser must not open before the server is listening.
for /l %%i in (1,1,15) do (
  curl -s -o nul http://127.0.0.1:3210/ && goto open
  ping -n 2 127.0.0.1 >nul
)
echo Server did not start on port 3210. Windows may have reserved the port: set PORT or check the server window.
pause
exit /b 1

:open
start "" http://localhost:3210
