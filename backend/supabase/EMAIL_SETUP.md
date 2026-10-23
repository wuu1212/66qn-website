# 66qn 邮箱登录配置手册（阿里云邮件推送）

> 目标：让 `#/register` 的邮箱注册、验证码验证、邮箱 + 密码登录正常工作。
>
> 原理：Supabase Auth 负责生成验证码，阿里云邮件推送（DirectMail）负责把邮件发出去。前端代码已经写好，本手册只做控制台配置。

---

## 0. 先看结论

- **不需要改数据库表结构，也不需要跑 SQL**。SMTP 是 Supabase Auth 的服务配置，不在数据库里。
- 需要准备：阿里云账号（已实名认证）、`66qnmc.top` 的 DNS 管理权限。
- 建议发信地址：`noreply@mail.66qnmc.top`（用子域名，避免影响主站）。
- 阿里云邮件推送免费额度：每个账号共 2000 封，每天最多免费 200 封，小型服务器足够。

---

## 1. 阿里云开通邮件推送

1. 登录阿里云控制台，搜索「邮件推送」或「DirectMail」。
2. 开通邮件推送服务（免费开通）。
3. 确认账号已完成实名认证。

---

## 2. 添加发信域名

1. 进入「邮件推送控制台」→「发信域名」→「新建域名」。
2. 填写：`mail.66qnmc.top`（用子域名，不要直接用 `66qnmc.top`）。
3. 控制台会给出 6 条 DNS 记录，到域名 DNS 服务商逐条添加（通常是 TXT、MX、CNAME 记录，具体以控制台显示为准）。
4. 注意事项：
   - **SPF 记录只能有一条**。如果已经有 SPF，需要合并成一条，不能新增第二条。
   - 域名在阿里云且与邮件推送同账号时，可以尝试「自动配置」。
   - 如果 DNS 用 Cloudflare，MX/TXT 记录保持 DNS only，不要开小黄云代理。
5. 等待约 10 分钟，回控制台点「验证」，状态变成「验证通过」即可。

---

## 3. 创建发信地址并设置 SMTP 密码

1. 「邮件推送控制台」→「发信地址」→「新建发信地址」。
2. 填写：
   - 发信地址：`noreply@mail.66qnmc.top`
   - 发信人昵称：`66qn`
   - 类型：**触发邮件**（注册验证码属于触发邮件，不要选批量邮件）
3. 创建后，在操作列点「设置 SMTP 密码」，设置一个强密码并记下来。
   - 这个密码不是阿里云登录密码，是专门给 SMTP 用的密码。
4. 如果控制台要求验证「回信地址」，按提示验证（可以填同一个地址）。

---

## 4. Supabase 配置 Custom SMTP

路径：Supabase Dashboard → **Authentication → Emails → SMTP Settings**（部分版本在 Project Settings → Authentication → SMTP Settings）。

打开 **Enable Custom SMTP**，填写：

| 字段 | 值 |
|---|---|
| Sender email | `noreply@mail.66qnmc.top` |
| Sender name | `66qn` |
| Host | `smtpdm.aliyun.com` |
| Port number | `465` |
| Username | `noreply@mail.66qnmc.top`（完整邮箱地址） |
| Password | 第 3 步设置的 SMTP 密码 |
| Minimum interval between emails being sent | `10` 秒（默认 60 也可以） |

保存。

注意事项：

- **Username 必须和 Sender email 完全一致**。阿里云要求 SMTP 认证账号与发件人一致，不一致会报 553。
- 端口优先用 `465`（SSL）。如果 465 不通，再试 `80`（非加密）；`25` 很多网络会封，不推荐。
- 保存后 Supabase 会立即使用新 SMTP，不需要重新部署项目。

---

## 5. Supabase Auth 设置

### 5.1 打开邮箱确认

Authentication → **Sign In / Providers → Email**：

- 确保 Email provider 是开启状态；
- 打开 **Confirm email**（邮箱确认）；
- 确保 **Allow new users to sign up** 是开启的。

### 5.2 URL 配置

Authentication → **URL Configuration**：

- Site URL：`https://66qnmc.top`
- Redirect URLs：添加 `https://66qnmc.top/**`（如果已经有就不用重复）

### 5.3 验证码设置（可选）

- Email OTP Length：`6`
- Email OTP Expiration：`3600` 秒（1 小时）

### 5.4 中文验证码邮件模板

Authentication → **Emails → Templates → Confirm signup**。

主题：

```text
【66qn】邮箱验证码：{{ .Token }}
```

正文（HTML，整段粘贴）：

```html
<div style="max-width:560px;margin:0 auto;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;line-height:1.7;color:#1f2937">
  <h2 style="margin:0 0 12px;font-size:20px">欢迎加入 66qn</h2>
  <p>你好，你的邮箱验证码是：</p>
  <p style="margin:20px 0;font-size:32px;font-weight:700;letter-spacing:8px;color:#2563eb">{{ .Token }}</p>
  <p>验证码 1 小时内有效。请回到网站输入验证码完成注册。</p>
  <p style="margin:24px 0">
    <a href="{{ .ConfirmationURL }}" style="display:inline-block;padding:10px 20px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px">也可以点击这里直接完成验证</a>
  </p>
  <p style="color:#6b7280;font-size:13px">如果这不是你本人的操作，请忽略这封邮件。</p>
  <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
  <p style="color:#9ca3af;font-size:12px">66qn 我的世界服务器 · https://66qnmc.top</p>
</div>
```

保存。

注意事项：

- **必须保留 `{{ .Token }}`**，否则邮件里没有验证码。
- `{{ .ConfirmationURL }}` 是「点击直接验证」的链接，建议保留。
- Supabase 免费版默认 SMTP 不允许修改模板；启用 Custom SMTP 后就可以修改。如果模板编辑被锁定，先确认 Custom SMTP 已保存成功。

---

## 6. 测试流程

1. 用没注册过的邮箱打开 `https://66qnmc.top/#/register` 注册。
2. 收到邮件后，在 `#/verify` 输入 6 位验证码。
3. 验证成功应该自动登录，并赠送 5000 电力。
4. 退出后，用邮箱 + 密码在 `#/login` 登录。
5. 用昵称 + 密码登录也应该正常（登录逻辑会自动反查 `profiles.email`）。

---

## 7. 排查

### 7.1 Supabase Auth 日志

Dashboard → **Logs → Auth Logs**，搜索 `smtp` 或 `email`。常见错误：

| 错误 | 原因 | 处理 |
|---|---|---|
| `535 Authentication failed` | SMTP 用户名或密码错误 | Username 必须是完整发信地址；重新设置 SMTP 密码 |
| `553 Mail from must equal authorized user` | 发件人和认证账号不一致 | Sender email 与 Username 填同一个地址 |
| `connection refused` / `timeout` | 端口不通 | 优先用 465 |
| `rate limit` / `too many` | Supabase 发信频率限制 | 默认 30 封/小时，可在 Authentication → Rate Limits 调整 |

### 7.2 阿里云发信记录

邮件推送控制台 →「数据统计」或「发信记录」，查看邮件是否投递、被拒或退信。

### 7.3 SQL 排查（只读，可选）

```sql
-- 最近的用户及邮箱确认状态
select u.email, u.email_confirmed_at, u.created_at, p.username
from auth.users u
left join public.profiles p on p.id = u.id
order by u.created_at desc
limit 20;

-- 查某个邮箱是否已验证
select email, email_confirmed_at, last_sign_in_at
from auth.users
where email = 'test@example.com';
```

说明：`email_confirmed_at` 为空表示还没验证；验证成功后会有时间。

---

## 8. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 点注册后没收到邮件 | 进了垃圾箱 / 域名未验证 / 发信地址类型选错 | 查垃圾箱、阿里云发信记录；确认是「触发邮件」 |
| 提示 `Email not confirmed` | 用户没输入验证码 | 去 `#/verify` 重新发送 |
| 注册页报错 | Confirm email 没开或 SMTP 没保存 | 检查第 4、5 步 |
| 邮件里没有验证码 | 模板没加 `{{ .Token }}` | 按 5.4 修改模板 |
| 验证码过期 | 超过 OTP 有效期 | 重新发送 |

---

## 9. 上线顺序

1. 按第 1–5 步配好阿里云和 Supabase。
2. 在 Supabase 里用测试邮箱走一遍注册，确认能收到验证码。
3. 确认无误后，让 AI 推送前端改动（版本号 `20261023a`）。
4. 推送后在线上再完整测试一遍。

> 前端代码已经改好并提交到本地，等你配好 SMTP 后再推送，避免线上提前暴露未完成的邮箱注册。
