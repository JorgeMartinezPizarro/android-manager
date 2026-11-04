# Mis Android

Panel web para ver y gestionar las apps de los móviles Android de casa desde el PC. Habla con ellos
por adb, igual que `droids.sh`, y usa los mismos ficheros, así que puedes usar uno u otro.

## Instalar en Windows

`MisAndroid-Setup.exe` lo instala todo de una vez. Lleva dentro sus propias copias de Node.js, adb y scrcpy, así que no
depende de lo que tenga el PC (ni de nvm) ni hay que instalar nada antes. Se instala para tu usuario, sin permisos de
administrador, en `%LOCALAPPDATA%\Programs\Mis Android`. Crea «Mis Android» en el menú Inicio y, si quieres, en el
escritorio, y puede arrancar el panel solo al entrar en Windows (en una ventana minimizada, sin abrir el navegador).

- Como no está firmado, Windows avisa con «Windows protegió tu PC»: «Más información» → «Ejecutar de todas formas».
- Para actualizar, instala la versión nueva encima: para el panel si está en marcha y conserva tus datos.
- Se quita desde Configuración → Aplicaciones → Mis Android. Para el panel y pregunta si borra también tus datos.
- Si en ese PC hay otro adb de otra versión en marcha (el de Android Studio, por ejemplo), cada uno reinicia el del
  otro y se caen las conexiones por wifi: usa uno solo.

**Hacer el instalador** (desde el código): `npm run instalador`. Necesita [Inno Setup](https://jrsoftware.org/isinfo.php)
(`winget install JRSoftware.InnoSetup`). La primera vez descarga Node.js y scrcpy, que trae adb, de sus páginas oficiales.
Las versiones son fijas, están en `instalador/construir.js` y se comprueban con su SHA-256. Deja
`instalador/salida/MisAndroid-Setup.exe` (unos 33 MB): pásalo por USB o por la nube, o súbelo a las Releases de GitHub.

## Arrancar desde el código

1. Instala adb (una vez), desde una terminal:

   ```bash
   winget install Google.PlatformTools
   ```

   También vale descargar las [SDK Platform-Tools](https://developer.android.com/tools/releases/platform-tools)
   y descomprimirlas aquí, de forma que quede `platform-tools\adb.exe`.

2. Con [Node.js](https://nodejs.org) 22 o más nuevo, doble clic en `panel.cmd` (o `npm start`). Se abre
   http://localhost:8765 en el navegador. Cierra la ventana negra para pararlo. Si ya estaba en marcha, `panel.cmd` solo
   lo abre en el navegador.

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

- **Dispositivos**: los móviles conectados con batería, conexión, espacio libre en la memoria interna (en rojo si
  queda menos de 1 GB o del 10 %; al pasar el ratón, el total y lo ocupado) y un nombre que tú eliges.
  **Ver pantalla** abre la pantalla del móvil en una ventana del PC (por wifi tarda unos segundos) y lo manejas
  con el ratón y el teclado. La ventana sigue abierta aunque cierres el panel.
  Usa [scrcpy](https://github.com/Genymobile/scrcpy): el instalador lo lleva dentro; desde el código, se instala una
  vez con `winget install Genymobile.scrcpy`. scrcpy necesita Android 5: en uno más viejo la pantalla se ve dentro del
  panel a base de capturas (una cada segundo o dos), y un clic es un toque y arrastrar, deslizar el dedo.
- **Ficha de cada móvil** («Controlar»):
  - **Acciones rápidas**: encender, desbloquear y apagar la pantalla, captura, girarla (horizontal, vertical o
    sola), abrir el calendario, volumen de la música, canción anterior / play / siguiente, abrir un enlace en el
    móvil y mandarle un aviso (Android 10 o superior).
  - **Cerrar**, junto al enlace, cierra del todo la app con la que se abrió (YouTube, el navegador…). Si el móvil
    preguntaría con qué app abrir el enlace, el panel elige la app antes que el navegador: un vídeo, en YouTube.
  - **Calendario** abre el que tenga cada móvil en la última vista que se usó: para verlo en modo mes, elige
    «Mes» una vez a mano en cada uno. Las apps que solo funcionan en vertical no giran aunque pidas horizontal.
  - **Hacer sonar**, para encontrarlo: pone un temporizador en el reloj si el móvil lo deja o, si no,
    reproduce la alarma en su reproductor de música con la música al máximo. Si no tiene ninguna de las dos
    cosas, lo dice.
  - **Desbloquear** solo quita el bloqueo de deslizar. Con PIN o patrón, adb no puede saltárselo: escríbelo
    tú desde «Ver pantalla».
  - **Sus apps** (las tuyas y, si quieres, las del sistema) para abrirlas, desactivarlas, desinstalarlas o
    restaurar las del sistema que hayas quitado.
- **Apps**, en dos pestañas: **Favoritas**, las apps que quieres, y **Limpiar**, todo lo demás.
  Las favoritas salen con su estado en cada móvil (✓ instalada, ↑ hay versión nueva, + falta, – ese móvil no la necesita,
  ! falló). Pulsa una celda para elegir: instalarla o ponerla al día en ese móvil, marcar que no la necesita (ahí ni se
  instala ni se actualiza), quitarla de ese móvil (la desinstala y la marca) o volver a ponerla. Los móviles que lleguen
  nuevos la llevan. «Poner (n)», en la cabecera de un móvil, le instala las que le faltan; «Instalar lo pendiente», todo
  lo que falta en todos. En cada fila, cuando le falta a algún móvil, sale un botón para ponerla donde falte (la flecha
  de descarga, o ▶ si es de Google Play, que se abre en esos móviles); el lápiz le cambia el nombre y la papelera la deja
  de tener como favorita y, si quieres, la desinstala de todos. Cada favorita
  viene de uno de estos sitios:
  - **APK propio**: lo subes tú, o lo copias de un móvil donde ya esté (solo apps de una pieza, como tus
    apps privadas). Se instala tal cual; si subes una versión nueva, se actualiza en todos.
  - **Enlace**: pegas el enlace a un .apk (una release de GitHub, la web de la app…) y el PC lo descarga, comprueba que
    es una app y lo guarda como un APK propio. Para tener una versión nueva, añade otra vez el enlace.
  - **F-Droid**: el panel descarga la última versión, comprueba que es la app correcta, la instala y la
    actualiza cuando sale otra.
  - **Google Play**: Play no deja instalar desde fuera. El panel abre la ficha de la app en cada móvil
    donde falte, y su pantalla en el PC (con scrcpy, como «Ver pantalla»), para que pulses «Instalar» desde aquí. Luego
    Play la mantiene al día.

  Con **«Instalar y actualizar solas»** activado, cada 5 minutos se ponen al día las de APK propio y
  F-Droid en los móviles conectados. Google Play nunca se abre solo.

  En **Limpiar** está lo que sobra, para dejar los móviles lo más limpios posible:
  - **Instaladas por ti** que no son favoritas (★ la hace favorita).
  - **Del sistema**: las que el panel sugiere quitar porque no hacen falta (Facebook, Netflix, Office, las apps del
    fabricante, las de Google que no usas…; cada una dice qué es) y las que marques tú con el buscador, «Sobra». Se
    quitan solo para el usuario del móvil: no se borran y se recuperan cuando quieras.
  - Cada celda dice cómo está en ese móvil: ● la tiene (púlsala para quitarla), ○ quitada (púlsala para recuperarla).
    Por app, «Quitar de todos» y «Recuperar»; por móvil, «Limpiar (n)»; y «Limpiar todos», de una vez. Siempre enseña
    antes la lista de lo que va a quitar.
  - «No tocar» la saca de las sugerencias y de lo que se quita en bloque; se deshace en «No se tocan».
  - Nunca se ofrecen las imprescindibles: Chrome y su WebView (en ellos funciona el altavoz), Google Play y sus
    servicios, el escritorio, el teclado y el propio sistema.
  - Los nombres e iconos vienen de Google Play y se guardan en `datos/nombres-apps.json`.
- **Música**: tus canciones sonando a la vez en los móviles que marques. Cada móvil hace de altavoz con una página
  que el panel le abre en Chrome («Abrir» en su fila o «Abrir en todos»; «Mostrar todos» abre en el PC la pantalla de cada uno). No se manda «play» a cada uno, porque cada móvil
  tarda distinto en obedecer (de 0,2 a 3 s): todos ajustan su reloj con el del PC y el PC les dice a qué hora exacta
  empieza la canción. Mientras suena, cada uno mide cada pocos segundos cuánto se ha ido de donde debería estar y lo corrige
  solo, acelerando o frenando un poco (como mucho un 0,5 %, que no se nota en el tono); solo si se va más de 30 ms se recoloca
  de golpe. En el panel, junto a «Sonando», sale su desfase en ese momento (**+n ms** si va adelantado, **−n ms** si va retrasado).
  - Las canciones son las de la carpeta `datos/musica/` (y sus subcarpetas): súbelas desde el panel o cópialas ahí.
    Valen mp3, m4a, aac, ogg, opus, wav y flac. Al acabar una suena la siguiente, y tras la última, otra vez la primera.
    Se eligen con **Canciones**, que las muestra a pantalla completa con un buscador (sin tildes ni mayúsculas; Enter
    pone la primera que quede). Al elegir una se cierra sola. De los nombres se quita lo que añade la descarga de
    YouTube: el código del vídeo («[p4QqMKe3rwY]») y coletillas como «(Official Music Video)» o «[4K]».
  - Cada altavoz tiene su **volumen** (el de la música del propio móvil, el mismo que cambian sus botones; el panel lo
    lee cada pocos segundos y lo muestra de 0 a 100 % en todos, aunque cada móvil tenga sus pasos). El altavoz a su
    izquierda lo **silencia** o le devuelve la voz de un clic, y **Solo** hace que suene únicamente ese. «Silenciar
    todos» los calla a la vez; cuando ya no suena ninguno, el mismo botón pasa a «Que suenen todos». La lupa es «Ver pantalla», y la flecha circular, «Reabrir».
  - **Sin pantalla**: el botón del móvil, en la fila de cada altavoz, lo deja solo para sonar, con la pantalla apagada:
    gasta mucho menos (para un móvil que no hace de mando, o que carga despacio). Su página deja de pedir la pantalla
    encendida y descansa a los 15 s, y entonces el panel se la apaga; si se enciende con la página detrás (la pantalla de
    bloqueo, al tocarlo o al empezar a cargar), la apaga a los 30 s. Si Android duerme Chrome y ese móvil deja de dar
    señales mientras suena la música, el panel le enciende la pantalla un momento para despertarlo. Otro toque al botón
    le devuelve la pantalla.
  - Pulsando en la barra de la canción se salta a ese punto. **Aleatorio** sigue con una canción cualquiera en vez de
    con la siguiente, y el **temporizador** pausa la música al cabo de 15 minutos a 2 horas.
  - La que va a sonar después sale debajo del título («Después: …») y los móviles la van preparando mientras suena la
    actual: la descargan enseguida y la descomprimen en sus últimos 45 s (descomprimida ocupa mucho, y los móviles viejos
    tienen poca memoria). Así pasan de una canción a otra sin esperar a que cargue. En aleatorio se elige de antemano.
  - **Modo ligero** (Android 4 o anterior, móviles y tablets viejos con poca memoria): allí descomprimir la canción entera (unos 80 MB, y otro
    tanto mientras se convierte) dejaba a Chrome sin memoria. La página se da cuenta sola y la escucha con un `<audio>`,
    que la va leyendo a trozos; se mantiene a la par mirando por dónde va, acelerando o frenando como mucho un 1 % (sin
    cambiar el tono) o, si se ha ido más de un cuarto de segundo, volviendo a arrancar donde toca. `?ligero` en la
    dirección de la página lo fuerza en cualquier móvil y `?ligero=0` lo quita.
  - **Prueba de sincronía**: un pitido por segundo. Si un móvil se oye antes que los demás, súbele el **retraso**;
    si se oye después, bájalo. Va de milisegundo en milisegundo con − y +, o escribe el número. Un altavoz Bluetooth suele
    ir un poco por detrás: ese móvil, con retraso negativo.
  - **Calibrar** lo hace con un micrófono en vez de a oído: el del PC o, abriendo el panel en el móvil, el del móvil.
    Hace sonar cada altavoz encendido por su cuenta (los silenciados no se tocan) con un barrido corto cada segundo, lo
    graba y busca cuándo llega cada barrido, con menos de 1 ms de error aunque haya eco. Lo que tarda el micrófono es
    igual para todos y se anula, así que queda cuánto antes o después se oye cada uno. **Medir todos** los mide seguidos
    desde donde está el micrófono: ponlo donde escuchas. Con el móvil se puede ir **habitación por habitación**: junto a
    cada altavoz (a un par de pasos, siempre a la misma distancia), su **Medir**; entre uno y otro la calibración calla y el
    micrófono sigue abierto, así que lo medido se puede comparar aunque estén lejos. El móvil pone su reloj en hora con el
    del PC antes de cada medida y no se apaga mientras el diálogo está abierto. Con dos o más medidos enseña cuánto se oye
    cada uno respecto al resto y los retrasos que los cuadran («Aplicar» los pone); al cerrar, la música vuelve por donde
    iba. Unos 10 s por altavoz; el que va en modo ligero, hasta 45 s, porque tarda más en cuadrarse al arrancar. El
    navegador pide permiso para el micrófono, y solo lo da en páginas seguras: en el PC (localhost) o por https, que es
    como se abre el panel desde otro aparato.
  - La página del altavoz ocupa toda la pantalla de cada móvil y hace de mando: arriba la canción (en una línea: si no
    cabe, se desliza despacio para enseñarla entera; con el artista debajo y por dónde va) y los botones de anterior, pausa y siguiente, que valen para todos los altavoces; abajo,
    **Elegir canción** y el volumen de ese móvil: **Bajar**, **Silenciar** (en ámbar mientras está silenciado; con otro
    toque vuelve a sonar) y **Subir**. El volumen lo cambia el PC por adb, porque una página no puede: es el mismo que
    el de los botones del móvil y el de la barra del panel. Elegir canción abre la lista a pantalla completa, con letra
    grande y buscador; se cierra al elegir una, con la X o con el botón de volver del móvil. La pantalla se queda encendida mientras la página está delante
    (si se apaga, Android puede dormir Chrome). Déjalos enchufados. Si nadie la toca en 3 minutos descansa: la página se queda
    en negro y el panel baja el brillo del móvil al mínimo. En las pantallas OLED el negro apaga los
    píxeles, así que no se ve nada ni se queda grabada la imagen. Los móviles que en manual no bajan del todo (alguno se
    queda en 17 de 255) se dejan en automático con el ajuste al mínimo, que a oscuras sí llega a 1. Vuelve al tocar la
    pantalla o arrastrar el dedo por ella, con el brillo que tenía (también el automático). El toque que la despierta no pulsa
    nada: el botón que hubiera debajo se pulsa con el siguiente.
  - Chrome no deja sonar una página hasta que alguien la toca: el panel la toca solo. Si el móvil tiene PIN o patrón,
    desbloquéalo cuando lo abras y el panel la tocará en cuanto pueda. La lupa («Ver pantalla»), en la fila de cada
    altavoz, abre su pantalla en el PC para desbloquearlo o tocarla desde aquí.
  - Cuando el panel trae una versión nueva de la página, las que están abiertas se recargan solas. «Reabrir» la vuelve a
    cargar en ese móvil, por si algo va raro. Si en un móvil hay varias pestañas de altavoz (Chrome a veces abre otra),
    solo cuenta la más nueva: las demás se callan y dicen que hay otra; al volver a una de ellas, se recarga y pasa a ser
    ella el altavoz.
  - El PC tiene que estar encendido con el panel en marcha: la música sale de él.
  - Los móviles con Android 7 no dejan que adb les abra la conexión con el PC: su página llega al PC
    por la wifi de casa, a la IP del PC. Ahí Chrome no deja mantener la pantalla encendida, así que déjalos enchufados
    con «Pantalla encendida mientras carga» (en Ajustes).
- **Ajustes**: un perfil común para todos los móviles: modo oscuro, brillo automático, cuándo se apaga la
  pantalla, tamaño de letra, giro automático, pantalla encendida mientras carga y animaciones.
  Cada casilla muestra lo que tiene cada móvil: verde si ya está como debe, naranja si falta cambiarlo y «—» si su
  Android no lo tiene (el modo oscuro necesita Android 10). Lo que dejes en «No tocar» no se cambia.
  Si algún móvil lo necesita distinto (uno que solo es altavoz, otro que solo hace de mando), pulsa su casilla: le
  pones su propio valor, «No tocar aquí» o «Como el perfil», y se cambia al momento. Las casillas con borde de puntos
  son las que ese móvil tiene distintas; se guardan por su número de serie. El fondo de pantalla y los temas del
  fabricante no se pueden poner desde el PC.
- **Tema del panel**: el botón de la paleta, arriba a la derecha, abre la lista de temas con una muestra de sus
  colores: **Clásico** (el verde de siempre, en claro u oscuro según el sistema; el que sale si no eliges otro), **Neón** (noche de los 80, con rejilla y letras que
  brillan), **Tocadiscos** (amplificador de madera con tornillos, pilotos ámbar y la barra como un vúmetro), **Aurora**
  (cristal esmerilado sobre luces de colores), **Casete** (etiqueta de cinta en papel crema, el único claro) y **Fósforo**
  (monitor verde de los de antes, con líneas de barrido). Cada navegador recuerda el suyo; con ?tema=neon en la
  dirección se abre con ese.
- **En el móvil** (pantallas de hasta 640 px): las pestañas van abajo, como en una app, y las tablas (altavoces,
  favoritas, limpiar, ajustes) pasan a tarjetas, con cada móvil como una etiqueta con su nombre, para que no se corte
  nada. En el ordenador se ve igual que siempre.

## Ficheros

Todo lo tuyo está en la carpeta `datos/`, que git no ve: en una copia nueva del proyecto (la de un amigo, por ejemplo)
el panel arranca vacío y la va llenando. Con el instalador, `datos\` está en la carpeta donde se instaló
(`%LOCALAPPDATA%\Programs\Mis Android\datos`). Para llevarte tu configuración a otro PC, copia `datos/` entera, con el panel
cerrado. Las versiones anteriores guardaban estos ficheros junto al proyecto; el panel los mueve a `datos/` al arrancar.

| Fichero en `datos/` | Para qué |
|---|---|
| `apps.json` | Las favoritas y de dónde se instalan. Lo escribe el panel. |
| `limpieza.json` | Las apps del sistema que marcaste con «Sobra» y las de «No tocar». Lo escribe el panel. |
| `nombres-apps.json` | Nombres e iconos de Google Play de las apps de Limpiar, para no volver a preguntar. |
| `apks/` | Los APK propios y la caché de descargas de F-Droid. |
| `settings.json` | El perfil de ajustes comunes y, en `moviles`, lo que algún móvil tiene distinto. Lo escribe el panel. |
| `panel.json` | Si se puede abrir el panel desde otros dispositivos de casa. Lo escribe el panel. |
| `panel-https.json` | El certificado (y su clave) con el que el panel se abre por https desde otros dispositivos. Si lo borras, hace otro y cada navegador vuelve a avisar una vez. |
| `musica/` | Las canciones para la pestaña Música. |
| `music.json` | Los móviles que hacen de altavoz (si suenan y su retraso), si las canciones van en aleatorio y el brillo que tenía cada móvil antes de bajárselo. Lo escribe el panel: no lo borres con los móviles en reposo, o se quedarán con el brillo al mínimo. |
| `keep.txt` | Lo regenera el panel desde `apps.json` para que `droids.sh prune` sepa qué conservar. La primera vez se guarda tu versión en `keep.txt.bak`. |
| `devices.txt` | IPs a las que reconectar por wifi (puerto 5555). |
| `names.txt` | Nombre de cada móvil, por su número de serie. Lo escribe el panel. |
| `debloat/<fabricante>.txt` | De versiones anteriores: la primera vez, sus apps pasan a «Marcada por ti» en Limpiar. `droids.sh debloat` las sigue usando. |

## Seguridad

El panel escucha en este PC. Con «Abrir el panel desde otros dispositivos de casa» (al final de Dispositivos) escucha
también en las IP privadas del PC y se abre desde el móvil, la tablet u otro ordenador de la misma red, en la dirección
que enseña (por ejemplo https://192.168.1.12:8765), o apuntando con la cámara del móvil al código QR que sale debajo, que
abre directamente la música. Por la red va por https, para que el navegador deje usar el micrófono al calibrar: en el
mismo puerto, quien llega por http se pasa a https. El certificado lo hace el propio panel la primera vez (se guarda en
`datos/panel-https.json` y vale un año; se rehace solo antes de caducar o si el PC estrena IP), así que cada navegador
avisa una vez de que no es de confianza: en Chrome, «Configuración avanzada» y «Acceder a…»; en Firefox, «Avanzado…» y
«Aceptar el riesgo y continuar». Si en el móvil Chrome no carga nada, prueba con Firefox. En este PC sigue siendo
http://localhost:8765, que ya cuenta como seguro.
Solo contesta a direcciones de casa (192.168.x.x, 10.x.x.x…), así
que aunque alguien abriera el puerto en el router, a internet no le contesta; y por la red solo se entra con la IP o el
nombre del PC, para que una web de fuera no pueda hacerse pasar por el panel. No pide contraseña: cualquiera conectado
a tu red podría usarlo. «Ver pantalla» y «Mostrar todos» abren la pantalla de los móviles en este PC.

Los altavoces llegan al PC por la propia conexión de adb (`adb reverse`), al puerto 8767, que tampoco escucha en la wifi.
Los de Android 7 no pueden: para ellos el puerto 8767 escucha también en la IP del PC en la wifi, y solo atiende a las IP
de esos móviles. Por ahí solo se puede poner, pausar o pasar canciones, descargarlas y subir o bajar el volumen de los
altavoces; cualquier app de esos móviles podría hacerlo.
