# Urutau

[![versão](https://img.shields.io/github/v/release/mateuspestana/urutau?label=versão)](https://github.com/mateuspestana/urutau/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/mateuspestana/urutau/ci.yml?branch=main&label=CI)](https://github.com/mateuspestana/urutau/actions/workflows/ci.yml)
[![licença](https://img.shields.io/github/license/mateuspestana/urutau?label=licença)](LICENSE)
[![atualizado](https://img.shields.io/github/last-commit/mateuspestana/urutau?label=atualizado)](https://github.com/mateuspestana/urutau/commits/main)

**Português** · [English](README.en.md) · [Español](README.es.md) · [Français](README.fr.md) · [Русский](README.ru.md)

O Urutau é uma estação de recepção de rádio para uso doméstico, baseada em um receptor RTL-SDR. Em um único painel web, ele reúne o rastreamento de aeronaves (ADS-B) e de embarcações (AIS), a escuta de rádio FM e da banda aeronáutica, a análise de espectro, a decodificação de mensagens digitais (ACARS, VDL2, APRS), o acompanhamento de radiossondas, a leitura de sensores sem fio e a recepção de imagens de satélites meteorológicos. Roda em Docker no Linux, no Raspberry Pi e, de forma experimental, no Windows. Todos os dados permanecem na máquina do usuário.

O nome vem do urutau (*Nyctibius griseus*), ave que passa a noite imóvel observando o céu.

![Visão geral do painel, com a escala de sintonia no topo](docs/img/visao-geral-pt.png)

## Motivação

Um receptor RTL-SDR de baixo custo cobre de 24 MHz a 1,7 GHz e capta dezenas de serviços diferentes. Cada serviço, porém, depende de um programa próprio, geralmente de linha de comando e em inglês, e apenas um desses programas pode usar o receptor de cada vez. Não havia um aplicativo que reunisse essas ferramentas e arbitrasse o acesso ao receptor. O Urutau preenche essa lacuna: o usuário escolhe o modo no painel, e o sistema encerra o processo anterior, libera o dispositivo USB e inicia o decodificador adequado.

O projeto se destina a quem quer observar o próprio espaço aéreo e marítimo sem depender de serviços de terceiros: pesquisadores, escolas, coletivos, associações de moradores e entusiastas de radioescuta.

## Funcionalidades

| Módulo | O que faz | Faixa |
|---|---|---|
| [ADS-B](#ads-b-aeronaves) | Aeronaves no mapa, com matrícula, tipo, altitude, velocidade e trilha | 1090 MHz |
| [Rádio FM](#rádio-fm-e-rds) | Emissoras comerciais, com nome e texto da emissora (RDS) | 87,5–108 MHz |
| [Banda aeronáutica](#banda-aeronáutica) | Comunicações de voz entre pilotos e controle de tráfego aéreo, em AM | 118–137 MHz |
| [Espectro](#espectro) | Varredura de qualquer faixa, com a frequência de cada pico identificada | 24–1700 MHz |
| [Navios (AIS)](#navios-ais) | Embarcações com nome, tipo, rumo, velocidade e destino | 161,975 e 162,025 MHz |
| [Datalink](#datalink-acars-e-vdl2) | Mensagens digitais ACARS e VDL2 entre aeronaves e estações de solo | 129–137 MHz |
| [APRS](#aprs) | Posições, dados meteorológicos e mensagens de radioamadores | 144–146 MHz |
| [Radiossondas](#radiossondas) | Balões meteorológicos com altitude, temperatura, umidade e trajetória | 400–406 MHz |
| [Sensores ISM](#sensores-ism-433-mhz) | Estações meteorológicas, termômetros e outros sensores sem fio | 433,92 MHz |
| [Satélites](#imagens-de-satélite-meteor-m) | Imagens dos satélites Meteor-M e agenda de passagens | 137,9 MHz |

Além dos receptores, o painel oferece [registro de aeronaves](#registro-de-aeronaves), [estudo de alcance](#estudo-de-alcance), [gráficos de desempenho](#gráficos), [marcadores](#marcadores) e interface em [cinco idiomas](#idiomas-e-aparência).

### Painel e escala de sintonia

O topo do painel reproduz a escala de um receptor de rádio. Cada serviço aparece na sua frequência real, distribuído em quatro faixas (FM, VHF, UHF e banda L), e um ponteiro laranja indica qual modo está com o receptor naquele momento. À esquerda, um mostrador exibe o modo e a frequência atuais; abaixo, as teclas de modo permitem trocar de serviço. Como o receptor atende a um serviço por vez, cada troca é feita pela própria API, que encerra o processo anterior antes de iniciar o novo. Depois de um reinício, a API retoma automaticamente o último modo escolhido.

### ADS-B (aeronaves)

As aeronaves transmitem continuamente, em 1090 MHz, sua identificação, posição, altitude e velocidade. O Urutau recebe esses sinais com o [readsb](https://github.com/wiedehopf/readsb) e os apresenta em um mapa no estilo do tar1090:

- ícones coloridos pela altitude e orientados pelo rumo, com trilha de cada voo;
- painel de detalhes com matrícula, modelo, operador, velocidade, razão de subida, piloto automático, vento e foto da aeronave;
- tabela ordenável e filtrável de todas as aeronaves recebidas;
- alerta para códigos de emergência (7500, 7600 e 7700);
- anéis de distância, rótulos e modo de acompanhamento de uma aeronave selecionada.

O mapa completo do tar1090 continua disponível em `http://localhost:8089`.

### Rádio FM e RDS

O modo FM sintoniza emissoras comerciais em banda larga (WBFM) e decodifica o RDS, sistema pelo qual a emissora transmite seu nome, tipo de programação, texto livre, hora e frequências alternativas.

Como muitos computadores e servidores não têm saída de som, o áudio é apresentado visualmente, com osciloscópio, espectrograma, medidor de nível em dBFS e uma estimativa automática do conteúdo (voz e música, chiado ou silêncio). A reprodução no navegador é opcional, e o áudio pode ser gravado em WAV.

![Rádio FM, banda aeronáutica e monitor de áudio](docs/img/radio-pt.png)

### Banda aeronáutica

O modo de banda aeronáutica recebe, em AM, as comunicações de voz entre pilotos e órgãos de controle (torre, aproximação, centro). Aceita canais com espaçamento de 8,33 kHz e utiliza o mesmo monitor visual de áudio do modo FM.

### Espectro

A análise de espectro varre qualquer intervalo de frequências com o `rtl_power` e desenha a potência recebida. O eixo horizontal é uma régua graduada, e cada pico significativo (8 dB acima da mediana) recebe um rótulo com a sua frequência. Ao passar o cursor, o gráfico mostra a frequência e o nível exatos. Há também um modo de cascata contínua, em que cada varredura vira uma linha colorida pela intensidade. Picos nas faixas de FM ou de banda aeronáutica podem ser sintonizados com um clique.

![Espectro da faixa de FM com os picos rotulados](docs/img/espectro-pt.png)

### Navios (AIS)

Embarcações transmitem, pelo sistema AIS, identificação, posição, rumo, velocidade e destino. O Urutau recebe os dois canais AIS ao mesmo tempo com o [AIS-catcher](https://github.com/jvde-github/AIS-catcher) e mostra as embarcações em um mapa, classificadas por categoria (carga, tanque, passageiros, pesca, recreio, rebocadores, auxílios à navegação), com trilha e ficha completa de cada uma. A recepção melhora muito com a antena voltada para o mar, uma baía ou um rio navegável.

### Decodificadores

A aba Decodificadores reúne os modos que transformam sinais digitais em dados estruturados. Cada um tem contadores de sessão, histórico em SQLite e a saída do programa decodificador para diagnóstico.

#### Datalink ACARS e VDL2

ACARS e VDL Modo 2 são os enlaces de dados pelos quais aeronaves e companhias aéreas trocam mensagens operacionais: posições, relatórios de motor, autorizações e mensagens CPDLC. O Urutau decodifica vários canais simultâneos (dentro de uma janela de 1,8 MHz) com o [acarsdec](https://github.com/TLeconte/acarsdec) ou o [dumpvdl2](https://github.com/szpajder/dumpvdl2) e apresenta as mensagens com sentido (solo ou aeronave), voo, matrícula, rótulo e texto, além do JSON completo de cada mensagem.

![Configuração do datalink e tabela de mensagens](docs/img/datalink-pt.png)

#### APRS

O APRS é a rede de radioamadores para posições, dados meteorológicos e mensagens curtas. O Urutau decodifica os pacotes com o [multimon-ng](https://github.com/EliasOenal/multimon-ng) e os interpreta com o aprslib. As estações aparecem em um mapa, com trilha, símbolo e comentário. A frequência padrão é 145,570 MHz (Brasil); estão disponíveis predefinições para 144,390 MHz (América do Norte), 144,800 MHz (Europa) e 145,825 MHz (Estação Espacial Internacional).

#### Radiossondas

Radiossondas são balões meteorológicos lançados duas vezes por dia, por volta de 00Z e 12Z, que transmitem posição, altitude, temperatura, umidade e pressão até estourarem a mais de 30 km de altitude. O Urutau executa o [radiosonde_auto_rx](https://github.com/projecthorus/radiosonde_auto_rx) em um container próprio e mostra no mapa cada sonda com a sua trajetória. Uma agenda opcional liga a busca automaticamente nas janelas de lançamento. O envio público de dados ao SondeHub permanece desligado.

#### Sensores ISM (433 MHz)

Na faixa ISM de 433,92 MHz operam estações meteorológicas domésticas, termômetros, sensores de pressão de pneus (TPMS), campainhas e controles remotos. O Urutau usa o [rtl_433](https://github.com/merbanan/rtl_433), que reconhece mais de 200 modelos, e organiza as leituras por dispositivo, com histórico de mensagens.

#### Imagens de satélite (Meteor-M)

Os satélites meteorológicos russos Meteor-M transmitem imagens da Terra em tempo real no formato LRPT, em 137,9 MHz. O Urutau calcula as passagens das próximas 48 horas a partir das órbitas publicadas pelo CelesTrak, com horário, duração, elevação máxima e trajetória. As capturas são decodificadas pelo [SatDump](https://github.com/SatDump/SatDump) e ficam disponíveis no próprio painel. Uma agenda opcional captura automaticamente toda passagem acima de uma elevação mínima e devolve o receptor ao modo anterior ao final. Uma antena externa com visão desobstruída do céu (dipolo em V ou QFH) é necessária para obter imagens.

<!-- Imagem de uma passagem Meteor capturada pela estação: a ser adicionada. -->

![Agenda de passagens de satélite](docs/img/satelites-pt.png)

### Registro de aeronaves

Toda aeronave recebida é registrada em um banco SQLite, inclusive as que não transmitem posição. Cada passagem gera uma linha, com horário, duração, voo, matrícula, tipo, altitude e distância máximas, intensidade do sinal e trilha. O registro pode ser filtrado por período e por texto, exportado em CSV e consultado no mapa. Um histórico de eventos da estação registra as trocas de modo, o que permite saber em que períodos o ADS-B esteve desligado.

### Estudo de alcance

Enquanto o ADS-B está ligado, o Urutau mede continuamente o alcance da estação em 360 setores de 1°, a partir do primeiro e do último contato de cada aeronave. O contorno resultante é suavizado (interpolação de lacunas, mediana circular e filtro gaussiano), de modo que uma aeronave isolada não produza um pico artificial; o valor máximo bruto continua disponível nas estatísticas. O contorno pode ser exibido no mapa e exportado como um relatório HTML autônomo.

![Estudo de alcance](docs/img/alcance-pt.png)

### Gráficos

A aba Gráficos apresenta as séries históricas geradas pelo graphs1090: número de aeronaves, taxa de mensagens, sinal, alcance, uso de CPU, temperatura e memória, em períodos de 2 horas a 1 ano.

### Marcadores

Frequências e pontos geográficos de interesse podem ser salvos como marcadores. Marcadores de frequência são sintonizados com um clique; marcadores de posição aparecem no mapa.

### Idiomas e aparência

A interface está disponível em português (padrão), inglês, espanhol, francês e russo, com números e datas no formato de cada idioma. Há temas claro e escuro, e o painel se adapta a telas de celular. O instalador também fala os cinco idiomas, conforme o idioma do sistema.

## Requisitos

- **Receptor RTL-SDR.** O modelo de referência é o [RTL-SDR Blog V4](https://www.rtl-sdr.com/v4/), vendido com antenas dipolo.
- **Computador:** Linux (Ubuntu, Debian, Fedora, Arch e derivados), Raspberry Pi 4 ou 5 com Raspberry Pi OS de 64 bits, ou Windows 10/11 com WSL2 (experimental).
- **Docker** com o plugin Compose.
- **Antena adequada ao serviço.** A antena que acompanha o receptor, em ambiente interno, atende ao FM e a aeronaves próximas. Navios, satélites e radiossondas exigem antena externa ou junto a uma janela, com visão do céu ou do mar.

O macOS não é suportado: o Docker no macOS não dá acesso a dispositivos USB.

## Instalação

### Linux e Raspberry Pi

```bash
git clone https://github.com/mateuspestana/urutau.git
cd urutau
./install.sh
```

O instalador:

1. verifica o Docker e o Docker Compose;
2. procura o receptor e, se necessário, oferece bloquear o driver de TV digital do kernel (`dvb_usb_rtl28xxu`), que costuma ocupar o dispositivo;
3. pergunta a localização da antena e quem pode abrir o painel: só esta máquina, a rede local e o Tailscale, ou só o Tailscale;
4. grava o arquivo `.env` e inicia os containers.

Ao final, o painel fica disponível em **http://localhost:3090**. Para instalação não interativa:

```bash
URUTAU_LAT=-15.799 URUTAU_LON=-47.864 ./install.sh -y
```

O instalador baixa imagens prontas para PC (amd64) e Raspberry Pi (arm64). Quando não há imagem para a arquitetura, ele compila localmente; em um Raspberry Pi, a compilação pode passar de uma hora.

### Windows (experimental)

No Windows, o Urutau roda dentro do WSL2, e o dongle é repassado ao Linux pelo [usbipd-win](https://github.com/dorssel/usbipd-win). O script `install-windows.ps1` automatiza o processo. Consulte o [guia para Windows](docs/windows.md).

### Acesso pela rede local e pelo Tailscale

Por padrão, o painel só abre no próprio computador. O instalador oferece três opções de acesso, gravadas em `URUTAU_BIND` no `.env`:

| Opção | `URUTAU_BIND` | Quem acessa |
|---|---|---|
| 1. Só esta máquina (padrão) | `127.0.0.1` | apenas o computador da estação |
| 2. Rede local e Tailscale | `0.0.0.0` | qualquer aparelho da rede local e da sua rede [Tailscale](https://tailscale.com) |
| 3. Só Tailscale | IP `100.x.y.z` da máquina | apenas aparelhos da sua rede Tailscale |

Com as opções 2 ou 3, abra `http://<endereço-da-estação>:3090` em outro aparelho (por exemplo, o nome ou o IP da máquina no Tailscale). Os links para o tar1090 e para os gráficos acompanham automaticamente o endereço usado. Na opção 3, o Tailscale precisa estar conectado antes de o Docker iniciar. Quem consegue abrir o painel também pode trocar o modo do receptor, e a API controla o Docker da máquina: libere o acesso apenas em redes de confiança.

Para trocar a opção depois, execute `./install.sh` novamente ou edite `URUTAU_BIND` no `.env` e rode `docker compose up -d`.

## Operação

| Ação | Comando |
|---|---|
| Parar a estação | `docker compose stop` |
| Iniciar novamente | `docker compose start` |
| Atualizar | `git pull && ./install.sh` |
| Ver os registros da API | `docker compose logs -f api` |
| Documentação da API | http://localhost:8000/docs |

A localização da antena pode ser alterada a qualquer momento na aba Config. Três casas decimais (cerca de 100 m) bastam para o estudo de alcance.

## Privacidade e conexões externas

O painel é acessível apenas no próprio computador (`127.0.0.1`), a menos que o acesso pela rede local ou pelo Tailscale seja autorizado (veja [Acesso pela rede local e pelo Tailscale](#acesso-pela-rede-local-e-pelo-tailscale)). Nenhum dado de recepção é enviado a terceiros: o compartilhamento com redes de rastreamento (ADS-B Exchange, FlightAware e similares) e o envio de radiossondas ao SondeHub vêm desligados.

O painel se conecta à internet apenas para obter informações que não podem ser geradas localmente:

| Finalidade | Serviço | Dado enviado |
|---|---|---|
| Órbitas dos satélites | CelesTrak | número do satélite (uma vez por dia) |
| Fundo do mapa | Esri (ArcGIS) | região do mapa exibida |
| Matrícula e tipo das aeronaves | banco de dados distribuído com o tar1090 | prefixo do código da aeronave |
| Foto da aeronave, ao selecioná-la | planespotters.net | código e matrícula da aeronave |
| Relatório de alcance em HTML, ao abri-lo | unpkg | requisição da biblioteca de mapas Leaflet |

Fontes e demais recursos do painel são distribuídos com o próprio software. A localização da antena fica apenas no arquivo `.env` e no volume Docker local.

## Arquitetura

```
receptor USB ─► ultrafeeder (readsb, tar1090, graphs1090) ─► ADS-B
             └► API (FastAPI) ─ rtl_fm, rtl_power, AIS-catcher, acarsdec, dumpvdl2,
                                rtl_433, multimon-ng, redsea, SatDump, radiosonde_auto_rx
                   │
                   └─► painel web (React + Vite, servido por nginx) em :3090
```

A API é a única responsável pelo receptor. A cada troca de modo, ela encerra o processo anterior, para ou inicia o ultrafeeder pelo Docker e só então inicia o novo decodificador. Os registros ficam em bancos SQLite no volume `urutau_api_data`. Instruções para desenvolvimento estão em [CONTRIBUTING.md](CONTRIBUTING.md).

## Solução de problemas

- **`usb_claim_interface error -6`:** outro programa está usando o receptor. Pode ser o driver de TV digital do kernel (execute `./install.sh` novamente) ou um programa externo como GQRX ou `rtl_*`. Antes de usar outro programa, pare a estação com `docker compose stop`.
- **Painel aberto, mas nenhuma aeronave:** com antena interna, é normal receber poucas aeronaves ou nenhuma. Para verificar o receptor, sintonize uma emissora FM: se o monitor de áudio mostrar sinal, o hardware está funcionando.
- **Permissão negada ao acessar o Docker:** confira se `DOCKER_GID` no `.env` corresponde ao resultado de `getent group docker`.
- **Satélites sem passagens:** defina a localização em Config e verifique se o container tem acesso à internet para buscar as órbitas.

## Aviso legal

A recepção de sinais transmitidos abertamente (ADS-B, AIS, FM, APRS, radiossondas e satélites meteorológicos) é uma prática comum de radioescuta. Comunicações de voz e mensagens de datalink não se destinam ao público: devem ser usadas apenas para estudo, sem divulgação do conteúdo. Cada usuário é responsável por observar a legislação do seu país.

## Créditos

O Urutau integra o trabalho de diversos projetos de código aberto: [docker-adsb-ultrafeeder](https://github.com/sdr-enthusiasts/docker-adsb-ultrafeeder) (readsb, tar1090 e graphs1090), [AIS-catcher](https://github.com/jvde-github/AIS-catcher), [acarsdec](https://github.com/TLeconte/acarsdec), [dumpvdl2](https://github.com/szpajder/dumpvdl2) e [libacars](https://github.com/szpajder/libacars), [rtl_433](https://github.com/merbanan/rtl_433), [multimon-ng](https://github.com/EliasOenal/multimon-ng), [redsea](https://github.com/windytan/redsea), [SatDump](https://github.com/SatDump/SatDump), [radiosonde_auto_rx](https://github.com/projecthorus/radiosonde_auto_rx), [Skyfield](https://rhodesmill.org/skyfield/) e [osmocom rtl-sdr](https://osmocom.org/projects/rtl-sdr).

## Como citar

Os metadados de citação estão em [CITATION.cff](CITATION.cff). No GitHub, use o botão *Cite this repository*. Em trabalhos acadêmicos, indique a versão utilizada e, quando disponível, o DOI da versão arquivada no Zenodo.

## Licença

Distribuído sob a [GNU General Public License v3.0](LICENSE) (GPL-3.0-only).

---

Desenvolvido por [MACAPE Pesquisas e Consultoria em Tecnologia Ltda](https://macape.dev).
