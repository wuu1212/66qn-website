# 66qn Minecraft 服务器官网

纯免费方案：**GitHub Pages（前端）+ Supabase（登录 + 数据库 + 存储 + AI 网关）**。
不需要服务器、不需要阿里云。

## 项目结构

```
66qn-website/
├── index.html / app.js / config.js     # GitHub Pages 实际使用的文件（仓库根目录）
├── frontend/                            # 源文件（与根目录内容一致，便于维护）
│   ├── index.html
│   ├── app.js
│   └── config.js                        # ★ 唯一需要填写的配置：Supabase 地址 + anon 密钥
└── backend/supabase/
    ├── schema.sql                       # 数据库建表 + 权限 + 函数（SQL 编辑器运行一次）
    └── functions/ai/index.ts            # AI 网关 Edge Function（客服 / 审核 / 举报复核）
```

## 功能清单

- 首页：服务器**实时**版本与在线人数（读取服务器 MOTD）、玩法特色、友情链接（QQ群 / B站 / **服务器地标总览**）
- **全站置顶公告**：后台配置后显示在导航栏下方
- **下载页**：分为「启动器」与「自有模组」两栏。启动器为 HMCL / FCL / PCL（仅跳转官方页面，含免责声明）；
  自有模组由管理员在后台「模组管理」中维护名称与下载链接
- **服务器指令**板块：后台增删改
- **活动**板块：后台发布/开启/关闭，可开启报名，用户报名可上传图片与文字
- **游戏实录**：上传截图 + 名字 + 坐标，**自动压缩至 100KB 内（可选 10–100KB）**，人工审核后展示
- 社区论坛：发帖 / 评论 / 回复 / 点赞 / 举报 / 删除（本人或管理员）
- 私信：展示全部用户、支持搜索用户名；复制、举报；**仅发送者本人、2 分钟内可撤回**（数据库层强制）
- 登录注册：邮箱（或用户名）+ GitHub 一键登录；注册需填 **游戏 ID** 与 **注册原因**
- **服务协议**：首次访问强制弹窗，不同意无法登录/发帖；后台可编辑内容，支持独立页面
- **AI 客服**：常驻右下角悬浮窗，先匹配"标准回答"再调用大模型
- **AI 审核**：帖子、评论、举报自动审核；举报经 AI 判定应删除时自动删除
- 管理后台：仪表盘、用户（撤销/恢复资格）、帖子/评论删除、举报处理（禁止使用/封禁/驳回）、
  公告、玩法特色、服务器指令、活动、游戏实录审核、**AI 配置（多模型按板块分配）**、协议设置、服务器设置
- 安全：全部权限由数据库行级安全（RLS）强制；AI 密钥使用 pgcrypto 加密存储，前端无法读回

## 部署步骤

### 第 1 步：Supabase 建表

1. 打开 https://supabase.com/dashboard → 进入你的项目
2. 左侧点 **SQL 编辑器** → New query
3. 把 `backend/supabase/schema.sql` 全文粘贴 → **Run**

### 第 2 步：设置 AI 密钥加密口令（仅用 AI 功能时需要）

在 SQL 编辑器执行一次（把口令换成你自己的随机长字符串）：

```sql
alter database postgres set app.ai_secret = '请替换为你的随机长字符串';
```

### 第 3 步：开启 GitHub 登录

1. https://github.com/settings/developers → New OAuth App
   - Homepage URL: `https://66qnmc.top`
   - Authorization callback URL: 填 Supabase「Authentication → Providers → GitHub」显示的 Redirect URL
2. 创建后复制 **Client ID**，Generate client secret 得到 **Client Secret**
3. Supabase → **Authentication → Providers** → 启用 GitHub → 粘贴 Client ID / Secret → 保存
4. Supabase → **Authentication → URL Configuration** → Redirect URLs 添加：
   - `https://66qnmc.top`
   - `https://wuu1212.github.io/66qn-website/`

### 第 4 步：部署 AI 网关 Edge Function

1. Supabase → **Edge Functions** → **Create a new function** → 名称填 `ai`
2. 把 `backend/supabase/functions/ai/index.ts` 内容整段粘贴进去 → **Deploy**
3. 在 Edge Function 的 **Secrets** 中添加：`AI_SECRET` = 与第 2 步相同的口令
   （`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` 由 Supabase 自动注入，无需填写）

### 第 5 步：上传 GitHub 并开启 Pages

1. 把项目推到 GitHub 仓库（根目录需包含 `index.html`、`app.js`、`config.js`、`CNAME`）
2. 仓库 Settings → Pages → Source 选 **Deploy from a branch** → 分支 `main` → 目录 `/ (root)` → Save
3. （可选）Custom domain 填 `66qnmc.top`
4. 等几分钟访问 `https://66qnmc.top`

## 设置管理员

1. 先在网站上注册一个账号
2. Supabase SQL 编辑器运行（换成你的邮箱）：

```sql
update public.profiles set role = 'admin'
where id = (select id from auth.users where email = '你的邮箱@example.com');
```

3. 刷新网站，右上角出现「管理」入口

## 配置 AI 模型

管理后台 → **AI 配置**：

| 字段 | 说明 |
| --- | --- |
| 配置名称 | 自定义，例如「主力模型」 |
| API 地址 | OpenAI 兼容地址，如 `https://api.openai.com/v1` 或 `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| 模型名称 | 例如 `gpt-4o-mini`、`qwen-plus`、`deepseek-chat` |
| API Key | 保存后不可查看，只能覆盖；数据库内加密存储 |
| 提示词 | 该模型的人设 / 审核标准 |
| 标准回答 | 每行一条：`关键词1,关键词2 => 回答内容`（命中关键词直接回复，不消耗模型额度） |
| 负责板块 | AI 客服 / 帖子审核 / 评论审核 / 举报复核（可多选） |
| 优先级 | 数字越小越优先；同一板块配置多个模型时取优先级最高的 |

> 可配置两个及以上模型，分别负责不同板块，实现"多选分配"。

## 本地预览（可选）

```bash
cd frontend
npx serve .
```

浏览器打开 http://localhost:3000（不要直接双击 index.html）。
