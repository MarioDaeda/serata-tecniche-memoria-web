-- =============================================================================
-- Serata Tecniche di Memoria — Setup Database Neon Postgres (Postgres 17)
-- =============================================================================
-- PREREQUISITO NEON CONSOLE:
--   Abilita prima "Data API" e "Neon Auth (Anonymous)" nel tuo progetto Neon,
--   in modo che i ruoli `anonymous` e `authenticated` siano già presenti.
--
-- ⚠️ ATTENZIONE SICUREZZA:
--   SOSTITUISCI '1234' QUI SOTTO CON IL TUO PIN PERSONALE PRIMA DI ESEGUIRE!
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Schema privato NON esposto dalla Neon Data API (solo funzioni SECURITY DEFINER)
CREATE SCHEMA IF NOT EXISTS app_private;

CREATE TABLE IF NOT EXISTS app_private.settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ⚠️ SOSTITUISCI '1234' CON IL TUO PIN PERSONALE PRIMA DI ESEGUIRE
INSERT INTO app_private.settings (key, value)
VALUES ('dashboard_pin_hash', crypt('1234', gen_salt('bf')))
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value,
    updated_at = now();

-- Tabella pubblica per le consegne dei partecipanti (solo INSERT per anonymous/authenticated)
CREATE TABLE IF NOT EXISTS public.test_submissions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  session_code          text NOT NULL CHECK (char_length(trim(session_code)) BETWEEN 1 AND 64),
  test_id               text NOT NULL CHECK (test_id IN ('A', 'B')),
  round_num             integer NOT NULL CHECK (round_num IN (1, 2, 3)),
  mode                  text NOT NULL CHECK (mode IN ('full', 'recall')),
  participant_id        text NOT NULL CHECK (char_length(trim(participant_id)) BETWEEN 1 AND 100),
  nickname              text NOT NULL DEFAULT '' CHECK (char_length(nickname) <= 80),
  category              text NOT NULL CHECK (category IN ('weekend', 'mesi_fa', 'nessun_corso')),
  score_total           numeric(6,2) NOT NULL CHECK (score_total >= 0 AND score_total <= 100),
  max_total             numeric(6,2) NOT NULL CHECK (max_total > 0 AND max_total <= 100),
  pct_total             numeric(5,2) NOT NULL CHECK (pct_total >= 0 AND pct_total <= 100),
  score_recall          numeric(6,2) NOT NULL CHECK (score_recall >= 0 AND score_recall <= 100),
  max_recall            numeric(6,2) NOT NULL CHECK (max_recall >= 0 AND max_recall <= 100),
  pct_recall            numeric(5,2) NOT NULL CHECK (pct_recall >= 0 AND pct_recall <= 100),
  score_comprehension   numeric(6,2) NOT NULL CHECK (score_comprehension >= 0 AND score_comprehension <= 100),
  max_comprehension     numeric(6,2) NOT NULL CHECK (max_comprehension >= 0 AND max_comprehension <= 100),
  pct_comprehension     numeric(5,2) NOT NULL CHECK (pct_comprehension >= 0 AND pct_comprehension <= 100),
  vocab_known_count     integer NOT NULL DEFAULT 0 CHECK (vocab_known_count BETWEEN 0 AND 20),
  vocab_new_correct     numeric(6,2) NOT NULL DEFAULT 0 CHECK (vocab_new_correct >= 0 AND vocab_new_correct <= 20),
  vocab_new_total       integer NOT NULL DEFAULT 20 CHECK (vocab_new_total BETWEEN 0 AND 20),
  digits_shift_detected boolean NOT NULL DEFAULT false,
  section_scores        jsonb NOT NULL DEFAULT '{}'::jsonb,
  duration_seconds      integer NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0 AND duration_seconds <= 86400)
);

CREATE INDEX IF NOT EXISTS idx_test_submissions_session_round_cat
  ON public.test_submissions (session_code, round_num, category);

CREATE INDEX IF NOT EXISTS idx_test_submissions_created_at
  ON public.test_submissions (created_at DESC);

-- =============================================================================
-- Sicurezza & Row-Level Security (RLS)
-- =============================================================================

ALTER TABLE public.test_submissions ENABLE ROW LEVEL SECURITY;

-- Protezione totale sullo schema privato
REVOKE ALL ON SCHEMA app_private FROM PUBLIC, anonymous, authenticated;
REVOKE ALL ON TABLE app_private.settings FROM PUBLIC, anonymous, authenticated;

-- Permessi minimi necessari su schema public e tabella consegne (NO SELECT diretto!)
GRANT USAGE ON SCHEMA public TO anonymous, authenticated;
REVOKE ALL ON TABLE public.test_submissions FROM PUBLIC, anonymous, authenticated;
GRANT INSERT ON TABLE public.test_submissions TO anonymous, authenticated;

-- Policy RLS: i partecipanti possono SOLO inserire la propria consegna,
-- nessuna policy SELECT/UPDATE/DELETE è concessa ad anonymous/authenticated.
DROP POLICY IF EXISTS allow_anonymous_insert_submissions ON public.test_submissions;
CREATE POLICY allow_anonymous_insert_submissions
  ON public.test_submissions
  FOR INSERT
  TO anonymous, authenticated
  WITH CHECK (
    category IN ('weekend', 'mesi_fa', 'nessun_corso')
    AND test_id IN ('A', 'B')
    AND round_num IN (1, 2, 3)
    AND mode IN ('full', 'recall')
    AND max_total > 0 AND max_total <= 100
    AND score_total >= 0 AND score_total <= max_total
    AND pct_total >= 0 AND pct_total <= 100
    AND score_recall >= 0 AND score_recall <= max_recall
    AND score_comprehension >= 0 AND score_comprehension <= max_comprehension
  );

-- =============================================================================
-- Funzioni RPC protette da PIN formatore (SECURITY DEFINER)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.verify_dashboard_pin(p_pin text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app_private, extensions
AS $$
DECLARE
  v_hash text;
BEGIN
  IF p_pin IS NULL OR length(trim(p_pin)) = 0 THEN
    RETURN false;
  END IF;

  SELECT value
  INTO v_hash
  FROM app_private.settings
  WHERE key = 'dashboard_pin_hash';

  IF v_hash IS NULL THEN
    RETURN false;
  END IF;

  RETURN crypt(p_pin, v_hash) = v_hash;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_dashboard_data(
  p_pin text,
  p_session text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app_private, extensions
AS $$
DECLARE
  v_clean_session text;
  v_sessions jsonb;
  v_submissions jsonb;
BEGIN
  IF NOT public.verify_dashboard_pin(p_pin) THEN
    RAISE EXCEPTION 'Accesso negato: PIN formatore non valido'
      USING ERRCODE = '42501';
  END IF;

  v_clean_session := NULLIF(upper(trim(COALESCE(p_session, ''))), '');
  IF v_clean_session = 'ALL' THEN
    v_clean_session := NULL;
  END IF;

  SELECT COALESCE(
    jsonb_agg(s.session_code ORDER BY s.session_code),
    '[]'::jsonb
  )
  INTO v_sessions
  FROM (
    SELECT DISTINCT upper(trim(session_code)) AS session_code
    FROM public.test_submissions
  ) s;

  SELECT COALESCE(
    jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC),
    '[]'::jsonb
  )
  INTO v_submissions
  FROM (
    SELECT
      id,
      created_at,
      session_code,
      test_id,
      round_num,
      mode,
      participant_id,
      nickname,
      category,
      score_total,
      max_total,
      pct_total,
      score_recall,
      max_recall,
      pct_recall,
      score_comprehension,
      max_comprehension,
      pct_comprehension,
      vocab_known_count,
      vocab_new_correct,
      vocab_new_total,
      digits_shift_detected,
      section_scores,
      duration_seconds
    FROM public.test_submissions
    WHERE v_clean_session IS NULL
       OR upper(trim(session_code)) = v_clean_session
  ) t;

  RETURN jsonb_build_object(
    'sessions', v_sessions,
    'submissions', v_submissions
  );
END;
$$;

REVOKE ALL ON FUNCTION public.verify_dashboard_pin(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_dashboard_data(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_dashboard_pin(text) TO anonymous, authenticated;
GRANT EXECUTE ON FUNCTION public.get_dashboard_data(text, text) TO anonymous, authenticated;
