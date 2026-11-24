-- Meta do mês da rede toda (as metas de unidade e de vendedora continuam em store_goals).
-- Sem meta nova, vale a do mês anterior; 0 = sem meta a partir do mês.
CREATE TABLE IF NOT EXISTS network_goals (
  network_id uuid NOT NULL REFERENCES store_networks(id) ON DELETE CASCADE,
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  target_cents integer NOT NULL CHECK (target_cents BETWEEN 0 AND 2000000000),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network_id, month)
);
