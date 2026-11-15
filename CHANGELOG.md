# Histórico de mudanças

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); as versões seguem o [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [0.1.5] - 2026-11-15

### Documentação

- Orientações no README para citar a versão utilizada e incluir seu DOI do Zenodo.

## [0.1.4] - 2026-11-14

### Corrigido

- A agenda não devolvia o receptor ao modo anterior quando a captura de satélite (ou a busca de radiossondas) terminava sozinha: o fim natural do processo era confundido com uma troca de modo feita pela pessoa, e a estação ficava parada em modo livre até alguém religar o ADS-B.

## [0.1.3] - 2026-11-14

### Adicionado

- Acesso pela rede local e pelo Tailscale: o instalador oferece três opções (só esta máquina, rede local e Tailscale, só Tailscale), gravadas em `URUTAU_BIND`.
- Os links para o tar1090 e para os gráficos seguem o endereço pelo qual o painel foi aberto, em vez de apontar sempre para `localhost`.

## [0.1.2] - 2026-11-14

Primeira versão pública.

### Recepção

- **ADS-B:** mapa no estilo do tar1090, com detalhes, trilhas, fotos, alerta de emergência e tabela ordenável.
- **Registro de aeronaves:** banco SQLite com uma linha por passagem, exportação em CSV e trilhas no mapa.
- **Estudo de alcance:** 360 setores, contorno suavizado e relatório HTML autônomo.
- **Rádio:** FM com RDS e banda aeronáutica em AM, com monitor visual de áudio e gravação em WAV.
- **Espectro:** régua graduada, frequência rotulada em cada pico, cursor de leitura e cascata contínua.
- **Decodificadores:** datalink ACARS e VDL2, navios (AIS), APRS, sensores de 433 MHz (rtl_433) e radiossondas (radiosonde_auto_rx).
- **Satélites Meteor-M:** captura e decodificação (SatDump), com agenda automática de passagens e de janelas de radiossondas.

### Operação

- A API arbitra o uso do receptor e retoma o último modo escolhido após um reinício.
- Instalador `install.sh` para Linux e Raspberry Pi, com verificação do Docker, bloqueio opcional do driver de TV do kernel e configuração da localização.
- Suporte experimental ao Windows por WSL2 e usbipd-win (`install-windows.ps1`).
- Imagens prontas para amd64 e arm64 no GitHub Container Registry.

### Interface

- Painel e instaladores em português, inglês, espanhol, francês e russo, com números e datas no formato de cada idioma.
- Visual inspirado no design de Dieter Rams para a Braun, com escala de sintonia, temas claro e escuro e layout responsivo.

### Privacidade

- O painel fica restrito a `127.0.0.1` por padrão; o acesso pela rede local é opcional.
- Sem envio de dados a redes de rastreamento nem ao SondeHub; fontes distribuídas com o software.
- A localização da antena é opcional e fica apenas no `.env` e no volume local.

[0.1.4]: https://github.com/mateuspestana/urutau/releases/tag/v0.1.4
[0.1.3]: https://github.com/mateuspestana/urutau/releases/tag/v0.1.3
[0.1.2]: https://github.com/mateuspestana/urutau/releases/tag/v0.1.2
