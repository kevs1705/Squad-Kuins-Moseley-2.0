@echo off
chcp 65001 > nul
title Instalador de Servicio Automatico - Biometrico K14
color 0A

echo =====================================================================
echo    INSTALADOR: SERVICIO AUTOMATICO BIOMETRICO K14 (MONSELEY)
echo =====================================================================
echo.
echo Configurando el arranque automatico con Windows...
echo.

set "SCRIPT_DIR=%~dp0"
set "VBS_PATH=%SCRIPT_DIR%Iniciar_Silencioso.vbs"
set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT_PATH=%STARTUP_FOLDER%\Biometrico_K14_Sync.lnk"

:: Crear el acceso directo en la carpeta Startup usando PowerShell
powershell -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%SHORTCUT_PATH%'); $s.TargetPath = 'wscript.exe'; $s.Arguments = '\"%VBS_PATH%\"'; $s.WorkingDirectory = '%SCRIPT_DIR%'; $s.Save()"

if exist "%SHORTCUT_PATH%" (
    echo [OK] Acceso directo de inicio creado exitosamente en Startup.
) else (
    echo [ERROR] No se pudo crear el acceso en la carpeta Startup.
    pause
    exit /b 1
)

echo.
echo Iniciando el servicio en segundo plano ahora mismo...
wscript.exe "%VBS_PATH%"

echo.
echo =====================================================================
echo  INSTALACION EXITOSA!
echo =====================================================================
echo  * El sincronizador ya esta corriendo en segundo plano (invisible).
echo  * Se ejecutara automaticamente cada vez que se encienda la PC.
echo  * Actualizara usuarios y asistencias cada 5 minutos.
echo  * Para revisar los registros de actividad, abre 'Ver_Estado_Servicio.bat'.
echo =====================================================================
echo.
pause
