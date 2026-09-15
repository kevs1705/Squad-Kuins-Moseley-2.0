@echo off
chcp 65001 > nul
title Sincronizador Biometrico K14 - MONSELEY
color 0B

echo =====================================================================
echo       SISTEMA DE SINCRONIZACION BIOMETRICO K14 - CLOUD (AIVEN)
echo =====================================================================
echo.
echo Conectando con la base de datos en la nube y el biometrico local...
echo.

cd /d "%~dp0"
node sincronizar_biometrico.js

echo.
echo =====================================================================
echo  Proceso completado. Puedes presionar cualquier tecla para cerrar.
echo =====================================================================
pause > nul
