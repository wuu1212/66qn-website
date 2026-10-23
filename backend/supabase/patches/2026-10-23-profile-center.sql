-- ============================================================
-- 66qn 个人中心补丁（2026-10-23）
--   1. my_ai_grants()          玩家查看自己授权出去的 AI 应用（不含 UID 明文）
--   2. set_my_ai_grant()       停用 / 启用自己的授权（不删除，可恢复）
--   3. admin_reset_password()  管理员直接给用户设新密码，不依赖邮件链路
-- 用法：Supabase SQL Editor 整段粘贴运行（幂等，可重复执行）。
-- 依赖：open_accounts / open_api_logs / profiles / is_admin() 已存在。
-- ============================================================

-- ---------- 1. 我授权出去的 AI 应用 ----------
create or replace function public.my_ai_grants()
returns table (public_id text, name text, status text,
               can_get_info boolean, can_get_power boolean, can_checkin boolean,
               call_count integer, install_rewarded boolean,
               created_at timestamptz, last_call_at timestamptz)
language sql stable security definer set search_path = public as $$
  select a.public_id, a.name, a.status,
         a.can_get_info, a.can_get_power, a.can_checkin,
         a.call_count, a.install_rewarded, a.created_at,
         (select max(l.created_at) from public.open_api_logs l where l.account_id = a.id)
    from public.open_accounts a
   where a.source = 'self'
     and a.bind_username = (select p.username from public.profiles p where p.id = auth.uid())
   order by a.created_at desc
$$;
comment on function public.my_ai_grants() is '当前登录玩家自己领取的开放平台授权列表；UID 明文不在此返回';
grant execute on function public.my_ai_grants() to authenticated;

-- ---------- 2. 停用 / 启用（只能动自己的 self 授权） ----------
create or replace function public.set_my_ai_grant(p_public_id text, p_enabled boolean)
returns boolean language plpgsql security definer set search_path = public as $$
declare me text; n integer;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  select username into me from public.profiles where id = auth.uid();
  if me is null then return false; end if;

  update public.open_accounts
     set status = case when p_enabled then 'active' else 'disabled' end
   where public_id = p_public_id and source = 'self' and bind_username = me;
  get diagnostics n = row_count;
  return n > 0;
end $$;
comment on function public.set_my_ai_grant(text, boolean) is '停用(true→active / false→disabled)自己的某个授权；停用后该 UID 调用立即被拒';
grant execute on function public.set_my_ai_grant(text, boolean) to authenticated;

-- ---------- 3. 管理员重置密码（忘记密码的兜底通道） ----------
-- 直接写 bcrypt 哈希，顺带把未确认的邮箱标记为已确认，保证重置后一定能登录。
-- 注意：不会踢掉该用户其他设备上的旧会话（GoTrue 的 refresh token 需另行处理）。
create or replace function public.admin_reset_password(p_user_id uuid, p_new_password text)
returns text language plpgsql security definer set search_path = public as $$
declare em text; un text;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  if not public.is_admin() then raise exception '需要管理员权限'; end if;
  if p_new_password is null or length(btrim(p_new_password)) < 6 then
    raise exception '密码至少 6 位';
  end if;

  select email into em from auth.users where id = p_user_id;
  if em is null then raise exception '账号不存在'; end if;

  update auth.users
     set encrypted_password = extensions.crypt(p_new_password, extensions.gen_salt('bf')),
         email_confirmed_at = coalesce(email_confirmed_at, now()),
         updated_at = now()
   where id = p_user_id;

  select username into un from public.profiles where id = p_user_id;
  return coalesce(un, em);
end $$;
comment on function public.admin_reset_password(uuid, text) is '管理员为用户直接设置新密码（绕过邮件），返回用户名';
grant execute on function public.admin_reset_password(uuid, text) to authenticated;

-- ---------- 4. 自助邮件重置开关（默认关，SMTP 修好后在后台「公告管理」打开） ----------
-- 已有 site 配置时只补一个 false 字段，不会覆盖公告等其它内容；重复执行也不会改掉你手动打开的开关。
insert into public.server_settings (key, value)
values ('site', '{"email_reset_enabled": false}'::jsonb)
on conflict (key) do update
   set value = jsonb_set(
         server_settings.value,
         '{email_reset_enabled}',
         coalesce(server_settings.value -> 'email_reset_enabled', 'false'::jsonb),
         true);
