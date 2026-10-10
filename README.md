# 66qn Minecraft 服务器官网

66qn 是一个纯净原版生存 Minecraft 服务器的官方网站，包含社区论坛、私信系统、启动器下载等功能。

## 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 前端 | Cloudflare Pages | 纯静态 HTML/CSS/JS SPA |
| 后端 | Cloudflare Workers | 无服务器 API |
| 数据库 | Cloudflare D1 | SQLite 兼容 |
| 认证 | JWT + GitHub OAuth | 双登录方式 |

## 项目结构

```
66qn-website/
├── frontend/
│   └── index.html          # SPA 前端（单文件）
├── backend/
│   ├── src/
│   │   ├── index.js        # Worker API 入口
│   │   └── db/
│   │       ├── schema.sql  # 数据库建表
│   │       └── seed.sql    # 初始数据
│   └── package.json
└── wrangler.toml           # Cloudflare 配置
```

## 功能特性

- **首页**：服务器状态展示、玩法特色、友情链接（QQ群 + B站）
- **启动器下载**：HMCL / FCL / PCL 官方下载跳转 + 免责声明
- **社区论坛**：发帖、评论、点赞、举报
- **私信系统**：用户间聊天，支持撤回（2分钟内）、举报、复制
- **用户认证**：邮箱注册登录 + GitHub OAuth 一键登录
- **管理后台**：仪表盘、用户/帖子/评论/举报管理、服务器设置
- **极简设计**：黑白为主 + 蓝色强调色，注重排版和留白

## 快速开始

### 环境要求

- Node.js 18+
- Wrangler CLI (`npm install -g wrangler`)
- Cloudflare 账号

### 本地开发

```bash
# 1. 克隆仓库
git clone https://github.com/wuu1212/66qn-website.git
cd 66qn-website

# 2. 安装后端依赖
cd backend && npm install && cd ..

# 3. 创建 D1 数据库
wrangler d1 create 66qn-db

# 4. 更新 wrangler.toml 中的 database_id

# 5. 初始化数据库
wrangler d1 execute 66qn-db --file=./backend/src/db/schema.sql
wrangler d1 execute 66qn-db --file=./backend/src/db/seed.sql

# 6. 配置 Secrets
wrangler secret put JWT_SECRET
wrangler secret put GITHUB_CLIENT_ID    # 可选
wrangler secret put GITHUB_CLIENT_SECRET # 可选

# 7. 本地启动后端
cd backend && npx wrangler dev

# 8. 另开终端，启动前端预览
cd frontend && npx serve .
```

### 部署

```bash
# 部署后端 API
cd backend && npx wrangler deploy

# 前端通过 GitHub 连接 Cloudflare Pages 自动部署
# 构建输出目录设为: frontend
```

## API 端点

<details>
<summary>认证 (7个端点)</summary>

- `POST /api/auth/register` - 注册
- `POST /api/auth/login` - 登录
- `GET /api/auth/github` - GitHub OAuth 跳转
- `GET /api/auth/github/callback` - GitHub 回调
- `GET /api/auth/me` - 获取当前用户
- `POST /api/auth/logout` - 登出
- `POST /api/auth/refresh` - 刷新 Token

</details>

<details>
<summary>帖子 & 评论 & 私信 & 管理后台</summary>

完整 API 文档请参考 `AI_DEPLOY_GUIDE.md`

</details>

## 友情链接

- **QQ群**：[66qn 官方群](https://qm.qq.com/q/bZNAGK8Rs4)
- **B站**：[66qn B站主页](https://space.bilibili.com/3546783978359356)

## 默认管理员

- 用户名：`admin`
- 密码：`admin123`
- **部署后请立即修改密码！**

## License

MIT
