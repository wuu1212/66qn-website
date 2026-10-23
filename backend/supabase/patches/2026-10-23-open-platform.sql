-- ============================================================
-- 66qn 开放平台补丁（2026-10-23）
-- 功能：第三方模组 / AI 助手凭 UID 调用接口，对绑定玩家执行
--       签到 / 查询电力 / 查询账号信息 / 加电力 / 减电力，
--       每个功能可按开放账号单独开关。
-- 用法：Supabase SQL Editor 整段粘贴运行（幂等，可重复执行）。
-- 依赖：pgcrypto 扩展（本补丁自带创建语句）。
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

-- 确保加密口令表存在；没有口令时补默认值（不会覆盖已有口令）
create table if not exists public.app_secrets (
  key   text primary key,
  value text not null
);
alter table public.app_secrets enable row level security;
insert into public.app_secrets (key, value)
values ('account_secret', '66qn-default-secret-change-me')
on conflict (key) do nothing;

-- ---------- 开放账号表 ----------
create table if not exists public.open_accounts (
  id              uuid primary key default gen_random_uuid(),
  public_id       text unique not null,                 -- 公开 ID（op_xxxxxx，可对外展示）
  name            text not null,                        -- 应用 / 备注名
  bind_username   text not null default '',             -- 绑定玩家昵称（空 = 调用时可指定任意玩家）
  uid_enc         text not null,                        -- UID（pgcrypto 加密存储）
  uid_hash        text unique not null,                 -- UID 的 sha256（用于查找，不可逆）
  can_get_info    boolean not null default false,       -- 查询账号信息
  can_get_power   boolean not null default false,       -- 查询电力
  can_checkin     boolean not null default false,       -- 每日签到
  can_add_power   boolean not null default false,       -- 增加电力
  can_deduct_power boolean not null default false,      -- 扣减电力
  status          text not null default 'active',       -- active | disabled
  call_count      integer not null default 0,
  created_at      timestamptz not null default now()
);

-- ---------- 调用日志表 ----------
create table if not exists public.open_api_logs (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references public.open_accounts(id) on delete cascade,
  action          text not null default '',
  target_username text not null default '',
  amount          integer,
  ok              boolean not null default true,
  err             text not null default '',
  created_at      timestamptz not null default now()
);
create index if not exists idx_open_logs_account on public.open_api_logs(account_id, created_at desc);

-- ---------- RLS：仅管理员可见 ----------
alter table public.open_accounts enable row level security;
alter table public.open_api_logs  enable row level security;
drop policy if exists "open_accounts_admin" on public.open_accounts;
create policy "open_accounts_admin" on public.open_accounts for all
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "open_logs_admin" on public.open_api_logs;
create policy "open_logs_admin" on public.open_api_logs for all
  using (public.is_admin()) with check (public.is_admin());

-- ---------- 工具：UID 哈希 ----------
create or replace function public.open_uid_hash(p_uid text)
returns text language sql immutable as $$
  select encode(extensions.digest(coalesce(p_uid, ''), 'sha256'), 'hex');
$$;

-- ---------- 内部：写调用日志并计数 ----------
create or replace function public.open_log_request(p_account uuid, p_action text, p_username text, p_amount integer, p_ok boolean, p_err text)
returns void language sql security definer set search_path = public as $$
  insert into public.open_api_logs (account_id, action, target_username, amount, ok, err)
  values (p_account, coalesce(p_action, ''), coalesce(p_username, ''), p_amount, coalesce(p_ok, true), coalesce(p_err, ''));
  update public.open_accounts set call_count = call_count + 1 where id = p_account;
$$;

-- ---------- 管理员：创建开放账号（UID 明文只在此返回一次） ----------
create or replace function public.admin_create_open_account(p_name text, p_bind_username text, p_caps jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid text;
  pub text;
  new_id uuid;
  secret text;
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  if p_name is null or length(btrim(p_name)) < 1 then raise exception '请填写应用名称'; end if;
  if p_bind_username is not null and btrim(p_bind_username) <> '' then
    if not exists (select 1 from public.profiles where lower(username) = lower(btrim(p_bind_username))) then
      raise exception '绑定的玩家昵称不存在：%', btrim(p_bind_username);
    end if;
  end if;

  select value into secret
  from public.app_secrets where key = 'account_secret';
  if secret is null then secret := '66qn-default-secret-change-me'; end if;

  uid := 'ok_' || encode(extensions.gen_random_bytes(24), 'hex');
  pub := 'op_' || substr(encode(extensions.gen_random_bytes(6), 'hex'), 1, 10);

  insert into public.open_accounts
    (public_id, name, bind_username, uid_enc, uid_hash,
     can_get_info, can_get_power, can_checkin, can_add_power, can_deduct_power)
  values (
    pub, btrim(p_name), coalesce(btrim(p_bind_username), ''),
    encode(extensions.pgp_sym_encrypt(uid, secret), 'base64'),
    public.open_uid_hash(uid),
    coalesce((p_caps->>'get_info')::boolean, false),
    coalesce((p_caps->>'get_power')::boolean, false),
    coalesce((p_caps->>'checkin')::boolean, false),
    coalesce((p_caps->>'add_power')::boolean, false),
    coalesce((p_caps->>'deduct_power')::boolean, false))
  returning id into new_id;

  return jsonb_build_object('id', new_id, 'public_id', pub, 'uid', uid);
end $$;
grant execute on function public.admin_create_open_account(text, text, jsonb) to authenticated;

-- ---------- 管理员：重新查看 UID ----------
create or replace function public.admin_view_open_uid(p_account uuid)
returns text language plpgsql security definer set search_path = public as $$
declare secret text;
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  select value into secret
  from public.app_secrets where key = 'account_secret';
  if secret is null then secret := '66qn-default-secret-change-me'; end if;
  return extensions.pgp_sym_decrypt(
    decode((select uid_enc from public.open_accounts where id = p_account), 'base64'), secret);
end $$;
grant execute on function public.admin_view_open_uid(uuid) to authenticated;

-- ---------- 开放接口（第三方用 anon key + UID 调用） ----------
-- action: ping / get_info / get_power / checkin / add_power / deduct_power
create or replace function public.open_api(p_uid text, p_action text, p_username text default null, p_amount integer default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  acct public.open_accounts;
  prof public.profiles;
  uname text;
  today date := (now() at time zone 'Asia/Shanghai')::date;
  last_day date;
  gained integer := 0;
  delta integer;
  new_power integer;
  res jsonb;
  ok boolean := true;
  errmsg text := '';
  cnt integer;
begin
  -- 1. 验证 UID
  select * into acct from public.open_accounts where uid_hash = public.open_uid_hash(coalesce(p_uid, ''));
  if acct.id is null then
    return jsonb_build_object('ok', false, 'error', 'UID 无效');
  end if;
  if acct.status <> 'active' then
    return jsonb_build_object('ok', false, 'error', '该开放账号已停用');
  end if;

  -- 2. 限频：每个开放账号每小时最多 120 次（含失败调用）
  select count(*) into cnt from public.open_api_logs
  where account_id = acct.id and created_at > now() - interval '1 hour';
  if cnt >= 120 then
    return jsonb_build_object('ok', false, 'error', '调用太频繁（每小时限 120 次），请稍后再试');
  end if;

  -- 3. ping：连通性测试，无需权限
  if p_action = 'ping' then
    perform public.open_log_request(acct.id, 'ping', '', null, true, '');
    return jsonb_build_object('ok', true, 'public_id', acct.public_id, 'name', acct.name, 'bind_username', acct.bind_username);
  end if;

  -- 4. 解析目标玩家
  uname := coalesce(nullif(btrim(coalesce(p_username, '')), ''), acct.bind_username);
  if uname is null or uname = '' then
    perform public.open_log_request(acct.id, p_action, '', null, false, '未指定玩家昵称');
    return jsonb_build_object('ok', false, 'error', '未指定玩家昵称，且该开放账号未绑定玩家');
  end if;
  if acct.bind_username <> '' and lower(uname) <> lower(acct.bind_username) then
    perform public.open_log_request(acct.id, p_action, uname, p_amount, false, '越权操作');
    return jsonb_build_object('ok', false, 'error', '该开放账号只能操作绑定的玩家：' || acct.bind_username);
  end if;
  select * into prof from public.profiles where lower(username) = lower(uname);
  if prof.id is null then
    perform public.open_log_request(acct.id, p_action, uname, p_amount, false, '玩家不存在');
    return jsonb_build_object('ok', false, 'error', '找不到玩家：' || uname);
  end if;
  if prof.status = 'banned' then
    perform public.open_log_request(acct.id, p_action, uname, p_amount, false, '玩家已封禁');
    return jsonb_build_object('ok', false, 'error', '该玩家已被封禁');
  end if;

  -- 5. 各操作
  if p_action = 'get_info' then
    if not acct.can_get_info then
      ok := false; errmsg := '该开放账号未开通「查询账号信息」权限';
    else
      res := jsonb_build_object('ok', true, 'username', prof.username, 'game_id', prof.game_id,
        'bio', prof.bio, 'power', prof.power, 'status', prof.status, 'created_at', prof.created_at);
    end if;

  elsif p_action = 'get_power' then
    if not acct.can_get_power then
      ok := false; errmsg := '该开放账号未开通「查询电力」权限';
    else
      res := jsonb_build_object('ok', true, 'username', prof.username, 'power', prof.power);
    end if;

  elsif p_action = 'checkin' then
    if not acct.can_checkin then
      ok := false; errmsg := '该开放账号未开通「每日签到」权限';
    else
      select (created_at at time zone 'Asia/Shanghai')::date into last_day
      from public.power_logs
      where user_id = prof.id and kind = 'daily'
      order by created_at desc limit 1;
      if last_day is not null and last_day >= today then
        gained := 0;
      else
        insert into public.power_logs (user_id, amount, kind, note)
        values (prof.id, 100, 'daily', '每日登录赠送');
        update public.profiles set power = coalesce(power, 0) + 100 where id = prof.id;
        gained := 100;
      end if;
      select power into new_power from public.profiles where id = prof.id;
      res := jsonb_build_object('ok', true, 'username', prof.username, 'gained', gained, 'power', new_power);
    end if;

  elsif p_action = 'add_power' or p_action = 'deduct_power' then
    if p_action = 'add_power' and not acct.can_add_power then
      ok := false; errmsg := '该开放账号未开通「增加电力」权限';
    elsif p_action = 'deduct_power' and not acct.can_deduct_power then
      ok := false; errmsg := '该开放账号未开通「扣减电力」权限';
    elsif p_amount is null or p_amount < 1 or p_amount > 100000 then
      ok := false; errmsg := '电力数量需在 1-100000 之间';
    elsif p_action = 'deduct_power' and coalesce(prof.power, 0) < p_amount then
      ok := false; errmsg := '电力不足，当前 ' || coalesce(prof.power, 0);
    else
      delta := case when p_action = 'add_power' then p_amount else -p_amount end;
      insert into public.power_logs (user_id, amount, kind, note)
      values (prof.id, delta, 'open', '开放平台（' || acct.name || '）');
      update public.profiles set power = coalesce(power, 0) + delta where id = prof.id
      returning power into new_power;
      res := jsonb_build_object('ok', true, 'username', prof.username, 'power', new_power, 'amount', delta);
    end if;

  else
    ok := false; errmsg := '未知操作：' || coalesce(p_action, '');
  end if;

  perform public.open_log_request(acct.id, p_action, uname, p_amount, ok, errmsg);
  if not ok then
    return jsonb_build_object('ok', false, 'error', errmsg);
  end if;
  return res;
end $$;
grant execute on function public.open_api(text, text, text, integer) to anon, authenticated;
