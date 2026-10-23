# 66qn 官网 — 项目交接文档

> 本文档面向**接手此项目的 AI 或开发者**。读完应能：理解网站在做什么、知道每个文件的角色、掌握部署/修改流程、避开所有已知的坑。
> 最后更新：2026-10-18。作者：前 AI 助手（WorkBuddy）。用户/站长：wuu1212。

---

## 1. 这个项目是什么

**66qn 我的世界服务器的官方网站**。面向玩家：展示服务器信息（实时在线人数、版本、玩法、指令、活动、玩家实录）、提供账号体系（论坛/私信/活动报名）、AI 客服、以及一个后台管理系统（管理员维护内容、审核内容、管理用户）。

- 线上地址：`https://66qnmc.top`（GitHub Pages 托管，CNAME 已生效）
- GitHub 仓库：`https://github.com/wuu1212/66qn-website`，分支 `main`
- 技术栈：**零成本方案**
  - 前端：纯静态单页应用（原生 JS，hash 路由 `#/xxx`），托管在 GitHub Pages
  - 后端：Supabase 免费版（Auth 登录 + PostgreSQL 数据库 + Storage 文件存储 + Edge Functions）
  - 无服务器、无阿里云、无构建步骤

---

## 2. 文件结构（重要）

```
66qn-website/
├── index.html / app.js / config.js     # ★ GitHub Pages 实际部署的文件（仓库根目录）
├── CNAME                               # 内容：66qnmc.top
├── frontend/                           # ★ 源文件，与根目录内容必须保持一致
│   ├── index.html                      #   修改流程：改这里 → 校验 → cp 到根目录 → 推送
│   ├── app.js                          #   全部前端逻辑（约 2700 行，无模块化，按注释分节）
│   └── config.js                       # ★ 唯一需要手填的配置（Supabase URL + anon key）
├── backend/supabase/
│   ├── schema.sql                      # 数据库：23 个表 + 30+ 函数 + RLS（幂等，可整份重复运行）
│   └── functions/ai/index.ts           # Edge Function 源码（部署名见下文「bright-service」）
└── README.md                           # 原始部署文档（部分内容已过时，见 §9）
```

**工作约定**：`frontend/` 是源，根目录是部署副本。每次改完必须 `cp frontend/app.js app.js && cp frontend/index.html index.html` 再推送，两边 SHA 要一致。

---

## 3. config.js（唯一配置）

```js
// frontend/config.js
const SUPABASE_URL = 'https://你的项目.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOi...';   // Supabase → Settings → API → anon public
```

前端用 supabase-js CDN 直连数据库（anon key 是公开的，安全靠数据库 RLS 保证）。

---

## 4. 功能清单（现状）

### 前台
| 模块 | 路由 | 说明 |
|---|---|---|
| 首页 | `#/` | 服务器实时状态（版本/在线人数，**每 30 秒局部刷新**，不重渲染页面）、MOTD 文本、玩法特色（**无默认内容**，后台没配就显示提示）、友情链接（QQ群/B站/地标） |
| 下载 | `#/download` | 启动器（HMCL/FCL/PCL 外链）+ 自有模组（后台维护） |
| 服务器指令 | `#/commands` | 读取 `server_commands` 表 |
| 活动 | `#/events` | 列表 + 详情；可报名（文字+图片） |
| 游戏实录 | `#/records` | 上传截图自动压缩至 10–100KB，人工审核后展示；**图片走 IndexedDB 本地缓存，列表走 localStorage 缓存 30 分钟** |
| 成员 | `#/members` | 展示所有注册用户（读 `profiles`，非 `members` 表），与 MOTD 在线玩家比对显示"服务器在线/离线/未知"；头像姓名可点进主页，可发私信 |
| 电力 | `#/power` | 积分系统：新用户注册送 5000、每日签到 +100（按北京时间，数据库层防重）；顶部公告"兑换功能后期开放"；含「我的邀请码」卡片 |
| 论坛 | `#/forum` | 发帖/评论/回复/点赞/举报/删除；发帖评论先经 AI 审核 |
| 私信 | `#/messages` | 两人会话；发送者 2 分钟内可撤回（数据库强制） |
| 个人主页 | `#/profile/:id` | |
| 服务协议 | `#/agreement` | 独立页 + 首次访问弹窗（localStorage 记一次）+ 登录/发帖强制拦截 |
| AI 客服 | 右下角悬浮窗 | 先匹配「标准回答」再调大模型 |

### 注册/登录（当前最重要的部分，见 §5 决策历史）
| 入口 | 路由 | 状态 |
|---|---|---|
| GitHub 登录 | 按钮 | ✅ 正常（无需邮件） |
| 邮箱注册 | `#/register` 表单 | ⚠️ **不可用**（无 SMTP，见 §7）。页面顶部有横幅："当前邮件功能正在配置中，请切换为申请账号" |
| 申请账号 | `#/apply` | ✅ **当前主流程**：昵称+联系方式（禁邮箱）+保密问题/答案+密码 → 后台审核 → 自动建号 → 昵称+密码登录 |
| 邮箱验证 | `#/verify` | 仅配好 SMTP 后可用；验证码页只输验证码，邮箱自动带入 |
| 登录 | `#/login` | 支持邮箱或**用户名**（用户名→`profiles.email` 反查后走 Auth） |

### 管理后台 `#/admin`
仪表盘、用户管理（撤销/恢复资格）、帖子/评论删除、举报处理（禁止/封禁/驳回）、公告、玩法特色、服务器指令、活动、游戏实录审核、**模组管理**、**成员管理**、**注册申请审核**（通过并创建账号/驳回/设置登录密码）、**AI 配置**、协议设置、服务器设置。

### AI 能力（Edge Function）
- **AI 客服**（chat）：多模型按板块分配，标准回答优先
- **AI 审核**（moderate）：帖子/评论，提示词分场景（`prompt_post`/`prompt_comment`），强制 JSON 输出契约 `{"verdict":"pass|reject","reason":"..."}`
- **举报复核**（review_report）：AI 判定 delete/keep，**应删则服务端自动删除并结案**
- **账号创建**（create_account）/ **改密码**（set_password）：仅管理员

---

## 5. 关键决策历史（"为什么是这样"）

按时间顺序，接手者必读，避免推翻已有决定：

1. **全站免服务器**：站长要求零成本，所有逻辑压在 Supabase 免费版 + GitHub Pages。
2. **数据库 RLS 是唯一的权限边界**：前端直连 Supabase，anon key 公开。所有读写安全靠 `public.is_admin()` + 行级策略。改功能先想 RLS。
3. **Edge Function 实际部署名叫 `bright-service`**（不是 `ai`）。前端常量 `AI_FN='bright-service'` 统一引用。改名只改这一处 + Supabase 部署名。
4. **AI 密钥加密**：API Key 用 pgcrypto 对称加密存 `ai_secrets` 表，口令在 `app_secrets` 表（key=`ai_secret`），Edge Function 环境变量 `AI_SECRET` 必须与表中值一致。
5. **TOKEN_REFRESHED 不重渲染页面**：Supabase 在标签页重新聚焦时会刷新令牌，最初代码因此 `route()` 重画页面导致表单清空。已改为只刷新 navbar。任何新的事件处理都要遵守此约束。
6. **邮箱验证不可用 → 申请制注册**：Supabase 免费版默认邮件通道只能发给项目成员，普通邮箱收不到验证码（站长实测）。站长不想再折腾 Resend/Cloudflare，遂改为 `#/apply` 申请制：无邮箱注册，管理员后台一键建号。注册页的邮箱表单**故意保留**，仅加横幅说明。
7. **申请制账号用"合成邮箱"**：Supabase Auth 必须有 email 字段，建号时自动生成 `昵称_随机@apply.66qn.top`（`email_confirm:true`），不外发任何邮件。玩家用**昵称+密码**登录——登录逻辑会按用户名反查 `profiles.email`，正好命中合成邮箱。这套机制完全绕开了邮件依赖。
8. **邀请码是选填的社交功能**，不是注册门槛：每个用户系统自动分配 6 位数字邀请码（电力页可复制/更换），好友注册时选填，仅记录邀请关系（`invited_by`/`invite_count`）。历史上曾做过"管理员批量邀请码"版本，**已彻底删除**。
9. **电力暂不开放兑换**：只进不出，公告已写明。`power_logs` 记录每笔流水。
10. **首页玩法特色无默认内容**：站长要求"不要预设"，后台为空就显示提示。
11. **省流量设计**：状态 30s 轮询（离开首页即停）、实录图片 IndexedDB、实录列表 localStorage 30 分钟、活动图片同样走 IndexedDB。
12. **浏览器缓存击穿**：`index.html` 里 `config.js`/`app.js` 带 `?v=20261011l` 版本号，**每次改 JS/HTML 必须 bump**。

---

## 6. 数据库结构速览

完整定义以 `backend/supabase/schema.sql` 为准（幂等，可整份重跑）。核心表：

| 表 | 要点 |
|---|---|
| `profiles` | 用户档案。扩展列：`email`（唯一，可为用户名反查）、`username`（唯一昵称）、`game_id`、`register_reason`、`role`(user/admin)、`status`(active/banned)、`power`、`invite_code`(6位数字,唯一)、`invited_by`、`invite_count`、`security_q`、`security_a_enc`（加密） |
| `posts` / `comments` / `likes` / `messages` / `reports` | 论坛与社交，计数由触发器自动维护 |
| `server_settings` | JSONB：`server`（ip/port/version/motd/maxPlayers/在线数）+ `site`（标题/QQ/B站/地标/公告） |
| `game_features` / `server_commands` / `events` / `event_signups` / `mods` | 后台可维护的内容表 |
| `game_records` | 实录，`status: pending/approved`，上传即压缩 |
| `ai_configs` | 多模型配置。分场景提示词：`prompt`（客服）/`prompt_post`/`prompt_comment`/`prompt_report`；`scopes[]`、`priority`、`temperature` |
| `ai_secrets` / `app_secrets` | 加密密钥库。**无任何 select 策略，前端永远读不到** |
| `account_applications` | 注册申请。密码/答案列加密存储；RLS 仅管理员可见 |
| `power_logs` | 电力流水（newuser/daily/admin） |
| `agreements` / `members` / `ai_reviews` | 协议签署 / 成员（现仅后台用，前台读 profiles）/ AI 审核记录 |

核心函数（均 `security definer`，权限在函数内校验）：
- 注册链路：`handle_new_user`（触发器：建 profile、送 5000 电力、分配邀请码）、`apply_account`（匿名可调用）、`review_application`、`get_application_secret`、`complete_application`、`set_profile_security`（仅 service_role）、`admin_view_security_answer`
- 电力：`claim_daily_power`（按北京时间每天一次）、`admin_add_power`
- 邀请码：`gen_invite_code`、`regenerate_invite_code`、`bind_inviter`
- AI：`admin_set_ai_key`、`get_ai_key`（仅 service_role）、`get_ai_configs`（仅 service_role）
- 通用：`is_admin`、`view_post`、`mark_messages_read`、`recall_message`、`resolve_report_action`

---

## 7. 当前已知问题与待办

| 事项 | 状态 | 说明 |
|---|---|---|
| **邮件发送（SMTP）** | ❌ 未配置 | 根因：Supabase 免费版默认邮件只能发项目成员。方案：Resend（免费 100 封/天）+ Custom SMTP。配好后开 Confirm Email + 模板加 `{{ .Token }}` |
| Confirm Email | ⚠️ 应保持关闭 | 开启则邮箱注册和验证码都无法工作（SMTP 没配）。申请制注册不受影响 |
| **申请制注册上线前提** | 站长待办 | ① 跑最新 schema.sql ② **重新部署 bright-service**（新增 create_account/set_password）。两步缺一，点"通过并创建账号"会失败 |
| 邮箱验证页 `#/verify` | 代码就绪 | SMTP 配好后自动可用 |
| 电力兑换 | 未实现 | 数据已积累，公告已告知玩家 |
| 保密问题找回密码 | 未实现 | Q&A 已加密存于 profile，做自助找回时直接用 |
| README.md 过时 | 低优 | 其中"Edge Function 名称填 ai"是错的，实际 bright-service；功能清单也缺申请制/电力 |
| Edge Function 命名 | 技术债 | 文件在 `functions/ai/` 但部署名 bright-service，易误导 |

---

## 8. 坑位清单（血泪史，务必遵守）

1. **pgcrypto 必须带前缀**：Supabase 的扩展装在 `extensions` schema，函数体内必须写 `extensions.pgp_sym_encrypt(...)` / `extensions.pgp_sym_decrypt(...)`，否则 42883 报错。
2. **SQL Editor 是单事务**：整段脚本任一报错全部回滚。分段补丁必须自包含；**新增列必须写在引用它的函数之前**。
3. **不允许 `alter database`**：自定义配置存 `app_secrets` 表（无 select 策略）。
4. **GitHub Pages 根目录即部署**：改 `frontend/` 后必须同步到根目录再推。
5. **版本号必须 bump**：`index.html` 里 `?v=20261011l`，改动后不改版本号用户看不到更新。
6. **推送方式**：本机 GitHub 连接器只有只读权限；实际走 **Contents API + 本机 git credential**（`git credential fill` 取 token）。大文件 base64 走 node 脚本（见 §10），不能拼命令行。
7. **推送后必须核验**：本地 `git hash-object` vs 远程 blob SHA。曾出现"推了 app.js 漏了 index.html"。
8. **TOKEN_REFRESHED 不得重渲染**：任何 auth 事件处理里不要对当前页 `route()`。
9. **国内 MC 服务器可能屏蔽海外探测**：首页状态接口（mcsrvstat.us/mcstatus.io）取不到时显示"获取失败"而非"离线"，这是有意设计。
10. **node/bash 工具坑**：bash heredoc 写 `.mjs` 会偶发静默失败 → 用 Write 工具建脚本文件；node 输出偶发不显示 → 脚本写日志文件再读；`git credential fill` 在 `$()` 里可能取不到值 → 先 `> tmp` 再 grep。

---

## 9. 部署 / 修改工作流

### 全新部署（从零）
1. Supabase 项目 → SQL Editor 粘贴 `schema.sql` 全文 → Run（幂等，报错会把整个事务回滚，看报错修）
2. SQL 执行（可选，配 AI 才需要）：
   ```sql
   insert into public.app_secrets (key, value) values ('ai_secret', '随机长字符串')
   on conflict (key) do update set value = excluded.value;
   ```
3. 部署 Edge Function：Create function → 名称 **`bright-service`** → 粘贴 `functions/ai/index.ts` → Deploy → Secrets 加 `AI_SECRET`（同第 2 步口令）
4. GitHub → Settings → Pages → main 分支 root；Custom domain `66qnmc.top`
5. 前端 `config.js` 填 Supabase URL + anon key → 推送
6. 注册账号 → SQL 提权：
   ```sql
   update public.profiles set role='admin'
   where id=(select id from auth.users where email='你的邮箱');
   ```

### 日常修改（改前端）
```bash
# 1. 编辑 frontend/app.js 或 frontend/index.html
# 2. 语法检查
node --check frontend/app.js
# 3. bump 版本号（index.html 里 ?v= 改成新值，frontend 和根目录都要）
# 4. 同步到根目录
cp frontend/app.js app.js && cp frontend/index.html index.html
# 5. 推送（Contents API，见下）
# 6. 核验远程 SHA == 本地 git hash-object
# 7. git add -A && git commit
```

### 改了 Edge Function / 数据库
- Edge Function：Supabase 控制台 `bright-service` → Code → 全选替换 → Deploy（不自动更新！）
- 数据库：改 `schema.sql` → 整份重跑（幂等）；或写自包含补丁段单独跑

---

## 10. 推送脚本模板（复制即用）

本机 token 获取：`printf "protocol=https\nhost=github.com\n\n" | git credential fill > .cred.txt`（token 在 `password=` 行）。

```js
// sync.mjs — node sync.mjs .cred.txt file1 file2 ...
import fs from 'node:fs';
const token = fs.readFileSync(process.argv[2],'utf8').split('\n').find(l=>l.startsWith('password=')).slice(9).trim();
const H = { Authorization: 'Bearer '+token, Accept: 'application/vnd.github+json' };
for (const f of process.argv.slice(3)) {
  const b64 = fs.readFileSync(f).toString('base64');
  const gr = await fetch(`https://api.github.com/repos/wuu1212/66qn-website/contents/${encodeURI(f)}?ref=main`, { headers: H });
  const sha = gr.ok ? (await gr.json()).sha : '';
  const r = await fetch(`https://api.github.com/repos/wuu1212/66qn-website/contents/${encodeURI(f)}`, {
    method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'update '+f, content: b64, branch: 'main', sha })
  });
  console.log(f, r.status);
}
```

---

## 11. 接手自检清单

- [ ] 能打开 `https://66qnmc.top`，`Ctrl+Shift+R` 后导航含：下载/申请账号/电力/成员/指令/活动/实录/社区
- [ ] `#/apply` 提交一条测试申请 → 后台「注册申请审核」可见 → 通过后能用昵称+密码登录
- [ ] 后台各页面能打开、能保存（重点：AI 配置、服务器设置、申请审核）
- [ ] 首页在线人数每 30 秒变化（如果服务器在线）
- [ ] 登录后刷新页面表单内容不丢（TOKEN_REFRESHED 约束生效）
- [ ] 电力页签到 +100，刷新后明细表有记录
- [ ] `git status` 干净，`frontend/` 与根目录 SHA 一致

## 12. 联系上下文

- 站长：wuu1212（GitHub 同 ID）；邮箱 `17363760695@163.com`（也是其 163 邮箱，当前管理员账号）
- 服务器：`66qn` Java 原版生存服（MOTD 探测地址需在后台「服务器设置」填真实 IP，注意网站域名 66qnmc.top 指向 GitHub Pages，**不能**当 MC 服务器地址用）
- 历史会话的记忆文件：`.workbuddy-ai/memory/`（本工作区，含逐日决策记录）
