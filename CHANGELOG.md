# Histórico de mudanças

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); as versões seguem o [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [0.6.1] - 2026-11-16

### Corrigido

- Captura de satélite: as estatísticas ao vivo (SNR, sincronismo, veredito) nunca eram atualizadas. O log do SatDump chega pelo stderr e o gancho que o lia tentava trocar o `append` de uma `deque`, o que o Python não permite; a primeira tentativa de captura de cada partida da API falhava com `'collections.deque' object attribute 'append' is read-only` e as seguintes rodavam sem estatísticas. O gancho agora é parte da própria fila do log.

## [0.6.0] - 2026-11-16

### Adicionado

- Torre com um dongle só: a opção **Alternar ADS-B e ACARS** (desligada por padrão) passa alguns segundos no ACARS quando há aeronave com sinal forte e volta ao ADS-B. O padrão é 3 min de ADS-B e 60 s de ACARS, com sinal mínimo de -30 dBFS; os três valores são ajustáveis na aba Torre, que mostra a fase atual, o tempo até a próxima troca, as mensagens captadas na última janela e quanto o ADS-B levou para voltar.
- O ciclo fica em pausa quando a pessoa troca de modo, quando a agenda assume o receptor (satélite e radiossonda têm prioridade e tomam o ACARS do ciclo) e com dois dongles.
- Endpoint `GET /api/tower/cycle` com o estado do ciclo.

## [0.5.2] - 2026-11-16

### Corrigido

- ACARS falhava com o código -4 em alguns computadores: o `acarsdec` era compilado com as instruções da máquina de build (`-march=native`) e encerrava com "Illegal instruction" em CPUs diferentes. Agora ele é compilado para a arquitetura genérica.

## [0.5.1] - 2026-11-16

### Corrigido

- Com [ufw-docker](https://github.com/chaifeng/ufw-docker), o instalador (acesso pela rede / Tailscale) libera a faixa `100.64.0.0/10` em `DOCKER-USER`. Antes só as redes locais privadas passavam: o painel abria na LAN e ficava inacessível por outros nós Tailscale.

## [0.5.0] - 2026-11-16

### Adicionado

- Aba Torre: consola ADS-B + ACARS/VDL2 sem mapa (tráfego, seleção cruzada com datalink, feed ao vivo).
- No estudo de alcance, o contorno, os pontos verdes (apareceu) e os vermelhos (sumiu) ligam e desligam cada um por si no mapa.

## [0.4.0] - 2026-11-16

### Adicionado

- PWA: manifesto, service worker (casco offline; nunca cacheia `/api/`) e instalação no celular em HTTPS ou `localhost`.
- Exportação genérica CSV/JSONL de todos os conjuntos; retenção configurável; painel Dados em Config. Parquet fora da API — converter com DuckDB no host.
- Aviso de nova versão desligado por padrão (`update_check`): se ligado, consulta o GitHub Releases uma vez por dia (`User-Agent: urutau-update-check`); nunca atualiza sozinho.

## [0.3.0] - 2026-11-16

### Adicionado

- Dois dongles (`URUTAU_ADSB_SERIAL` / `URUTAU_SDR_SERIAL`): ADS-B permanente no ultrafeeder e os demais modos no segundo receptor. Não validado em hardware.
- Alertas só no navegador: sino, toast e título da aba; a API Notification é bônus (sem Telegram nem e-mail).
- Cache de blocos de mapa em `/api/tiles` (o navegador não fala com a Esri); camada offline PMTiles; Leaflet embutido no relatório de alcance.
- SkyPlot polar das passagens e galeria de capturas com miniaturas.

## [0.2.0] - 2026-11-16

### Adicionado

- Senha do painel (`URUTAU_PASSWORD` / `URUTAU_VIEW_PASSWORD`): papéis admin e visitante; autenticação desligada se nenhuma senha estiver definida. A API passa a escutar só em `127.0.0.1:8000`; o tar1090 e os gráficos ficam atrás da mesma sessão na porta `:8089` via nginx do painel. O instalador pergunta as senhas nas opções de acesso pela rede.
- Captura de satélite: veredito por passagem (imagem ok, sinal fraco, sem sinal, interrompida, travou sem imagem), SNR ao vivo e médio, pipeline LRPT automático (72k → 80k se preciso) e remoção de capturas vazias.
- Agenda unificada: satélites, radiossondas e entradas próprias na mesma linha do tempo; satélite preempta sonda e a devolve se a janela ainda estiver aberta; gravação de áudio em WAV no servidor.
- Aba Saúde: diagnóstico do receptor e da antena, avisos e medição de piso de ruído por faixa para comparar antenas.

### Corrigido

- O log e o SNR de uma captura de satélite não “herdam” mais valores de passagens anteriores.
- Uma janela de radiossonda deixa de bloquear passagens Meteor: o satélite preempta a sonda e a sonda retoma depois, se a janela ainda estiver aberta.

## [0.1.6] - 2026-11-15

### Corrigido

- Sensores ISM: o rtl_433 emite um JSON a cada troca de frequência (hop) sem campo `model`; a API tratava isso como sensor `?` e poluía a lista. Esses eventos de hop passam a ser ignorados.

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

[0.6.1]: https://github.com/mateuspestana/urutau/releases/tag/v0.6.1
[0.6.0]: https://github.com/mateuspestana/urutau/releases/tag/v0.6.0
[0.5.2]: https://github.com/mateuspestana/urutau/releases/tag/v0.5.2
[0.5.1]: https://github.com/mateuspestana/urutau/releases/tag/v0.5.1
[0.5.0]: https://github.com/mateuspestana/urutau/releases/tag/v0.5.0
[0.4.0]: https://github.com/mateuspestana/urutau/releases/tag/v0.4.0
[0.3.0]: https://github.com/mateuspestana/urutau/releases/tag/v0.3.0
[0.2.0]: https://github.com/mateuspestana/urutau/releases/tag/v0.2.0
[0.1.6]: https://github.com/mateuspestana/urutau/releases/tag/v0.1.6
[0.1.5]: https://github.com/mateuspestana/urutau/releases/tag/v0.1.5
[0.1.4]: https://github.com/mateuspestana/urutau/releases/tag/v0.1.4
[0.1.3]: https://github.com/mateuspestana/urutau/releases/tag/v0.1.3
[0.1.2]: https://github.com/mateuspestana/urutau/releases/tag/v0.1.2
