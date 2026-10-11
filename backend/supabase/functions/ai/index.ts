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
  standard_answers: Array<{ keywords?: string[]; answer?: string }> | string;
  scopes: string[] | string; priority: number; temperature: number; api_key: string | null;
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

/** 从 JSON 文本中提取判定结果 */
function parseVerdict(raw: string): { verdict: string; reason: string } {
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]);
      const v = String(o.verdict || o.result || '').toLowerCase();
      if (v.includes('reject') || v.includes('delete') || v.includes('违规')) return { verdict: 'reject', reason: String(o.reason || 'AI 判定违规') };
      if (v.includes('allow') || v.includes('ok') || v.includes('通过')) return { verdict: 'allow', reason: String(o.reason || '') };
    } catch { /* ignore */ }
  }
  const low = raw.toLowerCase();
  if (low.includes('reject') || low.includes('违规')) return { verdict: 'reject', reason: raw.slice(0, 200) };
  return { verdict: 'allow', reason: raw.slice(0, 200) };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const AI_SECRET = Deno.env.get('AI_SECRET') || '66qn-default-secret-change-me';

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

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
      const targetId = body.target_id ? String(body.target_id) : null;
      const pool = pickByScope(targetType === 'comment' ? 'comments' : 'posts');
      if (!pool.length || !content) return json({ verdict: 'allow', skipped: true });

      const cfg = pool[0];
      const messages = [
        { role: 'system', content: cfg.prompt || '你是内容审核员。判断用户内容是否违反社区规范（色情、暴力、违法、辱骂、广告刷屏）。只输出 JSON：{"verdict":"allow"或"reject","reason":"简短原因"}' },
        { role: 'user', content },
      ];
      const raw = await callModel(cfg, messages);
      const { verdict, reason } = parseVerdict(raw);
      if (targetId) {
        await admin.from('ai_reviews').insert({ target_type: targetType, target_id: targetId, verdict, reason, model: cfg.name });
      }
      return json({ verdict, reason, model: cfg.name });
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
        { role: 'system', content: cfg.prompt || '你是社区审核员。根据举报理由与被举报内容，判断是否应当删除该内容。只输出 JSON：{"verdict":"delete"或"keep","reason":"简短原因"}' },
        { role: 'user', content: `举报理由：${report.reason}\n\n被举报内容：\n${targetText}` },
      ];
      const raw = await callModel(cfg, messages);
      const { verdict, reason } = parseVerdict(raw);
      const shouldDelete = verdict === 'reject';

      await admin.from('ai_reviews').insert({ target_type: 'report', target_id: reportId, verdict: shouldDelete ? 'reject' : 'allow', reason, model: cfg.name });

      if (shouldDelete) {
        // 服务端直接执行删除并结案
        if (report.target_type === 'post') await admin.from('posts').update({ status: 'deleted' }).eq('id', report.target_id);
        else if (report.target_type === 'comment') await admin.from('comments').update({ status: 'deleted' }).eq('id', report.target_id);
        else if (report.target_type === 'message') await admin.from('messages').update({ status: 'recalled' }).eq('id', report.target_id);
        await admin.from('reports').update({ status: 'resolved', admin_note: 'AI 自动删除：' + reason }).eq('id', reportId);
      }

      return json({ verdict: shouldDelete ? 'delete' : 'keep', reason, autoDeleted: shouldDelete, model: cfg.name });
    }

    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
