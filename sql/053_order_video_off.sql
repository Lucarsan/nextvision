-- Atendimento sem vídeo: quando a câmera da etapa já está com outro pet (ex.: duas tosadoras e uma
-- câmera), o operador pode iniciar este pedido sem vídeo. Ele segue as etapas normalmente, não grava
-- e não ocupa nem disputa câmera. Volta a false se o pedido retornar para a fila.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS video_off boolean NOT NULL DEFAULT false;
