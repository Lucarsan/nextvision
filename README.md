# NextVision — MVP no GitHub

Aplicação SaaS multi-tenant para acompanhamento de pedidos de lojas e serviços.

## Arquivos
- `src/server.js`: API Express, autenticação JWT, lojas, usuários, câmeras, clientes, processos, pedidos e rastreio público.
- `src/db.js`, `src/migrate.js`, `src/bootstrap.js`: PostgreSQL, migração e criação inicial do master.
- `sql/001_init.sql`: estrutura do banco.
- `public/index.html`, `public/app.js`, `public/ui.css`: painel web Master e Loja.
- `public/tracking.html`: acompanhamento do cliente por token.
- `render.yaml`: configuração inicial do serviço no Render.

## Configuração
```bash
npm install
cp .env.example .env
# configure DATABASE_URL, JWT_SECRET, BOOTSTRAP_ADMIN_EMAIL e BOOTSTRAP_ADMIN_PASSWORD
npm run db:migrate
npm run db:bootstrap
npm start
```

Abra `http://localhost:3000`. No Render, conecte o repositório e configure os segredos. O banco Neon ainda precisa ser provisionado e migrado.

## Limitações
Esta é uma **primeira base de desenvolvimento, ainda não validada em produção**. Falta testar integração real com PostgreSQL, verificar permissões e cenários de erro, implantar em Render, provisionar Neon, integração de pagamentos e webhooks, envio WhatsApp/e-mail, recuperação de conta, cookies seguros de autenticação, monitoramento e LGPD.

**Integração das câmeras Yoosee LEY-19 ainda não existe.** A conexão NVR liberada no app é local (LAN), e o método remoto seguro não foi validado. Não incluir URL RTSP com senha no banco nem no navegador. O streaming e gravações serão integrados posteriormente sem gateway local, caso haja conectividade remota segura.

Nenhuma credencial deve ser versionada. O cadastro da câmera no MVP é apenas cadastral; não indica vídeo online.
