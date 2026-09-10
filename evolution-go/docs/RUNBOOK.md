# Runbook — Evolution Go (motor do OpenWA)

Stack dedicada que serve de motor de WhatsApp para o OpenWA quando
`ENGINE_TYPE=evolution-go`.

## Por que dedicada

O TurboZap já roda um Evolution Go próprio (`avelarsys-turbozap-evolution`).
Esta stack **não** compartilha nada com ele: container, PostgreSQL, volume de
instâncias e licença são separados. Assim uma sessão do OpenWA nunca colide com
uma sessão do TurboZap, e derrubar/atualizar um não afeta o outro.

## Subir

```bash
cp evolution-go/.env.example evolution-go/.env
# edite EVOLUTION_GO_API_KEY e EVO_POSTGRES_PASSWORD
openssl rand -hex 32   # use a saída como EVOLUTION_GO_API_KEY

docker network create openwa-network 2>/dev/null || true   # se o OpenWA ainda não subiu
docker compose -f evolution-go/docker-compose.yml up -d
docker compose -f evolution-go/docker-compose.yml ps
```

Smoke test (de dentro da rede, ou com o override de debug):

```bash
docker compose -f evolution-go/docker-compose.yml \
               -f evolution-go/docker-compose.debug.yml up -d
KEY=$(grep -m1 '^EVOLUTION_GO_API_KEY=' evolution-go/.env | cut -d= -f2-)
curl -s -H "apikey: $KEY" http://127.0.0.1:7001/instance/all   # -> {"data":[],"message":"success"}
```

## Rede e isolamento

| Item | Valor |
|---|---|
| Rede interna da stack | `openwa-evolution` |
| Rede compartilhada com o OpenWA | `openwa-network` (externa, criada pelo compose do OpenWA) |
| Porta publicada | **nenhuma** por padrão; só `127.0.0.1` com `--profile debug` |
| Serviço alcançável em | `http://openwa-evo-api:8080` |

O OpenWA configura `EVOLUTION_GO_URL=http://openwa-evo-api:8080` e
`EVOLUTION_GO_CALLBACK_BASE_URL=http://openwa-api:2785` (o endereço pelo qual
**este** container alcança o OpenWA, usado no webhook e no host de mídia).

> Acesso externo, se algum dia for necessário, é por **túnel SSH** — nunca
> publicando a porta em `0.0.0.0`. Ver a memória global de padrão de túneis.

## Verificação de saúde

```bash
docker compose -f evolution-go/docker-compose.yml ps
docker inspect openwa-evo-api --format '{{.State.Health.Status}}'
docker logs --tail 100 openwa-evo-api
```

O healthcheck usa `/manager/login`, que responde sempre que o processo HTTP
está de pé. O Swagger do motor fica em `/swagger/index.html` (com o profile
debug) — é a fonte da verdade para o contrato que o adapter consome
(`GET /swagger/doc.json`).

## Upgrade de versão (cuidado)

A imagem está fixada por **digest** de propósito. Uma atualização silenciosa já
quebrou contrato no passado: o campo do QR mudou de `Qrcode` para `qrcode`
entre versões e o QR passou a voltar vazio sem erro nenhum.

Procedimento:

1. `docker pull evoapicloud/evolution-go:<nova-tag>` e anote o digest.
2. Leia o diff do contrato:
   ```bash
   docker run --rm --entrypoint cat evoapicloud/evolution-go:<nova-tag> /dev/null 2>/dev/null || true
   # suba uma instância de teste com a nova imagem e compare:
   curl -s http://127.0.0.1:7001/swagger/doc.json | python3 -m json.tool > /tmp/novo.json
   ```
   Compare com o contrato em uso: paths, campos de `MediaStruct`/`TextStruct`/
   `MessageInfo` e nomes de evento aceitos em `subscribe`.
3. Atualize o digest **e** o comentário de versão em `docker-compose.yml`.
4. Rode a suíte de integração do adapter (`npm test`) antes de subir para
   produção — os testes do adapter exercitam o contrato real.
5. Backup antes: `docker compose -f evolution-go/docker-compose.yml exec postgres pg_dumpall -U postgres > backup.sql`

## Backup

```bash
docker compose -f evolution-go/docker-compose.yml exec -T postgres \
  pg_dumpall -U "${EVO_POSTGRES_USER:-postgres}" > "evolution-go-backup-$(date +%F).sql"
```

O volume `openwa-evo-instances` guarda o estado das sessões pareadas. Os bancos
`evogo_auth`/`evogo_users` guardam o material de autenticação — trate o backup
como segredo (quem tiver o dump consegue assumir as contas pareadas).

## Rotacionar a GLOBAL_API_KEY

1. Gere a chave nova, atualize `EVOLUTION_GO_API_KEY` em `evolution-go/.env` **e**
   em `.env` do OpenWA (o mesmo valor nos dois).
2. `docker compose -f evolution-go/docker-compose.yml up -d` (recria o container).
3. `docker compose -f /root/TurboZap/GOpenWA/docker-compose.yml restart openwa-api`.

## Diagnóstico rápido

| Sintoma | Onde olhar |
|---|---|
| `/instance/all` devolve 401 | `apikey` errado — confira se o valor bate entre os dois `.env` |
| Sessão pareia mas não chega evento | `EVOLUTION_GO_CALLBACK_BASE_URL` precisa ser alcançável **de dentro** deste container (`http://openwa-api:2785`) |
| Envio de mídia retorna 200 e nada chega | O motor não conseguiu baixar a URL de mídia — mesmo teste de rede acima, mais `EVO_MAX_FILE_SIZE` |
| Instância fantasma no motor | Rode o reconciliador de órfãos do OpenWA, ou `DELETE /instance/delete/{id}` manualmente |
| Banco não sobe | `EVO_POSTGRES_PASSWORD` ausente — o compose falha de propósito (`:?`) |
