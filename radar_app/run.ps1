# Общий запуск приложения: движок, сервер и клиент - каждый в своем окне (закрыть окно - остановить эту часть).
# Запуск: двойной щелчок по run.cmd или powershell -ExecutionPolicy Bypass -File run.ps1 [-NoBrowser]
# Окружение движка ставится один раз вручную (README, «Движок»); пакеты клиента ставятся здесь, если их еще нет.
param(
    [switch]$NoBrowser # не открывать браузер
)

$root = $PSScriptRoot
$python = Join-Path $root "engine\.venv\Scripts\python.exe"

if (-not (Test-Path $python)) {
    Write-Host "Нет окружения движка engine\.venv - установите его по README, раздел «Движок»." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path (Join-Path $root "client\node_modules"))) {
    Write-Host "Установка пакетов клиента..."
    Push-Location (Join-Path $root "client")
    npm install
    Pop-Location
}

# каждое окно - отдельный PowerShell; заголовок окна - имя части
function Start-Part([string]$title, [string]$dir, [string]$command) {
    $script = "`$Host.UI.RawUI.WindowTitle = '$title'; `$env:PYTHONIOENCODING = 'utf-8'; $command"
    Start-Process powershell -WorkingDirectory $dir -ArgumentList "-NoExit", "-NoProfile", "-Command", $script | Out-Null
}

Start-Part "radar - движок" $root "& '$python' engine\main.py"
Start-Part "radar - сервер" (Join-Path $root "server") "dotnet run --project radar.forecast --launch-profile 'radar.forecast (no browser)'"
Start-Part "radar - клиент" (Join-Path $root "client") "npm run dev"

Write-Host "Запущены движок (http://127.0.0.1:8765), сервер (http://localhost:5080) и клиент (http://localhost:5175)."

if ($NoBrowser -or $env:RADAR_NO_BROWSER -eq "1") { exit 0 }

# браузер - когда клиент и сервер ответили (сборка сервера при первом запуске - до минуты)
Write-Host "Ожидание запуска..."
for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 2
    try {
        Invoke-WebRequest -UseBasicParsing "http://localhost:5080/swagger/index.html" -TimeoutSec 2 | Out-Null
        Invoke-WebRequest -UseBasicParsing "http://localhost:5175/" -TimeoutSec 2 | Out-Null
        Start-Process "http://localhost:5175"
        exit 0
    }
    catch { }
}

Write-Host "Сервер или клиент не ответили за 3 минуты - смотрите их окна." -ForegroundColor Yellow
