#!/usr/bin/env bash
# Urutau — instalador para Linux e Raspberry Pi OS
# Autor: Matheus C. Pestana — MACAPE Pesquisas e Consultoria em Tecnologia Ltda
#
# Uso:  ./install.sh            (pergunta o que precisa)
#       URUTAU_LAT=-15.799 URUTAU_LON=-47.864 ./install.sh -y   (sem perguntas; rede local fica fechada)
#       URUTAU_LANG=en ./install.sh                            (idioma: pt, en, es, fr, ru)
#       URUTAU_BIND=0.0.0.0 ./install.sh                       (rede local e Tailscale; ou o IP 100.x do Tailscale)
#
# O que ele faz, nesta ordem, e só com confirmação quando mexe fora desta pasta:
#   1. confere Docker e Docker Compose;
#   2. procura o dongle RTL-SDR e o driver de TV do kernel que o disputa (oferece bloquear, com sudo);
#   3. pergunta a localização da antena e quem pode abrir o painel (esta máquina, rede local/Tailscale);
#   4. escreve o .env (só nesta pasta) e sobe os containers.
set -euo pipefail

cd "$(dirname "$0")"

YES=0
[[ "${1:-}" == "-y" || "${1:-}" == "--yes" ]] && YES=1

# ---------- idioma ----------
pick_lang() {
  local v="${URUTAU_LANG:-${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}}"
  v="${v%%[_.@-]*}"
  case "$v" in
    pt | en | es | fr | ru) echo "$v" ;;
    "" | C | POSIX) echo pt ;;
    *) echo en ;;
  esac
}
L="$(pick_lang)"

declare -A M
# chave → texto em cada idioma (printf: %s recebe valores)
msg() { M["pt.$1"]="$2"; M["en.$1"]="$3"; M["es.$1"]="$4"; M["fr.$1"]="$5"; M["ru.$1"]="$6"; }
m() { local k="$1"; shift; local f="${M[$L.$k]:-${M[pt.$k]}}"; printf -- "$f" "$@"; }

msg title "estação RTL-SDR caseira" "home RTL-SDR station" "estación RTL-SDR casera" "station RTL-SDR domestique" "домашняя станция RTL-SDR"
msg s1 "1. Docker" "1. Docker" "1. Docker" "1. Docker" "1. Docker"
msg no_docker "Docker não encontrado. Instale com: curl -fsSL https://get.docker.com | sh" "Docker not found. Install it with: curl -fsSL https://get.docker.com | sh" "Docker no encontrado. Instálalo con: curl -fsSL https://get.docker.com | sh" "Docker introuvable. Installez-le avec : curl -fsSL https://get.docker.com | sh" "Docker не найден. Установите: curl -fsSL https://get.docker.com | sh"
msg no_compose "Falta o plugin Docker Compose (pacote docker-compose-plugin)." "The Docker Compose plugin is missing (package docker-compose-plugin)." "Falta el plugin Docker Compose (paquete docker-compose-plugin)." "Le plugin Docker Compose est absent (paquet docker-compose-plugin)." "Нет плагина Docker Compose (пакет docker-compose-plugin)."
msg no_perm "Seu usuário não tem acesso ao Docker. Rode: sudo usermod -aG docker \$USER e entre de novo na sessão." "Your user cannot access Docker. Run: sudo usermod -aG docker \$USER and log in again." "Tu usuario no tiene acceso a Docker. Ejecuta: sudo usermod -aG docker \$USER y vuelve a iniciar sesión." "Votre utilisateur n’a pas accès à Docker. Lancez : sudo usermod -aG docker \$USER puis reconnectez-vous." "У пользователя нет доступа к Docker. Выполните: sudo usermod -aG docker \$USER и войдите в систему заново."
msg docker_ok "Docker %s e Compose %s" "Docker %s and Compose %s" "Docker %s y Compose %s" "Docker %s et Compose %s" "Docker %s и Compose %s"
msg gid "grupo docker: GID %s" "docker group: GID %s" "grupo docker: GID %s" "groupe docker : GID %s" "группа docker: GID %s"
msg s2 "2. Dongle RTL-SDR" "2. RTL-SDR dongle" "2. Dongle RTL-SDR" "2. Dongle RTL-SDR" "2. Донгл RTL-SDR"
msg found "encontrado: %s" "found: %s" "encontrado: %s" "trouvé : %s" "найден: %s"
msg found_serial "encontrado: %s (serial %s)" "found: %s (serial %s)" "encontrado: %s (serial %s)" "trouvé : %s (serial %s)" "найден: %s (serial %s)"
msg dual_ask "Dois dongles. Qual serial fica no ADS-B? (o outro vai para FM/decodificadores)" "Two dongles. Which serial stays on ADS-B? (the other runs FM/decoders)" "Dos dongles. ¿Qué serial queda en ADS-B? (el otro va a FM/decodificadores)" "Deux dongles. Quel serial reste sur l’ADS-B ? (l’autre fait FM/décodeurs)" "Два донгла. Какой serial для ADS-B? (второй — FM/декодеры)"
msg dual_ok "ADS-B no serial %s · decodificadores no %s" "ADS-B on serial %s · decoders on %s" "ADS-B en serial %s · decodificadores en %s" "ADS-B sur serial %s · décodeurs sur %s" "ADS-B на serial %s · декодеры на %s"
msg dual_same "dois V4 com o mesmo serial de fábrica: use rtl_eeprom -d 0 -s 00000002 com um plugado por vez" "two V4s with the same factory serial: use rtl_eeprom -d 0 -s 00000002 with one plugged in at a time" "dos V4 con el mismo serial de fábrica: usa rtl_eeprom -d 0 -s 00000002 con uno enchufado cada vez" "deux V4 avec le même serial d’usine : rtl_eeprom -d 0 -s 00000002 avec un seul branché à la fois" "два V4 с одним заводским serial: rtl_eeprom -d 0 -s 00000002 с одним подключённым"
msg not_found "nenhum dongle RTL-SDR conectado agora. Dá para instalar e conectar depois." "no RTL-SDR dongle plugged in right now. You can install now and plug it in later." "ningún dongle RTL-SDR conectado ahora. Puedes instalar y conectarlo después." "aucun dongle RTL-SDR branché pour l’instant. Vous pouvez installer maintenant et le brancher ensuite." "донгл RTL-SDR сейчас не подключён. Можно установить сейчас и подключить позже."
msg dvb "o driver de TV digital do kernel (dvb_usb_rtl28xxu) está carregado e disputa o dongle." "the kernel’s digital TV driver (dvb_usb_rtl28xxu) is loaded and competes for the dongle." "el driver de TV digital del kernel (dvb_usb_rtl28xxu) está cargado y compite por el dongle." "le pilote TV numérique du noyau (dvb_usb_rtl28xxu) est chargé et accapare le dongle." "загружен драйвер цифрового ТВ ядра (dvb_usb_rtl28xxu), он перехватывает донгл."
msg dvb_fix "A correção é bloquear o módulo: cria %s e o descarrega agora. Precisa de sudo." "The fix is to blacklist the module: it creates %s and unloads it now. Requires sudo." "La solución es bloquear el módulo: crea %s y lo descarga ahora. Requiere sudo." "La solution est de bloquer le module : crée %s et le décharge maintenant. Nécessite sudo." "Решение — запретить модуль: создаётся %s, модуль выгружается сейчас. Нужен sudo."
msg dvb_ask "Bloquear o driver de TV?" "Blacklist the TV driver?" "¿Bloquear el driver de TV?" "Bloquer le pilote TV ?" "Запретить драйвер ТВ?"
msg dvb_unload "não foi possível descarregar agora; desconecte e reconecte o dongle (ou reinicie)." "could not unload it now; unplug and replug the dongle (or reboot)." "no se pudo descargar ahora; desconecta y vuelve a conectar el dongle (o reinicia)." "impossible de le décharger maintenant ; débranchez et rebranchez le dongle (ou redémarrez)." "не удалось выгрузить сейчас; переподключите донгл (или перезагрузитесь)."
msg dvb_done "driver de TV bloqueado" "TV driver blacklisted" "driver de TV bloqueado" "pilote TV bloqué" "драйвер ТВ запрещён"
msg dvb_skip "sem bloquear, o ADS-B e os outros modos podem falhar com 'usb_claim_interface error -6'." "without blacklisting, ADS-B and the other modes may fail with 'usb_claim_interface error -6'." "sin bloquearlo, ADS-B y los demás modos pueden fallar con 'usb_claim_interface error -6'." "sans blocage, l’ADS-B et les autres modes peuvent échouer avec 'usb_claim_interface error -6'." "без запрета ADS-B и другие режимы могут падать с ошибкой 'usb_claim_interface error -6'."
msg dvb_ok "nenhum driver do kernel disputando o dongle" "no kernel driver competing for the dongle" "ningún driver del kernel compite por el dongle" "aucun pilote du noyau n’accapare le dongle" "драйверы ядра донгл не перехватывают"
msg s3 "3. Onde está a antena" "3. Where the antenna is" "3. Dónde está la antena" "3. Où se trouve l’antenne" "3. Где стоит антенна"
msg s3_help1 "No OpenStreetMap ou no Google Maps, clique com o botão direito no local e copie as coordenadas." "In OpenStreetMap or Google Maps, right-click the spot and copy the coordinates." "En OpenStreetMap o Google Maps, haz clic derecho en el lugar y copia las coordenadas." "Dans OpenStreetMap ou Google Maps, faites un clic droit sur l’endroit et copiez les coordonnées." "В OpenStreetMap или Google Картах нажмите правой кнопкой на место и скопируйте координаты."
msg s3_help2 "Três casas decimais (~100 m) bastam. O valor fica só no .env desta pasta." "Three decimal places (~100 m) are enough. The value stays only in this folder’s .env." "Tres decimales (~100 m) bastan. El valor queda solo en el .env de esta carpeta." "Trois décimales (~100 m) suffisent. La valeur reste uniquement dans le .env de ce dossier." "Трёх знаков после запятой (~100 м) достаточно. Значение хранится только в .env этой папки."
msg lat "Latitude (ex.: -15.799)" "Latitude (e.g. -15.799)" "Latitud (p. ej. -15.799)" "Latitude (ex. : -15.799)" "Широта (напр. -15.799)"
msg lon "Longitude (ex.: -47.864)" "Longitude (e.g. -47.864)" "Longitud (p. ej. -47.864)" "Longitude (ex. : -47.864)" "Долгота (напр. -47.864)"
msg no_loc "sem localização: alcance, distâncias, satélites e sondas ficam desligados até você defini-la em Config." "no location: range, distances, satellites and radiosondes stay off until you set it in Settings." "sin ubicación: alcance, distancias, satélites y radiosondas quedan desactivados hasta que la definas en Ajustes." "sans emplacement : portée, distances, satellites et radiosondes restent désactivés jusqu’à ce que vous le définissiez dans Réglages." "без местоположения дальность, расстояния, спутники и зонды отключены, пока вы не укажете его в настройках."
msg loc_ok "antena em %s, %s" "antenna at %s, %s" "antena en %s, %s" "antenne à %s, %s" "антенна: %s, %s"
msg loc_bad_y "URUTAU_LAT/URUTAU_LON inválidos: '%s' '%s'" "invalid URUTAU_LAT/URUTAU_LON: '%s' '%s'" "URUTAU_LAT/URUTAU_LON no válidos: '%s' '%s'" "URUTAU_LAT/URUTAU_LON invalides : '%s' '%s'" "недопустимые URUTAU_LAT/URUTAU_LON: '%s' '%s'"
msg loc_bad "coordenadas inválidas; use graus decimais, com sul e oeste negativos." "invalid coordinates; use decimal degrees, with south and west negative." "coordenadas no válidas; usa grados decimales, con sur y oeste negativos." "coordonnées invalides ; utilisez des degrés décimaux, sud et ouest négatifs." "неверные координаты; используйте десятичные градусы, юг и запад со знаком минус."
msg s4 "4. Quem pode abrir o painel" "4. Who can open the panel" "4. Quién puede abrir el panel" "4. Qui peut ouvrir le panneau" "4. Кто может открыть панель"
msg s4_help1 "1) só esta máquina (mais seguro)   2) rede local e Tailscale   3) só Tailscale" "1) this machine only (safest)   2) local network and Tailscale   3) Tailscale only" "1) solo esta máquina (más seguro)   2) red local y Tailscale   3) solo Tailscale" "1) cette machine uniquement (le plus sûr)   2) réseau local et Tailscale   3) Tailscale uniquement" "1) только этот компьютер (безопаснее)   2) локальная сеть и Tailscale   3) только Tailscale"
msg s4_help2 "Nas opções 2 e 3 o painel pede senha; quem entra como admin troca o modo do dongle (a API controla o Docker). Visitante só lê." "With options 2 and 3 the panel asks for a password; admin can change the dongle mode (the API controls Docker). Viewer is read-only." "En las opciones 2 y 3 el panel pide contraseña; el admin puede cambiar el modo del dongle (la API controla Docker). El visitante solo lee." "Avec les options 2 et 3 le panneau demande un mot de passe ; l’admin peut changer le mode du dongle (l’API contrôle Docker). Le visiteur est en lecture seule." "В вариантах 2 и 3 панель просит пароль; админ может менять режим донгла (API управляет Docker). Гость — только чтение."
msg s4_ask "Opção" "Option" "Opción" "Option" "Вариант"
msg pw_ask "Senha de administrador (vazia = gerar uma)" "Admin password (empty = generate one)" "Contraseña de administrador (vacía = generar una)" "Mot de passe admin (vide = en générer un)" "Пароль администратора (пусто = сгенерировать)"
msg pw_view "Senha de visitante, só leitura (opcional, Enter pula)" "Viewer password, read-only (optional, Enter to skip)" "Contraseña de visitante, solo lectura (opcional, Enter omite)" "Mot de passe visiteur, lecture seule (optionnel, Entrée pour passer)" "Пароль гостя, только чтение (необязательно, Enter — пропуск)"
msg pw_gen "senha de administrador gerada (guarde agora; não aparece de novo): %s" "generated admin password (save it now; it will not be shown again): %s" "contraseña de administrador generada (guárdala ahora; no se mostrará otra vez): %s" "mot de passe admin généré (notez-le maintenant ; il ne réapparaîtra pas) : %s" "сгенерирован пароль администратора (сохраните сейчас; больше не покажется): %s"
msg pw_ok "autenticação do painel ligada" "panel authentication enabled" "autenticación del panel activada" "authentification du panneau activée" "аутентификация панели включена"
msg pw_off "BIND local: autenticação desligada (defina URUTAU_PASSWORD no .env se quiser)" "local BIND: authentication off (set URUTAU_PASSWORD in .env if you want it)" "BIND local: autenticación desactivada (define URUTAU_PASSWORD en .env si la quieres)" "BIND local : authentification désactivée (définissez URUTAU_PASSWORD dans .env si besoin)" "локальный BIND: аутентификация выключена (задайте URUTAU_PASSWORD в .env при необходимости)"
msg ts_none "Tailscale não encontrado ou desconectado (tailscale ip -4 vazio); usando só esta máquina." "Tailscale not found or not connected (tailscale ip -4 is empty); using this machine only." "Tailscale no encontrado o desconectado (tailscale ip -4 vacío); usando solo esta máquina." "Tailscale introuvable ou déconnecté (tailscale ip -4 vide) ; accès limité à cette machine." "Tailscale не найден или не подключён (tailscale ip -4 пусто); доступ только с этого компьютера."
msg ts_note "o Tailscale precisa estar conectado antes do Docker subir, senão os containers não abrem a porta nesse IP." "Tailscale must be connected before Docker starts, otherwise the containers cannot bind to that IP." "Tailscale debe estar conectado antes de que arranque Docker; si no, los contenedores no pueden abrir el puerto en esa IP." "Tailscale doit être connecté avant le démarrage de Docker, sinon les conteneurs ne peuvent pas ouvrir le port sur cette IP." "Tailscale должен подключаться раньше запуска Docker, иначе контейнеры не смогут открыть порт на этом IP."
msg bind_ok "painel em %s" "panel on %s" "panel en %s" "panneau sur %s" "панель на %s"
msg env_bak "o .env anterior foi guardado como backup" "the previous .env was backed up" "el .env anterior se guardó como copia de seguridad" "l’ancien .env a été sauvegardé" "прежний .env сохранён как резервная копия"
msg env_ok ".env escrito (chmod 600)" ".env written (chmod 600)" ".env escrito (chmod 600)" ".env écrit (chmod 600)" ".env записан (chmod 600)"
msg s5 "5. Subindo" "5. Starting" "5. Iniciando" "5. Démarrage" "5. Запуск"
msg pulled "imagens prontas baixadas" "prebuilt images downloaded" "imágenes listas descargadas" "images prêtes téléchargées" "готовые образы загружены"
msg building "não há imagem pronta para esta máquina; compilando (no Raspberry Pi pode levar mais de uma hora)." "no prebuilt image for this machine; building (on a Raspberry Pi this may take over an hour)." "no hay imagen lista para esta máquina; compilando (en una Raspberry Pi puede tardar más de una hora)." "aucune image prête pour cette machine ; compilation (sur un Raspberry Pi, cela peut prendre plus d’une heure)." "готового образа для этой машины нет; идёт сборка (на Raspberry Pi это может занять больше часа)."
msg done "Pronto." "Done." "Listo." "Terminé." "Готово."
msg open "Abra %s" "Open %s" "Abre %s" "Ouvrez %s" "Откройте %s"
msg links "mapa tar1090: %s · docs da API: %s" "tar1090 map: %s · API docs: %s" "mapa tar1090: %s · docs de la API: %s" "carte tar1090 : %s · docs de l’API : %s" "карта tar1090: %s · документация API: %s"
msg ops "parar: docker compose stop · voltar: docker compose start · atualizar: git pull && ./install.sh" "stop: docker compose stop · resume: docker compose start · update: git pull && ./install.sh" "detener: docker compose stop · volver: docker compose start · actualizar: git pull && ./install.sh" "arrêter : docker compose stop · relancer : docker compose start · mettre à jour : git pull && ./install.sh" "остановить: docker compose stop · запустить: docker compose start · обновить: git pull && ./install.sh"
msg yn "(s/n)" "(y/n)" "(s/n)" "(o/n)" "(д/н)"

b=$'\e[1m'; d=$'\e[2m'; o=$'\e[38;5;208m'; g=$'\e[32m'; r=$'\e[31m'; n=$'\e[0m'
say() { printf '%s\n' "$*"; }
ok() { printf '  %s✓%s %s\n' "$g" "$n" "$*"; }
warn() { printf '  %s!%s %s\n' "$o" "$n" "$*"; }
die() { printf '  %s✗%s %s\n' "$r" "$n" "$*" >&2; exit 1; }
ask() { # ask "pergunta" "padrão" → resposta em $REPLY
  if [[ $YES == 1 ]]; then REPLY="$2"; return; fi
  read -r -p "  $1 ${d}[$2]${n} " REPLY || true
  REPLY="${REPLY:-$2}"
}
yesno() { # yesno "pergunta" padrão(s|n) — aceita s, y, o (oui) e д (да)
  local def="$2"
  [[ "$L" == en && "$def" == s ]] && def=y
  [[ "$L" == fr && "$def" == s ]] && def=o
  [[ "$L" == ru && "$def" == s ]] && def=д
  [[ "$L" == ru && "$def" == n ]] && def=н
  ask "$1 $(m yn)" "$def"
  # prefixo como texto, não classe [..]: sem a locale instalada, o bash compara bytes e "н" casaria com "д"
  case "$REPLY" in
    s* | S* | y* | Y* | o* | O* | д* | Д*) return 0 ;;
    *) return 1 ;;
  esac
}

say ""
say "${b}Urutau${n} ${d}· $(m title)${n}"
say ""

# ---------- 1. Docker ----------
say "${b}$(m s1)${n}"
command -v docker >/dev/null || die "$(m no_docker)"
docker compose version >/dev/null 2>&1 || die "$(m no_compose)"
docker info >/dev/null 2>&1 || die "$(m no_perm)"
ok "$(m docker_ok "$(docker version --format '{{.Server.Version}}')" "$(docker compose version --short)")"
DOCKER_GID="$(getent group docker | cut -d: -f3 || true)"
[[ -n "$DOCKER_GID" ]] || DOCKER_GID="$(stat -c %g /var/run/docker.sock)"
ok "$(m gid "$DOCKER_GID")"

# ---------- 2. Dongle e driver ----------
say ""
say "${b}$(m s2)${n}"
found=0
SERIALS=()
for dev in /sys/bus/usb/devices/*; do
  [[ -f "$dev/idVendor" ]] || continue
  if [[ "$(cat "$dev/idVendor")" == "0bda" && "$(cat "$dev/idProduct")" =~ ^(2838|2832)$ ]]; then
    found=$((found + 1))
    prod="$(cat "$dev/product" 2>/dev/null || echo 'Realtek RTL2838')"
    ser="$(cat "$dev/serial" 2>/dev/null || true)"
    if [[ -n "$ser" ]]; then
      SERIALS+=("$ser")
      ok "$(m found_serial "$prod" "$ser")"
    else
      ok "$(m found "$prod")"
    fi
  fi
done
[[ $found -ge 1 ]] || warn "$(m not_found)"

ADSB_SERIAL="${URUTAU_ADSB_SERIAL:-}"
SDR_SERIAL="${URUTAU_SDR_SERIAL:-}"
if [[ -f .env ]]; then
  ADSB_SERIAL="${ADSB_SERIAL:-$(grep -E '^URUTAU_ADSB_SERIAL=' .env 2>/dev/null | cut -d= -f2- || true)}"
  SDR_SERIAL="${SDR_SERIAL:-$(grep -E '^URUTAU_SDR_SERIAL=' .env 2>/dev/null | cut -d= -f2- || true)}"
fi
if [[ $found -ge 2 && ${#SERIALS[@]} -ge 2 ]]; then
  if [[ "${SERIALS[0]}" == "${SERIALS[1]}" ]]; then
    warn "$(m dual_same)"
  elif [[ -z "$ADSB_SERIAL$SDR_SERIAL" || "$ADSB_SERIAL" == "$SDR_SERIAL" ]]; then
    ask "$(m dual_ask) [${SERIALS[0]}/${SERIALS[1]}]" "${ADSB_SERIAL:-${SERIALS[0]}}"
    ADSB_SERIAL="$REPLY"
    if [[ "$ADSB_SERIAL" == "${SERIALS[0]}" ]]; then
      SDR_SERIAL="${SERIALS[1]}"
    else
      SDR_SERIAL="${SERIALS[0]}"
    fi
    # se a pessoa digitou um serial que não está na lista, o outro vira o restante se houver só 2
    if [[ "$ADSB_SERIAL" != "${SERIALS[0]}" && "$ADSB_SERIAL" != "${SERIALS[1]}" ]]; then
      ADSB_SERIAL="${SERIALS[0]}"
      SDR_SERIAL="${SERIALS[1]}"
    fi
    ok "$(m dual_ok "$ADSB_SERIAL" "$SDR_SERIAL")"
  else
    ok "$(m dual_ok "$ADSB_SERIAL" "$SDR_SERIAL")"
  fi
fi

if lsmod 2>/dev/null | grep -q '^dvb_usb_rtl28xxu'; then
  warn "$(m dvb)"
  say "    $(m dvb_fix "${b}/etc/modprobe.d/urutau-rtlsdr.conf${n}")"
  if yesno "$(m dvb_ask)" "s"; then
    echo "blacklist dvb_usb_rtl28xxu" | sudo tee /etc/modprobe.d/urutau-rtlsdr.conf >/dev/null
    sudo modprobe -r dvb_usb_rtl28xxu 2>/dev/null || warn "$(m dvb_unload)"
    ok "$(m dvb_done)"
  else
    warn "$(m dvb_skip)"
  fi
else
  ok "$(m dvb_ok)"
fi

# ---------- 3. Localização ----------
say ""
say "${b}$(m s3)${n}"
say "    ${d}$(m s3_help1)${n}"
say "    ${d}$(m s3_help2)${n}"

valid_coord() { [[ "$1" =~ ^-?[0-9]+([.,][0-9]+)?$ ]]; }
LAT="${URUTAU_LAT:-}"; LON="${URUTAU_LON:-}"
if [[ -f .env ]]; then
  LAT="${LAT:-$(grep -E '^READSB_LAT=' .env | cut -d= -f2- || true)}"
  LON="${LON:-$(grep -E '^READSB_LON=' .env | cut -d= -f2- || true)}"
fi
while :; do
  ask "$(m lat)" "${LAT}"; LAT="${REPLY//,/.}"
  ask "$(m lon)" "${LON}"; LON="${REPLY//,/.}"
  if [[ -z "$LAT$LON" ]]; then
    warn "$(m no_loc)"
    break
  fi
  if valid_coord "$LAT" && valid_coord "$LON" \
     && awk -v a="$LAT" -v b="$LON" 'BEGIN{exit !(a>=-90 && a<=90 && b>=-180 && b<=180)}'; then
    ok "$(m loc_ok "$LAT" "$LON")"
    break
  fi
  [[ $YES == 1 ]] && die "$(m loc_bad_y "$LAT" "$LON")"
  warn "$(m loc_bad)"
  LAT=""; LON=""
done

# ---------- 4. Rede ----------
say ""
say "${b}$(m s4)${n}"
say "    ${d}$(m s4_help1)${n}"
say "    ${d}$(m s4_help2)${n}"
# URUTAU_BIND=… pula a pergunta (127.0.0.1, 0.0.0.0 ou o IP do Tailscale)
BIND="${URUTAU_BIND:-}"
if [[ -z "$BIND" ]]; then
  cur="$(grep -E '^URUTAU_BIND=' .env 2>/dev/null | cut -d= -f2- || true)"
  def=1
  [[ "$cur" == "0.0.0.0" ]] && def=2
  [[ "$cur" == 100.* ]] && def=3
  ask "$(m s4_ask) (1/2/3)" "$def"
  case "$REPLY" in
    2) BIND="0.0.0.0" ;;
    3)
      BIND="$(tailscale ip -4 2>/dev/null | head -1 || true)"
      if [[ -z "$BIND" ]]; then warn "$(m ts_none)"; BIND="127.0.0.1"; else warn "$(m ts_note)"; fi
      ;;
    *) BIND="127.0.0.1" ;;
  esac
fi
ok "$(m bind_ok "$BIND")"

# senha do painel: opções 2/3 (BIND não local); opção 1 não pergunta
ADMIN_PW="${URUTAU_PASSWORD-}"
VIEW_PW="${URUTAU_VIEW_PASSWORD-}"
is_local_bind() { [[ "$1" == "127.0.0.1" || "$1" == "localhost" || "$1" == "::1" ]]; }
if ! is_local_bind "$BIND"; then
  if [[ $YES == 1 ]]; then
    # -y: usa env; se não houver senha, gera e imprime uma vez
    if [[ -z "${ADMIN_PW}" ]]; then
      ADMIN_PW="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16)"
      warn "$(m pw_gen "$ADMIN_PW")"
    fi
  else
    # read -rs: senha oculta; vazio = gerar
    printf '  %s ' "$(m pw_ask)"
    read -rs ADMIN_PW || true
    printf '\n'
    if [[ -z "${ADMIN_PW}" ]]; then
      ADMIN_PW="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16)"
      warn "$(m pw_gen "$ADMIN_PW")"
    fi
    printf '  %s ' "$(m pw_view)"
    read -rs VIEW_PW || true
    printf '\n'
  fi
  ok "$(m pw_ok)"
else
  # BIND local: não força senha; preserva o que já estiver no ambiente/.env
  ADMIN_PW="${URUTAU_PASSWORD-}"
  VIEW_PW="${URUTAU_VIEW_PASSWORD-}"
  say "    ${d}$(m pw_off)${n}"
fi

if [[ -f .env ]]; then
  cp .env ".env.bak.$(date +%Y%m%d%H%M%S)"
  ok "$(m env_bak)"
fi
setkv() { # setkv CHAVE valor → atualiza ou acrescenta no .env
  if grep -qE "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
}
[[ -f .env ]] || cp .env.example .env
setkv READSB_LAT "$LAT"
setkv READSB_LON "$LON"
setkv URUTAU_BIND "$BIND"
setkv DOCKER_GID "$DOCKER_GID"
setkv URUTAU_ADSB_SERIAL "${ADSB_SERIAL:-}"
setkv URUTAU_SDR_SERIAL "${SDR_SERIAL:-}"
# só grava senhas quando BIND não é local (ou quando já vieram do ambiente no -y local)
if ! is_local_bind "$BIND"; then
  setkv URUTAU_PASSWORD "$ADMIN_PW"
  setkv URUTAU_VIEW_PASSWORD "$VIEW_PW"
elif [[ -n "${URUTAU_PASSWORD-}" || -n "${URUTAU_VIEW_PASSWORD-}" ]]; then
  [[ -n "${URUTAU_PASSWORD-}" ]] && setkv URUTAU_PASSWORD "$URUTAU_PASSWORD"
  [[ -n "${URUTAU_VIEW_PASSWORD-}" ]] && setkv URUTAU_VIEW_PASSWORD "$URUTAU_VIEW_PASSWORD"
fi
chmod 600 .env
ok "$(m env_ok)"

# ---------- 5. Subir ----------
say ""
say "${b}$(m s5)${n}"
if docker compose pull --quiet 2>/dev/null; then
  ok "$(m pulled)"
else
  warn "$(m building)"
  docker compose build
fi
docker compose up -d
host="localhost"
[[ "$BIND" == 100.* ]] && host="$BIND"
if [[ "$BIND" == "0.0.0.0" ]]; then
  # `hostname -I` não existe em todas as distros (ex.: Arch); `ip` é o plano B
  host="$({ hostname -I 2>/dev/null || ip -4 -o addr show scope global 2>/dev/null | awk '{sub("/.*", "", $4); print $4}'; } | awk 'NR==1{print $1}' || true)"
fi
host="${host:-localhost}"
say ""
say "${b}$(m done)${n} $(m open "${o}http://${host}:3090${n}")"
say "  ${d}$(m links "http://${host}:8089" "http://${host}:3090/api/docs")${n}"
say "  ${d}$(m ops)${n}"
say ""
