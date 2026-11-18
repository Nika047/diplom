@echo off
rem Launches engine, server and client (see run.ps1). Latin only: cmd misreads UTF-8 Cyrillic in .cmd files.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" %*
