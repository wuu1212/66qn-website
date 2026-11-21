-- ============================================================
-- 28. 公告改造 + QNID 登录绑定 + QQ 邮箱绑定（2026-11-21）
-- ============================================================
-- 用法：Supabase 控制台 → 左侧 SQL Editor → 新建查询 → 整段粘贴 → Run
--       本文件幂等，可以反复运行；某段报错会整体回滚，改好后原样重跑。
--
-- 这一版做了什么
--   A. 社区 → 公告：发帖权收回管理员（玩家不能再发帖）、评论/点赞写入口关闭、
--      私信下线（历史数据保留、禁止新写入），新增按天阅读流水（站内 / 游戏内分开统计）。
--   B. QNID：每个网站账号一个 QN 编号；游戏账号 ↔ QNID 用 4 位校验码双向确认。
--      校验码只在「本人网站账号申请 + 本人游戏账号在游戏内核销」这对组合下才有效。
--   C. QQ 绑定：QQ 号即邮箱前缀，发 6 位验证码到 QQ号@qq.com，验证通过才落库。
--      收件箱是玩家的 QQ 邮箱，发件仍走现有阿里云 SMTP（在 Edge Function 里发信），
--      不动 Supabase Auth 的唯一邮件通道。
--   D. 电力任务联动：私信 / 发帖两个奖励触发器停用（函数体保留，可一行恢复）。
--   E. 功能开关与模组参数进 server_settings.site。
--   F. 种子公告：以管理员名义发一条「登录方式与 QNID 绑定教程」，
--      模组进服提示直接把人引导到这条公告。
--
-- 依赖：schema.sql 与 patches/2026-10-23-*.sql 已执行（profiles / posts / app_secrets / is_admin 均已存在）。
-- 不含：Edge Function 部署（QQ 发信需要，见 backend/supabase/functions/ai/index.ts 与交付说明）。
--
-- 顺序说明：所有新表 / 新列统一放在第 0 节。PostgreSQL 在 CREATE FUNCTION 时就会校验函数体里
-- 引用的表和列，后建的表被先建的函数引用会直接报「关系不存在」，所以表结构必须先全部落地。
-- ============================================================

-- ============================================================
-- 0. 新增表与新增列（必须在任何函数之前）
-- ============================================================

-- 0.1 阅读流水：一行 = 一次有效阅读（同一读者 30 分钟内重复打开只算一次，见 view_announcement）
create table if not exists public.post_views (
  id         bigint generated always as identity primary key,
  post_id    uuid not null references public.posts(id) on delete cascade,
  viewer_id  uuid,                        -- 登录读者的 profiles.id（匿名阅读为空）
  visitor    text,                        -- 匿名读者指纹（前端本地生成）或游戏内标识 mc:<玩家名>
  reader_key text not null,              -- 去重键：登录用 uuid，站内匿名用 v:<visitor>，游戏内用 mc:<玩家名>
  source     text not null default 'web',-- web 站内 | game 游戏内
  viewed_on  date not null default ((now() at time zone 'Asia/Shanghai')::date),
  created_at timestamptz not null default now()
);
create index if not exists idx_post_views_day    on public.post_views(post_id, viewed_on);
create index if not exists idx_post_views_dedupe on public.post_views(post_id, reader_key, created_at desc);

-- 0.2 网站账号的 QNID（对外展示的编号，形如 QN418392）
alter table public.profiles add column if not exists qnid text;
create unique index if not exists ux_profiles_qnid on public.profiles(qnid) where qnid is not null;

-- 0.3 游戏账号绑定关系
create table if not exists public.game_bindings (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  game_username text not null,
  game_uuid     text not null default '',            -- 模组上报：正版 UUID 或离线派生 UUID
  premium       boolean not null default false,      -- 模组侧判定：true 正版 / false 离线
  status        text not null default 'bound',       -- bound | unbound
  source        text not null default 'code',        -- code 校验码 | admin 后台代绑
  bound_at      timestamptz not null default now(),
  last_seen_at  timestamptz,                         -- 最近一次进服（模组 lookup 时刷新）
  unbound_at    timestamptz,
  unbound_by    uuid references public.profiles(id),
  note          text not null default ''
);
-- 一个游戏账号同一时间只能属于一个 QNID（解绑后可以再被绑定）
create unique index if not exists ux_binding_game_active
  on public.game_bindings(lower(game_username)) where status = 'bound';
create index if not exists idx_binding_user on public.game_bindings(user_id, status);
create index if not exists idx_binding_seen on public.game_bindings(last_seen_at desc);

-- 0.4 QNID 4 位校验码
create table if not exists public.qnid_bind_codes (
  code          text primary key,                    -- 0000-9999
  user_id       uuid not null references public.profiles(id) on delete cascade,
  game_username text not null,
  status        text not null default 'pending',     -- pending | used | expired | cancelled | rejected
  attempts      integer not null default 0,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default (now() + interval '10 minutes'),
  used_at       timestamptz,
  redeemed_by   text                                 -- 实际来核销这个游戏码的游戏账号
);
create unique index if not exists ux_qnid_code_pending on public.qnid_bind_codes(code) where status = 'pending';
create index if not exists idx_qnid_code_user on public.qnid_bind_codes(user_id, status, created_at desc);
-- 失败核销的流水也留在这张表里（status='rejected' + attempts），用来做全局熔断判断

-- 0.5 QQ 绑定结果单独建表，不往 profiles 上加列
--     原因：profiles 的读策略现在是 using (true)（匿名可读全站），QQ 号放上去等于公开。
create table if not exists public.qq_bindings (
  user_id  uuid primary key references public.profiles(id) on delete cascade,
  qq       text not null,
  bound_at timestamptz not null default now(),
  source   text not null default 'code'
);
create unique index if not exists ux_qq_bindings_qq on public.qq_bindings(lower(qq));

-- 0.6 QQ 6 位验证码
create table if not exists public.qq_bind_codes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  qq         text not null,
  code       text not null,                          -- 6 位数字
  status     text not null default 'pending',        -- pending | used | expired | cancelled | rejected
  attempts   integer not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  used_at    timestamptz
);
create index if not exists idx_qq_code_user on public.qq_bind_codes(user_id, status, created_at desc);

-- 0.7 模组共享口令（第一次跑本补丁自动生成，取法见文件末尾「部署后必做」）
insert into public.app_secrets (key, value)
select 'mod_secret', encode(extensions.gen_random_bytes(16), 'hex')
where not exists (select 1 from public.app_secrets where key = 'mod_secret');

-- 0.8 RLS：新表全部启用行级安全。
--     这几张表都属于运营/身份数据，故意不给 anon 任何读取权限；
--     需要跨权限读的地方一律走下面的 security definer 函数。
alter table public.post_views     enable row level security;
alter table public.game_bindings  enable row level security;
alter table public.qnid_bind_codes enable row level security;
alter table public.qq_bindings    enable row level security;
alter table public.qq_bind_codes  enable row level security;

drop policy if exists "post_views_admin" on public.post_views;
create policy "post_views_admin" on public.post_views for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "binding_read_own" on public.game_bindings;
create policy "binding_read_own" on public.game_bindings for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
-- game_bindings 不给任何写入策略：写入只走 B6/B7/B9 的函数

drop policy if exists "qq_read_own" on public.qq_bindings;
create policy "qq_read_own" on public.qq_bindings for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- qnid_bind_codes / qq_bind_codes：一条策略都不建，anon key 直连必查不到，只能走函数

-- ============================================================
-- A. 公告改造
-- ============================================================

-- A1. 阅读计数
--     view_post(uuid)         旧签名，原样保留：Cloudflare 缓存里的老前端还在调它，不能断
--     view_announcement(...)  新签名，带读者指纹与来源，返回本次是否计入阅读量
create or replace function public.view_post(p_id uuid)
returns void language sql security definer set search_path = public as $$
  update public.posts set view_count = view_count + 1
  where id = p_id and status = 'published';
$$;

create or replace function public.view_announcement(
  p_id uuid,
  p_visitor text default null,
  p_source  text default 'web'
)
returns boolean language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
declare vid text := nullif(left(btrim(coalesce(p_visitor, '')), 64), '');
declare who text;
begin
  if p_id is null then return false; end if;
  if not exists (select 1 from public.posts where id = p_id and status = 'published') then
    return false;
  end if;

  who := coalesce(uid::text, 'v:' || coalesce(vid, 'anon'));

  if exists (
    select 1 from public.post_views
    where post_id = p_id and reader_key = who and created_at > now() - interval '30 minutes'
  ) then
    return false;   -- 30 分钟内同一读者重复打开，不重复计
  end if;

  insert into public.post_views (post_id, viewer_id, visitor, reader_key, source)
  values (p_id, uid, vid, who,
          case when coalesce(nullif(btrim(p_source), ''), 'web') = 'game' then 'game' else 'web' end);
  update public.posts set view_count = view_count + 1 where id = p_id;
  return true;
end $$;

grant execute on function public.view_post(uuid)                     to anon, authenticated;
grant execute on function public.view_announcement(uuid, text, text) to anon, authenticated;

-- A2. 玩家端只读收口：公告变成单向广播
--     发帖：只有管理员能发。后台发布免审核（前端不再调 AI moderate，直接 status='published'）
drop policy if exists "posts_insert" on public.posts;
create policy "posts_insert" on public.posts for insert to authenticated
  with check (user_id = auth.uid() and public.is_admin());

--     编辑：管理员独占。玩家对自己历史帖子的写入口一并关闭（公告是官方口径，不容个人改写）
drop policy if exists "posts_update" on public.posts;
create policy "posts_update" on public.posts for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

--     评论 / 点赞：不再接受新写入。历史行留在库里（后台仍可查），前台不展示
drop policy if exists "comments_insert" on public.comments;
drop policy if exists "likes_write"     on public.likes;
drop policy if exists "likes_delete"    on public.likes;

--     私信：功能下线。删掉收发双方的读取策略，改成仅管理员可读（数据不删，随时可恢复）
drop policy if exists "msg_read"   on public.messages;
drop policy if exists "msg_insert" on public.messages;
drop policy if exists "msg_delete" on public.messages;
create policy "msg_read_admin" on public.messages for select to authenticated
  using (public.is_admin());

-- A3. 后台发布 / 编辑公告（一个函数搞定新建和修改，标题正文长度在服务端校验）
create or replace function public.admin_publish_announcement(
  p_id uuid, p_title text, p_content text, p_category text, p_pinned boolean, p_status text
)
returns uuid language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
declare cat text := case when p_category in ('announcement', 'guide', 'changelog', 'general')
                         then p_category else 'announcement' end;
declare st  text := case when p_status in ('published', 'hidden') then p_status else 'published' end;
declare new_id uuid;
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  if p_title is null or length(btrim(p_title)) < 2 then raise exception '标题至少 2 个字'; end if;
  if p_content is null or length(btrim(p_content)) < 5 then raise exception '正文至少 5 个字'; end if;

  if p_id is not null then
    update public.posts
       set title = btrim(p_title), content = p_content, category = cat,
           is_pinned = coalesce(p_pinned, false), status = st, updated_at = now()
     where id = p_id
    returning id into new_id;
    if new_id is null then raise exception '公告不存在'; end if;
    return new_id;
  end if;

  insert into public.posts (user_id, title, content, category, is_pinned, status)
  values (uid, btrim(p_title), p_content, cat, coalesce(p_pinned, false), st)
  returning id into new_id;
  return new_id;
end $$;
grant execute on function public.admin_publish_announcement(uuid, text, text, text, boolean, text) to authenticated;

-- A4. 后台阅读数据 ①：每日阅读量（总量 / 独立读者 / 站内 / 游戏内）
create or replace function public.admin_announcement_daily(p_days integer default 14)
returns jsonb language plpgsql security definer set search_path = public as $$
declare span integer := greatest(1, least(90, coalesce(p_days, 14)));
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'day',     d.day::text,
      'views',   coalesce(s.views, 0),
      'readers', coalesce(s.readers, 0),
      'game',    coalesce(s.game, 0),
      'web',     coalesce(s.web, 0)
    ) order by d.day desc)
    from (
      select ((now() at time zone 'Asia/Shanghai')::date - (gs - 1)) as day
      from generate_series(1, span) as gs
    ) d
    left join lateral (
      select count(*)                              as views,
             count(distinct v.reader_key)          as readers,
             count(*) filter (where v.source = 'game') as game,
             count(*) filter (where v.source = 'web')  as web
        from public.post_views v
       where v.viewed_on = d.day
    ) s on true
  ), '[]'::jsonb);
end $$;
grant execute on function public.admin_announcement_daily(integer) to authenticated;

-- A5. 后台阅读数据 ②：每条公告的阅读情况（今日 / 近 7 天 / 累计 / 独立读者）
create or replace function public.admin_announcement_posts(p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path = public as $$
declare lim integer := greatest(1, least(200, coalesce(p_limit, 50)));
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', p.id, 'title', p.title, 'category', p.category, 'status', p.status,
      'is_pinned', p.is_pinned, 'author', a.username, 'qnid', a.qnid,
      'created_at', p.created_at, 'total', p.view_count,
      'today', coalesce(s.today, 0), 'week', coalesce(s.week, 0),
      'game',  coalesce(s.game, 0), 'web', coalesce(s.web, 0),
      'readers', coalesce(s.readers, 0)
    ) order by p.is_pinned desc, p.created_at desc)
    from (select * from public.posts where status <> 'deleted'
          order by created_at desc limit lim) p
    left join public.profiles a on a.id = p.user_id
    left join lateral (
      select count(*) filter (where v.viewed_on = ((now() at time zone 'Asia/Shanghai')::date)) as today,
             count(*) filter (where v.created_at > now() - interval '7 days') as week,
             count(*) filter (where v.source = 'game') as game,
             count(*) filter (where v.source = 'web')  as web,
             count(distinct v.reader_key)              as readers
        from public.post_views v where v.post_id = p.id
    ) s on true
  ), '[]'::jsonb);
end $$;
grant execute on function public.admin_announcement_posts(integer) to authenticated;

-- A6. 游戏内公告拉取：最新 N 条（RLS 已允许匿名读 published，这里只做裁剪，
--     正文截到 2000 字，避免刷屏；阅读上报由模组另外调 view_announcement，只报真正展示过的那条）
create or replace function public.game_announcements(p_limit integer default 5)
returns jsonb language plpgsql security definer set search_path = public as $$
declare lim integer := greatest(1, least(10, coalesce(p_limit, 5)));
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', x.id, 'title', x.title, 'category', x.category,
      'content', left(x.content, 2000), 'created_at', x.created_at, 'is_pinned', x.is_pinned
    ) order by x.rn)
    from (
      select p.id, p.title, p.category, p.content, p.created_at, p.is_pinned,
             row_number() over (order by p.is_pinned desc, p.created_at desc) as rn
        from public.posts p
       where p.status = 'published'
       order by p.is_pinned desc, p.created_at desc
       limit lim
    ) x
  ), '[]'::jsonb);
end $$;
grant execute on function public.game_announcements(integer) to anon, authenticated;

-- ============================================================
-- B. QNID 与游戏账号绑定
-- ============================================================

-- B1. 生成 QN 编号 + 老账号补号 + 新账号自动带号
create or replace function public.gen_qnid()
returns text language plpgsql as $$
declare c text;
begin
  loop
    c := 'QN' || ((floor(random() * 900000) + 100000)::bigint)::text;
    exit when not exists (select 1 from public.profiles where qnid = c);
  end loop;
  return c;
end $$;

update public.profiles set qnid = public.gen_qnid() where qnid is null;
alter table public.profiles alter column qnid set default public.gen_qnid();

-- B2. 模组与数据库之间的共享口令。校验码核销和状态查询都只认这个口令，
--     它只存在于服务端 config/q66login.json 和数据库 app_secrets 里，浏览器永远拿不到。
create or replace function public.mod_secret_ok(p_secret text)
returns boolean language sql security definer set search_path = public as $$
  select coalesce(p_secret, '') <> ''
     and p_secret = (select value from public.app_secrets where key = 'mod_secret');
$$;

-- B3. 网站侧：申请 4 位校验码
create or replace function public.qnid_request_code(p_game_username text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
declare me public.profiles;
declare raw_name text := btrim(coalesce(p_game_username, ''));
declare recent integer;
declare bound_qnid text;
declare c text;
declare tries integer := 0;
begin
  if uid is null then raise exception 'not authorized'; end if;
  select * into me from public.profiles where id = uid;
  if me.id is null then raise exception '账号信息缺失，请重新登录'; end if;
  if me.status = 'banned' then raise exception '该账号已被封禁，无法绑定游戏账号'; end if;

  if raw_name !~ '^[A-Za-z0-9_]{2,16}$' then
    return jsonb_build_object('ok', false, 'error', '游戏账号只能是 2-16 位字母、数字或下划线');
  end if;

  -- 已经被绑走就直接说明，省得白折腾一轮
  select p.qnid into bound_qnid
  from public.game_bindings b join public.profiles p on p.id = b.user_id
  where b.status = 'bound' and lower(b.game_username) = lower(raw_name)
  limit 1;
  if bound_qnid is not null then
    if coalesce(bound_qnid, '') = coalesce(me.qnid, '') then
      return jsonb_build_object('ok', false, 'error', '这个账号已经绑定到你的 QNID，直接进游戏就能玩');
    end if;
    return jsonb_build_object('ok', false, 'error', '这个游戏账号已绑定其它 QNID，需要解绑请联系管理员');
  end if;

  -- 限频：每小时最多申请 5 次
  select count(*) into recent from public.qnid_bind_codes
  where user_id = uid and created_at > now() - interval '1 hour';
  if recent >= 5 then
    return jsonb_build_object('ok', false, 'error', '申请太频繁，请一小时后再试');
  end if;

  -- 一个账号只保留最新一张有效码，旧的作废
  update public.qnid_bind_codes set status = 'cancelled' where user_id = uid and status = 'pending';

  loop
    c := lpad((floor(random() * 10000))::bigint::text, 4, '0');
    tries := tries + 1;
    exit when not exists (select 1 from public.qnid_bind_codes where code = c and status = 'pending');
    if tries > 30 then
      return jsonb_build_object('ok', false, 'error', '暂时生成不了校验码，请稍后再试');
    end if;
  end loop;

  insert into public.qnid_bind_codes (code, user_id, game_username) values (c, uid, raw_name);

  return jsonb_build_object('ok', true, 'code', c, 'game_username', raw_name,
                            'expires_at', (now() + interval '10 minutes'), 'qnid', me.qnid);
end $$;
grant execute on function public.qnid_request_code(text) to authenticated;

-- B4. 网站侧：轮询自己那张码的状态（模组核销成功后这里就变成 used）
create or replace function public.qnid_code_status()
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
declare r public.qnid_bind_codes;
begin
  if uid is null then raise exception 'not authorized'; end if;
  select * into r from public.qnid_bind_codes where user_id = uid order by created_at desc limit 1;
  if r.code is null then return jsonb_build_object('status', 'none'); end if;

  if r.status = 'pending' and r.expires_at < now() then
    update public.qnid_bind_codes set status = 'expired' where code = r.code and status = 'pending';
    r.status := 'expired';
  end if;

  return jsonb_build_object(
    'status', r.status,
    'code', case when r.status = 'pending' then r.code else null end,
    'game_username', r.game_username, 'attempts', r.attempts,
    'expires_at', r.expires_at, 'used_at', r.used_at, 'redeemed_by', r.redeemed_by);
end $$;
grant execute on function public.qnid_code_status() to authenticated;

-- B5. 网站侧：作废校验码 / 查看我的绑定 / 自助解绑（解绑在前端要过当前密码二次确认）
create or replace function public.qnid_cancel_code()
returns boolean language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authorized'; end if;
  update public.qnid_bind_codes set status = 'cancelled' where user_id = uid and status = 'pending';
  return found;
end $$;
grant execute on function public.qnid_cancel_code() to authenticated;

create or replace function public.qnid_my_bindings()
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authorized'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', b.id, 'game_username', b.game_username, 'premium', b.premium,
      'source', b.source, 'bound_at', b.bound_at, 'last_seen_at', b.last_seen_at
    ) order by b.bound_at desc)
    from public.game_bindings b
   where b.user_id = uid and b.status = 'bound'
  ), '[]'::jsonb);
end $$;
grant execute on function public.qnid_my_bindings() to authenticated;

create or replace function public.qnid_unbind(p_binding uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authorized'; end if;
  update public.game_bindings
     set status = 'unbound', unbound_at = now(), unbound_by = uid,
         note = case when public.is_admin() then '管理员解绑' else '玩家自助解绑' end
   where id = p_binding and status = 'bound' and (user_id = uid or public.is_admin());
  return found;
end $$;
grant execute on function public.qnid_unbind(uuid) to authenticated;

-- B6. 模组侧：进服时查绑定状态（顺带刷新 last_seen_at）
--     只返回模组判断准入需要的非敏感字段。
create or replace function public.qnid_lookup(p_username text, p_secret text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare b public.game_bindings;
declare p public.profiles;
begin
  if not public.mod_secret_ok(p_secret) then raise exception 'not authorized'; end if;

  select * into b from public.game_bindings
  where status = 'bound' and lower(game_username) = lower(btrim(coalesce(p_username, '')))
  limit 1;
  if b.id is null then
    return jsonb_build_object('ok', true, 'bound', false);
  end if;

  update public.game_bindings set last_seen_at = now() where id = b.id;
  select * into p from public.profiles where id = b.user_id;
  if p.status = 'banned' then
    return jsonb_build_object('ok', true, 'bound', true, 'banned', true, 'qnid', p.qnid);
  end if;
  return jsonb_build_object('ok', true, 'bound', true, 'banned', false,
                            'qnid', p.qnid, 'username', p.username, 'premium', b.premium);
end $$;
revoke all on function public.qnid_lookup(text, text) from public;
grant execute on function public.qnid_lookup(text, text) to anon, authenticated;

-- B7. 模组侧：核销校验码完成绑定
--     防被盗绑的关键设计：码是「哪个网站账号申请的」+「要求绑哪个游戏账号」都记在码上，
--     核销时必须是同一个游戏账号本人来打 /QNID。攻击者就算猜中 4 位码，
--     只要他不是在服务器里用那个账号本人登录，就核销不掉；猜错还会把 attempts 累加直至作废。
create or replace function public.qnid_redeem_code(
  p_code text, p_username text, p_uuid text, p_premium boolean, p_secret text
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.qnid_bind_codes;
declare me public.profiles;
declare uname text := btrim(coalesce(p_username, ''));
declare other_bound uuid;
declare my_count integer;
declare fail_count integer;
begin
  if not public.mod_secret_ok(p_secret) then
    return jsonb_build_object('ok', false, 'error', '模组口令不正确');
  end if;

  -- 全局熔断：近一小时累计 60 次失败核销就先停 10 分钟，防着被人拿 anon key 枚举 4 位码
  select count(*) into fail_count from public.qnid_bind_codes
  where created_at > now() - interval '1 hour'
    and (status = 'rejected' or (status = 'pending' and attempts >= 5));
  if fail_count >= 60 then
    return jsonb_build_object('ok', false, 'error', '绑定请求异常，已临时保护，请 10 分钟后再试');
  end if;

  if uname !~ '^[A-Za-z0-9_]{2,16}$' then
    return jsonb_build_object('ok', false, 'error', '游戏账号名不合法');
  end if;

  select * into r from public.qnid_bind_codes where code = btrim(coalesce(p_code, ''));
  if r.code is null then
    return jsonb_build_object('ok', false, 'error', '校验码不存在，请回网站重新申请');
  end if;
  if r.status = 'used' then
    return jsonb_build_object('ok', false, 'error', '这个校验码已经用过，请回网站重新申请');
  end if;
  if r.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', '校验码已失效，请回网站重新申请');
  end if;
  if r.expires_at < now() then
    update public.qnid_bind_codes set status = 'expired' where code = r.code;
    return jsonb_build_object('ok', false, 'error', '校验码已过期（10 分钟有效），请回网站重新申请');
  end if;

  -- 码和人不匹配：这张码不是给当前这个玩家用的
  if lower(r.game_username) <> lower(uname) then
    update public.qnid_bind_codes
       set attempts = attempts + 1,
           status = case when attempts + 1 >= 5 then 'rejected' else 'pending' end,
           redeemed_by = uname
     where code = r.code;
    return jsonb_build_object('ok', false, 'error',
      '校验码和当前游戏账号不匹配（申请时填的是 ' || r.game_username || '），请核对后重试');
  end if;

  select * into me from public.profiles where id = r.user_id;
  if me.id is null then
    update public.qnid_bind_codes set status = 'rejected' where code = r.code;
    return jsonb_build_object('ok', false, 'error', '对应的网站账号不存在');
  end if;
  if me.status = 'banned' then
    return jsonb_build_object('ok', false, 'error', '该网站账号已被封禁，无法绑定');
  end if;

  -- 这个游戏账号是否已经属于别的 QNID（防止核销动作把别人的绑定抢过来）
  select user_id into other_bound from public.game_bindings
  where status = 'bound' and lower(game_username) = lower(uname) and user_id <> r.user_id;
  if other_bound is not null then
    update public.qnid_bind_codes set status = 'rejected' where code = r.code;
    return jsonb_build_object('ok', false, 'error', '这个游戏账号已绑定其它 QNID，请联系管理员');
  end if;

  -- 一个 QNID 最多 3 个在绑游戏账号
  select count(*) into my_count from public.game_bindings
  where user_id = r.user_id and status = 'bound';
  if my_count >= 3 then
    return jsonb_build_object('ok', false, 'error', '你的 QNID 已绑定 3 个游戏账号，达到上限');
  end if;

  update public.qnid_bind_codes
     set status = 'used', used_at = now(), redeemed_by = uname, attempts = attempts + 1
   where code = r.code;

  insert into public.game_bindings (user_id, game_username, game_uuid, premium, source, last_seen_at)
  values (r.user_id, uname, coalesce(nullif(btrim(p_uuid), ''), ''), coalesce(p_premium, false), 'code', now())
  on conflict (lower(game_username)) where status = 'bound'
    do update set game_uuid = excluded.game_uuid, premium = excluded.premium,
                  last_seen_at = now(), note = '同一账号重新核销'
      where game_bindings.user_id = excluded.user_id;

  return jsonb_build_object('ok', true, 'qnid', me.qnid, 'username', me.username,
                            'game_username', uname, 'premium', coalesce(p_premium, false));
end $$;
revoke all on function public.qnid_redeem_code(text, text, text, boolean, text) from public;
grant execute on function public.qnid_redeem_code(text, text, text, boolean, text) to anon, authenticated;

-- B8. 后台：绑定总览（真实游戏账号 ↔ QNID，含最近进服时间）
create or replace function public.admin_list_bindings(p_keyword text default null, p_limit integer default 200)
returns jsonb language plpgsql security definer set search_path = public as $$
declare kw text := nullif(btrim(coalesce(p_keyword, '')), '');
declare lim integer := greatest(1, least(500, coalesce(p_limit, 200)));
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', b.id, 'game_username', b.game_username, 'game_uuid', b.game_uuid,
      'premium', b.premium, 'status', b.status, 'source', b.source,
      'bound_at', b.bound_at, 'last_seen_at', b.last_seen_at, 'unbound_at', b.unbound_at,
      'note', b.note, 'qnid', p.qnid, 'site_username', p.username,
      'qq', coalesce(nullif(q.qq, ''), ''),
      'email_mask', case when p.email is null then '' else split_part(p.email, '@', 1) || '@***' end
    ) order by b.bound_at desc)
    from public.game_bindings b
    join public.profiles p on p.id = b.user_id
    left join public.qq_bindings q on q.user_id = b.user_id
    where kw is null
       or lower(b.game_username) like '%' || lower(kw) || '%'
       or lower(p.username)       like '%' || lower(kw) || '%'
       or lower(coalesce(p.qnid, '')) like '%' || lower(kw) || '%'
    limit lim
  ), '[]'::jsonb);
end $$;
grant execute on function public.admin_list_bindings(text, integer) to authenticated;

-- B9. 后台：代绑 / 改绑（线下核过身的玩家，管理员直接建绑定，不用校验码）
create or replace function public.admin_bind_manually(p_qnid text, p_game_username text, p_premium boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare target uuid;
declare uname text := btrim(coalesce(p_game_username, ''));
declare taken uuid;
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  if uname !~ '^[A-Za-z0-9_]{2,16}$' then
    return jsonb_build_object('ok', false, 'error', '游戏账号只能是 2-16 位字母、数字或下划线');
  end if;

  select id into target from public.profiles
  where lower(coalesce(qnid, '')) = lower(btrim(coalesce(p_qnid, '')))
     or lower(username) = lower(btrim(coalesce(p_qnid, '')))
  limit 1;
  if target is null then return jsonb_build_object('ok', false, 'error', '找不到这个 QNID 或网站昵称'); end if;

  select user_id into taken from public.game_bindings
  where status = 'bound' and lower(game_username) = lower(uname) and user_id <> target;
  if taken is not null then
    return jsonb_build_object('ok', false, 'error', '这个游戏账号已绑定其它 QNID，请先在列表里解绑');
  end if;

  insert into public.game_bindings (user_id, game_username, premium, status, source, note, last_seen_at)
  values (target, uname, coalesce(p_premium, false), 'bound', 'admin', '管理员代绑', now())
  on conflict (lower(game_username)) where status = 'bound'
    do update set premium = excluded.premium, status = 'bound', source = 'admin',
                  note = '管理员改绑', bound_at = now()
      where game_bindings.user_id = excluded.user_id;

  update public.qnid_bind_codes set status = 'cancelled'
  where status = 'pending' and lower(game_username) = lower(uname);

  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.admin_bind_manually(text, text, boolean) to authenticated;

-- B10. 模组侧：服主在游戏里也能查绑定（网站后台是主入口，这里只是应急方便）。
--      用 mod_secret 而不是 is_admin()，因为模组只有 anon key，没有玩家 JWT。
create or replace function public.mod_list_bindings(p_secret text, p_keyword text default null, p_limit integer default 30)
returns jsonb language plpgsql security definer set search_path = public as $$
declare kw text := nullif(btrim(coalesce(p_keyword, '')), '');
declare lim integer := greatest(1, least(100, coalesce(p_limit, 30)));
begin
  if not public.mod_secret_ok(p_secret) then
    return jsonb_build_object('ok', false, 'error', '模组口令不正确');
  end if;
  return jsonb_build_object('ok', true, 'rows', coalesce((
    select jsonb_agg(jsonb_build_object(
      'game_username', b.game_username, 'premium', b.premium, 'status', b.status,
      'qnid', p.qnid, 'site_username', p.username, 'bound_at', b.bound_at,
      'last_seen_at', b.last_seen_at
    ) order by b.bound_at desc), '[]'::jsonb)
    from public.game_bindings b
    join public.profiles p on p.id = b.user_id
    where kw is null
       or lower(b.game_username) like '%' || lower(kw) || '%'
       or lower(coalesce(p.qnid, '')) like '%' || lower(kw) || '%'
    limit lim
  ), '[]'::jsonb));
end $$;
revoke all on function public.mod_list_bindings(text, text, integer) from public;
grant execute on function public.mod_list_bindings(text, text, integer) to anon, authenticated;

-- ============================================================
-- C. QQ 邮箱绑定
-- ============================================================

-- C1. 生成验证码：只允许 Edge Function（service_role）调用。
--     如果开放给 anon，任何人拿公开密钥就能反复给任意 QQ 邮箱发信，这个通道会被拿去轰炸。
create or replace function public.qq_create_bind_code(p_user uuid, p_qq text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me public.profiles;
declare v_qq text := btrim(coalesce(p_qq, ''));
declare owner uuid;
declare recent integer;
declare c text;
begin
  if v_qq !~ '^[1-9][0-9]{4,10}$' then
    return jsonb_build_object('ok', false, 'error', 'QQ 号格式不对：应为 5-11 位数字，且不能以 0 开头');
  end if;

  select * into me from public.profiles where id = p_user;
  if me.id is null then return jsonb_build_object('ok', false, 'error', '账号不存在'); end if;
  if me.status = 'banned' then return jsonb_build_object('ok', false, 'error', '该账号已被封禁'); end if;

  -- 这个 QQ 是不是已经属于别的账号（列名也叫 qq，所以这里一律带表别名 qb.，并用 v_qq 变量，避免歧义）
  select qb.user_id into owner from public.qq_bindings qb where lower(qb.qq) = lower(v_qq) limit 1;
  if owner is not null and owner <> p_user then
    return jsonb_build_object('ok', false, 'error', '这个 QQ 已经绑定了其它账号，请联系管理员处理');
  end if;

  select count(*) into recent from public.qq_bind_codes
  where user_id = p_user and created_at > now() - interval '1 hour';
  if recent >= 5 then return jsonb_build_object('ok', false, 'error', '发送太频繁，请一小时后再试'); end if;

  update public.qq_bind_codes set status = 'cancelled' where user_id = p_user and status = 'pending';

  c := lpad((floor(random() * 1000000))::bigint::text, 6, '0');
  insert into public.qq_bind_codes (user_id, qq, code) values (p_user, v_qq, c);

  return jsonb_build_object('ok', true, 'code', c, 'mail_to', v_qq || '@qq.com', 'qq', v_qq,
                            'nickname', me.username, 'expires_at', (now() + interval '15 minutes'));
end $$;
revoke all on function public.qq_create_bind_code(uuid, text) from public;
revoke all on function public.qq_create_bind_code(uuid, text) from anon;
revoke all on function public.qq_create_bind_code(uuid, text) from authenticated;
grant execute on function public.qq_create_bind_code(uuid, text) to service_role;

-- C2. 玩家填码确认 → 落库
create or replace function public.qq_confirm_bind(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
declare r public.qq_bind_codes;
declare dup uuid;
begin
  if uid is null then raise exception 'not authorized'; end if;

  select * into r from public.qq_bind_codes
  where user_id = uid and code = btrim(coalesce(p_code, '')) and status = 'pending'
  order by created_at desc limit 1;
  if r.id is null then
    return jsonb_build_object('ok', false, 'error', '验证码不正确或已失效，请重新获取');
  end if;
  if r.expires_at < now() then
    update public.qq_bind_codes set status = 'expired' where id = r.id;
    return jsonb_build_object('ok', false, 'error', '验证码已过期（15 分钟有效），请重新获取');
  end if;
  if r.attempts >= 5 then
    update public.qq_bind_codes set status = 'rejected' where id = r.id;
    return jsonb_build_object('ok', false, 'error', '输错次数过多，请重新获取验证码');
  end if;

  update public.qq_bind_codes set attempts = attempts + 1 where id = r.id;

  select qb.user_id into dup from public.qq_bindings qb where lower(qb.qq) = lower(r.qq);
  if dup is not null and dup <> uid then
    update public.qq_bind_codes set status = 'rejected' where id = r.id;
    return jsonb_build_object('ok', false, 'error', '这个 QQ 已经绑定了其它账号，请联系管理员处理');
  end if;

  update public.qq_bind_codes set status = 'used', used_at = now() where id = r.id;

  insert into public.qq_bindings (user_id, qq, source) values (uid, r.qq, 'code')
  on conflict (user_id) do update set qq = excluded.qq, bound_at = now(), source = 'code';

  return jsonb_build_object('ok', true, 'qq', r.qq, 'mail_to', r.qq || '@qq.com');
end $$;
grant execute on function public.qq_confirm_bind(text) to authenticated;

-- C3. 我的 QQ 状态 / 自助解绑（前端要二次确认 + 当前密码才调）
create or replace function public.qq_my_state()
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
declare b public.qq_bindings;
declare has_pending boolean;
begin
  if uid is null then raise exception 'not authorized'; end if;
  select * into b from public.qq_bindings where user_id = uid;
  select exists (
    select 1 from public.qq_bind_codes
    where user_id = uid and status = 'pending' and expires_at > now()
  ) into has_pending;
  return jsonb_build_object(
    'bound', b.user_id is not null, 'qq', coalesce(b.qq, ''), 'bound_at', b.bound_at,
    'mail_to', case when b.qq is null then '' else b.qq || '@qq.com' end,
    'pending', has_pending);
end $$;
grant execute on function public.qq_my_state() to authenticated;

create or replace function public.qq_unbind_self()
returns boolean language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authorized'; end if;
  delete from public.qq_bindings where user_id = uid;
  update public.qq_bind_codes set status = 'cancelled' where user_id = uid and status = 'pending';
  return found;
end $$;
grant execute on function public.qq_unbind_self() to authenticated;

-- C4. 后台：全站 QQ 绑定一览
create or replace function public.admin_list_qq_bindings()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'qq', q.qq, 'mail_to', q.qq || '@qq.com', 'bound_at', q.bound_at, 'source', q.source,
      'qnid', p.qnid, 'username', p.username, 'games', coalesce(g.game_list, '[]'::jsonb)
    ) order by q.bound_at desc)
    from public.qq_bindings q
    join public.profiles p on p.id = q.user_id
    left join lateral (
      select jsonb_agg(jsonb_build_object('game_username', b.game_username, 'premium', b.premium)) as game_list
        from public.game_bindings b
       where b.user_id = q.user_id and b.status = 'bound'
    ) g on true
  ), '[]'::jsonb);
end $$;
grant execute on function public.admin_list_qq_bindings() to authenticated;

-- ============================================================
-- D. 电力任务联动：私信 / 发帖 奖励停用
--    函数体保留。将来想恢复只跑这两行：
--      create trigger trg_message_power after insert on public.messages
--        for each row execute function public.award_message_power();
--      create trigger trg_post_power after insert on public.posts
--        for each row execute function public.award_post_power();
-- ============================================================
drop trigger if exists trg_message_power on public.messages;
drop trigger if exists trg_post_power    on public.posts;

-- ============================================================
-- E. 功能开关与模组参数（进 server_settings.key='site'）
--    沿用本项目约定：依赖邮件链路的新功能默认关闭，后台勾了才露入口。
-- ============================================================
insert into public.server_settings (key, value)
values ('site', jsonb_build_object(
  'qnid_bind_enabled', true,
  'qq_bind_enabled', false,
  'game_announcement_enabled', true,
  'qn_limit_premium_min', 120,
  'qn_limit_offline_min', 60,
  'qn_announcement_refresh_sec', 300))
on conflict (key) do nothing;

-- 只补缺失的键：管理员在后台改过的值一律保留，不会被这次补丁覆盖回去
update public.server_settings
set value = value || jsonb_build_object(
      'qnid_bind_enabled',           coalesce(value -> 'qnid_bind_enabled',           'true'::jsonb),
      'qq_bind_enabled',             coalesce(value -> 'qq_bind_enabled',             'false'::jsonb),
      'game_announcement_enabled',   coalesce(value -> 'game_announcement_enabled',   'true'::jsonb),
      'qn_limit_premium_min',        coalesce(value -> 'qn_limit_premium_min',        '120'::jsonb),
      'qn_limit_offline_min',        coalesce(value -> 'qn_limit_offline_min',        '60'::jsonb),
      'qn_announcement_refresh_sec', coalesce(value -> 'qn_announcement_refresh_sec', '300'::jsonb)),
    updated_at = now()
where key = 'site';

-- ============================================================
-- F. 种子公告：登录方式教程（模组进服提示会引导玩家来看这条；置顶）
--    幂等：同标题已存在就什么都不做。还没有管理员账号时跳过（建好后重跑本文件即可）。
-- ============================================================
do $$
declare admin_id uuid;
begin
  if exists (select 1 from public.posts
             where title = '【必读】66QN 登录方式与 QNID 绑定教程' and status <> 'deleted') then
    return;
  end if;

  select id into admin_id from public.profiles
  where role = 'admin' and status = 'active' order by created_at limit 1;
  if admin_id is null then
    raise notice '还没有管理员账号，跳过教程公告写入（建好管理员后重跑本补丁即可）';
    return;
  end if;

  insert into public.posts (user_id, title, content, category, is_pinned, status)
  values (
    admin_id,
    '【必读】66QN 登录方式与 QNID 绑定教程',
    E'进服前先看清楚自己是哪种账号。两种都能玩，只是流程不一样。\n\n## 一、正版账号（用微软账号登录启动器的）\n\n正版账号进服免密码，不用输密码、不用装额外东西。\n但正版账号同样要绑一次 QNID，绑定完成才算正式入服，之后不限时长。\n\n## 二、离线版账号（启动器里自己填名字的）\n\n离线账号必须绑定 QNID 才能正常游玩，一共 3 步：\n\n1. 打开官网 66qnmc.top，登录网站账号，进入「账号绑定」页；\n2. 输入你进服用的游戏账号，点「立即绑定」，网页给出一个 4 位数字校验码（10 分钟内有效）；\n3. 回到游戏，在聊天框输入 /QNID 你的4位码（例如 /QNID 3071），看到「绑定成功」就完成了。\n\n校验码是和你填的游戏账号一一绑定的：别人猜到你的码，也必须用同一个游戏账号进服才能核销，所以不用担心被盗绑。\n\n## 三、没绑定会怎样\n\n没绑定不会被踢出服务器，但会受限：\n\n- 正版账号：每天限玩 2 小时；\n- 离线账号：每天限玩 1 小时；\n- 受限期间禁止放置危险品（岩浆、TNT、末影水晶等）；\n- 时长按北京时间 0 点重置，用完会被请出服务器，第二天还能进。\n\n绑定完成之后以上限制全部解除。管理员和服主不受限制。\n\n## 四、绑定 QQ 号（可选，但强烈建议）\n\n在「个人中心 → 账号绑定」输入你的 QQ 号，系统会往 你的QQ号@qq.com 发一封带 6 位验证码的邮件，填码即完成绑定。\n绑定后管理员能通过 QQ 找到你，账号出问题（忘记密码、被误封）时处理快很多。\n\n## 五、随时查自己的状态\n\n游戏里输入 /QNID（不带参数）就能看到自己的 QNID、当前判定是正版还是离线、今天还剩多少时间。\n网站上「个人中心 → 账号绑定」能看全部已绑定的游戏账号，不需要了可以自助解绑（要输当前密码确认）。',
    'guide', true, 'published'
  );
end $$;

-- ============================================================
-- 部署后必做（模组端）
--   1) 单独运行下面这句，把结果填进服务端 config/q66login.json 的 secret 字段：
--        select value from public.app_secrets where key = 'mod_secret';
--   2) 后台「公告管理 → 功能开关」确认 qnid_bind_enabled 已打开；
--      qq_bind_enabled 等 Edge Function（action=qq_bind 发信）部署完再打开。
--
-- 自检（整段可反复运行）
--   select public.qnid_redeem_code('0000','Tester','','','wrong-secret') as r1;  -- 期望 error=模组口令不正确
--   select public.game_announcements(1)                                   as r2;  -- 期望 返回一条公告的 jsonb
--   select public.qnid_lookup('Tester','wrong-secret')                            as r3;  -- 期望 报 not authorized
--   select count(*) as bindings from public.game_bindings;                              -- 期望 0
--   select value->'qn_limit_offline_min' as offline_min
--     from public.server_settings where key = 'site';                                   -- 期望 60
--   select day, views, readers, game, web from public.admin_announcement_daily(7);
--     -- 注意：这句用 SQL Editor 跑才有效（它是 postgres 身份）；
--     -- 想验证 anon 能不能偷看，去网站控制台调 sb.rpc('admin_announcement_daily') 应当被拒。
-- ============================================================
