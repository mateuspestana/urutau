# Urutau — preparação no Windows 10/11 (WSL2 + usbipd-win). EXPERIMENTAL.
# Autor: Matheus C. Pestana — MACAPE Pesquisas e Consultoria em Tecnologia Ltda
#
# O Docker no Windows não enxerga USB sozinho. Este script:
#   1. confere o WSL2 e instala o usbipd-win (winget), que passa o dongle para dentro do Linux do WSL;
#   2. encontra o RTL-SDR, compartilha (bind) e conecta ao WSL (attach --auto-attach, que reconecta
#      quando o dongle é reconectado; a janela dele precisa ficar aberta);
#   3. roda o install.sh do Urutau dentro do WSL.
#
# Uso, num PowerShell **como administrador**:
#   Set-ExecutionPolicy -Scope Process Bypass; .\install-windows.ps1
# Distro diferente da padrão:  .\install-windows.ps1 -Distro Ubuntu-24.04
# Idioma (pt, en, es, fr, ru; padrão: o do Windows):  .\install-windows.ps1 -Lang en

param([string]$Distro = "", [string]$Lang = "")

$ErrorActionPreference = "Stop"

if (-not $Lang) { $Lang = (Get-UICulture).TwoLetterISOLanguageName }
if (@("pt", "en", "es", "fr", "ru") -notcontains $Lang) { $Lang = "en" }

# chave → @(pt, en, es, fr, ru)
$M = @{
  title      = @("Urutau · preparação no Windows (experimental)", "Urutau · Windows setup (experimental)", "Urutau · preparación en Windows (experimental)", "Urutau · préparation sous Windows (expérimental)", "Urutau · подготовка в Windows (экспериментально)")
  admin      = @("Abra o PowerShell como administrador (o usbipd precisa disso para compartilhar o USB).", "Open PowerShell as administrator (usbipd needs it to share the USB device).", "Abre PowerShell como administrador (usbipd lo necesita para compartir el USB).", "Ouvrez PowerShell en tant qu’administrateur (usbipd en a besoin pour partager l’USB).", "Запустите PowerShell от имени администратора (usbipd это нужно для проброса USB).")
  wsl_h      = @("1. WSL2", "1. WSL2", "1. WSL2", "1. WSL2", "1. WSL2")
  wsl_no     = @("O WSL não está pronto. Rode:  wsl --install -d Ubuntu  , reinicie o Windows, abra o Ubuntu uma vez e rode este script de novo.", "WSL is not ready. Run:  wsl --install -d Ubuntu  , restart Windows, open Ubuntu once and run this script again.", "WSL no está listo. Ejecuta:  wsl --install -d Ubuntu  , reinicia Windows, abre Ubuntu una vez y vuelve a ejecutar este script.", "WSL n’est pas prêt. Lancez :  wsl --install -d Ubuntu  , redémarrez Windows, ouvrez Ubuntu une fois et relancez ce script.", "WSL не готов. Выполните:  wsl --install -d Ubuntu  , перезагрузите Windows, один раз откройте Ubuntu и запустите скрипт снова.")
  wsl_ok     = @("WSL respondendo", "WSL is responding", "WSL responde", "WSL répond", "WSL отвечает")
  usb_h      = @("2. usbipd-win", "2. usbipd-win", "2. usbipd-win", "2. usbipd-win", "2. usbipd-win")
  usb_inst   = @("instalando com winget (dorssel.usbipd-win)…", "installing with winget (dorssel.usbipd-win)…", "instalando con winget (dorssel.usbipd-win)…", "installation avec winget (dorssel.usbipd-win)…", "установка через winget (dorssel.usbipd-win)…")
  usb_path   = @("usbipd instalado, mas não encontrado no PATH. Feche e abra o PowerShell e rode de novo.", "usbipd installed but not found in PATH. Close and reopen PowerShell and run again.", "usbipd instalado, pero no está en el PATH. Cierra y abre PowerShell y vuelve a ejecutar.", "usbipd installé mais introuvable dans le PATH. Fermez et rouvrez PowerShell, puis relancez.", "usbipd установлен, но не найден в PATH. Перезапустите PowerShell и повторите.")
  dongle_h   = @("3. Dongle RTL-SDR", "3. RTL-SDR dongle", "3. Dongle RTL-SDR", "3. Dongle RTL-SDR", "3. Донгл RTL-SDR")
  dongle_no  = @("Nenhum RTL-SDR (USB 0bda:2838) encontrado. Conecte o dongle e rode de novo.", "No RTL-SDR (USB 0bda:2838) found. Plug in the dongle and run again.", "No se encontró ningún RTL-SDR (USB 0bda:2838). Conecta el dongle y vuelve a ejecutar.", "Aucun RTL-SDR (USB 0bda:2838) trouvé. Branchez le dongle et relancez.", "RTL-SDR (USB 0bda:2838) не найден. Подключите донгл и запустите снова.")
  dongle_ok  = @("encontrado em BUSID {0}", "found at BUSID {0}", "encontrado en BUSID {0}", "trouvé sur BUSID {0}", "найден, BUSID {0}")
  bind_ok    = @("compartilhado (bind; --force tira o dongle do driver de TV do Windows)", "shared (bind; --force detaches the dongle from the Windows TV driver)", "compartido (bind; --force quita el dongle del driver de TV de Windows)", "partagé (bind ; --force retire le dongle du pilote TV de Windows)", "проброшен (bind; --force отключает донгл от ТВ-драйвера Windows)")
  attach     = @("conectando ao WSL numa janela à parte (deixe-a aberta enquanto usar o Urutau)…", "attaching to WSL in a separate window (keep it open while using Urutau)…", "conectando a WSL en una ventana aparte (déjala abierta mientras uses Urutau)…", "connexion à WSL dans une fenêtre séparée (laissez-la ouverte pendant l’utilisation d’Urutau)…", "подключение к WSL в отдельном окне (не закрывайте его, пока пользуетесь Urutau)…")
  seen_ok    = @("dongle visível dentro do WSL", "dongle visible inside WSL", "dongle visible dentro de WSL", "dongle visible dans WSL", "донгл виден внутри WSL")
  seen_no    = @("o WSL ainda não vê o dongle; confira a janela do usbipd.", "WSL does not see the dongle yet; check the usbipd window.", "WSL todavía no ve el dongle; revisa la ventana de usbipd.", "WSL ne voit pas encore le dongle ; vérifiez la fenêtre d’usbipd.", "WSL пока не видит донгл; проверьте окно usbipd.")
  urutau_h   = @("4. Urutau no WSL", "4. Urutau in WSL", "4. Urutau en WSL", "4. Urutau dans WSL", "4. Urutau в WSL")
  done       = @("Pronto. Abra http://localhost:3090 no navegador do Windows.", "Done. Open http://localhost:3090 in your Windows browser.", "Listo. Abre http://localhost:3090 en el navegador de Windows.", "Terminé. Ouvrez http://localhost:3090 dans le navigateur de Windows.", "Готово. Откройте http://localhost:3090 в браузере Windows.")
}
$i = @("pt", "en", "es", "fr", "ru").IndexOf($Lang)
function T($k, $a = $null) { $s = $M[$k][$i]; if ($null -ne $a) { $s -f $a } else { $s } }
function Ok($m) { Write-Host "  ✓ $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  ! $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "  ✗ $m" -ForegroundColor Red; exit 1 }

Write-Host "`n$(T 'title')`n"

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Die (T 'admin') }

# ---------- 1. WSL2 ----------
Write-Host (T 'wsl_h')
$wslArgs = @()
if ($Distro) { $wslArgs = @("-d", $Distro) }
try { wsl.exe @wslArgs -e true | Out-Null } catch { }
if ($LASTEXITCODE -ne 0) { Die (T 'wsl_no') }
Ok (T 'wsl_ok')

# ---------- 2. usbipd-win ----------
Write-Host "`n$(T 'usb_h')"
if (-not (Get-Command usbipd -ErrorAction SilentlyContinue)) {
  Write-Host "    $(T 'usb_inst')"
  winget install --exact --id dorssel.usbipd-win --accept-source-agreements --accept-package-agreements
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not (Get-Command usbipd -ErrorAction SilentlyContinue)) { Die (T 'usb_path') }
}
Ok "usbipd $(usbipd --version)"

# ---------- 3. Dongle ----------
Write-Host "`n$(T 'dongle_h')"
$line = usbipd list | Select-String -Pattern "0bda:283[28]" | Select-Object -First 1
if (-not $line) { Die (T 'dongle_no') }
$busid = ($line.ToString().Trim() -split "\s+")[0]
Ok (T 'dongle_ok' $busid)
usbipd bind --busid $busid --force
Ok (T 'bind_ok')

Write-Host "    $(T 'attach')"
$attachArgs = "attach --wsl --busid $busid --auto-attach"
if ($Distro) { $attachArgs = "attach --wsl $Distro --busid $busid --auto-attach" }
Start-Process -FilePath "usbipd" -ArgumentList $attachArgs -WindowStyle Minimized
Start-Sleep -Seconds 4
$seen = wsl.exe @wslArgs -e sh -c "grep -l 0bda /sys/bus/usb/devices/*/idVendor 2>/dev/null | head -1"
if ($seen) { Ok (T 'seen_ok') } else { Warn (T 'seen_no') }

# ---------- 4. Urutau dentro do WSL ----------
Write-Host "`n$(T 'urutau_h')"
$script = @'
set -e
if ! command -v docker >/dev/null; then
  echo "  Docker: curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER  (systemd=true em /etc/wsl.conf)"
  exit 1
fi
[ -d "$HOME/urutau" ] || git clone https://github.com/mateuspestana/urutau.git "$HOME/urutau"
cd "$HOME/urutau" && git pull --ff-only && ./install.sh
'@
wsl.exe @wslArgs -e env "URUTAU_LANG=$Lang" bash -lc $script
if ($LASTEXITCODE -eq 0) { Write-Host "`n$(T 'done')`n" }
