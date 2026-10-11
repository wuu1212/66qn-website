# 66qn Minecraft 服务器官网

纯免费方案：**GitHub Pages（前端）+ Supabase（登录 + 数据库）**。
不需要任何服务器、不需要阿里云。

## 项目结构

```
66qn-website/
├── frontend/
│   ├── index.html      # 页面骨架 + 全部样式（极简设计）
│   ├── app.js          # 全部功能逻辑（直连 Supabase）
│   └── config.js       # ★ 唯一需要修改的文件：填 Supabase 地址和 anon 密钥
└── backend/supabase/
    └── schema.sql      # 数据库建表脚本（在 Supabase SQL 编辑器里运行一次）
```

## 功能

- 首页：服务器状态（后台可填 IP/端口/版本/人数）、玩法特色、友情链接（QQ群 + B站）
- 启动器下载：HMCL / FCL / PCL，仅跳转官方页面，含免责声明
- 社区论坛：发帖 / 评论 / 回复 / 点赞 / 举报 / 删除（本人或管理员）
- 私信：发送、复制、举报；**仅发送者本人、2 分钟内可撤回**（数据库层强制）
- 登录注册：邮箱 + GitHub 一键登录（Supabase Auth）
- 管理后台：仪表盘、用户封禁/角色、帖子隐藏/置顶、评论删除、举报处理、服务器设置
- 安全：全部权限由数据库行级安全（RLS）强制，前端只使用 anon 公钥

## 部署（共 4 步）

### 第 1 步：Supabase 建表

1. 打开 https://supabase.com/dashboard → 进入你的项目
2. 左侧点 **SQL 编辑器**
3. 把 `backend/supabase/schema.sql` 全文粘贴进去 → **运行**

### 第 2 步：开启 GitHub 登录

1. 打开 https://github.com/settings/developers → New OAuth App
   - Homepage URL: `https://66qnmc.top`
   - Authorization callback URL: 填 Supabase「认证 → 第三方登录」页面里显示的 Redirect URL
2. 创建后复制 **Client ID**，点 Generate client secret 得到 **Client Secret**
3. 回到 Supabase：左侧 **认证 → 第三方登录（Sign In / OAuth）** → 启用 GitHub →
   粘贴 Client ID / Secret → 保存

### 第 3 步：填写配置文件

编辑 `frontend/config.js`：

```js
window.APP_CONFIG = {
  SUPABASE_URL: 'https://iywntwllhjbubmhtacdp.supabase.co',
  SUPABASE_ANON_KEY: '从 Supabase 项目设置 → API 复制的 anon public 密钥',
};
```

> anon 密钥是设计为公开的（配合 RLS 安全）；**绝不要**把 service_role 密钥放进前端或仓库。

### 第 4 步：上传 GitHub 并开启 Pages

1. 把整个项目推到 GitHub 仓库
2. 仓库 Settings → Pages → Source 选对应分支和 `/frontend` 目录 → Save
3. （可选）Custom domain 填 `66qnmc.top`，并按提示去域名控制台加一条 CNAME
4. 等几分钟后访问 `https://66qnmc.top`

## 设置管理员

1. 先在网站上用邮箱注册一个账号
2. 到 Supabase SQL 编辑器运行（把邮箱换成你的）：

```sql
update public.profiles set role = 'admin'
where id = (select id from auth.users where email = '你的邮箱@example.com');
```

3. 刷新网站，右上角出现「管理」入口

## 本地预览（可选）

```bash
cd frontend
npx serve .
```

浏览器打开 http://localhost:3000 （不要直接双击 index.html）。
