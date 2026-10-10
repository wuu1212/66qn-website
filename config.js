// ============================================================
// 66qn 网站配置文件 —— 部署前只需要改这一个文件
//
// SUPABASE_URL:  Supabase 项目设置 → API → Project URL
// SUPABASE_ANON_KEY: 同一页面的 "anon / public" 密钥（不是 service_role！）
//                    anon 密钥是设计上允许公开的，配合 RLS 使用是安全的
// ============================================================
window.APP_CONFIG = {
  SUPABASE_URL: 'https://iywntwllhjbubmhtacdp.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml5d250d2xsaGpidWJtaHRhY2RwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE2MzA5NjQsImV4cCI6MjEwNzIwNjk2NH0.JZqv3wA6RM3Tzz9Hli3TJZb1lxmmEqlBQMGJAdk1rQQ',
};
