@echo off
chcp 65001 >nul
rem Doble clic: arranca el panel y lo abre en el navegador. Cierra esta ventana para pararlo.
rem Si ya estaba en marcha (por ejemplo, porque arranca solo con Windows), solo lo abre en el navegador.
rem Con /fondo (el arranque con Windows, en una ventana minimizada) no abre el navegador.
rem Instalado con AndroidMixer-Setup.exe usa sus propias copias de Node.js, adb y scrcpy (vendor\), no las que tenga el
rem sistema; en una copia del código, sin vendor\, las del sistema.
title Android Mixer
cd /d "%~dp0"
set "NODE=node"
if exist "vendor\node\node.exe" set "NODE=%~dp0vendor\node\node.exe"
if exist "vendor\scrcpy\adb.exe" set "ADB=%~dp0vendor\scrcpy\adb.exe"
if exist "vendor\scrcpy\scrcpy.exe" set "SCRCPY=%~dp0vendor\scrcpy\scrcpy.exe"
"%NODE%" -e "process.exit(Number(process.versions.node.split('.')[0]) < 22 ? 1 : 0)" >nul 2>&1 || goto sin_node
set "ABRIR=--open"
if /i "%~1"=="/fondo" set "ABRIR="
rem Con la ruta entera: así el desinstalador reconoce este panel para pararlo
"%NODE%" "%~dp0panel\server.js" %ABRIR%
if errorlevel 1 pause
exit /b

:sin_node
echo Falta Node.js 22 o más nuevo. Instala Android Mixer con AndroidMixer-Setup.exe, que lo lleva dentro, o instala
echo Node.js desde https://nodejs.org
pause
exit /b 1
