# Urutau no Windows (experimental)

**Português** · [English](windows.en.md)

O Docker no Windows não dá aos containers acesso a dispositivos USB. Por isso, o Urutau roda dentro do **WSL2** (o subsistema Linux do Windows), e o receptor é repassado ao Linux pelo **[usbipd-win](https://github.com/dorssel/usbipd-win)**. A partir desse ponto, a instalação é idêntica à do Linux.

> Esta configuração ainda não foi validada com um receptor em um Windows real. Relatos de teste são bem-vindos nas [issues](https://github.com/mateuspestana/urutau/issues).

## Requisitos

- Windows 10 (21H2 ou posterior) ou Windows 11.
- WSL2 com Ubuntu: em um PowerShell como administrador, execute `wsl --install -d Ubuntu`, reinicie o computador e abra o Ubuntu uma vez para criar o usuário.
- Docker Engine **instalado dentro do Ubuntu do WSL**, que é o caminho mais direto para o receptor chegar aos containers:
  ```bash
  # no terminal do Ubuntu
  echo -e "[boot]\nsystemd=true" | sudo tee /etc/wsl.conf
  # no PowerShell: wsl --shutdown; depois abra o Ubuntu novamente
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker $USER   # feche e abra o terminal
  ```
  O Docker Desktop com a integração WSL ativada pode funcionar, mas não foi verificado.

## Instalação automática

Baixe o [`install-windows.ps1`](../install-windows.ps1) e execute-o em um **PowerShell como administrador**:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install-windows.ps1
```

O script instala o usbipd-win, localiza o receptor, conecta-o ao WSL e executa o `install.sh` dentro do Ubuntu, no idioma do Windows (ou no indicado em `-Lang pt|en|es|fr|ru`). Ao final, abra **http://localhost:3090** no navegador do Windows.

## Instalação manual

```powershell
winget install --exact --id dorssel.usbipd-win
usbipd list                                    # anote o BUSID do "RTL2838" (0bda:2838)
usbipd bind --busid 2-3 --force                # substitua 2-3 pelo BUSID encontrado
usbipd attach --wsl --busid 2-3 --auto-attach  # mantenha esta janela aberta
```

```bash
# no Ubuntu do WSL
lsusb | grep -i rtl                            # o receptor deve aparecer aqui
git clone https://github.com/mateuspestana/urutau.git && cd urutau && ./install.sh
```

## Observações

- A janela do `usbipd attach --auto-attach` deve permanecer aberta: ela reconecta o receptor quando ele é desconectado ou quando o WSL reinicia. Após reiniciar o Windows, execute o `attach` novamente; o `bind` fica salvo.
- Enquanto o receptor está no WSL, programas do Windows (SDR#, SDR++) não o enxergam. Para devolvê-lo ao Windows: `usbipd detach --busid 2-3`.
- A opção `--force` do `bind` desvincula o receptor do driver de TV do Windows. Para desfazer: `usbipd unbind --busid 2-3`.
- O painel fica em `localhost`, pois o Windows repassa automaticamente as portas do WSL.
