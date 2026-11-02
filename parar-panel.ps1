# parar-panel.ps1 — para el panel de esta carpeta antes de desinstalarlo o actualizarlo: su Node.js, su adb (que sigue en
# marcha aunque se cierre el panel) y su scrcpy, que se reconocen porque están aquí, y su ventana, que lleva esta ruta en
# la línea de órdenes. Nada de fuera de esta carpeta, ni el desinstalador, que también está aquí
$aqui = $PSScriptRoot
function Dentro($texto) { $texto -and $texto.IndexOf($aqui, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
Get-CimInstance Win32_Process |
  Where-Object { ((Dentro $_.ExecutablePath) -and $_.Name -notlike 'unins*') -or ($_.Name -eq 'cmd.exe' -and (Dentro $_.CommandLine)) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
