# Mis Android

Panel web para ver y gestionar las apps de los móviles Android de casa desde el PC. Habla con ellos
por adb, igual que `droids.sh`, y usa los mismos ficheros, así que puedes usar uno u otro.

## Arrancar

1. Instala adb (una vez), desde una terminal:

   ```bash
   winget install Google.PlatformTools
   ```

   También vale descargar las [SDK Platform-Tools](https://developer.android.com/tools/releases/platform-tools)
   y descomprimirlas aquí, de forma que quede `platform-tools\adb.exe`.

2. Doble clic en `panel.cmd` (o `npm start`). Se abre http://localhost:8765 en el navegador.
   Cierra la ventana negra para pararlo. Si ya estaba en marcha, `panel.cmd` solo lo abre en el navegador.

Para que arranque solo cada vez que entres en Windows (en una terminal minimizada), doble clic en
`arranque-automatico.bat`. Otro doble clic lo quita.

Para trastear sin móviles: `npm run demo` abre http://localhost:8766 con cuatro móviles simulados.
No toca tus ficheros.

## Preparar cada móvil (una sola vez)

1. **Opciones de desarrollador**: Ajustes → Información del teléfono → toca 7 veces «Número de compilación»
   (en Xiaomi, «Versión de MIUI/HyperOS»). Aparecen en Ajustes → Sistema.
2. Conéctalo al panel de una de estas dos formas:
   - **Con QR (Android 11 o superior, sin cables)**: en el panel, «Mostrar código QR». En el móvil, Opciones de
     desarrollador → Depuración inalámbrica → «Vincular dispositivo con código QR», y escanéalo.
     El móvil tiene que estar en la misma wifi que el PC. Si Windows pregunta si adb puede usar la red,
     permite las redes privadas. Después se reconecta solo cada vez que el móvil tenga activa la depuración
     inalámbrica (algunos móviles la apagan al reiniciarse: vuelve a activarla y listo, sin escanear).
   - **Con cable USB**: activa «Depuración USB», enchúfalo y acepta «¿Permitir depuración USB?» marcando
     «Permitir siempre». En el panel, «Pasar a Wi-Fi» y ya puedes quitar el cable. La IP se guarda en
     `datos/devices.txt` y el panel la reconecta al arrancar y, si se cae (por ejemplo, porque adb se ha reiniciado), al cabo
     de un minuto. Si lo quitas con «Desconectar», no vuelve hasta que pulses «Reconectar». Este modo se pierde si el
     móvil se reinicia.

3. **OPPO, realme, OnePlus y Xiaomi** no dejan a adb cambiar ajustes ni pulsar teclas hasta activar en Opciones de
   desarrollador «Desactivar supervisión de permisos» (OPPO, realme, OnePlus) o «Depuración USB (ajustes de
   seguridad)» (Xiaomi). Sin eso fallan los Ajustes, las acciones rápidas y el ratón en «Ver pantalla».

Consejo: reserva en el router una IP fija para cada móvil.

## Qué hace

- **Dispositivos**: los móviles conectados con batería, conexión y un nombre que tú eliges.
  **Ver pantalla** abre la pantalla del móvil en una ventana del PC (por wifi tarda unos segundos) y lo manejas
  con el ratón y el teclado. La ventana sigue abierta aunque cierres el panel.
  Usa [scrcpy](https://github.com/Genymobile/scrcpy), que se instala una vez con `winget install Genymobile.scrcpy`.
- **Ficha de cada móvil** («Controlar»):
  - **Acciones rápidas**: encender, desbloquear y apagar la pantalla, captura, girarla (horizontal, vertical o
    sola), abrir el calendario, volumen de la música, canción anterior / play / siguiente, abrir un enlace en el
    móvil y mandarle un aviso (Android 10 o superior).
  - **Cerrar**, junto al enlace, cierra del todo la app con la que se abrió (YouTube, el navegador…). Si el móvil
    preguntaría con qué app abrir el enlace, el panel elige la app antes que el navegador: un vídeo, en YouTube.
  - **Calendario** abre el que tenga cada móvil en la última vista que se usó: para verlo en modo mes, elige
    «Mes» una vez a mano en cada uno. Las apps que solo funcionan en vertical no giran aunque pidas horizontal.
  - **Hacer sonar**, para encontrarlo: pone un temporizador en el reloj si el móvil lo deja (como el OPPO) o, si no,
    reproduce la alarma en su reproductor de música con la música al máximo. Si no tiene ninguna de las dos
    cosas (como el Nexus), lo dice.
  - **Desbloquear** solo quita el bloqueo de deslizar. Con PIN o patrón, adb no puede saltárselo: escríbelo
    tú desde «Ver pantalla».
  - **Sus apps** (las tuyas y, si quieres, las del sistema) para abrirlas, desactivarlas, desinstalarlas o
    restaurar las del sistema que hayas quitado.
- **Apps**: las *apps comunes*, con su estado en cada móvil (✓ instalada, ↑ hay versión nueva, + falta,
  – ese móvil no la necesita, ! falló). Pulsa una celda para elegir: instalarla o ponerla al día en ese móvil, marcar que
  no la necesita (ahí ni se instala ni se actualiza), quitarla de ese móvil (la desinstala y la marca) o volver a ponerla.
  Las nuevas, y los móviles que lleguen nuevos, la llevan. «Instalar lo pendiente» instala todo lo que falta donde se
  necesita. Cada app común viene de uno de estos sitios:
  - **APK propio**: lo subes tú, o lo copias de un móvil donde ya esté (solo apps de una pieza, como tus
    apps privadas). Se instala tal cual; si subes una versión nueva, se actualiza en todos.
  - **F-Droid**: el panel descarga la última versión, comprueba que es la app correcta, la instala y la
    actualiza cuando sale otra.
  - **Google Play**: Play no deja instalar desde fuera. El panel abre la ficha de la app en cada móvil
    donde falte, y su pantalla en el PC (con scrcpy, como «Ver pantalla»), para que pulses «Instalar» desde aquí. Luego
    Play la mantiene al día.

  Con **«Instalar y actualizar solas»** activado, cada 5 minutos se ponen al día las de APK propio y
  F-Droid en los móviles conectados. Google Play nunca se abre solo.
  Debajo están las **otras apps** (instaladas pero no comunes): ★ la hace común, «Quitarlas todas»
  las desinstala. Y las listas de `datos/debloat/` para quitar apps del sistema.
- **Música**: tus canciones sonando a la vez en los móviles que marques. Cada móvil hace de altavoz con una página
  que el panel le abre en Chrome («Abrir» en su fila o «Abrir en todos»). No se manda «play» a cada uno, porque cada móvil
  tarda distinto en obedecer (de 0,2 a 3 s): todos ajustan su reloj con el del PC y el PC les dice a qué hora exacta
  empieza la canción. Mientras suena, cada uno mide cada pocos segundos cuánto se ha ido de donde debería estar y lo corrige
  solo, acelerando o frenando un poco (como mucho un 0,5 %, que no se nota en el tono); solo si se va más de 30 ms se recoloca
  de golpe. En el panel, junto a «Sonando», sale su **desfase** en ese momento.
  - Las canciones son las de la carpeta `datos/musica/` (y sus subcarpetas): súbelas desde el panel o cópialas ahí.
    Valen mp3, m4a, aac, ogg, opus, wav y flac. Al acabar una suena la siguiente, y tras la última, otra vez la primera.
    Se eligen con **Canciones**, que las muestra a pantalla completa con un buscador (sin tildes ni mayúsculas; Enter
    pone la primera que quede). Al elegir una se cierra sola. De los nombres se quita lo que añade la descarga de
    YouTube: el código del vídeo («[p4QqMKe3rwY]») y coletillas como «(Official Music Video)» o «[4K]».
  - Cada altavoz tiene su **volumen** (el de la música del propio móvil, el mismo que cambian sus botones; el panel lo
    lee cada pocos segundos y lo muestra de 0 a 100 % en todos, aunque cada móvil tenga sus pasos). El altavoz a su
    izquierda lo **silencia** o le devuelve la voz de un clic, y **Solo** hace que suene únicamente ese. «Que suenen
    todos» les quita el silencio a todos. La lupa es «Ver pantalla», y la flecha circular, «Reabrir».
  - Pulsando en la barra de la canción se salta a ese punto. **Aleatorio** sigue con una canción cualquiera en vez de
    con la siguiente, y el **temporizador** pausa la música al cabo de 15 minutos a 2 horas.
  - **Prueba de sincronía**: un pitido por segundo. Si un móvil se oye antes que los demás, súbele el **retraso**;
    si se oye después, bájalo. Va de milisegundo en milisegundo con − y +, o escribe el número. Un altavoz Bluetooth suele
    ir un poco por detrás: ese móvil, con retraso negativo.
  - La página del altavoz ocupa toda la pantalla de cada móvil y hace de mando: arriba la canción (en una línea: si no
    cabe, se desliza despacio para enseñarla entera; con el artista debajo y por dónde va) y los botones de anterior, pausa y siguiente, que valen para todos los altavoces; abajo,
    **Elegir canción** y el volumen de ese móvil: **Bajar**, **Silenciar** (en ámbar mientras está silenciado; con otro
    toque vuelve a sonar) y **Subir**. El volumen lo cambia el PC por adb, porque una página no puede: es el mismo que
    el de los botones del móvil y el de la barra del panel. Elegir canción abre la lista a pantalla completa, con letra
    grande y buscador; se cierra al elegir una, con la X o con el botón de volver del móvil. La pantalla se queda encendida mientras la página está delante
    (si se apaga, Android puede dormir Chrome). Déjalos enchufados. Si nadie la toca en 3 minutos descansa: la página se queda
    en negro y el panel baja el brillo del móvil al mínimo. En las pantallas OLED (como la del Nexus 6) el negro apaga los
    píxeles, así que no se ve nada ni se queda grabada la imagen. Los móviles que en manual no bajan del todo (el Nexus 6 se
    queda en 17 de 255) se dejan en automático con el ajuste al mínimo, que a oscuras sí llega a 1. Vuelve al tocar la
    pantalla o arrastrar el dedo por ella, con el brillo que tenía (también el automático). El toque que la despierta no pulsa
    nada: el botón que hubiera debajo se pulsa con el siguiente.
  - Chrome no deja sonar una página hasta que alguien la toca: el panel la toca solo. Si el móvil tiene PIN o patrón,
    desbloquéalo cuando lo abras y el panel la tocará en cuanto pueda. La lupa («Ver pantalla»), en la fila de cada
    altavoz, abre su pantalla en el PC para desbloquearlo o tocarla desde aquí.
  - Cuando el panel trae una versión nueva de la página, las que están abiertas se recargan solas. «Reabrir» la vuelve a
    cargar en ese móvil, por si algo va raro.
  - El PC tiene que estar encendido con el panel en marcha: la música sale de él.
  - Los móviles con Android 7, como el Nexus 6, no dejan que adb les abra la conexión con el PC: su página llega al PC
    por la wifi de casa, a la IP del PC. Ahí Chrome no deja mantener la pantalla encendida, así que déjalos enchufados
    con «Pantalla encendida mientras carga» (en Ajustes).
- **Ajustes**: un perfil común para todos los móviles: modo oscuro, brillo automático, cuándo se apaga la
  pantalla, tamaño de letra, giro automático, pantalla encendida mientras carga, animaciones y filtro de
  internet (DNS privado con AdGuard DNS o Cloudflare, que quita anuncios o webs para adultos en todo el móvil).
  Cada celda muestra lo que tiene cada móvil: verde si ya está como el perfil, naranja si no (púlsala para
  cambiarlo) y «—» si su Android no lo tiene: el modo oscuro necesita Android 10 y el filtro, Android 9.
  Lo que dejes en «No tocar» no se cambia. El fondo de pantalla y los temas del fabricante no se pueden
  poner desde el PC.
- **Instalar APK**: instala un APK suelto en los móviles que elijas, sin añadirlo a las apps comunes.

## Ficheros

Todo lo tuyo está en la carpeta `datos/`, que git no ve: en una copia nueva del proyecto (la de un amigo, por ejemplo)
el panel arranca vacío y la va llenando. Para llevarte tu configuración a otro PC, copia `datos/` entera, con el panel
cerrado. Las versiones anteriores guardaban estos ficheros junto al proyecto; el panel los mueve a `datos/` al arrancar.

| Fichero en `datos/` | Para qué |
|---|---|
| `apps.json` | Las apps comunes y de dónde se instalan. Lo escribe el panel. |
| `apks/` | Los APK propios y la caché de descargas de F-Droid. |
| `settings.json` | El perfil de ajustes comunes. Lo escribe el panel. |
| `musica/` | Las canciones para la pestaña Música. |
| `music.json` | Los móviles que hacen de altavoz (si suenan y su retraso), si las canciones van en aleatorio y el brillo que tenía cada móvil antes de bajárselo. Lo escribe el panel: no lo borres con los móviles en reposo, o se quedarán con el brillo al mínimo. |
| `keep.txt` | Lo regenera el panel desde `apps.json` para que `droids.sh prune` sepa qué conservar. La primera vez se guarda tu versión en `keep.txt.bak`. |
| `devices.txt` | IPs a las que reconectar por wifi (puerto 5555). |
| `names.txt` | Nombre de cada móvil, por su número de serie. Lo escribe el panel. |
| `debloat/<fabricante>.txt` | Apps del sistema que se quitan en bloque (p. ej. `debloat/xiaomi.txt`). |

## Seguridad

El panel solo escucha en este PC. Si lo arrancas con `HOST=0.0.0.0` para usarlo desde otro aparato de casa,
cualquiera en tu wifi podría gestionar los móviles: todavía no tiene contraseña.

Los altavoces llegan al PC por la propia conexión de adb (`adb reverse`), al puerto 8767, que tampoco escucha en la wifi.
Los de Android 7 no pueden: para ellos el puerto 8767 escucha también en la IP del PC en la wifi, y solo atiende a las IP
de esos móviles. Por ahí solo se puede poner, pausar o pasar canciones, descargarlas y subir o bajar el volumen de los
altavoces; cualquier app de esos móviles podría hacerlo.
