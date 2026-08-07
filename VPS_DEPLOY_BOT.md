# VPS 部署 bot-worker（Windows VPS + 已有 IG profile）

> 目标：让 bot 在 VPS 常驻，用已登录 raiha8833 IG 的 profile 去点赞/评论/关注，
> 消费 automation_tasks 队列里的 ig_browse 任务，慢慢引流。
> 本文件基于 2026-08-06 本机实测通过的配置整理。

## 0. 前置确认（VPS 上）

```powershell
# 1) engine 目录在哪（ecosystem 用相对路径，无所谓，clone 到哪都能跑）
cd C:\harvests-engine        # 举例；按你实际路径改

# 2) 依赖确认（首次）
npm install tsx --save-dev
npm install playwright        # bot 用 node playwright 起浏览器

# 3) IG 登录 profile 确认（关键！）
dir C:\harvests\profiles\bot_ig_01   # 应能看到 Default/ 等 Chrome profile 内容
#    如果 VPS 上 profile 不在这个路径，改 ecosystem.config.cjs 里 BOT_PROFILE_DIR

# 4) node.exe 在 PATH（Windows 上 ecosystem 用 interpreter: 'node.exe'）
node -v
```

## 1. 同步修复过的文件（从本机推 VPS）

必须同步（含 2026-08-06 关键修复）：

| 文件 | 修复内容 |
|---|---|
| `scripts/bot-worker-real.ts` | **删掉了重复的 `const sleep` 声明**（原来启动即崩：`The symbol "sleep" has already been declared`）。VPS 用旧文件必崩，必须用这份 |
| `scripts/comment-generator.ts` | bot 评论文案生成依赖 |
| `ecosystem.config.cjs` | BOT_API_BASE 改为 pages.dev（workers.dev 国内被墙）；**新增 BOT_FOLLOW_ENABLED=true**（关注 2-6/天，需 2 次访问后才关注）；profile 路径 `C:\harvests\profiles\bot_ig_01` |

```powershell
# 本机执行（Windows 可用 scp 或直接拷）
scp "F:/inkflow app/InkFlow_Project/harvests-engine/scripts/bot-worker-real.ts"  user@vps:C:/harvests-engine/scripts/
scp "F:/inkflow app/InkFlow_Project/harvests-engine/scripts/comment-generator.ts" user@vps:C:/harvests-engine/scripts/
scp "F:/inkflow app/InkFlow_Project/harvests-engine/ecosystem.config.cjs"        user@vps:C:/harvests-engine/
```

## 2. 启动（VPS 上，PowerShell）

```powershell
cd C:\harvests-engine
pm2 start ecosystem.config.cjs --only bot-worker
pm2 save
pm2 logs bot-worker          # 看日志
```

**预期日志**（对齐本机实测）：
```
[bot-real] launched persistent browser (stealth mode)
[bot-real] comment pool warmed up
[bot-real] execute task_xxx -> @handle [stage=stable, mode=browse_like]
[bot-real] done task_xxx
```

## 3. 引流节奏（已配好，无需改）

| 动作 | 配置 | 值 |
|---|---|---|
| 点赞 | `BOT_EXEC_MODE=browse_like` | 每次访问 **2-3 个**，间隔 45-120s，单账号≤2 赞，冷却 24-72h，**每日总量 6-20（bot 内置自动算）** |
| 评论 | `BOT_COMMENT_ENABLED=true` | 概率 0.2，每日上限 **3 条**，AI 生成文案，同账号 72h 冷却 |
| 关注 | `BOT_FOLLOW_ENABLED=true` | 每日 **3-5 个**，需同一账号访问 ≥2 次后才关注 |
| 帖子选择 | `BOT_SKIP_OLD_POST_DAYS=60` | 只互动近 60 天新帖，引流价值高 |
| 防封 | `HUMAN_MIMICRY_ENABLED=true` | 每 4 个任务休息 5-15 分钟 |

> **安全版（2026-08-06 定稿）**：这是保守档，专门为 raiha8833 真实账号设计——
> 行为突变（真人号突然高频互动）是 IG 最大封号红旗，第一周务必用保守档跑。
> 确认无 action block（如 "You can't perform this action right now"）后，
> 再逐步加量：评论 3→5/天、点赞间隔 120→90s。**点赞间隔别低于 45s，评论别超 5/天。**

## 4. 数据链路（VPS bot 消费什么）

```
scraper 抓 Maps → Neon artists + CSV
  → 桥接脚本 _import_maps_to_d1.py <STATE>   （把数据灌进 D1 + 建 ig_browse 任务）
    → VPS bot 轮询 /api/automation/poll?botId=bot_ig_01 领取任务
      → browse_like 浏览/点赞/评论/关注
        → 完成任务 POST /api/automation/report {status:'done'}
          → 后端自动把该店 artists.stage 回写为 'engaged'（2026-08-06 新增）
```

桥接命令（每次 AL 抓完一批跑一次，幂等）：
```powershell
cd C:\harvests-engine
python scripts/_import_maps_to_d1.py AL
```

## 5. 2026-08-07 新功能部署（回关 DM 全链路 / 多语言 / 产品库 / 帖子语言检测）

> 8-07 起本机推送了大量新功能（commit 52a50ee → 7181e88，详见 git log）。**不部署 = VPS 继续跑旧逻辑**。
> 全部命令在 VPS 上执行（PowerShell）。

### 5.1 更新 bot（harvests-engine）

```powershell
cd C:\harvests-engine
git pull
pm2 restart bot-worker          # 或 pm2 restart bot_ig_01（按 ecosystem 里的 app name）
```

### 5.2 更新云端 API（harvests-cloud-api，启用新端点）

```powershell
cd C:\harvests-cloud-api
git pull
wrangler deploy                 # 需要 VPS 上有 CLOUDFLARE_API_TOKEN
```

部署后新端点生效：
- `POST /api/automation/interaction` — bot 每次点赞/评论/关注/DM/回关写进 artist_interactions 时间线（前台可见）
- `POST /api/automation/tasks/retry-failed` — 重跑失败任务
- create-from-artists 任务 payload 带 `country/city` — 新任务自动带位置 → 按国家语言发 DM

### 5.3 重跑失败任务（可选，恢复 8 月初 bot 异常期的 861 个 failed）

```powershell
curl.exe -X POST -H "x-bot-key: vps-bot-secret-2024" https://harvests.pages.dev/api/automation/tasks/retry-failed
```

### 5.4 部署后验证

```powershell
curl.exe -H "x-bot-key: vps-bot-secret-2024" https://harvests.pages.dev/api/automation/task-counts
# 期望：done 持续增长（bot 在工作）；部署前基线 done=692 / pending=1352 / failed=861（2026-08-07 16:18）
pm2 logs bot-worker --lines 50     # 应出现 dm_direct_start / follow_back_detected / liked_us_detected 等新日志
# 前台 harvests.pages.dev：Artists 出现 stage=followback / dm_sent；详情页可看逐条互动时间线
```

> 提示：wrangler deploy 后主域名有约 1 分钟边缘缓存；deploy 报 Success 可能假，用 `wrangler pages deployment list` 核对。

## 6. 常见问题

- **`The symbol "sleep" has already been declared`** → bot-worker-real.ts 是旧版，重新同步
- **连不上 API** → 确认 `BOT_API_BASE=https://harvests.pages.dev`（VPS 上 workers.dev 可能被 GFW 屏蔽，pages.dev 两边都通）
- **没有任务可领（pending=0）** → 先跑桥接脚本把新抓数据灌进队列
- **想关掉本机沙箱的 bot** → 防止双 bot 抢任务：`taskkill /F /IM node.exe`（本机）
- **profile 路径不对** → bot 会用空 profile 起浏览器 → IG 未登录 → 点赞评论会失败。务必确认 `BOT_PROFILE_DIR` 指向含登录态的目录
