-- ============================================================
-- 66qn 邮箱验证码登录 · 开关补丁（2026-10-23）
-- 前端已上线，但入口默认隐藏；这段 SQL 只负责把两个开关以 false 落库，
-- 之后在后台「公告管理」里勾选即可生效（改的是 server_settings.site）。
-- 用法：Supabase SQL Editor 整段粘贴运行（幂等，可重复执行）。
-- 说明：验证码登录本身走 Supabase Auth，不需要数据库函数。
-- ============================================================

insert into public.server_settings (key, value)
values ('site', '{"email_reset_enabled": false, "otp_login_enabled": false}'::jsonb)
on conflict (key) do update
   set value = jsonb_set(
         jsonb_set(
           server_settings.value,
           '{email_reset_enabled}',
           coalesce(server_settings.value -> 'email_reset_enabled', 'false'::jsonb),
           true),
         '{otp_login_enabled}',
         coalesce(server_settings.value -> 'otp_login_enabled', 'false'::jsonb),
         true);

-- 看一眼当前开关状态
select value -> 'announcement_enabled'   as 公告,
       value -> 'email_reset_enabled'    as 邮件自助重置,
       value -> 'otp_login_enabled'      as 邮箱验证码登录
from public.server_settings where key = 'site';
