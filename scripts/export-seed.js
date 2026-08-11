import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'supabase-seed.sql');

const sql = `-- =====================================================================
--  CODER ASSISTANT — Supabase Seed
--  Pegar en: Supabase Dashboard → SQL Editor → New query → Run
-- =====================================================================


-- ── 1. CONFIGURACIÓN / PERSONALIDAD ──────────────────────────────────
CREATE TABLE IF NOT EXISTS coder_config (
  id            INTEGER PRIMARY KEY,
  system_prompt TEXT    NOT NULL,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Borrar fila anterior y reinsertar para evitar duplicados
DELETE FROM coder_config WHERE id = 1;

INSERT INTO coder_config (id, system_prompt) VALUES (1,
$$Sos Coder, el asistente personal de Joshua Zet.

PERSONALIDAD
- Hablás en español rioplatense: usás "vos", "che", "dale", "buenísimo".
- Sos directo, concreto e inteligente — no das rodeos.
- Tenés sentido del humor seco; no hacés chistes forzados.
- Cuando Joshua comparte algo técnico, respondés a su nivel, sin explicar lo obvio.
- Si no sabés algo, lo decís sin drama.

ROL
- Ayudás a Joshua a organizarse, pensar proyectos, debuggear ideas y ejecutar tareas.
- Recordás información sobre sus proyectos, clientes y preferencias de desarrollo.
- Cuando Joshua menciona algo importante y duradero, lo guardás con la herramienta guardar_hecho.

ESTILO DE RESPUESTA
- Respuestas cortas por defecto; desarrollás solo cuando hace falta.
- Preferís ejemplos concretos sobre teoría abstracta.
- Nunca repetís lo que Joshua dijo como introducción. Respondés directo.$$
);


-- ── 2. HECHOS RECORDADOS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coder_facts (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  category   TEXT        NOT NULL,
  content    TEXT        NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Datos de prueba
INSERT INTO coder_facts (category, content) VALUES
  ('perfil',          'Joshua Zet es desarrollador independiente y fundador de JZet Labs.'),
  ('perfil',          'Trabaja principalmente con Node.js, React y Supabase.'),
  ('proyectos',       'Coder es su asistente personal de voz, construido con Gemini Live.'),
  ('dev_preferences', 'Prefiere código limpio y sin comentarios innecesarios.'),
  ('dev_preferences', 'Usa español rioplatense en sus proyectos y comunicaciones.'),
  ('ventas_jzet_labs', 'JZet Labs ofrece desarrollo de software a medida para PYMES.');


-- ── 3. RESÚMENES DE CONVERSACIONES ───────────────────────────────────
CREATE TABLE IF NOT EXISTS coder_conversation_summaries (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  summary    TEXT        NOT NULL,
  topics     TEXT[]      DEFAULT '{}',
  started_at TIMESTAMPTZ,
  ended_at   TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);


-- ── 4. RECORDATORIOS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coder_reminders (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  mensaje    TEXT        NOT NULL,
  fecha_hora TIMESTAMPTZ NOT NULL,
  notificado BOOLEAN     DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);


-- ── 5. HABILITAR RLS (Row Level Security) ────────────────────────────
-- Por ahora acceso libre; ajustá las políticas según tu caso de uso.
ALTER TABLE coder_config                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE coder_facts                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE coder_conversation_summaries  ENABLE ROW LEVEL SECURITY;
ALTER TABLE coder_reminders               ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "anon_all_config"
  ON coder_config FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY IF NOT EXISTS "anon_all_facts"
  ON coder_facts FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY IF NOT EXISTS "anon_all_summaries"
  ON coder_conversation_summaries FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY IF NOT EXISTS "anon_all_reminders"
  ON coder_reminders FOR ALL TO anon USING (true) WITH CHECK (true);


-- ── LISTO ─────────────────────────────────────────────────────────────
-- Verificá con:
--   SELECT * FROM coder_config;
--   SELECT * FROM coder_facts;
--   SELECT * FROM coder_reminders;
`;

writeFileSync(OUT, sql, 'utf8');
console.log('Archivo generado: supabase-seed.sql');
console.log('Abrilo, copiá todo y pegalo en Supabase → SQL Editor → Run.');
