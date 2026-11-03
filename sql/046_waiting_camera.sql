-- Área de espera: câmera que mostra os pets (ou itens) na fila. Todos os pedidos da loja que
-- estão na fila veem essa câmera no link, junto com a posição na fila. Escolhida pelo dono.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS waiting_camera_id uuid REFERENCES cameras(id) ON DELETE SET NULL;
