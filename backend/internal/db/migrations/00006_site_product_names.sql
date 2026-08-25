-- +goose Up
-- Two things were wrong with the site board's identity columns.
--
-- The name was whoever's deployment the loop ran against — "Dify Studio
-- (self-hosted)", "n8n (self-hosted editor, jjcm/n8n fork)", "Langflow (fork)"
-- — so the board read as one person's infrastructure instead of a list of
-- products. Ingest now reduces a submitted name to the product
-- (internal/leaderboard/sitename.go); this brings the rows submitted before
-- that onto the same footing.
--
-- And nothing linked to the work. Every one of these runs was opened as a pull
-- request against a fork, so pr_url (migration 00005) gets the one each row was
-- measured from, and the board links the site name to it.
--
-- Matched on url plus the name as stored today, so a row someone has renamed by
-- hand since is left alone. Names, counts, metrics and modes are otherwise
-- untouched; both the cold and the warm row of a site are matched by url and
-- move together.

CREATE TEMPORARY TABLE site_product_names (
  url      VARCHAR(253) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  old_name VARCHAR(80)  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  new_name VARCHAR(80)  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  pr_url   VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (url, old_name)
) ENGINE = InnoDB;

-- Every row of GET /data/sites.json as of 2026-08-25 that changes. Two live
-- rows are deliberately absent: dave.com ("Legend of Dave") and new.opencut.app
-- ("OpenCut") are already named after their product and have no pull request on
-- record, so there is nothing to write. All of these are snapshotted in
-- backend/testdata/site_names.json, which is what the Down below restores from.
INSERT INTO site_product_names (url, old_name, new_name, pr_url) VALUES
  ('github.com',         'Langflow (fork)',                         'Langflow', 'https://github.com/jjcm/langflow/pull/1'),
  ('prompts.chat',       'prompts.chat',                            'prompts.chat', 'https://github.com/jjcm/prompts.chat/pull/1'),
  ('excalidraw.com',     'Excalidraw',                              'Excalidraw', 'https://github.com/jjcm/excalidraw/pull/1'),
  ('dify.ai',            'Dify Studio (self-hosted)',               'Dify', 'https://github.com/jjcm/dify/pull/1'),
  ('roadmap.sh',         'roadmap.sh',                              'roadmap.sh', 'https://github.com/jjcm/developer-roadmap/pull/1'),
  ('n8n.io',             'n8n (self-hosted editor, jjcm/n8n fork)', 'n8n', 'https://github.com/jjcm/n8n/pull/1'),
  ('freecodecamp.org',   'freeCodeCamp',                            'freeCodeCamp', 'https://github.com/jjcm/freeCodeCamp/pull/1'),
  ('app.nextchat.club',  'NextChat',                                'NextChat', 'https://github.com/jjcm/NextChat/pull/1'),
  ('uptime.kuma.pet',    'Uptime Kuma (self-hosted dashboard)',     'Uptime Kuma', 'https://github.com/jjcm/uptime-kuma/pull/1'),
  ('ragflow.io',         'RAGFlow',                                 'RAGFlow', 'https://github.com/jjcm/ragflow/pull/1'),
  ('immich.app',         'Immich',                                  'Immich', 'https://github.com/jjcm/immich/pull/1'),
  ('home-assistant.io',  'Home Assistant',                          'Home Assistant', 'https://github.com/jjcm/home-assistant/pull/1'),
  ('stirlingpdf.com',    'Stirling PDF',                            'Stirling PDF', 'https://github.com/jjcm/Stirling-PDF/pull/1');

-- A pull request someone has already recorded wins over the backfill; the name
-- is authoritative because the match was on the old one.
UPDATE sites s
JOIN site_product_names m ON m.url = s.url AND m.old_name = s.name
SET s.name = m.new_name,
    s.pr_url = IF(s.pr_url = '', m.pr_url, s.pr_url);

DROP TEMPORARY TABLE site_product_names;

-- ComfyUI, Open WebUI and A1111 were expected on the board but had not landed
-- when this was written, and their hostnames are not something to guess. They
-- are matched on the product name instead, wherever they turn up, and every
-- statement is a no-op until they do. Nothing here can create a row.
UPDATE sites SET name = 'ComfyUI', pr_url = 'https://github.com/jjcm/ComfyUI/pull/1'
WHERE name LIKE 'ComfyUI%' AND pr_url = '';

UPDATE sites SET name = 'Open WebUI', pr_url = 'https://github.com/jjcm/open-webui/pull/1'
WHERE (name LIKE 'Open WebUI%' OR name LIKE 'Open-WebUI%') AND pr_url = '';

UPDATE sites SET name = 'A1111', pr_url = 'https://github.com/jjcm/stable-diffusion-webui/pull/1'
WHERE (name LIKE 'A1111%' OR name LIKE 'AUTOMATIC1111%') AND pr_url = '';

-- Anything else that lands between this migration being written and deployed
-- gets the same treatment as the rows above, for the one case SQL can read
-- safely: a parenthetical that describes a deployment rather than a product.
-- A parenthetical without one of those words is left alone, because it might be
-- part of the name.
UPDATE sites
SET name = TRIM(REGEXP_REPLACE(name, '[[:space:]]*\\([^)]*(fork|self-hosted|selfhosted|self hosted|jjcm|dashboard|editor)[^)]*\\)', ''))
WHERE name REGEXP '\\([^)]*(fork|self-hosted|selfhosted|self hosted|jjcm|dashboard|editor)[^)]*\\)';

-- +goose Down
-- Reversible: the name each row carried is snapshotted here, so rolling back
-- restores it on any row still holding the product name this wrote, and clears
-- only the pull request this wrote. The table is spelled out a second time
-- because goose runs the two directions as separate sessions.

CREATE TEMPORARY TABLE site_product_names (
  url      VARCHAR(253) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  old_name VARCHAR(80)  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  new_name VARCHAR(80)  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  pr_url   VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (url, old_name)
) ENGINE = InnoDB;

INSERT INTO site_product_names (url, old_name, new_name, pr_url) VALUES
  ('github.com',         'Langflow (fork)',                         'Langflow', 'https://github.com/jjcm/langflow/pull/1'),
  ('prompts.chat',       'prompts.chat',                            'prompts.chat', 'https://github.com/jjcm/prompts.chat/pull/1'),
  ('excalidraw.com',     'Excalidraw',                              'Excalidraw', 'https://github.com/jjcm/excalidraw/pull/1'),
  ('dify.ai',            'Dify Studio (self-hosted)',               'Dify', 'https://github.com/jjcm/dify/pull/1'),
  ('roadmap.sh',         'roadmap.sh',                              'roadmap.sh', 'https://github.com/jjcm/developer-roadmap/pull/1'),
  ('n8n.io',             'n8n (self-hosted editor, jjcm/n8n fork)', 'n8n', 'https://github.com/jjcm/n8n/pull/1'),
  ('freecodecamp.org',   'freeCodeCamp',                            'freeCodeCamp', 'https://github.com/jjcm/freeCodeCamp/pull/1'),
  ('app.nextchat.club',  'NextChat',                                'NextChat', 'https://github.com/jjcm/NextChat/pull/1'),
  ('uptime.kuma.pet',    'Uptime Kuma (self-hosted dashboard)',     'Uptime Kuma', 'https://github.com/jjcm/uptime-kuma/pull/1'),
  ('ragflow.io',         'RAGFlow',                                 'RAGFlow', 'https://github.com/jjcm/ragflow/pull/1'),
  ('immich.app',         'Immich',                                  'Immich', 'https://github.com/jjcm/immich/pull/1'),
  ('home-assistant.io',  'Home Assistant',                          'Home Assistant', 'https://github.com/jjcm/home-assistant/pull/1'),
  ('stirlingpdf.com',    'Stirling PDF',                            'Stirling PDF', 'https://github.com/jjcm/Stirling-PDF/pull/1');

UPDATE sites s
JOIN site_product_names m ON m.url = s.url AND m.new_name = s.name
SET s.name = m.old_name,
    s.pr_url = IF(s.pr_url = m.pr_url, '', s.pr_url);

DROP TEMPORARY TABLE site_product_names;
