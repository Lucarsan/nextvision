# NextVision

Plataforma SaaS multi-tenant para acompanhamento visual de serviços e pedidos.

## Arquitetura
- API: Node.js + Express
- Banco: PostgreSQL (Neon)
- Hospedagem: Render
- Streaming: acesso remoto direto à câmera via NVR/ONVIF/RTSP, condicionado a comprovar conectividade segura a partir do servidor; sem gateway local
- Interfaces: painel Master, painel da loja, link público do pedido

## Estado
Repositório iniciado. O protótipo HTML original ainda é demonstrativo. Backend, banco e autenticação precisam ser provisionados e testados antes da produção. O streaming não consegue usar um IP privado da câmera diretamente a partir do Render. Validar primeiro conectividade remota do modelo Yoosee LEY-19, sem exposição insegura de portas.

## Segurança e implantação
Nunca incluir `DATABASE_URL`, senhas de câmeras, RTSP ou segredos no Git. Configure variáveis no Render. Use HTTPS, isolamento por tenant, tokens públicos aleatórios e controle de acesso. A integração financeira deve validar webhooks assinados; não marcar faturas como pagas somente por ação do navegador.

## Próximas integrações
Neon, Render, conectividade remota NVR/ONVIF/RTSP da LEY-19, armazenamento de vídeos, provedor WhatsApp e pagamento.
