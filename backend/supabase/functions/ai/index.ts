// ============================================================
// 66qn AI 统一网关（Supabase Edge Function）
// 作用：
//   1) AI 客服（chat）：先匹配"标准回答"，未命中再调用大模型
//   2) AI 审核（moderate）：帖子 / 评论内容合规判断
//   3) 举报复核（review_report）：判定是否应删除并自动执行
//
// 安全：API Key 加密存放在 public.ai_secrets，仅本函数（service_role）可解密，
//       浏览器永远拿不到密钥。
// 部署：Supabase 控制台 → Edge Functions → 新建函数（名称需与前端 app.js 里的 AI_FN 常量一致，
//       当前为 bright-service）→ 粘贴本文件 → Deploy
//       并在 Edge Function 的 Secrets 中设置 AI_SECRET，
//       其值必须与数据库 public.app_secrets 表中 key='ai_secret' 的值完全一致
//
// 2026-11-21 新增 action=qq_bind：给玩家的 QQ号@qq.com 发 6 位绑定验证码。
//   发信复用已有的阿里云 DirectMail 账号（和 Supabase Auth 用的是同一个发件地址，
//   但不经过 GoTrue，所以不会影响登录/找回密码那两条邮件链路）。
//   需要为本函数额外配 4 个 Secrets（在控制台 Functions → bright-service → Secrets 里加，
//   不要把口令贴进聊天或提交进仓库）：
//     SMTP_HOST = smtpdm.aliyun.com
//     SMTP_PORT = 465
//     SMTP_USER = noreply@mail.66qnmc.top      （必须和 DirectMail 里已验证的发件地址完全一致，否则 553）
//     SMTP_PASS = 该发件地址的 SMTP 密码
//   没配这四个时，qq_bind 会直接返回「邮件通道未就绪」，其它动作照常工作；
//   前端也只在后台「顶部横幅与开关 → 开放 QQ 邮箱绑定」勾上后才露出这个入口。
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

/** 把用户填写的 API 地址规范成 chat/completions 端点 */
function normalizeEndpoint(url: string): string {
  const u = (url || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (u.endsWith('/chat/completions')) return u;
  if (u.endsWith('/v1')) return u + '/chat/completions';
  return u + '/v1/chat/completions';
}

interface AiConfig {
  id: string; name: string; api_url: string; model: string; prompt: string;
  prompt_post?: string; prompt_comment?: string; prompt_report?: string;
  standard_answers: Array<{ keywords?: string[]; answer?: string }> | string;
  scopes: string[] | string; priority: number; temperature: number; api_key: string | null;
}

// ============================================================
// 各场景的「输出契约」——无论管理员写了什么提示词，都会强制附加，
// 保证模型返回可解析的固定格式，程序据此判定「打回」或「通过」。
// ============================================================
const CONTRACTS: Record<string, string> = {
  post: '你是社区内容审核员。判断下面这篇帖子是否违反社区规范（色情、暴力、违法犯罪、辱骂人身攻击、广告刷屏、恶意引战、泄露他人隐私）。\n'
    + '只输出一个 JSON 对象，不要输出任何解释、前后缀或代码块标记：\n'
    + '{"verdict":"pass","reason":"不超过30字的原因"}\n'
    + '{"verdict":"reject","reason":"不超过30字的原因"}\n'
    + 'pass = 通过（正常展示）；reject = 打回（不展示）。',
  comment: '你是社区内容审核员。判断下面这条评论是否违反社区规范（色情、暴力、违法犯罪、辱骂人身攻击、广告刷屏、恶意引战、泄露他人隐私）。\n'
    + '只输出一个 JSON 对象，不要输出任何解释、前后缀或代码块标记：\n'
    + '{"verdict":"pass","reason":"不超过30字的原因"}\n'
    + '{"verdict":"reject","reason":"不超过30字的原因"}\n'
    + 'pass = 通过（正常展示）；reject = 打回（不展示）。',
  report: '你是社区举报复核员。根据「举报理由」与「被举报内容」，判断是否应当删除该内容。\n'
    + '只输出一个 JSON 对象，不要输出任何解释、前后缀或代码块标记：\n'
    + '{"verdict":"delete","reason":"不超过30字的原因"}\n'
    + '{"verdict":"keep","reason":"不超过30字的原因"}\n'
    + 'delete = 应当删除；keep = 保留。',
};

const DEFAULT_PERSONA: Record<string, string> = {
  post: '你是严格但公正的社区内容审核员，只做判断，不写多余内容。',
  comment: '你是严格但公正的社区内容审核员，只做判断，不写多余内容。',
  report: '你是社区举报复核员，只做判断，不写多余内容。',
};

/** 取某个场景的提示词：优先用该场景专属提示词，绝不回落到客服提示词 */
function promptFor(cfg: AiConfig, scenario: 'post' | 'comment' | 'report'): string {
  const custom = scenario === 'post' ? cfg.prompt_post
    : scenario === 'comment' ? cfg.prompt_comment
    : cfg.prompt_report;
  const persona = (custom && custom.trim()) ? custom.trim() : DEFAULT_PERSONA[scenario];
  return persona + '\n\n' + CONTRACTS[scenario];
}

function toArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') return v.replace(/[{}"]/g, '').split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

/** 调用 OpenAI 兼容接口 */
async function callModel(cfg: AiConfig, messages: Array<{ role: string; content: string }>) {
  if (!cfg.api_url) throw new Error('未配置 API 地址');
  const res = await fetch(normalizeEndpoint(cfg.api_url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.api_key || ''}` },
    body: JSON.stringify({
      model: cfg.model || 'gpt-3.5-turbo',
      temperature: Number(cfg.temperature ?? 0.3),
      messages,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`模型返回 ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  return data?.choices?.[0]?.message?.content ?? '';
}

/** 标准回答关键词匹配 */
function matchStandardAnswer(cfg: AiConfig, message: string): string | null {
  let list = cfg.standard_answers;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { return null; } }
  if (!Array.isArray(list)) return null;
  const lower = message.toLowerCase();
  for (const item of list) {
    const keys = item?.keywords || [];
    if (!item?.answer) continue;
    if (keys.some(k => k && lower.includes(String(k).toLowerCase()))) return String(item.answer);
  }
  return null;
}

/** 从模型输出中解析判定结果：pass=通过 / reject=打回 / keep=保留 */
function parseVerdict(raw: string): { verdict: 'pass' | 'reject' | 'keep'; reason: string } {
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]);
      const v = String(o.verdict ?? o.result ?? o.decision ?? '').trim().toLowerCase();
      const reason = String(o.reason ?? o.说明 ?? '').slice(0, 100);
      if (['reject', 'delete', 'block', 'fail', '打回', '违规', '删除'].some(k => v.includes(k))) return { verdict: 'reject', reason };
      if (['keep', '保留', '不删除'].some(k => v.includes(k))) return { verdict: 'keep', reason };
      if (['pass', 'allow', 'ok', 'approve', '通过'].some(k => v.includes(k))) return { verdict: 'pass', reason };
    } catch { /* 落到下面用关键词兜底 */ }
  }
  const low = raw.toLowerCase();
  if (/reject|delete|打回|违规|删除/.test(low)) return { verdict: 'reject', reason: raw.slice(0, 100) };
  if (/keep|保留/.test(low)) return { verdict: 'keep', reason: raw.slice(0, 100) };
  return { verdict: 'pass', reason: raw.slice(0, 100) };
}

// ============================================================
// 发信：自带一个极简 SMTP 客户端（AUTH LOGIN + 隐式 TLS）
//   不 import 任何第三方邮件库，免得云端 esm.sh 拉包失败导致整个函数部署不上去。
//   只支持 465 端口（smtpdm.aliyun.com 的 SSL 端口）；587 的 STARTTLS 这里没实现。
// ============================================================
function b64utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function smtpSend(to: string, subject: string, html: string): Promise<void> {
  const host = Deno.env.get('SMTP_HOST') || 'smtpdm.aliyun.com';
  const port = parseInt(Deno.env.get('SMTP_PORT') || '465', 10);
  const user = Deno.env.get('SMTP_USER') || '';
  const pass = Deno.env.get('SMTP_PASS') || '';
  const from = Deno.env.get('SMTP_FROM') || user;
  if (!user || !pass) throw new Error('SMTP_USER / SMTP_PASS 未配置');

  const conn = await Deno.connectTls({ host, port, serverName: host });
  const dec = new TextDecoder();
  let buf = '';

  const readline = async (): Promise<string> => {
    for (;;) {
      const i = buf.indexOf('\r\n');
      if (i >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 2); return line; }
      const chunk = new Uint8Array(4096);
      const n = await conn.read(chunk);
      if (n === null) throw new Error('SMTP 连接被服务端关闭' + (buf ? '：' + buf : ''));
      buf += dec.decode(chunk.subarray(0, n), { stream: true });
    }
  };
  const expect = async (...codes: number[]): Promise<string> => {
    let line = await readline();
    while (/^\d{3}-/.test(line)) line = await readline();   // 多行响应取最后一行
    const code = parseInt(line.slice(0, 3), 10);
    if (!codes.includes(code)) throw new Error(`SMTP 期望 ${codes.join('/')}，实际 ${line}`);
    return line;
  };
  const send = async (s: string): Promise<void> => {
    await conn.write(new TextEncoder().encode(s + '\r\n'));
  };
  const cmd = async (s: string, ...codes: number[]): Promise<string> => {
    await send(s);
    return expect(...codes);
  };

  try {
    await expect(220);
    await cmd(`EHLO ${Deno.hostname ? Deno.hostname() : 'supabase-edge'}`, 250);
    await cmd('AUTH LOGIN', 334);
    await cmd(b64utf8(user), 334);
    await cmd(b64utf8(pass), 235);
    await cmd(`MAIL FROM:<${from}>`, 250);
    await cmd(`RCPT TO:<${to}>`, 250, 251);
    await cmd('DATA', 350);
    // 正文用 base64 传输，不会有以点开头的行，也不受行长度限制影响
    const mail = [
      `From: =?UTF-8?B?${b64utf8('66QN 服务器')}?= <${from}>`,
      `To: <${to}>`,
      `Subject: =?UTF-8?B?${b64utf8(subject)}?=`,
      'Date: ' + new Date().toUTCString(),
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64utf8(html),
      '',
      '.',
    ].join('\r\n');
    await send(mail);
    await expect(250);
    await cmd('QUIT', 221);
  } finally {
    try { conn.close(); } catch { /* 已经断了就不用再管 */ }
  }
}

function bindMailHtml(code: string, nickname: string, minutes: number): string {
  return `<div style="font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1a1a1a">
  <div style="font-size:15px;font-weight:600;margin-bottom:16px">66QN 账号绑定验证码</div>
  <p style="font-size:14px;line-height:1.8;margin:0 0 16px">${nickname}，你好：</p>
  <p style="font-size:14px;line-height:1.8;margin:0 0 20px">你在 66qnmc.top 上申请把 QQ 号绑定到网站账号。下面是本次验证码，<strong>${minutes} 分钟内有效</strong>，只使用一次。</p>
  <div style="font-size:34px;font-weight:700;letter-spacing:10px;text-align:center;padding:18px;background:#f2f6ff;border-radius:8px;color:#2563eb">${code}</div>
  <p style="font-size:13px;line-height:1.8;color:#666;margin:20px 0 0">如果你没有做过这个操作，说明有人填错了 QQ 号，忽略这封邮件即可，你的账号不会有任何变化。</p>
</div>`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const AI_SECRET = Deno.env.get('AI_SECRET') || '66qn-default-secret-change-me';

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  /** 校验调用者是否为有效管理员；不是则返回一个 Response（是则返回 null） */
  async function requireAdmin(r: Request): Promise<Response | null> {
    const hdr = r.headers.get('Authorization') || r.headers.get('apikey') || '';
    const token = hdr.replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ error: '未登录', need_login: true }, 401);
    const u = await admin.auth.getUser(token);
    if (u.error || !u.data || !u.data.user) return json({ error: '登录状态无效', need_login: true }, 401);
    const { data: prof } = await admin.from('profiles').select('role,status').eq('id', u.data.user.id).maybeSingle();
    if (!prof || prof.role !== 'admin' || prof.status !== 'active') {
      return json({ error: '需要管理员权限' }, 403);
    }
    return null;
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const action = String(body.action || 'chat');

  // 读取全部启用中的 AI 配置（含解密后的密钥）
  const { data: configsRaw, error: cfgErr } = await admin.rpc('get_ai_configs', { p_secret: AI_SECRET });
  if (cfgErr) return json({ error: '读取 AI 配置失败：' + cfgErr.message }, 500);
  const configs = (configsRaw || []) as AiConfig[];

  const pickByScope = (scope: string) =>
    configs.filter(c => toArray(c.scopes).includes(scope));

  try {
    // ---------------- AI 客服 ----------------
    if (action === 'chat') {
      const message = String(body.message || '').slice(0, 2000);
      if (!message) return json({ error: 'empty message' }, 400);
      const pool = pickByScope('chat');
      if (!pool.length) return json({ reply: '管理员还没有配置 AI 客服模型，请稍后再试。' });

      for (const cfg of pool) {
        const hit = matchStandardAnswer(cfg, message);
        if (hit) return json({ reply: hit, source: 'standard', model: cfg.name });
      }

      const cfg = pool[0];
      const history = Array.isArray(body.history) ? (body.history as Array<{ role: string; content: string }>).slice(-8) : [];
      const messages = [
        { role: 'system', content: cfg.prompt || '你是 66qn Minecraft 服务器的客服助手，请用简洁友好的中文回答玩家问题。' },
        ...history.map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content).slice(0, 2000) })),
        { role: 'user', content: message },
      ];
      const reply = await callModel(cfg, messages);
      return json({ reply: reply || '（模型没有返回内容）', source: 'model', model: cfg.name });
    }

    // ---------------- 内容审核 ----------------
    if (action === 'moderate') {
      const content = String(body.content || '').slice(0, 4000);
      const targetType = String(body.target_type || 'post');
      const scenario: 'post' | 'comment' = targetType === 'comment' ? 'comment' : 'post';
      const targetId = body.target_id ? String(body.target_id) : null;
      const pool = pickByScope(scenario === 'comment' ? 'comments' : 'posts');
      if (!pool.length || !content) return json({ verdict: 'pass', skipped: true });

      const cfg = pool[0];
      const messages = [
        { role: 'system', content: promptFor(cfg, scenario) },
        { role: 'user', content },
      ];
      const raw = await callModel(cfg, messages);
      const { verdict, reason } = parseVerdict(raw);
      const decision = verdict === 'reject' ? 'reject' : 'pass';
      if (targetId) {
        await admin.from('ai_reviews').insert({ target_type: targetType, target_id: targetId, verdict: decision, reason, model: cfg.name });
      }
      return json({ verdict: decision, reason, model: cfg.name });
    }

    // ---------------- 举报复核 ----------------
    if (action === 'review_report') {
      const reportId = String(body.report_id || '');
      if (!reportId) return json({ error: 'missing report_id' }, 400);

      const { data: report } = await admin.from('reports').select('*').eq('id', reportId).maybeSingle();
      if (!report) return json({ error: 'report not found' }, 404);

      let targetText = '';
      if (report.target_type === 'post') {
        const { data: p } = await admin.from('posts').select('title, content').eq('id', report.target_id).maybeSingle();
        targetText = p ? `${p.title}\n${p.content}` : '';
      } else if (report.target_type === 'comment') {
        const { data: c } = await admin.from('comments').select('content').eq('id', report.target_id).maybeSingle();
        targetText = c?.content || '';
      } else if (report.target_type === 'message') {
        const { data: m } = await admin.from('messages').select('content').eq('id', report.target_id).maybeSingle();
        targetText = m?.content || '';
      } else {
        targetText = report.reason;
      }

      const pool = pickByScope('reports');
      if (!pool.length) return json({ verdict: 'manual', reason: '未配置举报审核模型' });

      const cfg = pool[0];
      const messages = [
        { role: 'system', content: promptFor(cfg, 'report') },
        { role: 'user', content: `举报理由：${report.reason}\n\n被举报内容：\n${targetText}` },
      ];
      const raw = await callModel(cfg, messages);
      const { verdict, reason } = parseVerdict(raw);
      const shouldDelete = verdict === 'reject';

      await admin.from('ai_reviews').insert({ target_type: 'report', target_id: reportId, verdict: shouldDelete ? 'reject' : 'pass', reason, model: cfg.name });

      if (shouldDelete) {
        // 服务端直接执行删除并结案
        if (report.target_type === 'post') await admin.from('posts').update({ status: 'deleted' }).eq('id', report.target_id);
        else if (report.target_type === 'comment') await admin.from('comments').update({ status: 'deleted' }).eq('id', report.target_id);
        else if (report.target_type === 'message') await admin.from('messages').update({ status: 'recalled' }).eq('id', report.target_id);
        await admin.from('reports').update({ status: 'resolved', admin_note: 'AI 自动删除：' + reason }).eq('id', reportId);
      }

      return json({ verdict: shouldDelete ? 'delete' : 'keep', reason, autoDeleted: shouldDelete, model: cfg.name });
    }

    // ---------------- 管理员：通过申请并创建账号 ----------------
    if (action === 'create_account') {
      const guard = await requireAdmin(req);
      if (guard) return guard;

      const appId = String(body.app_id || '');
      if (!appId) return json({ error: '缺少申请编号' }, 400);

      const { data: sec, error: secErr } = await admin.rpc('get_application_secret', { p_app: appId });
      if (secErr || !sec) return json({ error: '读取申请失败：' + (secErr ? secErr.message : '记录不存在') }, 500);

      const nickname = String(sec.nickname || '').trim();
      const password = String(sec.password || '');
      const question = String(sec.question || '');
      const answer = String(sec.answer || '');
      if (!nickname || !password) return json({ error: '申请资料不完整，请让用户重新提交' }, 500);

      // 生成一个只用于 Supabase Auth 的登录地址（不会真的收发邮件）
      const tag = nickname.toLowerCase().replace(/[^a-z0-9_.-]/g, '') || 'player';
      const email = `${tag}_${Math.random().toString(36).slice(2, 8)}@apply.66qn.top`;

      const created = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { username: nickname, security_q: question, security_answer: answer },
      });
      if (created.error || !created.data || !created.data.user) {
        return json({ error: '创建账号失败：' + (created.error ? created.error.message : '未知错误') }, 500);
      }
      const uid = created.data.user.id;

      await admin.rpc('complete_application', { p_app: appId, p_user: uid });
      await admin.rpc('set_profile_security', { p_user: uid, p_question: question, p_answer: answer });

      return json({ ok: true, user_id: uid, nickname });
    }

    // ---------------- 管理员：设置或修改用户登录密码 ----------------
    if (action === 'set_password') {
      const guard = await requireAdmin(req);
      if (guard) return guard;

      const userId = String(body.user_id || '');
      const newPass = String(body.password || '');
      if (!userId) return json({ error: '缺少用户编号' }, 400);
      if (newPass.length < 6) return json({ error: '密码至少6位' }, 400);

      const r = await admin.auth.admin.updateUserById(userId, { password: newPass });
      if (r.error) return json({ error: '修改密码失败：' + r.error.message }, 500);
      return json({ ok: true });
    }

    // ---------------- 玩家：绑定 QQ 号（发 6 位验证码到 QQ号@qq.com）----------------
    if (action === 'qq_bind') {
      // 这里只要「已登录」，不要管理员：玩家给自己绑 QQ。用和 requireAdmin 相同的取 token 方式，
      // 但不查 role。
      const hdr = req.headers.get('Authorization') || '';
      const token = hdr.replace(/^Bearer\s+/i, '').trim();
      if (!token) return json({ error: '未登录', need_login: true }, 401);
      const me = await admin.auth.getUser(token);
      if (me.error || !me.data || !me.data.user) return json({ error: '登录状态无效', need_login: true }, 401);
      const uid = me.data.user.id;

      const qq = String(body.qq || '').trim();
      if (!/^[1-9][0-9]{4,10}$/.test(qq)) return json({ ok: false, error: 'QQ 号格式不对：应为 5-11 位数字，且不能以 0 开头' });

      // 后台开关没打开就不发信（这个入口默认关闭，避免 SMTP 没配好时给玩家一个死按钮）
      const { data: siteRow } = await admin.from('server_settings').select('value').eq('key', 'site').maybeSingle();
      const siteVal = (siteRow && siteRow.value) || {};
      if (siteVal.qq_bind_enabled !== true) return json({ ok: false, error: 'QQ 绑定功能尚未开放' }, 403);

      // 验证码在数据库里生成并落库（这个函数只允许 service_role 调用），避免任何人拿 anon key 直接发信
      const { data: made, error: madeErr } = await admin.rpc('qq_create_bind_code', { p_user: uid, p_qq: qq });
      if (madeErr) return json({ ok: false, error: '生成验证码失败：' + madeErr.message }, 500);
      if (!made || !(made as Record<string, unknown>).ok) {
        return json({ ok: false, error: String((made as Record<string, unknown>)?.error || '生成验证码失败') });
      }
      const code = String((made as Record<string, unknown>).code);
      const mailTo = String((made as Record<string, unknown>).mail_to);
      const nickname = String((made as Record<string, unknown>).nickname || '玩家');

      try {
        await smtpSend(mailTo, '66QN 账号绑定验证码', bindMailHtml(code, nickname, 15));
      } catch (e) {
        // 发信失败就把这张码作废，免得库里留一堆没人收得到的验证码
        await admin.from('qq_bind_codes').update({ status: 'cancelled' })
          .eq('user_id', uid).eq('code', code).eq('status', 'pending');
        const msg = String((e as Error)?.message || e);
        const notConfigured = /SMTP_USER|SMTP_PASS|未配置/.test(msg);
        return json({
          ok: false,
          error: notConfigured
            ? '邮件通道未就绪：请先在本函数的 Secrets 里配置 SMTP_USER / SMTP_PASS'
            : '邮件发送失败：' + msg,
        }, 502);
      }
      return json({ ok: true, mail_to: mailTo.replace(/^(\d{1,3})\d+(@.*)$/, '$1***$2') });
    }

    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
