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
-- （先 drop 再 create，保证本文件可以反复运行不报错）
drop policy if exists "features_read" on public.game_features;
drop policy if exists "features_admin" on public.game_features;
drop policy if exists "commands_read" on public.server_commands;
drop policy if exists "commands_admin" on public.server_commands;
drop policy if exists "events_read" on public.events;
drop policy if exists "events_admin" on public.events;
drop policy if exists "event_signups_own" on public.event_signups;
drop policy if exists "records_read" on public.game_records;
drop policy if exists "records_insert" on public.game_records;
drop policy if exists "records_admin" on public.game_records;
drop policy if exists "ai_admin" on public.ai_configs;
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
-- 13. 服务协议 / 免责声明 签署记录
-- ============================================================
create table if not exists public.agreements (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  version     text not null default 'v1',
  accepted_at timestamptz not null default now()
);
alter table public.agreements enable row level security;
drop policy if exists "agreements_own" on public.agreements;
create policy "agreements_own" on public.agreements for all
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

-- ============================================================
-- 14. AI 密钥加密存储（任何人无法通过接口读取，仅服务端可解密）
-- ============================================================
-- Supabase 的扩展默认装在 extensions 模式下，因此下面统一用 extensions. 前缀调用
create extension if not exists pgcrypto with schema extensions;

-- 先补齐 ai_configs 的列（必须在下面的函数之前，否则函数体校验会报列不存在）
alter table public.ai_configs add column if not exists priority integer not null default 10;
alter table public.ai_configs add column if not exists temperature numeric not null default 0.3;

create table if not exists public.ai_secrets (
  config_id     uuid primary key references public.ai_configs(id) on delete cascade,
  encrypted_key text not null,
  updated_at    timestamptz not null default now()
);
alter table public.ai_secrets enable row level security;
-- 注意：故意不建立 select 策略，任何前端（含管理员）都无法读回明文密钥
drop policy if exists "ai_secrets_insert" on public.ai_secrets;
drop policy if exists "ai_secrets_update" on public.ai_secrets;
drop policy if exists "ai_secrets_delete" on public.ai_secrets;
create policy "ai_secrets_insert" on public.ai_secrets for insert to authenticated with check (public.is_admin());
create policy "ai_secrets_update" on public.ai_secrets for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "ai_secrets_delete" on public.ai_secrets for delete to authenticated using (public.is_admin());

-- 写入密钥（前端调用；内部使用 pgcrypto 对称加密）
create or replace function public.admin_set_ai_key(p_config uuid, p_key text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  insert into public.ai_secrets (config_id, encrypted_key)
  values (p_config, encode(extensions.pgp_sym_encrypt(p_key, coalesce(current_setting('app.ai_secret', true), '66qn-default-secret-change-me')), 'base64'))
  on conflict (config_id) do update set encrypted_key = excluded.encrypted_key, updated_at = now();
end $$;
grant execute on function public.admin_set_ai_key(uuid, text) to authenticated;

-- 仅供服务端（service_role）解密使用
create or replace function public.get_ai_key(p_config uuid, p_secret text)
returns text language sql security definer set search_path = public as $$
  select extensions.pgp_sym_decrypt(decode(encrypted_key, 'base64'), p_secret)
  from public.ai_secrets where config_id = p_config;
$$;
revoke all on function public.get_ai_key(uuid, text) from public;
revoke all on function public.get_ai_key(uuid, text) from anon;
revoke all on function public.get_ai_key(uuid, text) from authenticated;

-- 供服务端读取 AI 配置（含密钥），仅 service_role
create or replace function public.get_ai_configs(p_secret text)
returns jsonb language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'name', c.name, 'api_url', c.api_url, 'model', c.model,
    'prompt', c.prompt, 'standard_answers', c.standard_answers,
    'scopes', c.scopes, 'priority', c.priority, 'temperature', c.temperature,
    'api_key', public.get_ai_key(c.id, p_secret)
  ) order by c.priority asc), '[]'::jsonb)
  from public.ai_configs c where c.enabled = true;
$$;
revoke all on function public.get_ai_configs(text) from public;
revoke all on function public.get_ai_configs(text) from anon;
revoke all on function public.get_ai_configs(text) from authenticated;

-- ============================================================
-- 15. AI 审核结果落库（帖子/评论/举报）
--    （priority / temperature 两列已在第 14 节开头补齐）
-- ============================================================
create table if not exists public.ai_reviews (
  id          uuid primary key default gen_random_uuid(),
  target_type text not null,           -- post | comment | report
  target_id   uuid not null,
  verdict     text not null,           -- allow | reject | error
  reason      text,
  model       text,
  created_at  timestamptz not null default now()
);
alter table public.ai_reviews enable row level security;
drop policy if exists "ai_reviews_admin" on public.ai_reviews;
create policy "ai_reviews_admin" on public.ai_reviews for all
  using (public.is_admin()) with check (public.is_admin());

-- ============================================================
-- 16. 举报处理动作（支持"禁止使用/删除内容"）
-- ============================================================
create or replace function public.resolve_report_action(p_report uuid, p_action text)
returns boolean language plpgsql security definer set search_path = public as $$
declare r public.reports;
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  select * into r from public.reports where id = p_report;
  if r.id is null then return false; end if;

  if p_action = 'delete' then
    if r.target_type = 'post' then
      update public.posts set status = 'deleted' where id = r.target_id;
    elsif r.target_type = 'comment' then
      update public.comments set status = 'deleted' where id = r.target_id;
    elsif r.target_type = 'message' then
      update public.messages set status = 'recalled' where id = r.target_id;
    elsif r.target_type = 'user' then
      update public.profiles set status = 'banned' where id = r.target_id;
    end if;
    update public.reports set status = 'resolved', admin_note = '已删除内容（处理人：' || coalesce(auth.jwt()->>'email','admin') || '）' where id = p_report;
  elsif p_action = 'ban' then
    if r.target_type = 'post' then
      update public.posts set status = 'deleted' where id = r.target_id;
      update public.profiles set status = 'banned' where id = (select user_id from public.posts where id = r.target_id);
    elsif r.target_type = 'comment' then
      update public.comments set status = 'deleted' where id = r.target_id;
      update public.profiles set status = 'banned' where id = (select user_id from public.comments where id = r.target_id);
    elsif r.target_type = 'user' then
      update public.profiles set status = 'banned' where id = r.target_id;
    end if;
    update public.reports set status = 'resolved', admin_note = '已封禁用户（处理人：' || coalesce(auth.jwt()->>'email','admin') || '）' where id = p_report;
  else
    update public.reports set status = 'dismissed', admin_note = '已驳回' where id = p_report;
  end if;
  return true;
end $$;
grant execute on function public.resolve_report_action(uuid, text) to authenticated;

-- ============================================================
-- 17. 补齐缺失的权限策略
-- ============================================================
drop policy if exists "comments_update" on public.comments;
create policy "comments_update" on public.comments for update
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists "records_delete" on public.game_records;
create policy "records_delete" on public.game_records for delete using (public.is_admin());

drop policy if exists "posts_delete_admin" on public.posts;

-- ============================================================
-- 18. 文件存储（Supabase Storage 默认 AES-256 静态加密 + HTTPS 传输）
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit)
values ('uploads', 'uploads', true, 5242880)
on conflict (id) do nothing;

drop policy if exists "uploads_read" on storage.objects;
drop policy if exists "uploads_insert" on storage.objects;
drop policy if exists "uploads_delete" on storage.objects;
create policy "uploads_read" on storage.objects for select using (bucket_id = 'uploads');
create policy "uploads_insert" on storage.objects for insert to authenticated with check (bucket_id = 'uploads');
create policy "uploads_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'uploads' and owner = auth.uid());

-- ============================================================
-- 19. 下载页 · 自有模组（管理员在后台维护名称与下载链接）
-- ============================================================
create table if not exists public.mods (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text not null default '',
  version     text not null default '',
  url         text not null default '',
  sort_order  integer not null default 0,
  enabled     boolean not null default true,
  created_at  timestamptz not null default now()
);
alter table public.mods enable row level security;
drop policy if exists "mods_read"  on public.mods;
drop policy if exists "mods_admin" on public.mods;
create policy "mods_read"  on public.mods for select using (enabled = true or public.is_admin());
create policy "mods_admin" on public.mods for all using (public.is_admin()) with check (public.is_admin());

-- ============================================================
-- 完成。部署清单：
-- 1) 先在 Supabase 执行本文件全部 SQL
-- 2) 执行下面这行，为 AI 密钥加密设置口令（务必改成你自己的随机串，然后重新连接）
-- 3) 注册第一个账号后，把下面 admin 那行的邮箱换成你的，再运行一次
-- 4) 部署 Edge Function：backend/supabase/functions/ai/index.ts（见 README）
-- ============================================================
-- alter database postgres set app.ai_secret = '请替换为你的随机长字符串';
-- update public.profiles set role = 'admin'
--   where id = (select id from auth.users where email = '你的邮箱@example.com');
