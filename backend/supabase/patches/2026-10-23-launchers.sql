-- ============================================================
-- 66qn 启动器管理补丁（2026-10-23）
-- 功能：下载页「启动器」从硬编码改为数据库驱动，管理员可在后台
--       增删改；description 支持 **词语** 语法（前端渲染为蓝底加粗）；
--       tags 逗号分隔，第一个显示为蓝色徽标。
-- 用法：Supabase SQL Editor 整段粘贴运行（幂等，可重复执行）。
-- 初始数据：HMCL / FCL / PCL 三条，按名称判重，不会重复插入。
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

-- 初始数据（幂等：按名称判重）
insert into public.launchers (name, subtitle, description, url, tags, sort_order)
select v.name, v.subtitle, v.description, v.url, v.tags, v.sort_order
from (values
  ('HMCL', 'Hello Minecraft! Launcher', '跨平台、功能丰富的 Java 版启动器，支持多版本管理、微软账户登录、模组加载器。', 'https://hmcl.huangyuhui.net/download/', '推荐,Windows,macOS,Linux', 0),
  ('FCL',  'Fold Craft Launcher',      '安卓专属启动器，触屏优化，支持在手机上运行 Minecraft Java 版。', 'https://github.com/FCL-Team/FoldCraftLauncher/releases', 'Android,开源', 1),
  ('PCL',  'Plain Craft Launcher 2',   'Windows 平台启动器，界面简洁，操作高效，国内开发者维护。', 'https://github.com/Meloong-Git/PCL/releases', 'Windows,免费', 2)
) as v(name, subtitle, description, url, tags, sort_order)
where not exists (select 1 from public.launchers l where l.name = v.name);
