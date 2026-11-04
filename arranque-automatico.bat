@echo off
chcp 65001 >nul
rem Doble clic: el panel arrancará solo cada vez que entres en Windows, en una terminal minimizada.
rem Otro doble clic lo quita. Para abrirlo a mano sigue estando panel.cmd.
set "ENTRY=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Android Mixer.cmd"
if exist "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Mis Android.cmd" ren "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Mis Android.cmd" "Android Mixer.cmd"
if exist "%ENTRY%" goto quitar

> "%ENTRY%" echo @echo off
>> "%ENTRY%" echo rem Lo creó arranque-automatico.bat: abre el panel de Android Mixer al entrar en Windows
>> "%ENTRY%" echo cd /d "%~dp0."
>> "%ENTRY%" echo start "Android Mixer" /min cmd /k node panel\server.js
echo Listo: el panel arrancará solo cada vez que entres en Windows, minimizado en la barra de tareas.
echo Ábrelo en el navegador con panel.cmd o en http://localhost:8765. Para pararlo, cierra su ventana.
echo Para que deje de arrancar solo, vuelve a abrir este archivo.
goto fin

:quitar
del "%ENTRY%"
echo Hecho: el panel ya no arranca solo al entrar en Windows. Puedes abrirlo cuando quieras con panel.cmd.

:fin
echo.
pause
