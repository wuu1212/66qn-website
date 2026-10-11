-- ============================================================
-- 66qn 网站数据库（Supabase 免费方案 · 最终版）
-- 架构：Supabase Auth（邮箱+GitHub 登录）+ PostgreSQL + RLS 权限
-- 使用方法：Supabase 左侧「SQL 编辑器」→ 新建查询 → 粘贴全部 → 运行
-- 如需彻底重来，先执行：
--   drop table if exists reports, messages, likes, comments, posts, server_settings, profiles cascade;
-- ============================================================

-- ---------- 1. 用户档案表（登录账号本身由 Supabase Auth 管理）----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text unique not null,
  email       text unique,
  game_id     text,
  register_reason text,
  avatar_url  text,
  role        text not null default 'user',    -- user | admin
  status      text not null default 'active',  -- active | banned
  bio         text default '',
  created_at  timestamptz not null default now()
);

-- ---------- 2. 帖子 ----------
create table if not exists public.posts (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  title          text not null,
  content        text not null,
  category       text not null default 'general',
  likes_count    integer not null default 0,
  comments_count integer not null default 0,
  view_count     integer not null default 0,
  is_pinned      boolean not null default false,
  status         text not null default 'published', -- published | hidden | deleted
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ---------- 3. 评论 ----------
create table if not exists public.comments (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references public.posts(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  parent_id  uuid references public.comments(id) on delete cascade,
  content    text not null,
  status     text not null default 'published',
  created_at timestamptz not null default now()
);

-- ---------- 4. 点赞 ----------
create table if not exists public.likes (
  post_id    uuid not null references public.posts(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

-- ---------- 5. 私信 ----------
create table if not exists public.messages (
  id          uuid primary key default gen_random_uuid(),
  sender_id   uuid not null references public.profiles(id) on delete cascade,
  receiver_id uuid not null references public.profiles(id) on delete cascade,
  content     text not null,
  status      text not null default 'sent',  -- sent | read | recalled
  created_at  timestamptz not null default now()
);

-- ---------- 6. 举报 ----------
create table if not exists public.reports (
  id          uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  target_type text not null,          -- post | comment | message | user
  target_id   uuid not null,
  reason      text not null,
  status      text not null default 'pending', -- pending | resolved | dismissed
  admin_note  text,
  created_at  timestamptz not null default now()
);

-- ---------- 7. 服务器设置（官网后台可改）----------
create table if not exists public.server_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---------- 8. 可扩展内容：玩法、指令、活动、游戏实录、AI 配置 ----------
create table if not exists public.game_features (
  id uuid primary key default gen_random_uuid(), title text not null, description text not null default '', sort_order integer not null default 0, enabled boolean not null default true, created_at timestamptz not null default now()
);
create table if not exists public.server_commands (
  id uuid primary key default gen_random_uuid(), command text not null, description text not null default '', permission text not null default '玩家', enabled boolean not null default true, created_at timestamptz not null default now()
);
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(), name text not null, description text not null default '', starts_at timestamptz, ends_at timestamptz, signup_enabled boolean not null default false, enabled boolean not null default true, created_at timestamptz not null default now()
);
create table if not exists public.event_signups (
  id uuid primary key default gen_random_uuid(), event_id uuid not null references public.events(id) on delete cascade, user_id uuid not null references public.profiles(id) on delete cascade, text_content text not null default '', image_url text, created_at timestamptz not null default now(), unique(event_id, user_id)
);
create table if not exists public.game_records (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id) on delete cascade, player_name text not null, coordinates text not null, image_url text not null, status text not null default 'pending', created_at timestamptz not null default now()
);
create table if not exists public.ai_configs (
  id uuid primary key default gen_random_uuid(), name text not null, api_url text not null default '', encrypted_api_key text not null default '', model text not null default '', prompt text not null default '', standard_answers jsonb not null default '[]'::jsonb, enabled boolean not null default true, scopes text[] not null default '{posts,reports}', created_at timestamptz not null default now()
);

create index if not exists idx_posts_created   on public.posts(status, created_at desc);
create index if not exists idx_comments_post   on public.comments(post_id);
create index if not exists idx_messages_both   on public.messages(sender_id, receiver_id, created_at);
create index if not exists idx_reports_pending on public.reports(status, created_at desc);

-- ---------- 默认设置（服务器 IP/端口/版本，之后在管理后台随时改）----------
insert into public.server_settings (key, value) values
  ('server', jsonb_build_object(
    'name','66qn 我的世界服务器','edition','Java 原版生存',
    'ip','待填写','port','25565','version','待填写',
    'motd','欢迎来到 66qn！','maxPlayers',20))
on conflict (key) do nothing;

insert into public.server_settings (key, value) values
  ('site', jsonb_build_object(
    'title','66qn','slogan','原版生存 · 自由建造',
    'qq_group','https://qm.qq.com/q/bZNAGK8Rs4',
    'bilibili','https://space.bilibili.com/3546783978359356',
    'landmarks','https://gaox.s.gy/66qn'))
on conflict (key) do nothing;

-- ============================================================
-- 8. 注册时自动创建档案
--    邮箱注册时把 username 放进 user_metadata；GitHub 登录用 login
-- ============================================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, email, game_id, register_reason, avatar_url)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data->>'username',
      split_part(coalesce(new.email, new.raw_user_meta_data->>'user_login', ''), '@', 1),
      'player_' || substr(new.id::text, 1, 6)
    ),
    new.email,
    new.raw_user_meta_data->>'game_id',
    new.raw_user_meta_data->>'register_reason',
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- 9. 管理员判断函数（security definer 避免 RLS 递归）
-- ============================================================
create or replace function public.is_admin()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and status = 'active'
  );
$$;

-- ============================================================
-- 10. 行级安全（RLS）—— 浏览器直连也只按规则放行
-- ============================================================
alter table public.profiles        enable row level security;
alter table public.posts           enable row level security;
alter table public.comments        enable row level security;
alter table public.likes           enable row level security;
alter table public.messages        enable row level security;
alter table public.reports         enable row level security;
alter table public.server_settings enable row level security;
alter table public.game_features enable row level security;
alter table public.server_commands enable row level security;
alter table public.events enable row level security;
alter table public.event_signups enable row level security;
alter table public.game_records enable row level security;
alter table public.ai_configs enable row level security;

-- 新增内容表：公开内容可读，管理员可维护；报名和实录由登录用户提交
create policy "features_read" on public.game_features for select using (enabled = true or public.is_admin());
create policy "features_admin" on public.game_features for all using (public.is_admin()) with check (public.is_admin());
create policy "commands_read" on public.server_commands for select using (enabled = true or public.is_admin());
create policy "commands_admin" on public.server_commands for all using (public.is_admin()) with check (public.is_admin());
create policy "events_read" on public.events for select using (enabled = true or public.is_admin());
create policy "events_admin" on public.events for all using (public.is_admin()) with check (public.is_admin());
create policy "event_signups_own" on public.event_signups for all using (user_id = auth.uid() or public.is_admin()) with check (user_id = auth.uid() or public.is_admin());
create policy "records_read" on public.game_records for select using (status = 'approved' or user_id = auth.uid() or public.is_admin());
create policy "records_insert" on public.game_records for insert to authenticated with check (user_id = auth.uid());
create policy "records_admin" on public.game_records for update using (public.is_admin()) with check (public.is_admin());
create policy "ai_admin" on public.ai_configs for all using (public.is_admin()) with check (public.is_admin());

-- profiles：所有人可见；本人可补建档案 / 本人或管理员可改
drop policy if exists "profiles_read"    on public.profiles;
drop policy if exists "profiles_insert"  on public.profiles;
drop policy if exists "profiles_update"  on public.profiles;
create policy "profiles_read" on public.profiles for select using (true);
create policy "profiles_insert" on public.profiles for insert to authenticated with check (id = auth.uid());
create policy "profiles_update" on public.profiles for update
  using (id = auth.uid() or public.is_admin());

-- posts
drop policy if exists "posts_read"   on public.posts;
drop policy if exists "posts_insert" on public.posts;
drop policy if exists "posts_update" on public.posts;
drop policy if exists "posts_delete" on public.posts;
create policy "posts_read" on public.posts for select using (status = 'published' or user_id = auth.uid() or public.is_admin());
create policy "posts_insert" on public.posts for insert to authenticated with check (user_id = auth.uid());
create policy "posts_update" on public.posts for update using (user_id = auth.uid() or public.is_admin());
create policy "posts_delete" on public.posts for delete using (user_id = auth.uid() or public.is_admin());

-- comments
drop policy if exists "comments_read"   on public.comments;
drop policy if exists "comments_insert" on public.comments;
drop policy if exists "comments_delete" on public.comments;
create policy "comments_read" on public.comments for select using (status = 'published' or user_id = auth.uid() or public.is_admin());
create policy "comments_insert" on public.comments for insert to authenticated with check (user_id = auth.uid());
create policy "comments_delete" on public.comments for delete using (user_id = auth.uid() or public.is_admin());

-- likes
drop policy if exists "likes_read"   on public.likes;
drop policy if exists "likes_write"  on public.likes;
drop policy if exists "likes_delete" on public.likes;
create policy "likes_read" on public.likes for select using (true);
create policy "likes_write" on public.likes for insert to authenticated with check (user_id = auth.uid());
create policy "likes_delete" on public.likes for delete using (user_id = auth.uid());

-- messages：仅收发双方可见；本人才能发（≤5000字）；改状态走下方 RPC
drop policy if exists "msg_read"     on public.messages;
drop policy if exists "msg_insert"   on public.messages;
drop policy if exists "msg_delete"   on public.messages;
create policy "msg_read" on public.messages for select using (sender_id = auth.uid() or receiver_id = auth.uid());
create policy "msg_insert" on public.messages for insert to authenticated with check (sender_id = auth.uid() and char_length(content) <= 5000);
create policy "msg_delete" on public.messages for delete using (sender_id = auth.uid() or receiver_id = auth.uid() or public.is_admin());

-- reports：登录可提交；只有管理员可查看全部并处理
drop policy if exists "reports_insert" on public.reports;
drop policy if exists "reports_admin"  on public.reports;
create policy "reports_insert" on public.reports for insert to authenticated with check (reporter_id = auth.uid());
create policy "reports_admin" on public.reports for all using (public.is_admin()) with check (public.is_admin());

-- server_settings：所有人可读；管理员可写
drop policy if exists "settings_read"  on public.server_settings;
drop policy if exists "settings_write" on public.server_settings;
create policy "settings_read" on public.server_settings for select using (true);
create policy "settings_write" on public.server_settings for all using (public.is_admin()) with check (public.is_admin());

-- ============================================================
-- 11. 计数联动（数据库自动维护点赞数/评论数）
-- ============================================================
create or replace function public.sync_like_count() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'INSERT') then
    update public.posts set likes_count = likes_count + 1 where id = new.post_id;
  else
    update public.posts set likes_count = greatest(0, likes_count - 1) where id = old.post_id;
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists trg_like_count on public.likes;
create trigger trg_like_count after insert or delete on public.likes
  for each row execute function public.sync_like_count();

create or replace function public.sync_comment_count() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'INSERT') then
    update public.posts set comments_count = comments_count + 1 where id = new.post_id;
  else
    update public.posts set comments_count = greatest(0, comments_count - 1) where id = old.post_id;
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists trg_comment_count on public.comments;
create trigger trg_comment_count after insert or delete on public.comments
  for each row execute function public.sync_comment_count();

-- ============================================================
-- 12. 安全 RPC（浏览 +1 / 标记已读 / 撤回，权限在函数内校验）
-- ============================================================
create or replace function public.view_post(p_id uuid)
returns void language sql security definer set search_path = public as $$
  update public.posts set view_count = view_count + 1
  where id = p_id and status = 'published';
$$;

create or replace function public.mark_messages_read(p_other uuid)
returns void language sql security definer set search_path = public as $$
  update public.messages set status = 'read'
  where sender_id = p_other and receiver_id = auth.uid() and status = 'sent';
$$;

-- 撤回：仅发送者本人、仅 2 分钟内、仅未撤回的消息
create or replace function public.recall_message(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update public.messages set status = 'recalled'
  where id = p_id and sender_id = auth.uid() and status = 'sent'
    and now() - created_at < interval '2 minutes';
  get diagnostics n = row_count;
  return n > 0;
end $$;

grant execute on function public.view_post(uuid)                 to anon, authenticated;
grant execute on function public.mark_messages_read(uuid)        to authenticated;
grant execute on function public.recall_message(uuid)            to authenticated;

-- ============================================================
-- 完成。下一步：第一个注册的用户设为管理员
-- （你先在网站上注册一次，然后把下面这行的邮箱换成你的，再运行一次）
-- ============================================================
-- update public.profiles set role = 'admin'
--   where id = (select id from auth.users where email = '你的邮箱@example.com');
