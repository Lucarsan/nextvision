# TEF Stone (AutoTEF) no caixa do quiosque

Documentação da Stone: https://autotef.readme.io (conferida em 25/11/2026).

## Como funciona

```
Caixa (navegador, audace.ficoupronto.com)
  1. POST /api/store/tef/transactions      → servidor guarda a cobrança como "pending"
  2. POST http://127.0.0.1:8000/api/Pay    → AutoTEF Slim → pinpad PPC930 → Stone
  3. POST /api/store/tef/transactions/:id/result  (resposta do Slim, como veio; o servidor interpreta)
  4. POST /api/store/sales com tef_transaction_ids
```

- A cobrança fica registrada **antes** de ir ao pinpad. Se o navegador cair, se a venda não gravar ou se o valor mudar, a cobrança aparece em **Pendências do pinpad**, no caixa. Lá dá para estornar ou marcar como resolvida depois de conferir no app da Stone.
- A venda só grava com uma cobrança **aprovada**, da mesma unidade, sem outra venda ligada a ela e com o **mesmo valor e a mesma forma de pagamento**.
- Com o TEF ligado, o quiosque não grava venda no cartão ou no Pix sem cobrança do pinpad. A exceção é a opção "Pinpad fora do ar", que vai para a maquininha avulsa e deixa a venda pendente de ECONF.
- Cancelar uma venda paga no pinpad abre o estorno, que precisa do mesmo cartão. Até o estorno ser feito, a cobrança fica nas pendências.
- O Pix é devolvido pelo app da Stone. A documentação do AutoTEF não mostra estorno de Pix pelo pinpad.
- **NFC-e** (IN 87/2025): a venda guarda em `sales.tef` o CNPJ da Stone (16.501.555/0001-57), a bandeira (tBand), a autorização (no Pix, o endToEndId) e o terminal (número de série do pinpad que a ativação devolve).

## Modos por unidade (Central → Redes → Pinpad Stone)

| Modo | Para quê |
| --- | --- |
| Desligado | Como hoje: maquininha avulsa. |
| Simulador | Treino e testes, sem a Stone. Não cobra e **nunca vira NFC-e**. Centavos finais: **,51** recusa, **,52** erro, **,53** sem resposta, **,61** Pix expira. |
| Teste Stone (sandbox) | Stone Code de teste e Slim com `IsProd: false`. |
| Produção | Stone Code real da conta da unidade e Slim com `IsProd: true`, depois da homologação. |

## Instalar no PC do quiosque (quando a Stone liberar)

1. Pinpad PPC930 no USB. Ele está na lista de dispositivos do AutoTEF, mas precisa do **kernel 2.12**: confirmar com a Stone.
2. Instalar o Slim com `InstallWindows.ps1`. O script instala o .NET 6, se faltar, e roda o Slim como serviço do Windows em `http://localhost:8000`.
3. No `appsettings.json` do Slim:
   ```json
   { "Settings": { "IsPdv": true, "IsProd": false, "HasSplit": false, "UpdateSchedule": "0 0 * * 1" } }
   ```
   Depois de alterar o arquivo, reiniciar o Slim.
4. Na central, colocar a unidade em "Teste Stone (sandbox)", com o Stone Code de teste e a porta do pinpad (ex.: `COM4`).
5. Abrir o caixa e vender R$ 1,00 no débito.

## Ainda não confirmado (testar no PC real com o Slim)

- **O navegador consegue chamar o Slim?** A página `https://audace.ficoupronto.com` chama `http://127.0.0.1:8000`, e para isso o Slim precisa responder com CORS. O Chrome também pode pedir uma vez a permissão de "acesso à rede local". A documentação não fala de CORS. Se o Slim não liberar, a saída é uma ponte local no agente FicouPronto: o navegador chama a ponte, e a ponte repassa ao Slim e devolve com CORS só para o domínio da rede. O cliente do caixa já aceita outro endereço em "Endereço do Slim", então a ponte entra sem mudar o caixa.
- **Valor na resposta do cartão:** o exemplo da documentação manda `11.00` e devolve `amount: 11`, então pode estar em reais ou em centavos. O servidor não usa esse campo; vale o valor registrado antes do pinpad.
- **Pix/Status:** a documentação diz que a rota "faz polling internamente". O caixa repete a consulta até o Pix ser pago ou expirar (5 minutos + margem).
- **Parcelado:** usa `installment.type = 2` (lojista, sem juros). Confirmar com a Stone se é preciso habilitar.
- **Bandeiras (tBand):** os códigos 01 a 09 e 99 são estáveis. Os outros (Alelo, Discover, JCB, Sodexo, VR, Ticket) precisam ser conferidos com o emissor na homologação.
- A Stone manda o **roteiro de testes** de homologação depois do desenvolvimento.

## Arquivos

- `sql/093_autotef.sql`: modo e Stone Code por unidade, e a tabela `tef_transactions`.
- `src/tef.js`: rotas e interpretação das respostas do Slim.
- `public/tef-client.js`: cliente do Slim e simulador no navegador.
- `public/caixa.html`: cobrança ao finalizar, QR do Pix, parcelas e pendências.
- `public/central-tef.js`: configuração na central.
- Testes: `test/tef.test.js`, `test/tef.integration.test.js` e `test/tef-caixa-panel.integration.test.js`. Este último abre o caixa no Chrome com o simulador.
