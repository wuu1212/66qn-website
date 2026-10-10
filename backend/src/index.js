// 66qn Minecraft Server API - Cloudflare Workers Entry Point
import { Router } from 'itty-router';
import * as jose from 'jose';

const router = Router();

// ==================== CORS Headers ====================
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

// ==================== Utility Functions ====================
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

function error(code, message, status = 400) {
  return json({ success: false, error: { code, message } }, status);
}

function success(data, meta = null) {
  const resp = { success: true, data };
  if (meta) resp.meta = meta;
  return json(resp);
}

async function getUser(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  try {
    const secret = new TextEncoder().encode(env.JWT_SECRET || 'demo-secret-key');
    const { payload } = await jose.jwtVerify(auth.slice(7), secret);
    const user = await env.DB.prepare('SELECT id, username, email, role, bio, avatar_url, is_banned FROM users WHERE id = ?').bind(payload.sub).first();
    if (!user || user.is_banned) return null;
    return user;
  } catch {
    return null;
  }
}

async function requireAuth(request, env) {
  const user = await getUser(request, env);
  if (!user) throw new Error('UNAUTHORIZED');
  return user;
}

async function requireAdmin(request, env) {
  const user = await requireAuth(request, env);
  if (user.role !== 'admin') throw new Error('FORBIDDEN');
  return user;
}

async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const hash = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt || '66qn-default-salt'), iterations: 100000, hash: 'SHA-256' }, keyMaterial, 256);
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

async function generateToken(user, env) {
  const secret = new TextEncoder().encode(env.JWT_SECRET || 'demo-secret-key');
  return await new jose.SignJWT({ sub: user.id, role: user.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret);
}

function paginate(page = 1, limit = 20) {
  page = Math.max(1, parseInt(page) || 1);
  limit = Math.min(100, Math.max(1, parseInt(limit) || 20));
  return { page, limit, offset: (page - 1) * limit };
}

// ==================== OPTIONS Preflight ====================
router.options('*', () => new Response(null, { headers: corsHeaders }));

// ==================== Auth Routes ====================

// Register
router.post('/api/auth/register', async (request, env) => {
  const { username, email, password } = await request.json();
  if (!username || username.length < 3 || username.length > 20) return error('INVALID_USERNAME', '用户名需要3-20个字符');
  if (!email || !email.includes('@')) return error('INVALID_EMAIL', '请输入有效的邮箱地址');
  if (!password || password.length < 6) return error('INVALID_PASSWORD', '密码至少6位');

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ? OR username = ?').bind(email, username).first();
  if (existing) return error('USER_EXISTS', '该邮箱或用户名已被注册');

  const hash = await hashPassword(password);
  const result = await env.DB.prepare('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)').bind(username, email, hash).run();

  const user = await env.DB.prepare('SELECT id, username, email, role FROM users WHERE id = ?').bind(result.meta.last_row_id).first();
  const token = await generateToken(user, env);

  return success({ user, token });
});

// Login
router.post('/api/auth/login', async (request, env) => {
  const { email, password } = await request.json();
  if (!email || !password) return error('MISSING_FIELDS', '请填写邮箱和密码');

  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!user || !user.password_hash) return error('INVALID_CREDENTIALS', '邮箱或密码错误', 401);
  if (user.is_banned) return error('USER_BANNED', '该账户已被封禁', 403);

  const hash = await hashPassword(password);
  if (hash !== user.password_hash) return error('INVALID_CREDENTIALS', '邮箱或密码错误', 401);

  await env.DB.prepare('UPDATE users SET last_login_at = unixepoch() WHERE id = ?').bind(user.id).run();
  const token = await generateToken(user, env);

  return success({ user: { id: user.id, username: user.username, email: user.email, role: user.role, bio: user.bio, avatar_url: user.avatar_url }, token });
});

// GitHub OAuth - Initiate
router.get('/api/auth/github', (request, env) => {
  const clientId = env.GITHUB_CLIENT_ID;
  const redirectUri = env.GITHUB_REDIRECT_URI || env.API_URL + '/api/auth/github/callback';
  const state = crypto.randomUUID();
  const url = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=read:user user:email&state=${state}`;
  return Response.redirect(url, 302);
});

// GitHub OAuth - Callback
router.get('/api/auth/github/callback', async (request, env) => {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code) return error('MISSING_CODE', '缺少授权码', 400);

  // Exchange code for token
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code }),
  });
  const tokenData = await tokenRes.json();
  if (tokenData.error) return error('GITHUB_AUTH_FAILED', tokenData.error_description, 400);

  // Get user info
  const [userRes, emailsRes] = await Promise.all([
    fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${tokenData.access_token}` } }),
    fetch('https://api.github.com/user/emails', { headers: { Authorization: `Bearer ${tokenData.access_token}` } }),
  ]);
  const ghUser = await userRes.json();
  const ghEmails = await emailsRes.json();
  const primaryEmail = ghEmails.find(e => e.primary)?.email || ghUser.email;

  // Find or create user
  let user = await env.DB.prepare('SELECT * FROM users WHERE github_id = ?').bind(ghUser.id).first();
  if (!user) {
    let username = ghUser.login;
    const existingUsername = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
    if (existingUsername) username += '_' + Math.floor(Math.random() * 9999);

    const result = await env.DB.prepare('INSERT INTO users (username, email, github_id, github_username, avatar_url, role) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(username, primaryEmail, ghUser.id, ghUser.login, ghUser.avatar_url, 'user').run();
    user = await env.DB.prepare('SELECT id, username, email, role, bio, avatar_url FROM users WHERE id = ?').bind(result.meta.last_row_id).first();
  } else {
    await env.DB.prepare('UPDATE users SET last_login_at = unixepoch(), avatar_url = ? WHERE id = ?').bind(ghUser.avatar_url, user.id).run();
  }

  const token = await generateToken(user, env);
  const frontendUrl = env.FRONTEND_URL || 'http://localhost:8787';
  return Response.redirect(`${frontendUrl}/#/login?token=${token}`, 302);
});

// Get current user
router.get('/api/auth/me', async (request, env) => {
  const user = await getUser(request, env);
  if (!user) return error('UNAUTHORIZED', '未登录', 401);
  return success(user);
});

// Logout
router.post('/api/auth/logout', async (request, env) => {
  return success({ message: '已退出登录' });
});

// ==================== Server Info Routes ====================

router.get('/api/server/info', async (request, env) => {
  const rows = await env.DB.prepare('SELECT key, value FROM server_info').all();
  const info = {};
  rows.results.forEach(r => { info[r.key] = r.value; });
  return success(info);
});

router.get('/api/server/status', async (request, env) => {
  const addrRow = await env.DB.prepare("SELECT value FROM server_info WHERE key = 'server_address'").first();
  const portRow = await env.DB.prepare("SELECT value FROM server_info WHERE key = 'server_port'").first();
  if (!addrRow) return success({ online: false });

  try {
    const res = await fetch(`https://api.mcstatus.io/v2/status/java/${addrRow.value}:${portRow?.value || '25565'}`);
    const data = await res.json();
    return success({
      online: data.online,
      players: data.players?.online || 0,
      maxPlayers: data.players?.max || 0,
      version: data.version?.name_clean || 'Unknown',
      motd: data.motd?.clean || '',
    });
  } catch {
    return success({ online: false });
  }
});

// ==================== Posts Routes ====================

router.get('/api/posts', async (request, env) => {
  const url = new URL(request.url);
  const { page, limit, offset } = paginate(url.searchParams.get('page'), url.searchParams.get('limit'));
  const category = url.searchParams.get('category');
  const search = url.searchParams.get('search');

  let where = "WHERE p.status = 'published'";
  const bindings = [];
  if (category) { where += ' AND p.category = ?'; bindings.push(category); }
  if (search) { where += ' AND (p.title LIKE ? OR p.content LIKE ?)'; bindings.push(`%${search}%`, `%${search}%`); }

  const total = await env.DB.prepare(`SELECT COUNT(*) as count FROM posts p ${where}`).bind(...bindings).first();
  const posts = await env.DB.prepare(`
    SELECT p.*, u.username as author_name, u.avatar_url as author_avatar
    FROM posts p LEFT JOIN users u ON p.author_id = u.id
    ${where} ORDER BY p.is_pinned DESC, p.created_at DESC LIMIT ? OFFSET ?
  `).bind(...bindings, limit, offset).all();

  return success(posts.results, { page, limit, total: total.count });
});

router.get('/api/posts/:id', async (request, env) => {
  const { params } = request;
  const post = await env.DB.prepare(`
    SELECT p.*, u.username as author_name, u.avatar_url as author_avatar
    FROM posts p LEFT JOIN users u ON p.author_id = u.id WHERE p.id = ?
  `).bind(params.id).first();
  if (!post) return error('NOT_FOUND', '帖子不存在', 404);

  await env.DB.prepare('UPDATE posts SET view_count = view_count + 1 WHERE id = ?').bind(params.id).run();
  return success(post);
});

router.post('/api/posts', async (request, env) => {
  const user = await requireAuth(request, env);
  const { title, content, category } = await request.json();
  if (!title || title.length < 5) return error('INVALID_TITLE', '标题至少5个字符');
  if (!content || content.length < 10) return error('INVALID_CONTENT', '正文至少10个字符');

  const result = await env.DB.prepare('INSERT INTO posts (author_id, title, content, category) VALUES (?, ?, ?, ?)')
    .bind(user.id, title, content, category || 'general').run();
  const post = await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(result.meta.last_row_id).first();
  return success(post, null, 201);
});

router.put('/api/posts/:id', async (request, env) => {
  const user = await requireAuth(request, env);
  const post = await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(request.params.id).first();
  if (!post) return error('NOT_FOUND', '帖子不存在', 404);
  if (post.author_id !== user.id && user.role !== 'admin') return error('FORBIDDEN', '无权限', 403);

  const { title, content } = await request.json();
  await env.DB.prepare('UPDATE posts SET title = COALESCE(?, title), content = COALESCE(?, content), updated_at = unixepoch() WHERE id = ?')
    .bind(title || null, content || null, request.params.id).run();
  return success({ message: '更新成功' });
});

router.delete('/api/posts/:id', async (request, env) => {
  const user = await requireAuth(request, env);
  const post = await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(request.params.id).first();
  if (!post) return error('NOT_FOUND', '帖子不存在', 404);
  if (post.author_id !== user.id && user.role !== 'admin') return error('FORBIDDEN', '无权限', 403);

  await env.DB.prepare("UPDATE posts SET status = 'deleted', updated_at = unixepoch() WHERE id = ?").bind(request.params.id).run();
  return success({ message: '已删除' });
});

// Like/Unlike post
router.post('/api/posts/:id/like', async (request, env) => {
  const user = await requireAuth(request, env);
  const postId = parseInt(request.params.id);
  const existing = await env.DB.prepare("SELECT id FROM likes WHERE user_id = ? AND target_type = 'post' AND target_id = ?").bind(user.id, postId).first();

  if (existing) {
    await env.DB.prepare("DELETE FROM likes WHERE id = ?").bind(existing.id).run();
    await env.DB.prepare('UPDATE posts SET like_count = MAX(0, like_count - 1) WHERE id = ?').bind(postId).run();
    return success({ liked: false });
  } else {
    await env.DB.prepare("INSERT INTO likes (user_id, target_type, target_id) VALUES (?, 'post', ?)").bind(user.id, postId).run();
    await env.DB.prepare('UPDATE posts SET like_count = like_count + 1 WHERE id = ?').bind(postId).run();
    return success({ liked: true });
  }
});

// Report post
router.post('/api/posts/:id/report', async (request, env) => {
  const user = await requireAuth(request, env);
  const { reason } = await request.json();
  if (!reason || reason.length < 10) return error('INVALID_REASON', '举报理由至少10个字符');

  await env.DB.prepare("INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES (?, 'post', ?, ?)")
    .bind(user.id, request.params.id, reason).run();
  return success({ message: '举报已提交' });
});

// ==================== Comments Routes ====================

router.get('/api/posts/:postId/comments', async (request, env) => {
  const comments = await env.DB.prepare(`
    SELECT c.*, u.username as author_name, u.avatar_url as author_avatar
    FROM comments c LEFT JOIN users u ON c.author_id = u.id
    WHERE c.post_id = ? AND c.status = 'published'
    ORDER BY c.created_at ASC
  `).bind(request.params.postId).all();
  return success(comments.results);
});

router.post('/api/posts/:postId/comments', async (request, env) => {
  const user = await requireAuth(request, env);
  const { content, parent_id } = await request.json();
  if (!content || content.length < 1 || content.length > 2000) return error('INVALID_CONTENT', '评论内容需要1-2000个字符');

  const result = await env.DB.prepare('INSERT INTO comments (post_id, author_id, parent_id, content) VALUES (?, ?, ?, ?)')
    .bind(request.params.postId, user.id, parent_id || null, content).run();

  await env.DB.prepare('UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?').bind(request.params.postId).run();
  return success({ id: result.meta.last_row_id });
});

router.delete('/api/comments/:id', async (request, env) => {
  const user = await requireAuth(request, env);
  const comment = await env.DB.prepare('SELECT * FROM comments WHERE id = ?').bind(request.params.id).first();
  if (!comment) return error('NOT_FOUND', '评论不存在', 404);
  if (comment.author_id !== user.id && user.role !== 'admin') return error('FORBIDDEN', '无权限', 403);

  await env.DB.prepare("UPDATE comments SET status = 'deleted' WHERE id = ?").bind(request.params.id).run();
  return success({ message: '已删除' });
});

router.post('/api/comments/:id/like', async (request, env) => {
  const user = await requireAuth(request, env);
  const commentId = parseInt(request.params.id);
  const existing = await env.DB.prepare("SELECT id FROM likes WHERE user_id = ? AND target_type = 'comment' AND target_id = ?").bind(user.id, commentId).first();

  if (existing) {
    await env.DB.prepare("DELETE FROM likes WHERE id = ?").bind(existing.id).run();
    await env.DB.prepare('UPDATE comments SET like_count = MAX(0, like_count - 1) WHERE id = ?').bind(commentId).run();
    return success({ liked: false });
  } else {
    await env.DB.prepare("INSERT INTO likes (user_id, target_type, target_id) VALUES (?, 'comment', ?)").bind(user.id, commentId).run();
    await env.DB.prepare('UPDATE comments SET like_count = like_count + 1 WHERE id = ?').bind(commentId).run();
    return success({ liked: true });
  }
});

router.post('/api/comments/:id/report', async (request, env) => {
  const user = await requireAuth(request, env);
  const { reason } = await request.json();
  if (!reason || reason.length < 10) return error('INVALID_REASON', '举报理由至少10个字符');

  await env.DB.prepare("INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES (?, 'comment', ?, ?)")
    .bind(user.id, request.params.id, reason).run();
  return success({ message: '举报已提交' });
});

// ==================== Messages Routes ====================

router.get('/api/messages/conversations', async (request, env) => {
  const user = await requireAuth(request, env);
  const conversations = await env.DB.prepare(`
    SELECT
      CASE WHEN m.sender_id = ? THEN m.receiver_id ELSE m.sender_id END as other_id,
      u.username as other_name, u.avatar_url as other_avatar,
      m.content as last_message, m.created_at as last_time, m.is_recalled,
      (SELECT COUNT(*) FROM messages WHERE sender_id = CASE WHEN m.sender_id = ? THEN m.receiver_id ELSE m.sender_id END AND receiver_id = ? AND status = 'sent') as unread
    FROM messages m
    LEFT JOIN users u ON u.id = CASE WHEN m.sender_id = ? THEN m.receiver_id ELSE m.sender_id END
    WHERE m.sender_id = ? OR m.receiver_id = ?
    GROUP BY other_id
    ORDER BY m.created_at DESC
  `).bind(user.id, user.id, user.id, user.id, user.id, user.id).all();
  return success(conversations.results);
});

router.get('/api/messages/:userId', async (request, env) => {
  const user = await requireAuth(request, env);
  const otherId = parseInt(request.params.userId);
  const url = new URL(request.url);
  const { page, limit, offset } = paginate(url.searchParams.get('page'), url.searchParams.get('limit'));

  const messages = await env.DB.prepare(`
    SELECT * FROM messages
    WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
    ORDER BY created_at ASC LIMIT ? OFFSET ?
  `).bind(user.id, otherId, otherId, user.id, limit, offset).all();

  // Mark as read
  await env.DB.prepare("UPDATE messages SET status = 'read' WHERE sender_id = ? AND receiver_id = ? AND status = 'sent'").bind(otherId, user.id).run();
  return success(messages.results);
});

router.post('/api/messages', async (request, env) => {
  const user = await requireAuth(request, env);
  const { receiver_id, content } = await request.json();
  if (!receiver_id || !content || content.length > 5000) return error('INVALID_MESSAGE', '消息内容无效');

  const result = await env.DB.prepare('INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)')
    .bind(user.id, receiver_id, content).run();
  return success({ id: result.meta.last_row_id });
});

router.delete('/api/messages/:id', async (request, env) => {
  const user = await requireAuth(request, env);
  const msg = await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(request.params.id).first();
  if (!msg) return error('NOT_FOUND', '消息不存在', 404);
  if (msg.sender_id !== user.id) return error('FORBIDDEN', '只能撤回自己发送的消息', 403);
  if (Date.now() / 1000 - msg.created_at > 120) return error('TIMEOUT', '只能撤回2分钟内发送的消息');

  await env.DB.prepare('UPDATE messages SET is_recalled = 1, status = \'recalled\' WHERE id = ?').bind(request.params.id).run();
  return success({ message: '已撤回' });
});

router.post('/api/messages/:id/report', async (request, env) => {
  const user = await requireAuth(request, env);
  const { reason } = await request.json();
  if (!reason || reason.length < 10) return error('INVALID_REASON', '举报理由至少10个字符');

  await env.DB.prepare("INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES (?, 'message', ?, ?)")
    .bind(user.id, request.params.id, reason).run();
  return success({ message: '举报已提交' });
});

// ==================== User Routes ====================

router.get('/api/users/:id', async (request, env) => {
  const user = await env.DB.prepare('SELECT id, username, bio, avatar_url, role, created_at FROM users WHERE id = ?').bind(request.params.id).first();
  if (!user) return error('NOT_FOUND', '用户不存在', 404);
  return success(user);
});

router.put('/api/users/me', async (request, env) => {
  const user = await requireAuth(request, env);
  const { bio, username } = await request.json();
  if (username && (username.length < 3 || username.length > 20)) return error('INVALID_USERNAME', '用户名需要3-20个字符');

  await env.DB.prepare('UPDATE users SET bio = COALESCE(?, bio), username = COALESCE(?, username), updated_at = unixepoch() WHERE id = ?')
    .bind(bio || null, username || null, user.id).run();
  return success({ message: '更新成功' });
});

// ==================== Admin Routes ====================

router.get('/api/admin/dashboard', async (request, env) => {
  await requireAdmin(request, env);
  const [userCount, postCount, commentCount, reportCount] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) as c FROM users').first(),
    env.DB.prepare("SELECT COUNT(*) as c FROM posts WHERE status = 'published'").first(),
    env.DB.prepare("SELECT COUNT(*) as c FROM comments WHERE status = 'published'").first(),
    env.DB.prepare("SELECT COUNT(*) as c FROM reports WHERE status = 'pending'").first(),
  ]);
  return success({ users: userCount.c, posts: postCount.c, comments: commentCount.c, pendingReports: reportCount.c });
});

router.get('/api/admin/users', async (request, env) => {
  await requireAdmin(request, env);
  const url = new URL(request.url);
  const { page, limit, offset } = paginate(url.searchParams.get('page'), url.searchParams.get('limit'));
  const search = url.searchParams.get('search');
  let where = '';
  const bindings = [];
  if (search) { where = 'WHERE username LIKE ? OR email LIKE ?'; bindings.push(`%${search}%`, `%${search}%`); }

  const total = await env.DB.prepare(`SELECT COUNT(*) as c FROM users ${where}`).bind(...bindings).first();
  const users = await env.DB.prepare(`SELECT id, username, email, role, bio, is_banned, created_at, last_login_at FROM users ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(...bindings, limit, offset).all();
  return success(users.results, { page, limit, total: total.c });
});

router.put('/api/admin/users/:id/ban', async (request, env) => {
  await requireAdmin(request, env);
  const { is_banned } = await request.json();
  await env.DB.prepare('UPDATE users SET is_banned = ? WHERE id = ?').bind(is_banned ? 1 : 0, request.params.id).run();
  return success({ message: is_banned ? '已封禁' : '已解封' });
});

router.put('/api/admin/users/:id/role', async (request, env) => {
  await requireAdmin(request, env);
  const { role } = await request.json();
  if (!['user', 'admin'].includes(role)) return error('INVALID_ROLE', '无效的角色');
  await env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, request.params.id).run();
  return success({ message: '角色已更新' });
});

router.get('/api/admin/posts', async (request, env) => {
  await requireAdmin(request, env);
  const posts = await env.DB.prepare(`
    SELECT p.*, u.username as author_name FROM posts p
    LEFT JOIN users u ON p.author_id = u.id ORDER BY p.created_at DESC LIMIT 100
  `).all();
  return success(posts.results);
});

router.put('/api/admin/posts/:id/status', async (request, env) => {
  await requireAdmin(request, env);
  const { status } = await request.json();
  if (!['draft', 'published', 'hidden', 'deleted'].includes(status)) return error('INVALID_STATUS', '无效的状态');
  await env.DB.prepare('UPDATE posts SET status = ?, updated_at = unixepoch() WHERE id = ?').bind(status, request.params.id).run();
  return success({ message: '状态已更新' });
});

router.get('/api/admin/comments', async (request, env) => {
  await requireAdmin(request, env);
  const comments = await env.DB.prepare(`
    SELECT c.*, u.username as author_name, p.title as post_title
    FROM comments c LEFT JOIN users u ON c.author_id = u.id LEFT JOIN posts p ON c.post_id = p.id
    ORDER BY c.created_at DESC LIMIT 100
  `).all();
  return success(comments.results);
});

router.put('/api/admin/comments/:id/status', async (request, env) => {
  await requireAdmin(request, env);
  const { status } = await request.json();
  await env.DB.prepare('UPDATE comments SET status = ? WHERE id = ?').bind(status, request.params.id).run();
  return success({ message: '状态已更新' });
});

router.get('/api/admin/reports', async (request, env) => {
  await requireAdmin(request, env);
  const reports = await env.DB.prepare(`
    SELECT r.*, u.username as reporter_name FROM reports r
    LEFT JOIN users u ON r.reporter_id = u.id ORDER BY r.created_at DESC LIMIT 100
  `).all();
  return success(reports.results);
});

router.put('/api/admin/reports/:id', async (request, env) => {
  const admin = await requireAdmin(request, env);
  const { status, admin_note } = await request.json();
  if (!['reviewed', 'resolved', 'dismissed'].includes(status)) return error('INVALID_STATUS', '无效的状态');
  await env.DB.prepare('UPDATE reports SET status = ?, admin_note = ?, reviewed_by = ?, reviewed_at = unixepoch() WHERE id = ?')
    .bind(status, admin_note || null, admin.id, request.params.id).run();
  return success({ message: '举报已处理' });
});

router.put('/api/admin/server', async (request, env) => {
  await requireAdmin(request, env);
  const body = await request.json();
  for (const [key, value] of Object.entries(body)) {
    await env.DB.prepare('INSERT INTO server_info (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = unixepoch()')
      .bind(key, String(value), String(value)).run();
  }
  return success({ message: '服务器信息已更新' });
});

// ==================== 404 Fallback ====================
router.all('*', () => error('NOT_FOUND', '接口不存在', 404));

// ==================== Worker Entry ====================
export default {
  async fetch(request, env, ctx) {
    try {
      return await router.fetch(request, env, ctx);
    } catch (err) {
      if (err.message === 'UNAUTHORIZED') return error('UNAUTHORIZED', '请先登录', 401);
      if (err.message === 'FORBIDDEN') return error('FORBIDDEN', '无权限访问', 403);
      console.error('Unhandled error:', err);
      return error('INTERNAL_ERROR', '服务器内部错误', 500);
    }
  },
};
