-- ============================================================
-- 66qn 电力任务系统补丁（2026-10-23）
-- 功能：
--   1. 邀请奖励落地：每成功邀请 1 位好友注册，邀请人 +10000 电力
--      （原 bind_inviter 只建立邀请关系，从未实际发放）
--   2. 游戏实录审核通过 +500（每次通过均奖励）
--   3. 论坛发帖 +600（每日首次，按北京时间去重）
--   4. 发送社区私信 +100（每日首次，按北京时间去重）
-- 用法：Supabase SQL Editor 整段粘贴运行（幂等，可重复执行）。
-- 注意：与 schema.sql 第 22 节 bind_inviter、第 25 节内容一致，
--       两份跑哪份都可以，重复执行不会重复发放。
-- ============================================================

-- ---------- 1. 邀请奖励（替换 bind_inviter） ----------
create or replace function public.bind_inviter(p_code text)
returns boolean language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
declare inviter uuid;
declare invite_reward integer := 10000;
begin
  if uid is null then raise exception 'not authorized'; end if;
  if p_code is null or trim(p_code) = '' then return false; end if;

  if exists (select 1 from public.profiles where id = uid and invited_by is not null) then
    return exists (
      select 1 from public.profiles me join public.profiles up on up.id = me.invited_by
      where me.id = uid and up.invite_code = trim(p_code)
    );
  end if;

  select id into inviter from public.profiles
  where invite_code = trim(p_code) and status <> 'banned';

  if inviter is null or inviter = uid then return false; end if;

  update public.profiles
  set invited_by = inviter, invite_count = coalesce(invite_count, 0) + 1
  where id = inviter;

  insert into public.power_logs (user_id, amount, kind, note)
  values (inviter, invite_reward, 'invite', '成功邀请好友注册');
  update public.profiles set power = coalesce(power, 0) + invite_reward where id = inviter;

  return true;
end $$;
grant execute on function public.bind_inviter(text) to authenticated;

-- ---------- 2. 游戏实录审核通过 +500 ----------
create or replace function public.award_record_power()
returns trigger language plpgsql security definer set search_path = public as $$
declare amt integer := 500;
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    insert into public.power_logs (user_id, amount, kind, note)
    values (new.user_id, amt, 'record', '游戏实录审核通过');
    update public.profiles set power = coalesce(power, 0) + amt where id = new.user_id;
  end if;
  return new;
end $$;
drop trigger if exists trg_record_power on public.game_records;
create trigger trg_record_power after update of status on public.game_records
  for each row execute function public.award_record_power();

-- ---------- 3. 论坛发帖每日首次 +600 ----------
create or replace function public.award_post_power()
returns trigger language plpgsql security definer set search_path = public as $$
declare today date := (now() at time zone 'Asia/Shanghai')::date;
declare amt integer := 600;
begin
  if exists (
    select 1 from public.power_logs
    where user_id = new.user_id and kind = 'post'
      and (created_at at time zone 'Asia/Shanghai')::date = today
  ) then
    return new;
  end if;
  insert into public.power_logs (user_id, amount, kind, note)
  values (new.user_id, amt, 'post', '发布社区帖子');
  update public.profiles set power = coalesce(power, 0) + amt where id = new.user_id;
  return new;
end $$;
drop trigger if exists trg_post_power on public.posts;
create trigger trg_post_power after insert on public.posts
  for each row execute function public.award_post_power();

-- ---------- 4. 社区私信每日首次 +100 ----------
create or replace function public.award_message_power()
returns trigger language plpgsql security definer set search_path = public as $$
declare today date := (now() at time zone 'Asia/Shanghai')::date;
declare amt integer := 100;
begin
  if exists (
    select 1 from public.power_logs
    where user_id = new.sender_id and kind = 'message'
      and (created_at at time zone 'Asia/Shanghai')::date = today
  ) then
    return new;
  end if;
  insert into public.power_logs (user_id, amount, kind, note)
  values (new.sender_id, amt, 'message', '发送社区私信');
  update public.profiles set power = coalesce(power, 0) + amt where id = new.sender_id;
  return new;
end $$;
drop trigger if exists trg_message_power on public.messages;
create trigger trg_message_power after insert on public.messages
  for each row execute function public.award_message_power();
