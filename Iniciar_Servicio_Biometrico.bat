@echo off
chcp 65001 > nul
title Servicio Continuo Biometrico K14 - MONSELEY
color 0A

echo =====================================================================
echo    SERVICIO PERMANENTE DE SINCRONIZACION AUTOMATICA (CADA 5 MIN)
echo =====================================================================
echo.
echo  * Esta ventana se mantendra abierta actualizando marcajes y usuarios.
echo  * Para detenerlo, simplemente cierra esta ventana.
echo.

cd /d "%~dp0"
node sincronizar_biometrico.js --daemon
