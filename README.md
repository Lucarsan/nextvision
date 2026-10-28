# NextVision

Plataforma SaaS multi-tenant para acompanhamento visual de serviços e pedidos.

## Arquitetura
- API: Node.js + Express
- Banco: PostgreSQL (Neon)
- Hospedagem: Render
- Streaming: gateway local por loja + servidor de mídia separado (a definir)
- Interfaces: painel Master, painel da loja, link público do pedido

## Estado
Repositório iniciado. O protótipo HTML original ainda é demonstrativo. Backend, banco e autenticação precisam ser provisionados e testados antes da produção. O streaming não deve usar diretamente IP privado da câmera em Render.

## Segurança e implantação
Nunca incluir `DATABASE_URL`, senhas de câmeras, RTSP ou segredos no Git. Configure variáveis no Render. Use HTTPS, isolamento por tenant, tokens públicos aleatórios e controle de acesso. A integração financeira deve validar webhooks assinados; não marcar faturas como pagas somente por ação do navegador.

## Próximas integrações
Neon, Render, gateway ONVIF/RTSP, armazenamento de vídeos, provedor WhatsApp e pagamento.
