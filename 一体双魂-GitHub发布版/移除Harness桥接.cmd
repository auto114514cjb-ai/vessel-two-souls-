@echo off
setlocal
cd /d "%~dp0"
call node-run.cmd install-harness.mjs --remove %*
