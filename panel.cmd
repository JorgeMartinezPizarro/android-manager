@echo off
rem Doble clic: arranca el panel y lo abre en el navegador. Cierra esta ventana para pararlo.
rem Si ya estaba en marcha (por ejemplo, porque arranca solo con Windows), solo lo abre en el navegador.
cd /d "%~dp0"
node panel\server.js --open
if errorlevel 1 pause
