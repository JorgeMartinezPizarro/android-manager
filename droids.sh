#!/usr/bin/env bash
# droids.sh — gestión de apps en varios Android a la vez vía ADB (cable o wifi)
#
#   ./droids.sh wifi              # con los móviles por cable: activa ADB por wifi y muestra sus IPs
#   ./droids.sh connect           # conecta por wifi a las IPs de devices.txt
#   ./droids.sh list              # dispositivos y apps de terceros instaladas en cada uno
#   ./droids.sh install app.apk   # instala/actualiza un APK en todos (en paralelo)
#   ./droids.sh uninstall paquete # desinstala un paquete en todos
#   ./droids.sh prune [--yes]     # quita las apps de terceros que no estén en keep.txt (sin --yes solo muestra)
#   ./droids.sh debloat [--yes]   # quita apps del sistema listadas en debloat/<fabricante>.txt (sin --yes solo muestra)
#
# Ficheros en datos/, los mismos que usa el panel:
#   devices.txt         una IP por línea (192.168.1.50); líneas con # se ignoran
#   keep.txt            paquetes de terceros que se conservan (uno por línea)
#   debloat/huawei.txt  paquetes del sistema a quitar en Huawei (idem oppo.txt, motorola.txt...)

set -uo pipefail
cd "$(dirname "$0")"

DATA=datos
DEVICES_FILE=$DATA/devices.txt
KEEP_FILE=$DATA/keep.txt
PORT=5555

clean() { grep -v '^\s*#' "$1" 2>/dev/null | sed 's/\s*#.*//; s/\s*$//' | grep -v '^$'; }
prop()  { adb -s "$1" shell getprop "$2" | tr -d '\r'; }

# Dispositivos listos, sin duplicados (un móvil conectado por cable y wifi a la vez cuenta una vez)
devices() {
  declare -A seen
  for t in $(adb devices | awk 'NR>1 && $2=="device"{print $1}'); do
    sn=$(prop "$t" ro.serialno)
    [ -n "${seen[$sn]:-}" ] && continue
    seen[$sn]=1
    echo "$t"
  done
}

label() { echo "$1 ($(prop "$1" ro.product.manufacturer) $(prop "$1" ro.product.model), Android $(prop "$1" ro.build.version.release))"; }

cmd_wifi() {
  for s in $(adb devices | awk 'NR>1 && $2=="device" && $1 !~ /:/ {print $1}'); do
    ip=$(adb -s "$s" shell ip -f inet addr show wlan0 | awk '/inet /{sub(/\/.*/,"",$2); print $2}' | tr -d '\r')
    adb -s "$s" tcpip "$PORT" >/dev/null
    echo "$(label "$s") -> $ip"
  done
  echo "Añade esas IPs a $DEVICES_FILE, desconecta los cables y ejecuta: $0 connect"
}

cmd_connect() {
  clean "$DEVICES_FILE" | while read -r ip; do
    adb connect "$ip:$PORT"
  done
  adb devices -l
}

cmd_list() {
  for s in $(devices); do
    echo "== $(label "$s")"
    adb -s "$s" shell pm list packages -3 | tr -d '\r' | sed 's/^package:/   /' | sort
  done
}

cmd_install() {
  local apk=${1:?Uso: $0 install fichero.apk}
  [ -f "$apk" ] || { echo "No existe $apk"; exit 1; }
  for s in $(devices); do
    (
      out=$(adb -s "$s" install -r "$apk" 2>&1 | tail -n1)
      if [[ $out == *Success* ]]; then echo "OK   $s"; else echo "FAIL $s: $out"; fi
    ) &
  done
  wait
}

cmd_uninstall() {
  local pkg=${1:?Uso: $0 uninstall nombre.del.paquete}
  for s in $(devices); do
    echo "$s: $(adb -s "$s" uninstall "$pkg" 2>&1 | tail -n1)"
  done
}

cmd_prune() {
  local apply=${1:-}
  # Sin la lista se quitaría todo: mejor no hacer nada
  [ -s "$KEEP_FILE" ] || { echo "Falta $KEEP_FILE con las apps que se conservan (si acabas de actualizar, arranca el panel una vez)"; exit 1; }
  for s in $(devices); do
    echo "== $(label "$s")"
    adb -s "$s" shell pm list packages -3 | tr -d '\r' | sed 's/^package://' | sort | while read -r pkg; do
      clean "$KEEP_FILE" | grep -qxF "$pkg" && continue
      if [ "$apply" = "--yes" ]; then
        echo "   quitando $pkg: $(adb -s "$s" uninstall "$pkg" 2>&1 | tail -n1)"
      else
        echo "   sobra $pkg"
      fi
    done
  done
  [ "$apply" = "--yes" ] || echo "(simulación; repite con --yes para aplicar)"
}

cmd_debloat() {
  local apply=${1:-}
  for s in $(devices); do
    vendor=$(prop "$s" ro.product.manufacturer | tr '[:upper:]' '[:lower:]')
    list="$DATA/debloat/$vendor.txt"
    echo "== $(label "$s") -> $list"
    [ -f "$list" ] || { echo "   (no hay lista para $vendor)"; continue; }
    installed=$(adb -s "$s" shell pm list packages | tr -d '\r' | sed 's/^package://')
    clean "$list" | while read -r pkg; do
      grep -qxF "$pkg" <<<"$installed" || continue
      if [ "$apply" = "--yes" ]; then
        # --user 0: se quita para el usuario, reversible con: adb shell pm install-existing <paquete>
        echo "   quitando $pkg: $(adb -s "$s" shell pm uninstall --user 0 "$pkg" 2>&1 | tr -d '\r' | tail -n1)"
      else
        echo "   se quitaría $pkg"
      fi
    done
  done
  [ "$apply" = "--yes" ] || echo "(simulación; repite con --yes para aplicar)"
}

case "${1:-}" in
  wifi|connect|list|install|uninstall|prune|debloat) c=$1; shift; "cmd_$c" "$@" ;;
  *) sed -n '2,15p' "$0"; exit 1 ;;
esac
