-- ============================================================
-- Migration 003: Bot Mimicry Configuration
--
-- 目的：Bot 休息期真人行为模拟的配置数据
-- 行为匹配 VPS IP (163.245.212.169 — New York City, NY)
--
-- 使用:
--   psql $DATABASE_URL -f sql/003_mimicry_config.sql
-- 或在 Neon Console → SQL Editor 逐段粘贴执行
-- ============================================================

-- 0. 扩展表（如果使用 bot_accounts 已有，确认字段存在）
ALTER TABLE bot_accounts ADD COLUMN IF NOT EXISTS mimicry_enabled BOOLEAN DEFAULT true;
ALTER TABLE bot_accounts ADD COLUMN IF NOT EXISTS mimicry_config JSONB DEFAULT '{}';

-- ============================================================
-- 1. 站点池 — 供 bot 休息时浏览
-- ============================================================
CREATE TABLE IF NOT EXISTS bot_mimicry_sites (
  id SERIAL PRIMARY KEY,
  url TEXT NOT NULL,
  label TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('news', 'social', 'shopping', 'entertainment', 'local')),
  country TEXT NOT NULL DEFAULT 'US',
  region TEXT DEFAULT 'NY',              -- 本地站点限定区域
  enabled BOOLEAN DEFAULT true,
  weight INTEGER DEFAULT 10,             -- 权重，越高越容易被选中
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mimicry_sites_enabled ON bot_mimicry_sites(enabled);

COMMENT ON TABLE bot_mimicry_sites IS 'Bot 休息期浏览的站点池，按纽约/US 定位';

-- 初始数据：纽约定位的站点
INSERT INTO bot_mimicry_sites (url, label, category, region, weight) VALUES
  -- News / Weather
  ('https://www.cnn.com', 'CNN', 'news', NULL, 10),
  ('https://www.foxnews.com', 'Fox News', 'news', NULL, 8),
  ('https://www.nytimes.com', 'NY Times', 'news', 'NY', 10),
  ('https://nypost.com', 'NY Post', 'news', 'NY', 8),
  ('https://weather.com/weather/today/l/10004', 'Weather NYC', 'news', 'NY', 10),
  ('https://www.amny.com', 'AM NY', 'news', 'NY', 7),

  -- Social
  ('https://www.reddit.com/r/nyc/', 'Reddit r/nyc', 'social', 'NY', 10),
  ('https://www.reddit.com/r/all/top/', 'Reddit All', 'social', NULL, 8),
  ('https://x.com', 'X/Twitter', 'social', NULL, 10),
  ('https://www.tumblr.com', 'Tumblr', 'social', NULL, 5),

  -- Shopping
  ('https://www.amazon.com', 'Amazon', 'shopping', NULL, 10),
  ('https://www.walmart.com', 'Walmart', 'shopping', NULL, 8),
  ('https://www.ebay.com', 'eBay', 'shopping', NULL, 7),
  ('https://www.target.com', 'Target', 'shopping', NULL, 8),

  -- Entertainment
  ('https://www.youtube.com', 'YouTube', 'entertainment', NULL, 10),
  ('https://www.twitch.tv/directory', 'Twitch Browse', 'entertainment', NULL, 6),
  ('https://www.tiktok.com', 'TikTok', 'entertainment', NULL, 9),

  -- Sports / Local NYC
  ('https://www.espn.com', 'ESPN', 'local', NULL, 8),
  ('https://www.nfl.com/teams/new-york-giants/', 'NY Giants', 'local', 'NY', 9),
  ('https://www.nba.com/knicks/', 'NY Knicks', 'local', 'NY', 8),
  ('https://new.mta.info', 'MTA NYC', 'local', 'NY', 7),
  ('https://www.timeout.com/newyork', 'Timeout NYC', 'local', 'NY', 8),
  ('https://www.nyc.gov', 'NYC Gov', 'local', 'NY', 5),
  ('https://www.yelp.com/search?find_desc=Restaurants&find_loc=New+York%2C+NY', 'Yelp NYC', 'local', 'NY', 7)
ON CONFLICT DO NOTHING;

-- ============================================================
-- 2. 搜索词库 — 休息时做 Google 搜索用
-- ============================================================
CREATE TABLE IF NOT EXISTS bot_mimicry_queries (
  id SERIAL PRIMARY KEY,
  query_text TEXT NOT NULL,
  category TEXT DEFAULT 'general',       -- general / local / shopping / howto
  enabled BOOLEAN DEFAULT true,
  weight INTEGER DEFAULT 10,
  created_at TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE bot_mimicry_queries IS 'Google 搜索词，模拟人类找东西';

INSERT INTO bot_mimicry_queries (query_text, category, weight) VALUES
  ('weather in new york city today', 'local', 10),
  ('best pizza near me', 'local', 10),
  ('nike outlet store', 'shopping', 8),
  ('how to fix a leaky faucet', 'howto', 7),
  ('nfl schedule 2026', 'general', 8),
  ('youtube trending', 'general', 9),
  ('amazon prime deals', 'shopping', 8),
  ('best coffee shops nyc', 'local', 10),
  ('nyc events this weekend', 'local', 9),
  ('giants schedule 2026', 'local', 8),
  ('how to make iced coffee', 'howto', 7),
  ('best air fryer 2026', 'shopping', 7),
  ('central park hours', 'local', 8),
  ('new york restaurants', 'local', 9),
  ('mta subway map', 'local', 8),
  ('iphone 17 price', 'shopping', 6),
  ('netflix new releases june 2026', 'general', 7),
  ('best wireless earbuds 2026', 'shopping', 6),
  ('how to tie a tie', 'howto', 5),
  ('times square events', 'local', 8),
  ('best burger nyc', 'local', 8),
  ('j crew sale', 'shopping', 5),
  ('how to lose weight fast', 'general', 6),
  ('what to do in nyc this weekend', 'local', 9)
ON CONFLICT DO NOTHING;

-- ============================================================
-- 3. 网页游戏 — 简单免登录的浏览器游戏
-- ============================================================
CREATE TABLE IF NOT EXISTS bot_mimicry_games (
  id SERIAL PRIMARY KEY,
  url TEXT NOT NULL,
  label TEXT NOT NULL,
  enabled BOOLEAN DEFAULT true,
  play_duration_min INTEGER DEFAULT 30,   -- 最少玩多少秒
  play_duration_max INTEGER DEFAULT 90,   -- 最多玩多少秒
  created_at TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE bot_mimicry_games IS '休息时可玩的网页小游戏';

INSERT INTO bot_mimicry_games (url, label, play_duration_min, play_duration_max) VALUES
  ('https://play2048.co/', '2048', 30, 120),
  ('https://www.nytimes.com/puzzles/wordle', 'Wordle', 30, 90),
  ('https://sudoku.com', 'Sudoku', 60, 180),
  ('https://www.nytimes.com/puzzles/spelling-bee', 'Spelling Bee', 60, 180),
  ('https://gabrielecirulli.github.io/2048/', '2048 Classic', 30, 120)
ON CONFLICT DO NOTHING;

-- ============================================================
-- 4. 行为配置 — 每个 bot 账号可单独调参
-- ============================================================
CREATE TABLE IF NOT EXISTS bot_mimicry_config (
  id SERIAL PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES bot_accounts(account_id) ON DELETE CASCADE,
  enabled BOOLEAN DEFAULT true,
  max_tabs INTEGER DEFAULT 4,             -- 最多同时开几个标签页
  google_search_chance REAL DEFAULT 0.7,  -- 每轮休息搜一次的概率
  game_chance REAL DEFAULT 0.4,           -- 每轮休息玩游戏的概率
  click_link_chance REAL DEFAULT 0.3,     -- 页面内点链接概率
  scroll_min_px INTEGER DEFAULT 200,
  scroll_max_px INTEGER DEFAULT 1500,
  dwell_min_ms INTEGER DEFAULT 3000,      -- 最小停留毫秒
  dwell_max_ms INTEGER DEFAULT 25000,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE bot_mimicry_config IS '每个 bot 账号的休息行为参数';

-- 为已有账号插入默认配置
INSERT INTO bot_mimicry_config (account_id)
SELECT account_id FROM bot_accounts
ON CONFLICT DO NOTHING;

-- ============================================================
-- 5. 行为日志 — 记录休息时干了什么
-- ============================================================
CREATE TABLE IF NOT EXISTS bot_mimicry_logs (
  id SERIAL PRIMARY KEY,
  account_id TEXT REFERENCES bot_accounts(account_id),
  action_type TEXT NOT NULL,              -- 'browse' / 'search' / 'game' / 'cleanup'
  site_url TEXT,
  site_label TEXT,
  duration_seconds INTEGER,              -- 在该站停留秒数
  page_closed INTEGER DEFAULT 0,         -- 清理时关了多少页
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mimicry_logs_account ON bot_mimicry_logs(account_id, created_at DESC);

COMMENT ON TABLE bot_mimicry_logs IS 'Bot 休息行为记录，用于分析优化';

-- ============================================================
-- 完成
-- ============================================================
SELECT '✅ Migration 003 complete: bot_mimicry tables created'
  AS status;
