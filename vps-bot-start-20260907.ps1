# ============================================================
# harvests IG bot — VPS 启动脚本
# 用途：RDP 到 VPS 后，用管理员 PowerShell 执行（逐段跑，看输出再继续）
# 背景：本机曾误起 bot_ig_01（已停），bot 必须只在 VPS 跑，避免同 BOT_ID 双实例
# ============================================================
$ErrorActionPreference = 'Continue'
$ENGINE      = 'C:\harvests\harvests-engine'
$PROFILE_DIR = 'C:\harvests\profiles\bot_ig_01'

Set-Location $ENGINE

# ---------- 0) 现状：确认 pm2 里只有一个 bot-worker ----------
pm2 list

# ---------- 1) 核对降频档位（关键） ----------
# 代码默认值仍是 4000ms / 15000ms（爆 D1 配额的旧档），20s/60s 只写在 ecosystem 里。
# 必须看到 20000 / 60000 才继续；否则先跑第 1b 段修复。
Select-String "$ENGINE\ecosystem.config.cjs" -Pattern "BOT_POLL_INTERVAL_MS|BOT_HEARTBEAT_INTERVAL_MS|BOT_DAILY_TASK_LIMIT|BOT_LAUNCH_MODE|BOT_CDP_URL|BOT_ACCOUNT_IDS"

# ---------- 1b) 仅当上面显示 4000 或 15000 时才执行这段修复 ----------
# $f = "$ENGINE\ecosystem.config.cjs"
# (Get-Content $f -Raw) `
#   -replace "BOT_POLL_INTERVAL_MS: '4000'", "BOT_POLL_INTERVAL_MS: '20000'" `
#   -replace "BOT_HEARTBEAT_INTERVAL_MS: '15000'", "BOT_HEARTBEAT_INTERVAL_MS: '60000'" |
#   Set-Content $f -Encoding UTF8
# Select-String $f -Pattern "BOT_POLL_INTERVAL_MS|BOT_HEARTBEAT_INTERVAL_MS"

# ---------- 2) 拉最新代码（.git 残缺会报错，可忽略继续） ----------
git pull

# ---------- Part A：起 bot 专用 Chrome（CDP 9222） ----------
# 注意：这一步会杀掉 VPS 上所有 Chrome，包括你手动开的窗口
taskkill /F /IM chrome.exe
Remove-Item "$PROFILE_DIR\SingletonLock","$PROFILE_DIR\SingletonCookie","$PROFILE_DIR\SingletonSocket" -Force -ErrorAction SilentlyContinue
Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" -ArgumentList '--remote-debugging-port=9222',"--user-data-dir=$PROFILE_DIR",'--no-first-run','--disable-gpu','--disable-dev-shm-usage','--remote-allow-origins=*'
Start-Sleep 5
Invoke-RestMethod http://127.0.0.1:9222/json/version    # 必须返回 webSocketDebuggerUrl，否则重跑本段

# ---------- Part A2：取关回收配置（.env） ----------
# 注：自动关注已由 ecosystem 的 BOT_FOLLOW_ENABLED=false 关闭（关注改手动），
#     BOT_FOLLOW_MAX_FOLLOWING 因此不再需要，仅保留取关回收来压低存量 following。
# bot 启动时 import 'dotenv/config'，会读 cwd\.env。
# 这些变量 ecosystem.config.cjs 里没有定义，所以 .env 生效（dotenv 不覆盖已有 env，故不会打架）。
$envLines = @(
  '# --- 取关回收：压低存量 following（2026-09-07）---',
  'BOT_UNFOLLOW_ENABLED=true',        # 打开关注回收（清存量 600+）
  'BOT_UNFOLLOW_DRY_RUN=true',        # 第一天先只采集+打印名单，不真取关；确认后改 false
  'BOT_UNFOLLOW_ORDER=desc',          # 粉丝多的先取关（小号互动好，尽量保留）
  'BOT_UNFOLLOW_GRACE_DAYS=14',       # 关注满 14 天未回关才动
  'BOT_UNFOLLOW_DAILY_MAX=50',        # 每日取关上限
  'BOT_UNFOLLOW_MIN_FOLLOWING=300',   # following 降到 300 以下自动停手
  'BOT_UNFOLLOW_CHECK_INTERVAL_MIN=30',
  'BOT_UNFOLLOW_KEEP_IF_ENGAGED=true',# 有过互动（回关/DM/赞过我们/评论过）的永不取关
  'BOT_FOLLOW_BACK_ENABLED=true',      # 回关独立开关：别人关注我们仍礼貌回关（不增 following）
  'BOT_FOLLOW_BACK_REQUIRE_TATTOO=true'# 回关行业审核：bio 判定 tattoo 相关才自动回关；false=无脑全回关
)
$envFile = "$ENGINE\.env"
if (Test-Path $envFile) {
  Copy-Item $envFile "$envFile.bak.$(Get-Date -Format yyyyMMddHHmmss)" -Force
  $existing = Get-Content $envFile | Where-Object { $_ -notmatch '^BOT_UNFOLLOW_|^BOT_FOLLOW_BACK_ENABLED' }
  ($existing + $envLines) | Set-Content $envFile -Encoding UTF8
} else {
  $envLines | Set-Content $envFile -Encoding UTF8
}
Get-Content $envFile | Select-String "BOT_UNFOLLOW|BOT_FOLLOW_BACK"

# ---------- Part B：起 bot-worker ----------
# 任务池当前 pending 308，暂不需要 ig-scheduler（其旧版连 Neon 会 402 报错循环）
pm2 delete bot-worker
pm2 start ecosystem.config.cjs --only "bot-worker"
pm2 save
pm2 list

# ---------- Part C：验证 ----------
Start-Sleep 25
Get-Content C:\harvests\logs\bot-worker-out.log -Tail 30 | Select-String "connected via CDP|login confirmed|execute|fatal"
# 健康判据：出现 "connected via CDP" 且随后有 "execute @handle"
# 只有 login confirmed、反复无 execute → 9222 没真正起来，回到 Part A
# 反复 starting with config + fatal d1_quota_exceeded → D1 配额爆，不是 Chrome 问题
