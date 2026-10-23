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
declare new_id uuid;
declare gift integer := 5000;
begin
  insert into public.profiles (id, username, email, game_id, register_reason, avatar_url, power, invite_code)
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
    new.raw_user_meta_data->>'avatar_url',
    gift,
    public.gen_invite_code()
  )
  on conflict (id) do nothing
  returning id into new_id;

  if new_id is not null then
    insert into public.power_logs (user_id, amount, kind, note)
    values (new_id, gift, 'newuser', '新用户注册赠送');
  end if;
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
-- 给已有用户补齐邮箱，确保邮箱登录和用户名反查都可用
update public.profiles p
set email = u.email
from auth.users u
where p.id = u.id and (p.email is null or p.email = '');
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
-- 各场景独立提示词：prompt = 客服；下面三个分别是帖子审核 / 评论审核 / 举报复核
alter table public.ai_configs add column if not exists prompt_post text not null default '';
alter table public.ai_configs add column if not exists prompt_comment text not null default '';
alter table public.ai_configs add column if not exists prompt_report text not null default '';

-- 加密口令存放表（故意不建 select 策略：前端无法读取；只在 SQL 编辑器里写入）
create table if not exists public.app_secrets (
  key   text primary key,
  value text not null
);
alter table public.app_secrets enable row level security;

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

-- 写入密钥（前端调用；口令取自 app_secrets，内部用 pgcrypto 对称加密）
create or replace function public.admin_set_ai_key(p_config uuid, p_key text)
returns void language plpgsql security definer set search_path = public as $$
declare s text;
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  select value into s from public.app_secrets where key = 'ai_secret';
  if s is null then s := '66qn-default-secret-change-me'; end if;
  insert into public.ai_secrets (config_id, encrypted_key)
  values (p_config, encode(extensions.pgp_sym_encrypt(p_key, s), 'base64'))
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
    'prompt_post', c.prompt_post, 'prompt_comment', c.prompt_comment, 'prompt_report', c.prompt_report,
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
-- 20. 成员名单（前台展示，并与服务器在线玩家对比显示状态）
-- ============================================================
create table if not exists public.members (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,                        -- 游戏 ID（用于与在线玩家比对）
  display_name text not null default '',             -- 展示名，留空则显示游戏 ID
  role         text not null default '成员',          -- 服主 / 管理 / 成员 …
  description  text not null default '',
  avatar_url   text not null default '',
  sort_order   integer not null default 0,
  enabled      boolean not null default true,
  created_at   timestamptz not null default now()
);
alter table public.members enable row level security;
drop policy if exists "members_read"  on public.members;
drop policy if exists "members_admin" on public.members;
create policy "members_read"  on public.members for select using (enabled = true or public.is_admin());
create policy "members_admin" on public.members for all using (public.is_admin()) with check (public.is_admin());

-- ============================================================
-- 21. 电力系统（每日登录 +100 / 新用户注册 +5000；兑换后期开放）
-- ============================================================
alter table public.profiles add column if not exists power integer not null default 0;
-- 个人邀请码：6 位纯数字，由系统生成，可在电力页更换
alter table public.profiles add column if not exists invite_code text unique;
alter table public.profiles add column if not exists invited_by uuid;
alter table public.profiles add column if not exists invite_count integer not null default 0;

create table if not exists public.power_logs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  amount     integer not null,
  kind       text not null default 'manual',   -- newuser | daily | admin
  note       text not null default '',
  created_at timestamptz not null default now()
);
alter table public.power_logs enable row level security;
drop policy if exists "power_logs_own"  on public.power_logs;
drop policy if exists "power_logs_admin" on public.power_logs;
create policy "power_logs_own"  on public.power_logs for select
  using (user_id = auth.uid() or public.is_admin());
create policy "power_logs_admin" on public.power_logs for all
  using (public.is_admin()) with check (public.is_admin());
create index if not exists idx_power_logs_user on public.power_logs(user_id, created_at desc);

-- 给已存在的老用户补一次新用户赠送（只补没有记录过的，避免重复发放）
insert into public.power_logs (user_id, amount, kind, note)
select p.id, 5000, 'newuser', '新用户注册赠送'
from public.profiles p
where not exists (select 1 from public.power_logs l where l.user_id = p.id and l.kind = 'newuser');

update public.profiles p
set power = coalesce(power, 0) + 5000
where not exists (select 1 from public.power_logs l where l.user_id = p.id and l.kind = 'newuser');

-- 每日签到（按北京时间计算，每天仅一次，返回本次获得的电力，0 表示今天已领过）
create or replace function public.claim_daily_power()
returns integer language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
declare today date := (now() at time zone 'Asia/Shanghai')::date;
declare last_day date;
declare amt integer;
begin
  if uid is null then raise exception 'not authorized'; end if;

  select (created_at at time zone 'Asia/Shanghai')::date into last_day
  from public.power_logs
  where user_id = uid and kind = 'daily'
  order by created_at desc limit 1;

  if last_day is not null and last_day >= today then
    return 0;
  end if;

  insert into public.power_logs (user_id, amount, kind, note)
  values (uid, 100, 'daily', '每日登录赠送')
  returning amount into amt;

  update public.profiles set power = coalesce(power, 0) + amt where id = uid;
  return amt;
end $$;
grant execute on function public.claim_daily_power() to authenticated;

-- 管理员手动调整电力（可正可负）
create or replace function public.admin_add_power(p_user uuid, p_amount integer, p_note text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  insert into public.power_logs (user_id, amount, kind, note)
  values (p_user, p_amount, 'admin', coalesce(nullif(trim(p_note), ''), '管理员调整'));
  update public.profiles set power = coalesce(power, 0) + p_amount where id = p_user;
end $$;
grant execute on function public.admin_add_power(uuid, integer, text) to authenticated;

-- ============================================================
-- 22. 个人邀请码（6 位纯数字，注册时选填；填写后双方建立邀请关系）
-- ============================================================
create or replace function public.gen_invite_code()
returns text language plpgsql as $$
declare c text;
begin
  loop
    c := lpad((floor(random() * 1000000))::bigint::text, 6, '0');
    exit when not exists (select 1 from public.profiles where invite_code = c);
  end loop;
  return c;
end $$;

-- 生成/更换自己的邀请码
create or replace function public.regenerate_invite_code()
returns text language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
declare c text;
begin
  if uid is null then raise exception 'not authorized'; end if;
  c := public.gen_invite_code();
  update public.profiles set invite_code = c where id = uid;
  return c;
end $$;
grant execute on function public.regenerate_invite_code() to authenticated;

-- 注册时绑定邀请人（选填；幂等，重复绑定返回原结果）
-- 邀请奖励：每成功邀请 1 位好友注册，邀请人获得 10000 电力（一次性）
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

-- 给自己补一个邀请码（老用户）
update public.profiles
set invite_code = public.gen_invite_code()
where invite_code is null;

-- ============================================================
-- 23. 申请注册（免邮箱）：提交申请 → 后台审核 → 自动建号
--     密码与保密答案用 pgcrypto 加密保存，前端无任何读取权限
-- ============================================================
alter table public.profiles add column if not exists security_q text not null default '';
alter table public.profiles add column if not exists security_a_enc text not null default '';

create table if not exists public.account_applications (
  id         uuid primary key default gen_random_uuid(),
  nickname   text not null,                          -- 申请的昵称（登录名）
  contact    text not null,                          -- 联系方式：游戏ID / QQ / 微信（禁止填邮箱）
  secret_q   text not null,                          -- 保密问题
  secret_a   text not null,                          -- 保密答案（加密）
  pwd        text not null,                          -- 密码（加密）
  status     text not null default 'pending',        -- pending | approved | rejected
  note       text not null default '',
  user_id    uuid,                                   -- 审核通过后创建的账号
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);
alter table public.account_applications enable row level security;
drop policy if exists "apps_admin" on public.account_applications;
create policy "apps_admin" on public.account_applications for all
  using (public.is_admin()) with check (public.is_admin());
create index if not exists idx_apps_status on public.account_applications(status, created_at desc);

-- 提交申请：匿名可用；昵称/联系方式/密码/保密问题全部在服务端校验并加密
create or replace function public.apply_account(
  p_nickname text, p_contact text, p_password text, p_question text, p_answer text
)
returns uuid language plpgsql security definer set search_path = public as $$
declare k text; new_id uuid;
begin
  if p_nickname is null or length(btrim(p_nickname)) < 3 or length(btrim(p_nickname)) > 20 then
    raise exception '昵称需3-20个字符';
  end if;
  if position('@' in p_nickname) > 0 then raise exception '昵称不能包含 @'; end if;
  if p_contact is null or length(btrim(p_contact)) < 2 then raise exception '请填写联系方式'; end if;
  if position('@' in p_contact) > 0 then raise exception '联系方式不能填邮箱，请填游戏ID、QQ或微信'; end if;
  if p_password is null or length(p_password) < 6 then raise exception '密码至少6位'; end if;
  if p_question is null or length(btrim(p_question)) < 2 then raise exception '请设置保密问题'; end if;
  if p_answer is null or length(btrim(p_answer)) < 1 then raise exception '请填写保密答案'; end if;

  select coalesce(value, '66qn-default-secret-change-me') into k
  from public.app_secrets where key = 'account_secret';

  if exists (select 1 from public.profiles where lower(username) = lower(btrim(p_nickname))) then
    raise exception '该昵称已被占用，请换一个';
  end if;
  if exists (select 1 from public.account_applications
             where lower(nickname) = lower(btrim(p_nickname)) and status = 'pending') then
    raise exception '该昵称已有待审核的申请，请换一个或等待审核';
  end if;

  insert into public.account_applications (nickname, contact, secret_q, secret_a, pwd)
  values (
    btrim(p_nickname), btrim(p_contact), btrim(p_question),
    encode(extensions.pgp_sym_encrypt(btrim(p_answer), k), 'base64'),
    encode(extensions.pgp_sym_encrypt(p_password, k), 'base64')
  )
  returning id into new_id;
  return new_id;
end $$;
grant execute on function public.apply_account(text, text, text, text, text) to anon, authenticated;

-- 管理员改状态（创建账号由 Edge Function 完成，成功后自动置为 approved）
create or replace function public.review_application(p_app uuid, p_action text, p_note text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  if p_action = 'reject' then
    update public.account_applications
    set status = 'rejected', note = coalesce(nullif(btrim(p_note), ''), '未通过'), reviewed_at = now()
    where id = p_app;
  else
    update public.account_applications
    set status = 'approved', note = coalesce(btrim(p_note), ''), reviewed_at = now()
    where id = p_app;
  end if;
  return true;
end $$;
grant execute on function public.review_application(uuid, text, text) to authenticated;

-- 以下三个函数仅供服务端（service_role / Edge Function）调用
create or replace function public.get_application_secret(p_app uuid)
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'nickname', a.nickname,
    'contact',  a.contact,
    'question', a.secret_q,
    'answer',   extensions.pgp_sym_decrypt(decode(a.secret_a, 'base64'), (select coalesce(value,'66qn-default-secret-change-me') from public.app_secrets where key = 'account_secret')),
    'password', extensions.pgp_sym_decrypt(decode(a.pwd, 'base64'), (select coalesce(value,'66qn-default-secret-change-me') from public.app_secrets where key = 'account_secret'))
  )
  from public.account_applications a where a.id = p_app;
$$;
revoke all on function public.get_application_secret(uuid) from public;
revoke all on function public.get_application_secret(uuid) from anon;
revoke all on function public.get_application_secret(uuid) from authenticated;

create or replace function public.complete_application(p_app uuid, p_user uuid)
returns void language sql security definer set search_path = public as $$
  update public.account_applications
  set status = 'approved', user_id = p_user, reviewed_at = now()
  where id = p_app;
$$;
revoke all on function public.complete_application(uuid, uuid) from public;
revoke all on function public.complete_application(uuid, uuid) from anon;
revoke all on function public.complete_application(uuid, uuid) from authenticated;

create or replace function public.set_profile_security(p_user uuid, p_question text, p_answer text)
returns void language plpgsql security definer set search_path = public as $$
declare k text;
begin
  select coalesce(value, '66qn-default-secret-change-me') into k
  from public.app_secrets where key = 'account_secret';
  update public.profiles
  set security_q = btrim(p_question),
      security_a_enc = encode(extensions.pgp_sym_encrypt(btrim(p_answer), k), 'base64')
  where id = p_user;
end $$;
revoke all on function public.set_profile_security(uuid, text, text) from public;
revoke all on function public.set_profile_security(uuid, text, text) from anon;
revoke all on function public.set_profile_security(uuid, text, text) from authenticated;

-- 管理员查看某条申请的保密答案（用于客服核身）
create or replace function public.admin_view_security_answer(p_app uuid)
returns text language sql security definer set search_path = public as $$
  select extensions.pgp_sym_decrypt(decode(secret_a, 'base64'), (select coalesce(value,'66qn-default-secret-change-me') from public.app_secrets where key = 'account_secret'))
  from public.account_applications where id = p_app;
$$;
grant execute on function public.admin_view_security_answer(uuid) to authenticated;

-- ============================================================
-- 完成。部署清单：
-- 1) 先在 Supabase 执行本文件全部 SQL
-- 2) 写入 AI 加密口令（把随机串换成你自己的），见文件末尾示例
-- 3) 注册第一个账号后，把下面 admin 那行的邮箱换成你的，再运行一次
-- 4) 部署 Edge Function：backend/supabase/functions/ai/index.ts，并在其 Secrets 里
--    设置 AI_SECRET = 与第 2 步完全相同的字符串
-- ============================================================
-- insert into public.app_secrets (key, value) values ('ai_secret', '请替换为你的随机长字符串')
--   on conflict (key) do update set value = excluded.value;
-- update public.profiles set role = 'admin'
--   where id = (select id from auth.users where email = '你的邮箱@example.com');

-- ============================================================
-- 24. 开放平台（第三方模组 / AI 助手凭 UID 调用；管理员后台管理）
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

-- ============================================================
-- 25. 电力任务系统（2026-10-23）
--   游戏实录审核通过 +500（每次通过均奖励）
--   论坛发帖 +600（每日首次，按北京时间去重）
--   发送社区私信 +100（每日首次，按北京时间去重）
--   邀请奖励 10000/人（见第 22 节 bind_inviter，已改为实际发放）
-- ============================================================

-- 游戏实录：审核通过（非 approved → approved）奖励 500
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

-- 论坛发帖：每日首次发帖奖励 600
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

-- 社区私信：每日首次发送奖励 100
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

-- ============================================================
-- 26. 启动器管理（下载页 · 启动器，管理员可增删改，2026-10-23）
--     description 支持 **词语** 语法，前端渲染为蓝底加粗强调
--     tags 逗号分隔，第一个显示为蓝色徽标
-- ============================================================
create table if not exists public.launchers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  subtitle    text not null default '',           -- 括号内全称（可选）
  description text not null default '',           -- 描述，支持 **强调** 语法
  url         text not null default '',
  tags        text not null default '',           -- 逗号分隔，第一个显示为蓝色
  sort_order  integer not null default 0,
  enabled     boolean not null default true,
  created_at  timestamptz not null default now()
);
alter table public.launchers enable row level security;
drop policy if exists "launchers_read"  on public.launchers;
drop policy if exists "launchers_admin" on public.launchers;
create policy "launchers_read"  on public.launchers for select using (enabled = true or public.is_admin());
create policy "launchers_admin" on public.launchers for all using (public.is_admin()) with check (public.is_admin());

-- 初始数据（幂等：按名称判重，已存在则不插入，管理员删除后重跑也不会重复灌）
insert into public.launchers (name, subtitle, description, url, tags, sort_order)
select v.name, v.subtitle, v.description, v.url, v.tags, v.sort_order
from (values
  ('HMCL', 'Hello Minecraft! Launcher', '跨平台、功能丰富的 Java 版启动器，支持多版本管理、微软账户登录、模组加载器。', 'https://hmcl.huangyuhui.net/download/', '推荐,Windows,macOS,Linux', 0),
  ('FCL',  'Fold Craft Launcher',      '安卓专属启动器，触屏优化，支持在手机上运行 Minecraft Java 版。', 'https://github.com/FCL-Team/FoldCraftLauncher/releases', 'Android,开源', 1),
  ('PCL',  'Plain Craft Launcher 2',   'Windows 平台启动器，界面简洁，操作高效，国内开发者维护。', 'https://github.com/Meloong-Git/PCL/releases', 'Windows,免费', 2)
) as v(name, subtitle, description, url, tags, sort_order)
where not exists (select 1 from public.launchers l where l.name = v.name);

-- ============================================================
-- 27. AI 技能 · 玩家自助（2026-10-23）
--    玩家在「AI 技能」页自助领取授权码（绑定本人，仅签到/查询权限），
--    首次安装成功（自助账号首次非 ping 调用成功）奖励 60000 电力，只发一次。
--    注意：本节会覆盖第 24 节的 open_api（加入安装奖励逻辑）。
-- ============================================================
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
