@echo off
chcp 65001 > nul
title Monitor de Sincronizacion Biometrico K14
color 0E

echo =====================================================================
echo    ESTADO DEL SERVICIO BIOMETRICO K14 (MONSELEY)
echo =====================================================================
echo.

powershell -Command "$proc = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*sincronizar_biometrico.js*' }; if ($proc) { Write-Host 'ESTADO: ACTIVO (Ejecutandose en segundo plano)' -ForegroundColor Green; Write-Host ('PID: ' + $proc.ProcessId + ' | Inicio: ' + $proc.CreationDate) } else { Write-Host 'ESTADO: INACTIVO (El servicio no esta corriendo)' -ForegroundColor Red }"

echo.
echo ---------------------------------------------------------------------
echo  ULTIMAS LINEAS DE LA BITACORA (sincronizacion.log):
echo ---------------------------------------------------------------------

if exist "%~dp0sincronizacion.log" (
    powershell -Command "Get-Content -Path '%~dp0sincronizacion.log' -Tail 25"
) else (
    echo [INFO] Todavia no hay registros generados en sincronizacion.log
)

echo.
echo =====================================================================
echo  Presiona cualquier tecla para salir.
echo =====================================================================
pause > nul
