-- ============================================================
-- 66qn AI 技能 · 玩家自助补丁（2026-10-23）
-- 功能：
--   1. 玩家在网站「AI 技能」页自助领取授权码（每人一个，绑定本人，
--      仅开放 签到/查询 权限，不加不扣电）
--   2. 首次安装成功（自助账号首次非 ping 调用成功）奖励 60000 电力
--   3. 玩家可随时查看自己的 UID
-- 用法：Supabase SQL Editor 整段粘贴运行（幂等，可重复执行）。
-- 依赖：open_accounts / open_api 已存在（2026-10-23-open-platform.sql）。
-- ============================================================

-- ---------- 1. open_accounts 增加两列 ----------
alter table public.open_accounts add column if not exists install_rewarded boolean not null default false;
alter table public.open_accounts add column if not exists source text not null default 'admin';  -- admin=后台创建 | self=玩家自助

-- ---------- 2. 玩家自助领取授权码（每人一个，幂等） ----------
create or replace function public.claim_open_account()
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
declare me public.profiles;
declare new_uid text; pub text; new_id uuid; secret text; existing uuid; existing_pub text;
begin
  if uid is null then raise exception 'not authorized'; end if;
  select * into me from public.profiles where id = uid;
  if me.id is null then raise exception 'profile not found'; end if;
  if me.username is null or btrim(me.username) = '' then raise exception '请先设置昵称'; end if;

  -- 已领取过：返回公开 ID，不返回 UID 明文（查看用 view_my_open_uid）
  select id, public_id into existing, existing_pub from public.open_accounts
  where bind_username = me.username and source = 'self' limit 1;
  if existing is not null then
    return jsonb_build_object('is_new', false, 'public_id', existing_pub);
  end if;

  select value into secret from public.app_secrets where key = 'account_secret';
  if secret is null then secret := '66qn-default-secret-change-me'; end if;

  new_uid := 'ok_' || encode(extensions.gen_random_bytes(24), 'hex');
  pub := 'op_' || substr(encode(extensions.gen_random_bytes(6), 'hex'), 1, 10);

  insert into public.open_accounts
    (public_id, name, bind_username, uid_enc, uid_hash, source,
     can_get_info, can_get_power, can_checkin, can_add_power, can_deduct_power)
  values (
    pub, '玩家自助 · ' || me.username, me.username,
    encode(extensions.pgp_sym_encrypt(new_uid, secret), 'base64'),
    public.open_uid_hash(new_uid), 'self',
    true, true, true, false, false)
  returning id into new_id;

  return jsonb_build_object('is_new', true, 'public_id', pub, 'uid', new_uid);
end $$;
grant execute on function public.claim_open_account() to authenticated;

-- ---------- 3. 玩家查看自己的 UID ----------
create or replace function public.view_my_open_uid()
returns text language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
declare me public.profiles;
declare acct_id uuid; secret text;
begin
  if uid is null then raise exception 'not authorized'; end if;
  select * into me from public.profiles where id = uid;
  select id into acct_id from public.open_accounts
  where bind_username = me.username and source = 'self' limit 1;
  if acct_id is null then return null; end if;
  select value into secret from public.app_secrets where key = 'account_secret';
  if secret is null then secret := '66qn-default-secret-change-me'; end if;
  return extensions.pgp_sym_decrypt(
    decode((select uid_enc from public.open_accounts where id = acct_id), 'base64'), secret);
end $$;
grant execute on function public.view_my_open_uid() to authenticated;

-- ---------- 4. open_api：增加首次安装奖励 ----------
-- 玩家自助账号（source='self'）首次非 ping 调用成功 → 绑定玩家 +60000（kind='skill'），只发一次
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
  reward integer := 60000;
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

  -- 3. ping：连通性测试，无需权限，不计安装
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

  -- 6. 首次安装奖励：仅玩家自助账号，首次非 ping 成功调用触发，只发一次
  if acct.source = 'self' and not acct.install_rewarded then
    update public.open_accounts set install_rewarded = true
    where id = acct.id and install_rewarded = false;
    if found then
      insert into public.power_logs (user_id, amount, kind, note)
      values (prof.id, reward, 'skill', 'AI 技能安装奖励');
      update public.profiles set power = coalesce(power, 0) + reward where id = prof.id;
      res := res || jsonb_build_object('install_reward', reward);
    end if;
  end if;

  return res;
end $$;
grant execute on function public.open_api(text, text, text, integer) to anon, authenticated;
