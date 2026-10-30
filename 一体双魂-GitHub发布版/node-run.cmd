@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "DESK_NODE=node"
if exist "SnowLuma\node.exe" set "DESK_NODE=%~dp0SnowLuma\node.exe"
"%DESK_NODE%" %*
if errorlevel 1 pause
