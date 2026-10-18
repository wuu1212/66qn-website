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

    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
