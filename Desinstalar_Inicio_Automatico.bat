@echo off
chcp 65001 > nul
title Desinstalador - Biometrico K14
color 0C

echo =====================================================================
echo    DESINSTALADOR: SERVICIO BIOMETRICO K14 (MONSELEY)
echo =====================================================================
echo.

set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT_PATH=%STARTUP_FOLDER%\Biometrico_K14_Sync.lnk"

if exist "%SHORTCUT_PATH%" (
    del /f /q "%SHORTCUT_PATH%"
    echo [OK] Acceso directo eliminado del inicio de Windows.
) else (
    echo [INFO] No habia acceso directo configurado en Startup.
)

echo.
echo Deteniendo procesos del sincronizador...
powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*sincronizar_biometrico.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ('[OK] Proceso detenido: PID ' + $_.ProcessId) }"

echo.
echo =====================================================================
echo  Servicio desinstalado y detenido correctamente.
echo =====================================================================
echo.
pause
