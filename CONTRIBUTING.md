# Como contribuir

Contribuições são bem-vindas, em português ou inglês. Para relatar um problema ou propor uma melhoria, abra uma [issue](https://github.com/mateuspestana/urutau/issues); para enviar código, abra um pull request.

## Ambiente de desenvolvimento

```bash
git clone https://github.com/mateuspestana/urutau.git && cd urutau
cp .env.example .env            # preencha READSB_LAT/LON e DOCKER_GID
docker compose up -d --build    # painel em http://localhost:3090
```

Para desenvolver o painel com recarga automática, mantendo a API no Docker:

```bash
cd web && npm ci && npm run dev  # http://localhost:5173, com proxy de /api para :8000
```

## Verificações antes do pull request

```bash
cd api && pip install -r requirements.txt pytest ruff && ruff check . && pytest -q
cd web && npm run build && npm run lint && npm run i18n:check
```

Os testes da API não dependem de receptor, Docker ou rede: cobrem os interpretadores dos decodificadores, a suavização do estudo de alcance e o cálculo de passagens de satélite. O CI executa os mesmos comandos e também compila as imagens Docker.

## Diretrizes

- **Um consumidor USB por vez.** Toda troca de modo passa por `api/app/modes.py` (`apply`), que encerra o processo anterior e para ou inicia o ultrafeeder. Nenhum código deve abrir o receptor fora desse caminho.
- **Nenhum dado sai da máquina sem que o usuário saiba.** Qualquer nova conexão externa deve ser incluída na tabela de privacidade dos READMEs. Compartilhamento com redes externas permanece desligado por padrão.
- **Localização.** Use `store.receiver()`, que devolve `(lat, lon)` ou `None`; recursos que dependem da localização devem funcionar, ou se desativar com clareza, quando ela não estiver definida. Exemplos e testes não devem conter coordenadas residenciais reais.
- **Idiomas.** Todo texto visível passa por `t('frase em português')`, `tn(singular, plural, n)` ou, para constantes, `markApi('…')` (em `web/src/i18n.ts`). Ao criar ou alterar uma frase, acrescente a tradução em `web/src/locales/{en,es,fr,ru}.ts`; o `npm run i18n:check` aponta frases faltando ou sobrando. Números e datas usam `fmtNum` e `fmtDate`.
- **Sistema visual.** As cores, a tipografia e os espaçamentos são tokens definidos em `web/src/App.css`, nos temas claro e escuro. O laranja (`--accent`) indica exclusivamente o modo que está com o receptor; texto em laranja usa `--accent-text`. Ícones vêm de `Icon.tsx`. Os componentes de canvas leem `--accent`, `--line`, `--bg-elev`, `--muted`, `--warn`, `--danger` e `--text`, que não devem ser renomeados.
- **Tipos compartilhados.** Ao alterar uma resposta da API, atualize o tipo correspondente em `web/src/api.ts`.

Ao contribuir, você concorda em licenciar sua contribuição sob a [GPL-3.0](LICENSE).
