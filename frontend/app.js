// ============================================================
// 66qn 网站前端 —— Supabase 直连版
// 依赖：index.html 里的 supabase-js CDN + config.js
// ============================================================

// ==================== Supabase 初始化 ====================
const CFG = window.APP_CONFIG || {};
const CONFIGURED = CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && !CFG.SUPABASE_ANON_KEY.includes('粘贴');

let sb = null;
if (CONFIGURED) {
    sb = supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
}

// ==================== 应用状态 ====================
const APP = {
    user: null,        // profiles 行：{id, username, role, status, avatar_url, bio, created_at}
    isAdmin: false,
    pages: {},
    async init() {
        this.setupRouter();
        refreshAnnouncement();
        this.updateNavbar();
        if (!sb) return;
        // OAuth 回调可能先返回 code，再由 SDK 换取 session；必须在首次路由前处理。
        const callbackError = new URLSearchParams(location.search).get('error_description');
        if (callbackError) {
            history.replaceState({}, document.title, location.pathname);
            setTimeout(() => toast('GitHub 登录失败：' + callbackError, 'error'), 0);
        }
        await this.loadSession();
        // 协议弹窗只在首次访问时出现一次，之后由页脚常驻提示
        if (!(await checkAgreement()) && !localStorage.getItem('66qn_agreement_seen')) {
            localStorage.setItem('66qn_agreement_seen', '1');
            setTimeout(() => showAgreementModal(true), 700);
        }
        sb.auth.onAuthStateChange(async (event, session) => {
            // 注意：TOKEN_REFRESHED 会在标签页重新获得焦点时触发。
            // 这里绝不能重新渲染当前页面，否则用户填到一半的表单会被清空。
            if (event === 'TOKEN_REFRESHED') {
                if (session) await this.loadProfile(session.user.id);   // 只刷新用户名/头像
                return;
            }
            if (event === 'PASSWORD_RECOVERY') {
                // 邮件里的重置链接回调：supabase-js 已接住 token，直接进设置新密码页
                if (session) await this.loadProfile(session.user.id);
                location.hash = '#/setpwd';
                return;
            }
            if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
                if (session) {
                    await this.loadProfile(session.user.id);
                    // 只有停在登录/注册页时才跳回首页；其它页面保持原样，不重画
                    if (location.hash === '#/login' || location.hash === '#/register') location.hash = '#/';
                }
            } else if (event === 'SIGNED_OUT') {
                this.user = null; this.isAdmin = false; this.updateNavbar(); this.route();
            }
        });
    },
    async loadSession() {
        if (!sb) { this.route(); return; }
        const { data: { session }, error } = await sb.auth.getSession();
        if (error) { toast('登录会话读取失败，请刷新重试', 'error'); }
        if (session) await this.loadProfile(session.user.id);
        this.route();
        autoClaimDailyPower();   // 登录后按天发放每日电力，数据库层去重
    },
    async loadProfile(uid) {
        let { data } = await sb.from('profiles').select('*').eq('id', uid).maybeSingle();
        if (!data) {
            // 兼容尚未运行触发器的项目：从当前 Auth 用户创建最小 profile。
            const { data: authData } = await sb.auth.getUser();
            const authUser = authData && authData.user;
            const rawName = authUser && authUser.user_metadata && (authUser.user_metadata.user_name || authUser.user_metadata.preferred_username);
            const emailName = authUser && authUser.email ? authUser.email.split('@')[0] : '';
            const uname = String(rawName || emailName || ('player_' + uid.slice(0, 6))).replace(/[^a-zA-Z0-9_\u4e00-\u9fff-]/g, '').slice(0, 20) || ('player_' + uid.slice(0, 6));
            const r = await sb.from('profiles').insert({ id: uid, username: uname }).select().maybeSingle();
            data = r.data;
        }
        this.user = data;
        this.isAdmin = !!data && data.role === 'admin';
        this.updateNavbar();
    },
    setupRouter() {
        window.addEventListener('hashchange', () => this.route());
        this.route();
    },
    route() {
        const hash = location.hash.slice(1) || '/';
        const [path, ...params] = hash.split('/').filter(Boolean);
        const route = '/' + (path || '');

        document.querySelectorAll('.nav-link').forEach(el => {
            el.classList.toggle('active', el.dataset.route === route || (route === '/' && el.dataset.route === '/'));
        });

        const app = document.getElementById('app');
        app.innerHTML = '';
        app.className = 'page-enter';
        document.getElementById('mobile-nav').style.display = 'none';
        stopStatusAutoRefresh();   // 离开首页后停止轮询，避免后台空跑流量

        if (!CONFIGURED && route !== '/login' && route !== '/register') {
            app.innerHTML = `<div class="container" style="padding:var(--space-16) var(--space-6);text-align:center">
                <h2 class="section-title">还没完成 Supabase 配置</h2>
                <p class="text-secondary">请编辑 <code>frontend/config.js</code>，把 SUPABASE_ANON_KEY 换成你的 anon 公开密钥。</p></div>`;
            return;
        }

        switch (route) {
            case '/': renderHome(app); break;
            case '/download':
            case '/launcher': renderDownload(app); break;
            case '/commands': renderCommands(app); break;
            case '/members': renderMembers(app); break;
            case '/power': renderPower(app); break;
            case '/skill': renderSkill(app); break;
            case '/events': renderEvents(app, params[0]); break;
            case '/records': renderRecords(app); break;
            case '/agreement': renderAgreementPage(app); break;
            case '/forum':
                if (params[0] === 'new') renderForumNew(app);
                else if (params[0]) renderForumDetail(app, params[0]);
                else renderForum(app);
                break;
            case '/messages':
                if (params[0]) renderMessageDetail(app, params[0]);
                else renderMessages(app);
                break;
            case '/login': renderLogin(app); break;
            case '/register': renderRegister(app); break;
            case '/apply': renderApply(app); break;
            case '/verify': renderVerify(app, params[0] ? decodeURIComponent(params[0]) : ''); break;
            case '/reset': renderReset(app); break;
            case '/setpwd': renderSetPassword(app); break;
            case '/profile': renderProfile(app, params[0] || (this.user && this.user.id)); break;
            case '/admin':
                if (!this.isAdmin) { toast('需要管理员权限', 'error'); location.hash = '#/'; return; }
                renderAdmin(app, params[0] || 'dashboard');
                break;
            default: render404(app);
        }
        if (AUTH_ROUTES[route]) mountAuthVisual(app);
        window.scrollTo(0, 0);
    },
    updateNavbar() {
        const el = document.getElementById('navbar-user');
        if (this.user) {
            el.innerHTML = `
                ${this.isAdmin ? '<a href="#/admin" class="btn btn-ghost btn-sm">管理</a>' : ''}
                <a href="#/profile" class="flex-center" style="gap:8px">
                    ${avatarHtml(this.user, 32)}
                    <span style="font-size:0.875rem;font-weight:500">${esc(this.user.username)}</span>
                </a>
                <button class="btn btn-ghost btn-sm" onclick="doLogout()">退出</button>`;
        } else {
            el.innerHTML = `
                <a href="#/login" class="btn btn-ghost btn-sm">登录</a>
                <a href="#/register" class="btn btn-primary btn-sm">注册</a>`;
        }
    }
};

// ==================== 公告 ====================
async function refreshAnnouncement() {
    const bar = document.getElementById('announcement-bar');
    if (!bar || !sb) return;
    const { data } = await sb.from('server_settings').select('value').eq('key', 'site').maybeSingle();
    const site = data && data.value || {};
    if (site.announcement && site.announcement_enabled !== false) {
        bar.innerHTML = `<strong>公告</strong> ${esc(site.announcement)}${site.announcement_url ? `<a href="${esc(site.announcement_url)}" target="_blank" rel="noopener">查看详情</a>` : ''}`;
        bar.style.display = 'block';
    } else bar.style.display = 'none';
}

// ==================== 工具函数 ====================
function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

// 描述文本渲染：**词语** → 蓝底加粗强调（先转义防 XSS，再做替换）
function mdEmphasis(s) { return esc(s || '').replace(/\*\*(.+?)\*\*/g, '<strong class="md-hl">$1</strong>'); }

// 复制文本到剪贴板（失败时降级为 prompt 手动复制）
async function copyText(t) {
    try { await navigator.clipboard.writeText(String(t == null ? '' : t)); return true; }
    catch { prompt('请手动复制：', String(t == null ? '' : t)); return false; }
}
function timeAgo(t) {
    const ts = typeof t === 'number' ? t : new Date(t).getTime();
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + '分钟前';
    const h = Math.floor(m / 60);
    if (h < 24) return h + '小时前';
    const d = Math.floor(h / 24);
    if (d < 30) return d + '天前';
    return new Date(ts).toLocaleDateString('zh-CN');
}
function fmtTime(t) {
    return new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}
function avatarHtml(u, size) {
    size = size || 32;
    const name = (u && u.username) || '?';
    const fallback = `<span class="avatar" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px">${esc(name[0].toUpperCase())}</span>`;
    if (u && u.avatar_url) {
        return `<img src="${esc(u.avatar_url)}" alt="" style="width:${size}px;height:${size}px;border-radius:50%;flex-shrink:0" onerror="this.outerHTML='${fallback.replace(/'/g, "\\'")}'">`;
    }
    return fallback;
}
function toast(msg, type = 'success') {
    const c = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = 'toast toast-' + type;
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(() => el.remove(), 3000);
}
function loadingBlock() {
    return '<div style="padding:var(--space-12);text-align:center;color:var(--color-text-tertiary)">加载中…</div>';
}
function toggleMobileNav() {
    const nav = document.getElementById('mobile-nav');
    if (nav.style.display === 'block') { nav.style.display = 'none'; return; }
    nav.style.display = 'block';
    nav.innerHTML = `
        <a href="#/" class="nav-link" onclick="toggleMobileNav()">首页</a>
        <a href="#/download" class="nav-link" onclick="toggleMobileNav()">下载</a>
        <a href="#/apply" class="nav-link" onclick="toggleMobileNav()">申请账号</a>
        <a href="#/power" class="nav-link" onclick="toggleMobileNav()">电力</a>
        <a href="#/skill" class="nav-link" onclick="toggleMobileNav()">AI 技能</a>
        <a href="#/members" class="nav-link" onclick="toggleMobileNav()">成员</a>
        <a href="#/commands" class="nav-link" onclick="toggleMobileNav()">指令</a>
        <a href="#/events" class="nav-link" onclick="toggleMobileNav()">活动</a>
        <a href="#/records" class="nav-link" onclick="toggleMobileNav()">实录</a>
        <a href="#/forum" class="nav-link" onclick="toggleMobileNav()">社区</a>
        <a href="#/messages" class="nav-link" onclick="toggleMobileNav()">私信</a>
        <a href="#/agreement" class="nav-link" onclick="toggleMobileNav()">服务协议</a>
        ${APP.user ? `<a href="#/profile" class="nav-link" onclick="toggleMobileNav()">个人</a>` : ''}
        ${APP.isAdmin ? '<a href="#/admin" class="nav-link" onclick="toggleMobileNav()">管理后台</a>' : ''}`;
}
function requireLogin() {
    if (!APP.user) { toast('请先登录', 'error'); location.hash = '#/login'; return false; }
    if (APP.user.status === 'banned') { toast('该账户已被封禁', 'error'); return false; }
    return true;
}
function showModal(title, content, actions) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = `<div class="modal"><div class="modal-title">${title}</div><div class="modal-body">${content}</div><div class="modal-actions">${actions}</div></div>`;
    document.body.appendChild(overlay);
    return overlay;
}
function errText(err, fallback) {
    if (!err) return fallback;
    if (/duplicate key|already exists/i.test(err.message || '')) return '该内容已存在';
    if (/row-level security|not authorized/i.test(err.message || '')) return '没有权限执行此操作';
    return err.message || fallback;
}

// ==================== 图片压缩与上传（传输 HTTPS + 存储 AES-256）====================
// 把图片压缩到目标体积（默认 100KB，可选 10-100KB）
function compressImage(file, targetKB = 100) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('读取图片失败'));
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error('图片格式不支持'));
            img.onload = () => {
                const maxSide = 1600;
                let { width, height } = img;
                const scale = Math.min(1, maxSide / Math.max(width, height));
                width = Math.round(width * scale);
                height = Math.round(height * scale);
                const canvas = document.createElement('canvas');
                canvas.width = width; canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                const targetBytes = Math.max(10, Math.min(100, Number(targetKB) || 100)) * 1024;
                let quality = 0.92;
                let out = canvas.toDataURL('image/jpeg', quality);
                // 逐步降低质量，直到低于目标体积
                let guard = 0;
                while (out.length * 0.75 > targetBytes && quality > 0.2 && guard < 12) {
                    quality -= 0.1; guard++;
                    out = canvas.toDataURL('image/jpeg', quality);
                }
                // 若仍超标，缩小尺寸再压
                let shrink = 1;
                while (out.length * 0.75 > targetBytes && shrink < 4) {
                    shrink += 0.5;
                    const c2 = document.createElement('canvas');
                    c2.width = Math.max(1, Math.round(width / shrink));
                    c2.height = Math.max(1, Math.round(height / shrink));
                    c2.getContext('2d').drawImage(canvas, 0, 0, c2.width, c2.height);
                    out = c2.toDataURL('image/jpeg', Math.max(0.3, quality));
                }
                const blob = dataUrlToBlob(out);
                resolve({ blob, dataUrl: out, sizeKB: Math.round(blob.size / 1024), quality: Math.round(quality * 100) });
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}
function dataUrlToBlob(dataUrl) {
    const [head, body] = dataUrl.split(',');
    const mime = (head.match(/:(.*?);/) || [])[1] || 'image/jpeg';
    const bin = atob(body);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
}
// 上传到 Supabase Storage（HTTPS 传输，静态 AES-256 加密）
async function uploadImage(blob, prefix = 'img') {
    if (!APP.user) throw new Error('请先登录');
    const ext = blob.type === 'image/png' ? 'png' : 'jpg';
    const path = `${prefix}/${APP.user.id}-${Date.now()}.${ext}`;
    const { error } = await sb.storage.from('uploads').upload(path, blob, { upsert: false, contentType: blob.type });
    if (error) throw new Error(errText(error, '上传失败'));
    const { data } = sb.storage.from('uploads').getPublicUrl(path);
    return data.publicUrl;
}

// ==================== AI 客服悬浮窗 ====================
// Supabase Edge Function 名称（若你部署时用了别的名字，改这里即可）
const AI_FN = 'bright-service';
const AI_CHAT = { history: [], busy: false };
function toggleAiPanel() {
    const p = document.getElementById('ai-panel');
    if (!p) return;
    p.style.display = p.style.display === 'none' ? 'flex' : 'none';
    if (p.style.display === 'flex') document.getElementById('ai-input')?.focus();
}
function aiPush(text, who) {
    const body = document.getElementById('ai-body');
    if (!body) return;
    const el = document.createElement('div');
    el.className = 'ai-msg ' + (who === 'me' ? 'ai-msg-me' : 'ai-msg-bot');
    el.textContent = text;
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
}
async function askAi() {
    const input = document.getElementById('ai-input');
    const message = (input?.value || '').trim();
    if (!message || AI_CHAT.busy) return;
    input.value = '';
    aiPush(message, 'me');
    AI_CHAT.history.push({ role: 'user', content: message });
    AI_CHAT.busy = true;
    aiPush('正在思考…', 'bot');
    const body = document.getElementById('ai-body');
    const thinking = body.lastElementChild;
    try {
        if (!sb) throw new Error('服务未配置');
        const { data, error } = await sb.functions.invoke(AI_FN, { body: { action: 'chat', message, history: AI_CHAT.history.slice(0, -1) } });
        thinking.remove();
        if (error) throw new Error(error.message || 'AI 服务暂不可用');
        if (data?.error) throw new Error(data.error);
        const reply = data?.reply || '（没有返回内容）';
        aiPush(reply, 'bot');
        AI_CHAT.history.push({ role: 'assistant', content: reply });
    } catch (e) {
        thinking.remove();
        aiPush('抱歉，AI 客服暂时不可用：' + (e.message || e), 'bot');
    } finally { AI_CHAT.busy = false; }
}

// ==================== 服务协议 ====================
let AGREEMENT_TEXT = null;
async function loadAgreementText() {
    if (AGREEMENT_TEXT) return AGREEMENT_TEXT;
    const { data } = await sb.from('server_settings').select('value').eq('key', 'legal').maybeSingle();
    AGREEMENT_TEXT = (data && data.value) || {};
    return AGREEMENT_TEXT;
}
function defaultAgreement() {
    return '欢迎使用 66qn 服务器社区。\n\n'
        + '1. 本站为玩家自发组织的非官方社区，与 Mojang / Microsoft 无任何关联。\n'
        + '2. 禁止发布违法违规、色情暴力、辱骂他人、广告刷屏等内容。\n'
        + '3. 请勿在社区中泄露他人隐私信息。\n'
        + '4. 违规内容将被删除，严重者将撤销注册资格。\n'
        + '5. 使用本站即表示你已阅读并同意以上条款。';
}
async function showAgreementModal(force = false) {
    const legal = await loadAgreementText();
    const text = legal.agreement_text || defaultAgreement();
    const title = legal.agreement_title || '服务协议与免责声明';
    const overlay = document.createElement('div');
    overlay.className = 'agree-overlay';
    overlay.id = 'agree-overlay';
    overlay.innerHTML = `
        <div class="agree-card">
            <div class="agree-head">${esc(title)}</div>
            <div class="agree-body">${esc(text).replace(/\n/g, '<br>')}</div>
            <div class="agree-foot">
                ${force ? '' : '<button class="btn btn-secondary" onclick="document.getElementById(\'agree-overlay\').remove()">稍后再说</button>'}
                <a href="#/agreement" class="btn btn-secondary" onclick="document.getElementById('agree-overlay').remove()">查看独立页面</a>
                <button class="btn btn-primary" onclick="acceptAgreement()">我已阅读并同意</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
}
async function acceptAgreement() {
    if (APP.user) {
        const { error } = await sb.from('agreements').upsert({ user_id: APP.user.id, version: 'v1', accepted_at: new Date().toISOString() });
        if (error) return toast(errText(error, '保存协议记录失败'), 'error');
        AGREEMENT_OK = true;
    }
    localStorage.setItem('66qn_agreed', '1');
    document.getElementById('agree-overlay')?.remove();
    toast('感谢同意，欢迎使用');
}
let AGREEMENT_OK = false;
async function checkAgreement() {
    if (localStorage.getItem('66qn_agreed') === '1') { AGREEMENT_OK = true; return true; }
    if (APP.user) {
        const { data } = await sb.from('agreements').select('user_id').eq('user_id', APP.user.id).maybeSingle();
        if (data) { AGREEMENT_OK = true; localStorage.setItem('66qn_agreed', '1'); return true; }
    }
    return false;
}
// 在需要登录的动作前校验协议
function requireAgreement() {
    if (AGREEMENT_OK || localStorage.getItem('66qn_agreed') === '1') return true;
    toast('当前不同意该协议，请同意后再使用', 'error');
    showAgreementModal(true);
    return false;
}

// ==================== 页面：服务协议独立页 ====================
async function renderAgreementPage(app) {
    const legal = await loadAgreementText();
    const text = legal.agreement_text || defaultAgreement();
    app.innerHTML = `
    <div class="container" style="max-width:720px;padding:var(--space-12) var(--space-6)">
        <h1 class="section-title">${esc(legal.agreement_title || '服务协议与免责声明')}</h1>
        <div class="card" style="line-height:1.9;font-size:0.9375rem">${esc(text).replace(/\n/g, '<br>')}</div>
        <div style="margin-top:1.5rem"><button class="btn btn-primary" onclick="acceptAgreement();location.hash='#/'">我已阅读并同意</button></div>
    </div>`;
}

// ==================== SVG 图标 ====================
const icons = {
    users: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    shield: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    cube: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
    heart: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
    message: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    download: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    server: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>',
    pin: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>',
    github: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>',
    send: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
    back: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>',
    edit: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    flag: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>',
    copy: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    undo: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>',
    thumb: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>',
    dashboard: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
    settings: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
};

const CATEGORIES = [
    { key: '', label: '全部' }, { key: 'announcement', label: '公告' },
    { key: 'guide', label: '攻略' }, { key: 'build', label: '建筑' },
    { key: 'discussion', label: '讨论' }, { key: 'general', label: '综合' },
];
const CAT_LABEL = Object.fromEntries(CATEGORIES.map(c => [c.key, c.label]));

// 服务器设置缓存（登录后首页和后台都会刷新）
const Settings = {
    cache: null,
    async load(force) {
        if (this.cache && !force) return this.cache;
        const { data } = await sb.from('server_settings').select('key, value');
        const info = {};
        (data || []).forEach(r => { info[r.key] = r.value; });
        this.cache = info;
        return info;
    }
};

// ==================== 页面：首页 ====================
// ==================== 服务器实时状态（通过 MOTD 接口）====================
// 返回：{online,max,version,motd} 在线 | {offline:true,tried} 两个接口都判定离线
//      | {error:'noaddr'|'unreachable', tried} 失败
function buildAddress(ip, port) {
    let host = String(ip || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    let p = String(port || '').trim();
    const m = host.match(/^(.*):(\d+)$/);      // 地址里自带端口时优先用地址里的
    if (m) { host = m[1]; p = m[2]; }
    if (!p) p = '25565';
    return host + ':' + p;
}

// 单次探测；网络异常返回 null，接口明确回复返回 {online:boolean,...}
// players: 在线玩家名数组；接口未返回名单时为 null（表示"无法得知名单"）
async function probeMcSrvStat(address) {
    try {
        const r = await fetch('https://api.mcsrvstat.us/3/' + encodeURIComponent(address), { cache: 'no-store' });
        if (!r.ok) return null;
        const d = await r.json();
        if (!d) return null;
        if (d.online) {
            const rawList = d.players?.list;
            return {
                online: true,
                online_count: d.players?.online ?? 0,
                max: d.players?.max ?? null,
                version: d.version || '',
                motd: Array.isArray(d.motd?.clean) ? d.motd.clean.join(' ') : '',
                players: Array.isArray(rawList)
                    ? rawList.map(x => typeof x === 'string' ? x : (x && (x.name_clean || x.name_raw)) || '').filter(Boolean)
                    : null,
            };
        }
        return { online: false };
    } catch { return null; }
}

async function probeMcStatusIo(address) {
    try {
        const r = await fetch('https://api.mcstatus.io/v2/status/java/' + encodeURIComponent(address), { cache: 'no-store' });
        if (!r.ok) return null;
        const d = await r.json();
        if (!d) return null;
        if (d.online) {
            const rawList = d.players?.list;
            return {
                online: true,
                online_count: d.players?.online ?? 0,
                max: d.players?.max ?? null,
                version: (d.version && (d.version.name_clean || d.version.name)) || '',
                motd: (d.motd && (d.motd.clean || d.motd.raw)) || '',
                players: Array.isArray(rawList)
                    ? rawList.map(x => (x && (x.name_clean || x.name_raw)) || '').filter(Boolean)
                    : null,
            };
        }
        return { online: false };
    } catch { return null; }
}

async function fetchServerStatus(ip, port) {
    const raw = String(ip || '').trim();
    if (!raw || raw === '待填写') return { error: 'noaddr' };
    const address = buildAddress(raw, port);

    // 两个接口并行探测，谁先成功用谁
    const results = await Promise.all([probeMcSrvStat(address), probeMcStatusIo(address)]);

    const online = results.find(r => r && r.online);
    if (online) {
        return {
            online: online.online_count, max: online.max, version: online.version,
            motd: online.motd, players: online.players, tried: address,
        };
    }
    // 只要有一个接口网络异常，就不轻易判定离线（可能是探测服务本身不可达）
    if (results.some(r => r === null)) return { error: 'unreachable', tried: address };
    // 两个接口都明确说离线
    if (results.some(r => r && r.online === false)) return { offline: true, tried: address };
    return { error: 'unreachable', tried: address };
}

async function renderHome(app) {
    app.innerHTML = `<div class="container"><div style="padding:var(--space-16) 0;text-align:center;color:var(--color-text-tertiary)">加载中…</div></div>`;
    const info = await Settings.load();
    const s = info.server || {};
    const site = info.site || {};
    const live = await fetchServerStatus(s.ip, s.port);
    const liveOk = !!(live && !live.error && !live.offline);
    // 玩法特色：只显示后台配置的内容，没有配置就显示提示，不预设默认项
    const { data: feats } = await sb.from('game_features').select('*').eq('enabled', true).order('sort_order', { ascending: true }).limit(12);
    const iconPool = [icons.cube, icons.heart, icons.shield, icons.users];
    const featureCards = (feats || []).map((f, i) => ({ icon: iconPool[i % iconPool.length], title: f.title, desc: f.description || '' }));

    app.innerHTML = `
    <div class="container">
        <section class="hero">
            <h1 class="hero-title">${esc(site.title || '66qn')}</h1>
            <p class="hero-subtitle">${esc(site.slogan || '纯净原版生存 · 回归游戏本真')}</p>
            <div class="hero-actions">
                <button class="btn btn-primary btn-lg" onclick="copyAddress()">复制服务器地址</button>
                <a href="#/download" class="btn btn-secondary btn-lg">前往下载页</a>
            </div>
        </section>
        <section class="section" style="padding-top:0">
            <div class="status-cards" id="status-cards" data-ip="${esc(s.ip || '')}" data-port="${esc(s.port || '25565')}">
                <div class="card status-card">
                    <div class="status-card-value" id="st-version">${esc(liveOk ? (live.version || '—') : (live && live.offline ? '离线' : (s.version || '—')))}</div>
                    <div class="status-card-label">游戏版本${liveOk ? '（实时）' : ''}</div>
                </div>
                <div class="card status-card">
                    <div class="status-card-value" id="st-online">${liveOk ? `${live.online}/${live.max ?? esc(s.maxPlayers || 20)}` : (live && live.offline ? '服务器离线' : `${(s.players != null ? s.players : 0)}/${esc(s.maxPlayers || 20)}`)}</div>
                    <div class="status-card-label">在线人数${liveOk ? '（实时）' : ''}</div>
                </div>
                <div class="card status-card">
                    <div class="status-card-value" style="font-size:1rem;word-break:break-all">${esc(s.ip || '待填写')}:${esc(s.port || '25565')}</div>
                    <div class="status-card-label">服务器地址</div>
                </div>
            </div>
            <p class="text-tertiary text-center" id="st-note" style="margin-top:var(--space-3)">
                ${liveOk ? (live.motd ? esc(live.motd) : '') : (live && live.error === 'noaddr'
                    ? '管理员还没有在后台填写服务器地址，当前显示的是默认值'
                    : (live && live.offline
                        ? `探测地址 ${esc(live.tried || '')} 未响应（部分服务器会屏蔽海外探测，玩家仍可能正常进入）`
                        : `实时状态获取失败，当前显示的是后台手动填写的数值${live && live.tried ? '（探测地址 ' + esc(live.tried) + '）' : ''}`))}
            </p>
        </section>
        <section class="section">
            <h2 class="section-title text-center">玩法特色</h2>
            <div class="grid-4">
                ${featureCards.length
                    ? featureCards.map(f => `<div class="card feature-card"><div class="feature-icon">${f.icon}</div><h3>${esc(f.title)}</h3><p>${esc(f.desc)}</p></div>`).join('')
                    : '<p class="text-secondary text-center" style="grid-column:1/-1">管理员还没有配置玩法特色</p>'}
            </div>
        </section>
        <section class="section">
            <h2 class="section-title text-center">友情链接</h2>
            <div class="links-grid">
                <a href="${esc(site.qq_group || 'https://qm.qq.com/q/bZNAGK8Rs4')}" target="_blank" rel="noopener" class="link-card">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" stroke-width="1.5"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
                    <div><div class="link-card-name">QQ群</div><div class="link-card-desc">66qn 官方群聊</div></div>
                </a>
                <a href="${esc(site.bilibili || 'https://space.bilibili.com/3546783978359356')}" target="_blank" rel="noopener" class="link-card">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                    <div><div class="link-card-name">B站主页</div><div class="link-card-desc">服务器视频和动态</div></div>
                </a>
                ${site.landmarks ? `<a href="${esc(site.landmarks)}" target="_blank" rel="noopener" class="link-card"><div><div class="link-card-name">服务器地标</div><div class="link-card-desc">查看世界地标总览</div></div></a>` : ''}
            </div>
        </section>
    </div>`;

    startStatusAutoRefresh(s.ip, s.port);
}

// ==================== 首页状态每 30 秒自动刷新（只刷这两个卡片，不重画页面）====================
function stopStatusAutoRefresh() {
    if (window.__statusTimer) { clearInterval(window.__statusTimer); window.__statusTimer = null; }
}

async function refreshStatusCards(ip, port) {
    const wrap = document.getElementById('status-cards');
    if (!wrap) { stopStatusAutoRefresh(); return; }
    const live = await fetchServerStatus(ip, port);
    const vEl = document.getElementById('st-version');
    const oEl = document.getElementById('st-online');
    const nEl = document.getElementById('st-note');
    if (!vEl || !oEl) return;
    if (live && !live.error && !live.offline) {
        vEl.textContent = live.version || '—';
        oEl.textContent = `${live.online}/${live.max ?? 20}`;
        if (nEl) nEl.textContent = live.motd || '';
    } else if (live && live.offline) {
        oEl.textContent = '服务器离线';
    }
}

function startStatusAutoRefresh(ip, port) {
    stopStatusAutoRefresh();
    if (!ip || ip === '待填写') return;
    window.__statusTimer = setInterval(() => refreshStatusCards(ip, port), 30000);
}

async function copyAddress() {
    const info = await Settings.load();
    const s = info.server || {};
    const addr = (s.ip || '') + ':' + (s.port || '25565');
    navigator.clipboard.writeText(addr).then(() => toast('地址已复制到剪贴板'));
}

// ==================== 页面：服务器指令 ====================
async function renderCommands(app) {
    app.innerHTML = `<div class="container" style="max-width:860px;padding:var(--space-12) var(--space-6)"><h1 class="section-title">服务器特有指令</h1><div class="card" id="cmd-list">${loadingBlock()}</div></div>`;
    const { data } = await sb.from('server_commands').select('*').eq('enabled', true).order('created_at', { ascending: false });
    const box = document.getElementById('cmd-list');
    box.innerHTML = (data || []).map(c => `
        <div style="padding:.9rem 0;border-bottom:1px solid var(--color-border-light)">
            <code style="font-size:.9375rem;font-weight:600;color:var(--color-accent)">${esc(c.command)}</code>
            <span class="badge badge-gray" style="margin-left:.5rem">${esc(c.permission || '玩家')}</span>
            <p class="text-secondary" style="margin-top:.35rem;font-size:.875rem">${esc(c.description || '')}</p>
        </div>`).join('') || '<p class="text-secondary">管理员还没有添加指令</p>';
}

// ==================== 页面：成员 ====================
async function renderMembers(app) {
    app.innerHTML = `<div class="container" style="max-width:960px;padding:var(--space-12) var(--space-6)"><h1 class="section-title">成员</h1><div id="members-body">${loadingBlock()}</div></div>`;
    const info = await Settings.load();
    const s = info.server || {};

    const [live, memberRes] = await Promise.all([
        fetchServerStatus(s.ip, s.port),
        // 成员来源为所有已注册用户，不再依赖单独 members 表；撤销资格用户不展示
        sb.from('profiles').select('id,username,game_id,avatar_url,role,bio,status,created_at').neq('status', 'banned').order('created_at', { ascending: true }),
    ]);

    const members = memberRes.data || [];
    const onlineNames = (live && Array.isArray(live.players)) ? live.players : null;
    const onlineSet = new Set((onlineNames || []).map(n => String(n).trim().toLowerCase()));

    const body = document.getElementById('members-body');
    if (!members.length) {
        body.innerHTML = '<div class="card text-secondary" style="text-align:center">管理员还没有添加成员</div>';
        return;
    }

    // 顶部状态说明
    let summary;
    if (!onlineNames) {
        summary = live && live.offline
            ? '服务器当前离线，无法获取在线玩家名单'
            : '暂时无法获取服务器在线玩家名单，成员状态显示为「未知」';
    } else {
        summary = `服务器当前在线 ${live.online}${live.max ? '/' + live.max : ''} 人`;
    }

    body.innerHTML = `
        <p class="text-secondary mb-8" style="font-size:.875rem">${esc(summary)}</p>
        <div class="grid-3">
            ${members.map(m => {
                const name = String(m.game_id || m.username || '').trim();
                const label = m.username || name;
                let badge = '<span class="badge badge-gray">状态未知</span>';
                if (onlineNames) {
                    badge = onlineSet.has(name.toLowerCase())
                        ? '<span class="badge badge-green">服务器在线</span>'
                        : '<span class="badge badge-gray">服务器离线</span>';
                }
                return `
                <div class="card member-card">
                    <a href="#/profile/${m.id}" class="member-top" style="color:inherit">
                        ${m.avatar_url
                            ? `<img src="${esc(m.avatar_url)}" alt="" class="member-avatar" onerror="this.style.display='none'">`
                            : `<div class="member-avatar member-avatar-fallback">${esc(label.slice(0, 1).toUpperCase())}</div>`}
                        <div style="min-width:0">
                            <div class="member-name">${esc(label)}</div>
                            <div class="member-role">${esc(m.role === 'admin' ? '管理员' : '成员')}</div>
                        </div>
                    </a>
                    <div style="margin-top:.6rem">${badge}</div>
                    ${m.bio ? `<p class="text-secondary" style="font-size:.8125rem;margin-top:.6rem">${esc(m.bio)}</p>` : ''}
                    <div class="text-tertiary" style="font-size:.75rem;margin-top:.5rem">游戏 ID：${esc(name)}</div>
                    <div style="display:flex;gap:.5rem;margin-top:.75rem">
                        <a href="#/profile/${m.id}" class="btn btn-secondary btn-sm">查看主页</a>
                        ${APP.user && APP.user.id !== m.id ? `<a href="#/messages/${m.id}" class="btn btn-ghost btn-sm">发私信</a>` : ''}
                    </div>
                </div>`;
            }).join('')}
        </div>`;
}

// ==================== 本地缓存（省流量：先读本地，没有才下载）====================
// 图片缓存用 IndexedDB（容量大，可存二进制）；列表缓存用 localStorage
const ImgCache = {
    dbPromise: null,
    open() {
        if (this.dbPromise) return this.dbPromise;
        this.dbPromise = new Promise((resolve, reject) => {
            try {
                const req = indexedDB.open('66qn-cache', 1);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains('images')) db.createObjectStore('images');
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            } catch (e) { reject(e); }
        });
        return this.dbPromise;
    },
    async get(url) {
        try {
            const db = await this.open();
            return await new Promise((res) => {
                const r = db.transaction('images', 'readonly').objectStore('images').get(url);
                r.onsuccess = () => res(r.result || null);
                r.onerror = () => res(null);
            });
        } catch { return null; }
    },
    async put(url, blob) {
        try {
            const db = await this.open();
            db.transaction('images', 'readwrite').objectStore('images').put(blob, url);
        } catch { /* 缓存失败不阻塞页面 */ }
    },
    /** 有本地缓存就直接用，否则下载一次并写入本地，之后不再重复下载 */
    async resolve(url) {
        if (!url) return url;
        const local = await this.get(url);
        if (local) return URL.createObjectURL(local);
        try {
            const res = await fetch(url, { mode: 'cors' });
            if (!res.ok) return url;
            const blob = await res.blob();
            await this.put(url, blob);
            return URL.createObjectURL(blob);
        } catch { return url; }
    },
};

/** 给容器里所有带 data-cache-img 的 <img> 套上本地缓存 */
async function applyImgCache(root) {
    const imgs = (root || document).querySelectorAll('img[data-cache-img]');
    for (const img of imgs) {
        const src = img.getAttribute('src');
        if (!src) continue;
        const finalSrc = await ImgCache.resolve(src);
        if (finalSrc !== src) img.setAttribute('src', finalSrc);
    }
}

/** 列表数据缓存：先渲染本地旧数据，再从网络刷新 */
const ListCache = {
    read(key) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return null;
            const obj = JSON.parse(raw);
            if (!obj || typeof obj.ts !== 'number') return null;
            return obj;
        } catch { return null; }
    },
    write(key, data) {
        try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch { /* 超出容量时忽略 */ }
    },
    ttl: 30 * 60 * 1000,   // 30 分钟内的本地缓存可直接使用
};

// ==================== 页面：电力 ====================
const POWER_NOTICE = '电力兑换将通过游戏内模组开放，模组制作中，上线后将在本页通知；期间电力正常累积、不清零。开放平台接口已上线，第三方应用可申请接入，管理员可在后台「开放平台」创建账号。';

async function renderPower(app) {
    if (!requireLogin()) return;
    app.innerHTML = `<div class="container" style="max-width:760px;padding:var(--space-12) var(--space-6)" id="power-page">${loadingBlock()}</div>`;

    document.getElementById('power-page').innerHTML = `
        <h1 class="section-title">电力</h1>
        <div class="power-notice mb-8">${esc(POWER_NOTICE)}</div>

        <div class="power-hero mb-8">
            <div class="power-value" id="power-now">…</div>
            <div class="power-unit">当前电力</div>
            <div style="margin-top:1.25rem">
                <button class="btn btn-primary btn-lg" id="power-claim-btn" onclick="claimDailyPower()">每日签到领取 100 电力</button>
            </div>
            <p class="text-tertiary" style="margin-top:.75rem;font-size:.8125rem">每天可领一次，新用户注册赠送 5000 电力</p>
        </div>

        <h3 style="font-size:1rem;font-weight:600;margin-bottom:var(--space-4)">任务列表</h3>
        <div class="power-rules mb-8">
            <div class="card power-task-card"><div><div class="form-label">每日登录</div><p class="text-secondary" style="font-size:.8125rem">每天首次签到</p></div><span class="power-task-reward">+100</span></div>
            <div class="card power-task-card"><div><div class="form-label">新用户注册</div><p class="text-secondary" style="font-size:.8125rem">完成注册（一次性）</p></div><span class="power-task-reward">+5000</span></div>
            <div class="card power-task-card"><div><div class="form-label">上传游戏实录</div><p class="text-secondary" style="font-size:.8125rem">上传截图并通过审核，每次通过</p></div><span class="power-task-reward">+500</span></div>
            <div class="card power-task-card"><div><div class="form-label">发布社区帖子</div><p class="text-secondary" style="font-size:.8125rem">在论坛发帖，每日首次</p></div><span class="power-task-reward">+600</span></div>
            <div class="card power-task-card"><div><div class="form-label">发送社区私信</div><p class="text-secondary" style="font-size:.8125rem">给任意玩家发消息，每日首次</p></div><span class="power-task-reward">+100</span></div>
        </div>

        <h3 style="font-size:1rem;font-weight:600;margin-bottom:var(--space-4)">我的邀请码</h3>
        <div class="card mb-8">
            <p class="text-secondary" style="font-size:.875rem;margin-bottom:.75rem">每成功邀请 1 位好友注册，你获得
                <span style="text-decoration:line-through;opacity:.55;font-weight:600">5000</span>
                <strong style="color:var(--color-accent);font-size:1.15em">10000</strong>
                电力（立即到账）。把邀请码分享给好友，好友注册时填写（选填）即可建立邀请关系。</p>
            <div style="display:flex;align-items:center;gap:1rem;flex-wrap:wrap">
                <div style="font-size:2rem;font-weight:700;letter-spacing:.35em;color:var(--color-accent)" id="my-invite-code">———</div>
                <span class="badge badge-gray">已邀请 <strong id="my-invite-count">0</strong> 人</span>
            </div>
            <div style="display:flex;gap:.5rem;margin-top:1rem">
                <button class="btn btn-secondary btn-sm" onclick="copyMyInviteCode()">复制邀请码</button>
                <button class="btn btn-ghost btn-sm" onclick="regenMyInviteCode()">换一个邀请码</button>
            </div>
        </div>

        <h3 style="font-size:1rem;font-weight:600;margin-bottom:var(--space-4)">电力明细</h3>
        <div class="card" style="padding:0;overflow:hidden" id="power-log-list">${loadingBlock()}</div>`;

    await refreshPowerPanel();
}

async function refreshPowerPanel() {
    const nowEl = document.getElementById('power-now');
    const listEl = document.getElementById('power-log-list');
    if (!nowEl || !listEl) return;

    const [{ data: profile }, { data: logs }] = await Promise.all([
        sb.from('profiles').select('power, invite_code, invite_count').eq('id', APP.user.id).maybeSingle(),
        sb.from('power_logs').select('*').eq('user_id', APP.user.id).order('created_at', { ascending: false }).limit(50),
    ]);

    nowEl.textContent = String((profile && profile.power) || 0);
    const codeEl = document.getElementById('my-invite-code');
    const countEl = document.getElementById('my-invite-count');
    if (codeEl) codeEl.textContent = (profile && profile.invite_code) || '———';
    if (countEl) countEl.textContent = String((profile && profile.invite_count) || 0);
    const todayKey = new Date().toLocaleDateString('sv-SE');   // YYYY-MM-DD（本地时区）
    const claimed = (logs || []).some(l => l.kind === 'daily' && String(l.created_at).slice(0, 10) === todayKey);
    const btn = document.getElementById('power-claim-btn');
    if (btn) {
        btn.disabled = claimed;
        btn.textContent = claimed ? '今日已签到' : '每日签到领取 100 电力';
    }

    const KIND = { newuser: '新用户注册', daily: '每日登录', admin: '管理员调整', manual: '其他', record: '游戏实录', post: '社区帖子', message: '社区私信', invite: '邀请好友', skill: 'AI 技能安装', open: '开放平台' };
    listEl.innerHTML = (logs || []).length
        ? `<table class="data-table"><thead><tr><th>时间</th><th>类型</th><th>数量</th><th>说明</th></tr></thead>
           <tbody>${logs.map(l => `<tr>
                <td class="text-tertiary">${new Date(l.created_at).toLocaleString('zh-CN')}</td>
                <td>${esc(KIND[l.kind] || l.kind)}</td>
                <td style="font-weight:600;color:${l.amount >= 0 ? 'var(--color-success)' : 'var(--color-danger)'}">${l.amount >= 0 ? '+' : ''}${l.amount}</td>
                <td class="text-tertiary">${esc(l.note || '')}</td></tr>`).join('')}</tbody></table>`
        : '<div style="padding:1.5rem;text-align:center;color:var(--color-text-tertiary)">暂无记录</div>';
}

async function claimDailyPower() {
    if (!requireLogin()) return;
    const { data, error } = await sb.rpc('claim_daily_power');
    if (error) return toast(errText(error, '签到失败'), 'error');
    if (!data) { toast('今天已经签到过了'); await refreshPowerPanel(); return; }
    toast('签到成功，获得 ' + data + ' 电力');
    await refreshPowerPanel();
}

// 登录后自动尝试一次每日签到（数据库层按北京时间去重，重复调用不会多发）
async function autoClaimDailyPower() {
    if (!APP.user) return;
    try { await sb.rpc('claim_daily_power'); } catch { /* 静默失败 */ }
}

function copyMyInviteCode() {
    const code = document.getElementById('my-invite-code')?.textContent || '';
    if (!code || code === '———') return toast('还没有邀请码', 'error');
    navigator.clipboard.writeText(code).then(() => toast('邀请码已复制：' + code)).catch(() => prompt('请手动复制邀请码：', code));
}

async function regenMyInviteCode() {
    if (!confirm('更换邀请码后，旧邀请码将失效，确定更换？')) return;
    const { data, error } = await sb.rpc('regenerate_invite_code');
    if (error) return toast(errText(error, '更换失败'), 'error');
    const codeEl = document.getElementById('my-invite-code');
    if (codeEl) codeEl.textContent = data;
    toast('已生成新邀请码');
}

// ==================== 页面：AI 技能（开放平台 · 玩家入口） ====================
async function renderSkill(app) {
    app.innerHTML = `
    <div class="container" style="max-width:760px;padding:var(--space-12) var(--space-6)">
        <h1 class="section-title">AI 技能 · 自动管家</h1>
        <p class="text-secondary mb-8">把 66qn 的 AI 技能装进你的 AI 助手（Claude / ChatGPT / 夸克 / 各类 Agent），它就能替你自动干活。</p>

        <div class="power-rules mb-8">
            <div class="card power-task-card"><div><div class="form-label">每日自动签到</div><p class="text-secondary" style="font-size:.8125rem">AI 每天替你签到领取电力</p></div><span class="power-task-reward">+100/天</span></div>
            <div class="card power-task-card"><div><div class="form-label">查询电力余额</div><p class="text-secondary" style="font-size:.8125rem">随时问 AI「我还有多少电力」</p></div><span class="power-task-reward">实时</span></div>
            <div class="card power-task-card"><div><div class="form-label">查询账号信息</div><p class="text-secondary" style="font-size:.8125rem">昵称、游戏 ID、注册时间等</p></div><span class="power-task-reward">实时</span></div>
            <div class="card power-task-card"><div><div class="form-label">安装奖励</div><p class="text-secondary" style="font-size:.8125rem">首次安装成功并完成首次连接</p></div><span class="power-task-reward">+60000</span></div>
        </div>

        <div class="card mb-8" id="skill-uid-card">${loadingBlock()}</div>
        <div class="card mb-8" id="skill-prompt-card">${loadingBlock()}</div>

        <div class="card">
            <h3 style="font-size:1rem;font-weight:600;margin-bottom:var(--space-4)">技能文件</h3>
            <p class="text-secondary" style="font-size:.875rem;margin-bottom:.75rem">把 SKILL.md 交给你的 AI，或让它自己去下面这个地址下载。</p>
            <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.75rem">
                <a class="btn btn-secondary" href="agent-skill-66qn/SKILL.md" target="_blank" rel="noopener">在线查看</a>
                <a class="btn btn-primary" href="agent-skill-66qn/SKILL.md" download="SKILL.md">下载 SKILL.md</a>
            </div>
            <p class="text-tertiary" style="font-size:.8125rem">文件地址：<code>https://66qnmc.top/agent-skill-66qn/SKILL.md</code></p>
        </div>
    </div>`;
    await loadSkillPanel();
}

async function loadSkillPanel() {
    const uidCard = document.getElementById('skill-uid-card');
    const promptCard = document.getElementById('skill-prompt-card');
    if (!uidCard || !promptCard) return;

    if (!APP.user) {
        uidCard.innerHTML = `<h3 style="font-size:1rem;font-weight:600;margin-bottom:var(--space-4)">我的授权码</h3>
            <p class="text-secondary" style="font-size:.875rem;margin-bottom:.75rem">登录后即可领取你的专属授权码。</p>
            <a href="#/login" class="btn btn-primary">去登录</a>`;
        promptCard.innerHTML = `<h3 style="font-size:1rem;font-weight:600;margin-bottom:var(--space-4)">安装提示词</h3>
            <p class="text-secondary" style="font-size:.875rem">登录后生成属于你的安装提示词。</p>`;
        return;
    }

    const [{ data: myUid }, { data: rewardLog }] = await Promise.all([
        sb.rpc('view_my_open_uid'),
        sb.from('power_logs').select('id').eq('user_id', APP.user.id).eq('kind', 'skill').maybeSingle(),
    ]);
    const uid = typeof myUid === 'string' ? myUid : (myUid && myUid.uid) || '';

    uidCard.innerHTML = `
        <h3 style="font-size:1rem;font-weight:600;margin-bottom:var(--space-4)">我的授权码</h3>
        ${uid ? `
            <p class="text-secondary" style="font-size:.875rem;margin-bottom:.75rem">授权码是 AI 技能操作你账号的唯一凭证，请勿泄露给他人。</p>
            <div style="display:flex;align-items:center;gap:.75rem;flex-wrap:wrap">
                <code id="my-skill-uid" style="font-size:.9375rem;background:var(--color-bg-tertiary);padding:.5rem .75rem;border-radius:6px;word-break:break-all">${esc(uid)}</code>
                <button class="btn btn-secondary btn-sm" onclick="copySkillUid()">复制授权码</button>
            </div>` : `
            <p class="text-secondary" style="font-size:.875rem;margin-bottom:.75rem">你还没有领取授权码。点击下方按钮领取（每人一个，仅支持签到和查询，不能动你的电力余额）。</p>
            <button class="btn btn-primary" onclick="claimSkillUid()">领取我的授权码</button>`}`;

    promptCard.innerHTML = `
        <h3 style="font-size:1rem;font-weight:600;margin-bottom:var(--space-4)">安装提示词（复制后发给你的 AI）</h3>
        ${uid ? `
            <textarea class="textarea" id="skill-prompt-text" rows="7" readonly style="font-size:.8125rem;line-height:1.7">请帮我安装并使用「66qn AI 技能」：
1. 从 https://66qnmc.top/agent-skill-66qn/SKILL.md 下载技能文件并阅读
2. 按文件说明安装技能，将授权码 ${uid} 配置为环境变量 QN66_UID
3. 调用开放接口执行一次每日签到（checkin），完成首次连接
4. 把签到结果告诉我</textarea>
            <div style="display:flex;gap:.5rem;margin-top:.75rem;flex-wrap:wrap">
                <button class="btn btn-primary" onclick="copySkillPrompt()">复制提示词</button>
            </div>
            <p class="text-tertiary" style="font-size:.8125rem;margin-top:.75rem">首次连接成功后，<strong>60000 电力</strong>奖励自动到账。
            当前状态：${rewardLog ? '<span class="badge badge-green">已获得</span>' : '<span class="badge badge-gray">未获得</span>'}</p>`
        : `<p class="text-secondary" style="font-size:.875rem">领取授权码后，这里会生成属于你的安装提示词。</p>`}`;
}

async function claimSkillUid() {
    const { data, error } = await sb.rpc('claim_open_account');
    if (error) return toast(errText(error, '领取失败'), 'error');
    if (data && data.is_new && data.uid) {
        showModal('领取成功 · 请妥善保存', `
            <p class="text-secondary" style="font-size:.875rem;margin-bottom:.75rem">这是你的专属授权码，只会完整显示这一次，之后可在本页随时查看。</p>
            <code style="display:block;font-size:.9375rem;background:var(--color-bg-tertiary);padding:.75rem;border-radius:6px;word-break:break-all">${esc(data.uid)}</code>`,
            `<button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">关闭</button>
             <button class="btn btn-primary" onclick="copyText('${data.uid}').then(()=>toast('授权码已复制'))">复制授权码</button>`);
    } else {
        toast('你已领取过授权码');
    }
    await loadSkillPanel();
}

async function copySkillUid() {
    const el = document.getElementById('my-skill-uid');
    if (!el) return;
    try { await navigator.clipboard.writeText(el.textContent || ''); toast('授权码已复制'); }
    catch { prompt('请手动复制授权码：', el.textContent || ''); }
}

async function copySkillPrompt() {
    const el = document.getElementById('skill-prompt-text');
    if (!el) return;
    try { await navigator.clipboard.writeText(el.value || ''); toast('提示词已复制，快去发给你的 AI'); }
    catch { el.select(); document.execCommand && document.execCommand('copy'); toast('提示词已复制'); }
}

// ==================== 页面：活动 ====================
async function renderEvents(app, eventId) {
    if (eventId) return renderEventDetail(app, eventId);
    app.innerHTML = `<div class="container" style="max-width:860px;padding:var(--space-12) var(--space-6)"><h1 class="section-title">服务器活动</h1><div class="card" id="event-list">${loadingBlock()}</div></div>`;
    const { data } = await sb.from('events').select('*').eq('enabled', true).order('created_at', { ascending: false });
    const box = document.getElementById('event-list');
    box.innerHTML = (data || []).map(e => `
        <div style="padding:1rem 0;border-bottom:1px solid var(--color-border-light)">
            <a href="#/events/${e.id}" style="font-size:1rem;font-weight:600">${esc(e.name)}</a>
            ${e.signup_enabled ? '<span class="badge badge-blue" style="margin-left:.5rem">开放报名</span>' : '<span class="badge badge-gray" style="margin-left:.5rem">仅展示</span>'}
            <p class="text-secondary" style="margin-top:.35rem;font-size:.875rem">${esc(e.description || '')}</p>
            ${e.starts_at ? `<div class="text-tertiary" style="margin-top:.35rem">开始：${new Date(e.starts_at).toLocaleString('zh-CN')}</div>` : ''}
        </div>`).join('') || '<p class="text-secondary">暂无活动</p>';
}

async function renderEventDetail(app, eventId) {
    app.innerHTML = `<div class="container" style="max-width:720px;padding:var(--space-12) var(--space-6)">${loadingBlock()}</div>`;
    const { data: ev } = await sb.from('events').select('*').eq('id', eventId).maybeSingle();
    if (!ev) { app.innerHTML = '<div class="container" style="padding:var(--space-16);text-align:center">活动不存在</div>'; return; }
    const { data: signups } = await sb.from('event_signups').select('*, user:profiles!event_signups_user_id_fkey(username)').eq('event_id', eventId).order('created_at', { ascending: true });
    const mine = APP.user ? (signups || []).find(s => s.user_id === APP.user.id) : null;

    app.innerHTML = `
    <div class="container" style="max-width:720px;padding:var(--space-8) var(--space-6)">
        <a href="#/events" class="btn btn-ghost btn-sm mb-4">${icons.back} 返回活动</a>
        <h1 class="section-title">${esc(ev.name)}</h1>
        <div class="card mb-8" style="line-height:1.8;font-size:.9375rem">${esc(ev.description || '暂无描述').replace(/\n/g,'<br>')}</div>
        <h3 style="font-size:1rem;font-weight:600;margin-bottom:var(--space-4)">报名 (${(signups || []).length})</h3>
        ${ev.signup_enabled ? (APP.user ? (mine ? '<div class="card mb-4 text-secondary">你已报名，可等待管理员审核。</div>' : `
            <div class="card mb-4">
                <div class="form-group"><label class="form-label">报名留言</label><textarea class="textarea" id="signup-text" rows="3" maxlength="500" placeholder="介绍一下你的情况或想参加的理由"></textarea></div>
                <div class="form-group"><label class="form-label">上传图片（可选，自动压缩至 100KB 内）</label>
                    <input class="input" type="file" id="signup-file" accept="image/*" onchange="previewSignupImage(this)"></div>
                <div id="signup-preview"></div>
                <button class="btn btn-primary" onclick="submitSignup('${ev.id}')">提交报名</button>
            </div>`) : '<p class="text-secondary mb-4">请先登录后报名</p>') : '<p class="text-secondary mb-4">该活动未开放报名</p>'}
        <div class="card" style="padding:0;overflow:hidden">
            ${(signups || []).map(s => `
                <div style="padding:.85rem 1rem;border-bottom:1px solid var(--color-border-light)">
                    <strong style="font-size:.875rem">${esc(s.user?.username || '玩家')}</strong>
                    <p class="text-secondary" style="font-size:.875rem;margin-top:.25rem">${esc(s.text_content || '')}</p>
                    ${s.image_url ? `<img src="${esc(s.image_url)}" data-cache-img alt="" loading="lazy" style="width:100%;max-width:220px;height:auto;border-radius:8px;border:1px solid var(--color-border);margin-top:.5rem"><div class="mt-2"><a href="${esc(s.image_url)}" target="_blank" rel="noopener" class="btn btn-secondary btn-sm">查看原图</a></div>` : ''}
                </div>`).join('') || '<div style="padding:1.5rem;text-align:center;color:var(--color-text-tertiary)">还没有人报名</div>'}
        </div>
    </div>`;
    applyImgCache(app);
}

async function previewSignupImage(input) {
    const file = input.files?.[0];
    if (!file) return;
    const box = document.getElementById('signup-preview');
    box.innerHTML = '<p class="text-tertiary">压缩中…</p>';
    try {
        const { dataUrl, sizeKB } = await compressImage(file, 100);
        window.__signupImage = dataUrl;
        box.innerHTML = `<div class="thumb-preview"><img src="${dataUrl}" alt=""><span class="text-secondary" style="font-size:.8125rem">已压缩至约 ${sizeKB} KB</span></div>`;
    } catch (e) { box.innerHTML = ''; toast(e.message, 'error'); }
}

async function submitSignup(eventId) {
    if (!requireLogin() || !requireAgreement()) return;
    const text = document.getElementById('signup-text').value.trim();
    if (text.length < 2) return toast('请填写报名留言', 'error');
    let imageUrl = null;
    try {
        if (window.__signupImage) imageUrl = await uploadImage(dataUrlToBlob(window.__signupImage), 'events');
    } catch (e) { return toast(e.message, 'error'); }
    const { error } = await sb.from('event_signups').insert({ event_id: eventId, user_id: APP.user.id, text_content: text, image_url: imageUrl });
    if (error) return toast(errText(error, '报名失败'), 'error');
    window.__signupImage = null;
    toast('报名已提交');
    APP.route();
}

// ==================== 页面：游戏实录 ====================
async function renderRecords(app) {
    app.innerHTML = `<div class="container" style="max-width:900px;padding:var(--space-12) var(--space-6)"><h1 class="section-title">游戏实录</h1><div id="rec-body">${loadingBlock()}</div></div>`;

    const CACHE_KEY = '66qn_cache_records_v1';
    const cached = ListCache.read(CACHE_KEY);
    const cacheFresh = cached && (Date.now() - cached.ts) < ListCache.ttl;

    if (cacheFresh) {
        paintRecords(cached.data);
        return;   // 本地缓存有效，直接使用，不再请求网络
    }

    const { data } = await sb.from('game_records').select('*').eq('status', 'approved').order('created_at', { ascending: false });
    ListCache.write(CACHE_KEY, data || []);
    paintRecords(data || []);
}

function paintRecords(data) {
    const body = document.getElementById('rec-body');
    if (!body) return;
    body.innerHTML = `
        ${APP.user ? `
        <div class="card mb-8">
            <h3 style="font-size:1rem;font-weight:600;margin-bottom:var(--space-4)">上传我的实录（人工审核）</h3>
            <div class="grid-2">
                <div class="form-group"><label class="form-label">游戏名字</label><input class="input" id="rec-name" value="${esc(APP.user.game_id || APP.user.username)}" maxlength="32"></div>
                <div class="form-group"><label class="form-label">坐标</label><input class="input" id="rec-coord" placeholder="例如 120,64,-340" maxlength="64"></div>
            </div>
            <div class="form-group"><label class="form-label">压缩目标体积</label>
                <select class="input" id="rec-size">
                    <option value="100">100 KB（推荐，清晰）</option>
                    <option value="60">60 KB</option>
                    <option value="30">30 KB</option>
                    <option value="10">10 KB（最省流量）</option>
                </select></div>
            <div class="form-group"><label class="form-label">截图</label>
                <input class="input" type="file" id="rec-file" accept="image/*" onchange="previewRecordImage(this)"></div>
            <div id="rec-preview"></div>
            <button class="btn btn-primary" style="margin-top:.75rem" onclick="submitRecord()">提交审核</button>
        </div>` : '<p class="text-secondary mb-8">请先登录后上传实录</p>'}
        <div class="grid-3">
            ${data.map(r => `
                <div class="card" style="padding:0;overflow:hidden">
                    <img src="${esc(r.image_url)}" alt="" data-cache-img style="width:100%;height:170px;object-fit:cover" loading="lazy">
                    <div style="padding:.85rem 1rem">
                        <strong style="font-size:.9375rem">${esc(r.player_name)}</strong>
                        <div class="text-tertiary" style="font-size:.8125rem;margin-top:.2rem">${esc(r.coordinates)}</div>
                    </div>
                </div>`).join('') || '<p class="text-secondary">还没有通过审核的实录</p>'}
        </div>`;
    applyImgCache(body);
}

async function previewRecordImage(input) {
    const file = input.files?.[0];
    if (!file) return;
    const target = Number(document.getElementById('rec-size').value) || 100;
    const box = document.getElementById('rec-preview');
    box.innerHTML = '<p class="text-tertiary">压缩中…</p>';
    try {
        const { dataUrl, sizeKB } = await compressImage(file, target);
        window.__recImage = dataUrl;
        box.innerHTML = `<div class="thumb-preview"><img src="${dataUrl}" alt=""><span class="text-secondary" style="font-size:.8125rem">已压缩至约 ${sizeKB} KB（目标 ${target} KB）</span></div>`;
    } catch (e) { box.innerHTML = ''; toast(e.message, 'error'); }
}

async function submitRecord() {
    if (!requireLogin() || !requireAgreement()) return;
    const playerName = document.getElementById('rec-name').value.trim();
    const coordinates = document.getElementById('rec-coord').value.trim();
    if (!playerName) return toast('请填写游戏名字', 'error');
    if (!coordinates) return toast('请填写坐标', 'error');
    if (!window.__recImage) return toast('请先选择并压缩截图', 'error');
    let imageUrl;
    try { imageUrl = await uploadImage(dataUrlToBlob(window.__recImage), 'records'); }
    catch (e) { return toast(e.message, 'error'); }
    const { error } = await sb.from('game_records').insert({ user_id: APP.user.id, player_name: playerName, coordinates, image_url: imageUrl, status: 'pending' });
    if (error) return toast(errText(error, '提交失败'), 'error');
    window.__recImage = null;
    localStorage.removeItem('66qn_cache_records_v1');   // 清掉本地缓存，下次进入拉取最新列表
    toast('已提交，等待管理员审核');
    APP.route();
}

// ==================== 页面：下载页（启动器 + 自有模组）====================
async function renderDownload(app) {
    app.innerHTML = `
    <div class="container" style="max-width:680px;margin:0 auto;padding:var(--space-16) var(--space-6)">
        <h1 class="section-title" style="font-size:1.875rem">下载页</h1>
        <p class="text-secondary mb-8">这里提供进入 66qn 所需的启动器，以及本站自有的整合模组。</p>

        <h2 class="dl-section-title">启动器</h2>
        <div id="launchers-list" style="display:flex;flex-direction:column;gap:var(--space-4)">${loadingBlock()}</div>
        <div class="disclaimer"><strong>免责声明</strong><br>以上启动器均为第三方开发的 Minecraft 启动工具，与本站无关。上述链接仅跳转到各启动器的官方网站或 GitHub Releases 页面，本站不提供任何启动器文件的直接下载。请从官方渠道下载以确保安全。使用第三方启动器所产生的任何风险由用户自行承担。</div>

        <h2 class="dl-section-title" style="margin-top:var(--space-16)">自有模组</h2>
        <p class="text-secondary mb-4" style="font-size:.875rem">由 66qn 服务器整理或自制的模组资源，请按需下载。</p>
        <div id="mods-list" style="display:flex;flex-direction:column;gap:var(--space-4)">${loadingBlock()}</div>
    </div>`;

    const box = document.getElementById('mods-list');
    const lbox = document.getElementById('launchers-list');
    const [lr, mr] = await Promise.all([
        sb.from('launchers').select('*').eq('enabled', true).order('sort_order', { ascending: true }).order('created_at', { ascending: false }),
        sb.from('mods').select('*').eq('enabled', true).order('sort_order', { ascending: true }).order('created_at', { ascending: false }),
    ]);
    if (lbox) {
        if (lr.error) { lbox.innerHTML = '<p class="text-secondary">暂时无法加载启动器列表</p>'; }
        else lbox.innerHTML = (lr.data || []).map(l => {
            const tags = String(l.tags || '').split(',').map(t => t.trim()).filter(Boolean);
            const tagHtml = tags.map((t, i) => `<span class="badge ${i === 0 ? 'badge-blue' : 'badge-gray'}">${esc(t)}</span>`).join('');
            return `
            <div class="card launcher-card">
                <div class="launcher-info">
                    <h3>${esc(l.name)}${l.subtitle ? ` <span class="text-tertiary" style="font-weight:400">(${esc(l.subtitle)})</span>` : ''}</h3>
                    <p>${mdEmphasis(l.description || '暂无说明')}</p>
                    ${tags.length ? `<div class="launcher-tags">${tagHtml}</div>` : ''}
                </div>
                ${l.url ? `<a href="${esc(l.url)}" target="_blank" rel="noopener" class="btn btn-primary" style="flex-shrink:0">${icons.download} 前往下载</a>` : '<span class="badge badge-gray">暂未提供链接</span>'}
            </div>`;
        }).join('') || '<div class="card text-secondary" style="text-align:center">管理员还没有添加启动器</div>';
    }
    if (mr.error) { box.innerHTML = '<p class="text-secondary">暂时无法加载模组列表</p>'; return; }
    box.innerHTML = (mr.data || []).map(m => `
        <div class="card launcher-card">
            <div class="launcher-info">
                <h3>${esc(m.name)} ${m.version ? `<span class="text-tertiary" style="font-weight:400">v${esc(m.version)}</span>` : ''}</h3>
                <p>${mdEmphasis(m.description || '暂无说明')}</p>
            </div>
            ${m.url ? `<a href="${esc(m.url)}" target="_blank" rel="noopener" class="btn btn-primary" style="flex-shrink:0">${icons.download} 下载</a>` : '<span class="badge badge-gray">暂未提供下载</span>'}
        </div>`).join('') || '<div class="card text-secondary" style="text-align:center">管理员还没有上传模组</div>';
}

// ==================== 页面：论坛列表 ====================
async function renderForum(app) {
    app.innerHTML = `<div class="container" style="max-width:720px;margin:0 auto;padding:var(--space-8) var(--space-6)">
        <div class="card" style="padding:0">${loadingBlock()}</div></div>`;
    const { data: posts } = await sb.from('posts')
        .select('*, author:profiles!posts_user_id_fkey(username, avatar_url)')
        .eq('status', 'published')
        .order('is_pinned', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(100);

    app.innerHTML = `
    <div class="container" style="max-width:720px;margin:0 auto;padding:var(--space-8) var(--space-6)">
        <div class="forum-toolbar">
            <div class="forum-tabs">
                ${CATEGORIES.map(c => `<button class="forum-tab${c.key === '' ? ' active' : ''}" data-cat="${c.key}">${c.label}</button>`).join('')}
            </div>
            <a href="#/forum/new" class="btn btn-primary btn-sm">${icons.edit} 发帖</a>
        </div>
        <div class="card" style="padding:0;overflow:hidden">
            ${!posts || posts.length === 0 ? '<div style="padding:var(--space-12);text-align:center;color:var(--color-text-tertiary)">暂无帖子</div>' :
            posts.map(p => `
                <div class="post-item" data-cat="${esc(p.category)}" onclick="location.hash='#/forum/${p.id}'">
                    <div>
                        <div class="post-title">${p.is_pinned ? '<span class="pinned-icon">' + icons.pin + '</span>' : ''}${esc(p.title)}</div>
                        <div class="post-meta">
                            <span>${esc(p.author?.username || '未知')}</span>
                            <span>${timeAgo(p.created_at)}</span>
                            <span class="badge badge-gray">${esc(CAT_LABEL[p.category] || p.category)}</span>
                        </div>
                    </div>
                    <div class="post-stats">
                        <span class="post-stat">${icons.thumb} ${p.likes_count}</span>
                        <span class="post-stat">${icons.message} ${p.comments_count}</span>
                    </div>
                </div>`).join('')}
        </div>
    </div>`;

    app.querySelectorAll('.forum-tab').forEach(tab => {
        tab.onclick = () => {
            app.querySelectorAll('.forum-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const cat = tab.dataset.cat;
            app.querySelectorAll('.post-item').forEach(item => {
                item.style.display = (!cat || item.dataset.cat === cat) ? '' : 'none';
            });
        };
    });
}

// ==================== 页面：帖子详情 ====================
async function renderForumDetail(app, postId) {
    app.innerHTML = `<div class="container" style="max-width:720px;margin:0 auto;padding:var(--space-8) var(--space-6)">${loadingBlock()}</div>`;
    sb && sb.rpc('view_post', { p_id: postId });

    const { data: post } = await sb.from('posts')
        .select('*, author:profiles!posts_user_id_fkey(username, avatar_url)')
        .eq('id', postId).maybeSingle();
    if (!post) { app.innerHTML = '<div class="container" style="padding:var(--space-16);text-align:center">帖子不存在或已删除</div>'; return; }

    const { data: comments } = await sb.from('comments')
        .select('*, author:profiles!comments_user_id_fkey(username, avatar_url)')
        .eq('post_id', postId).eq('status', 'published')
        .order('created_at', { ascending: true });

    let isLiked = false;
    if (APP.user) {
        const { data: lk } = await sb.from('likes').select('post_id').eq('post_id', postId).eq('user_id', APP.user.id).maybeSingle();
        isLiked = !!lk;
    }
    const canManage = APP.user && (APP.user.id === post.user_id || APP.isAdmin);

    app.innerHTML = `
    <div class="container" style="max-width:720px;margin:0 auto;padding:var(--space-8) var(--space-6)">
        <a href="#/forum" class="btn btn-ghost btn-sm mb-4">${icons.back} 返回列表</a>
        <div class="post-detail-header">
            <h1 class="post-detail-title">${esc(post.title)}</h1>
            <div class="post-detail-meta">
                ${avatarHtml(post.author, 32)}
                <span style="font-weight:500">${esc(post.author?.username || '未知')}</span>
                <span class="badge badge-gray">${esc(CAT_LABEL[post.category] || post.category)}</span>
                <span class="text-tertiary">${timeAgo(post.created_at)}</span>
                <span class="text-tertiary">${post.view_count} 次浏览</span>
            </div>
        </div>
        <div class="post-detail-content">${renderMarkdown(post.content)}</div>
        <div class="post-detail-actions">
            <button class="btn ${isLiked ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="toggleLike('${postId}')">${icons.thumb} <span id="like-count">${post.likes_count}</span></button>
            <button class="btn btn-ghost btn-sm" onclick="showReportModal('post','${postId}')">${icons.flag} 举报</button>
            ${canManage ? `<button class="btn btn-ghost btn-sm" onclick="deletePost('${postId}')">${icons.trash} 删除</button>` : ''}
        </div>
        <div class="comment-section">
            <h3 style="font-size:1rem;font-weight:600;margin-bottom:var(--space-4)">评论 (${(comments || []).length})</h3>
            ${APP.user ? `
            <div style="display:flex;gap:var(--space-3);margin-bottom:var(--space-6)">
                ${avatarHtml(APP.user, 32)}
                <div style="flex:1">
                    <textarea class="textarea" id="comment-input" placeholder="发表评论..." rows="2"></textarea>
                    <button class="btn btn-primary btn-sm mt-2" onclick="submitComment('${postId}')">发送</button>
                </div>
            </div>` : '<p class="text-secondary mb-4" style="font-size:0.875rem"><a href="#/login" style="color:var(--color-accent)">登录</a> 后发表评论</p>'}
            <div id="comments-list">
            ${(comments || []).map(c => `
                <div class="comment-item">
                    <div class="comment-header">
                        ${avatarHtml(c.author, 24)}
                        <span class="comment-author">${esc(c.author?.username || '未知')}</span>
                        <span class="comment-time">${timeAgo(c.created_at)}</span>
                    </div>
                    <div class="comment-content">${esc(c.content)}</div>
                    <div class="comment-actions">
                        ${APP.user ? `<button onclick="replyToComment('${postId}','${c.id}','${esc(c.author?.username || '')}')">回复</button>` : ''}
                        ${APP.user ? `<button onclick="showReportModal('comment','${c.id}')">${icons.flag} 举报</button>` : ''}
                        ${(APP.user && (APP.user.id === c.user_id || APP.isAdmin)) ? `<button onclick="deleteComment('${c.id}')">${icons.trash} 删除</button>` : ''}
                    </div>
                </div>`).join('')}
            </div>
        </div>
    </div>`;
}

function renderMarkdown(text) {
    return esc(text)
        .replace(/^### (.+)$/gm, '<h3 style="font-size:1.125rem;font-weight:600;margin:var(--space-6) 0 var(--space-3)">$1</h3>')
        .replace(/^## (.+)$/gm, '<h2 style="font-size:1.25rem;font-weight:600;margin:var(--space-8) 0 var(--space-4)">$1</h2>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n\n/g, '</p><p>')
        .replace(/\n/g, '<br>')
        .replace(/^(\d+)\.\s(.+)$/gm, '<li style="margin-left:var(--space-6);margin-bottom:var(--space-1)">$1. $2</li>')
        .replace(/<p>/g, '<p style="margin-bottom:var(--space-4)">');
}

async function toggleLike(postId) {
    if (!requireLogin()) return;
    const { data: lk } = await sb.from('likes').select('post_id').eq('post_id', postId).eq('user_id', APP.user.id).maybeSingle();
    if (lk) {
        await sb.from('likes').delete().eq('post_id', postId).eq('user_id', APP.user.id);
        toast('已取消点赞');
    } else {
        const { error } = await sb.from('likes').insert({ post_id: postId, user_id: APP.user.id });
        if (error) return toast(errText(error, '点赞失败'), 'error');
        toast('已点赞');
    }
    APP.route();
}

async function submitComment(postId) {
    if (!requireLogin() || !requireAgreement()) return;
    const input = document.getElementById('comment-input');
    const content = input.value.trim();
    if (!content) return toast('请输入评论内容', 'error');
    if (content.length > 2000) return toast('评论不能超过2000字', 'error');
    const review = await aiModerate('comment', content);
    if (review && review.verdict === 'reject') return toast('评论未通过审核：' + (review.reason || '疑似违规'), 'error');
    const { error } = await sb.from('comments').insert({ post_id: postId, user_id: APP.user.id, content });
    if (error) return toast(errText(error, '评论失败'), 'error');
    toast('评论已发送');
    APP.route();
}

async function replyToComment(postId, parentId, authorName) {
    if (!requireLogin()) return;
    const content = prompt(`回复 ${authorName}:`);
    if (!content || !content.trim()) return;
    const { error } = await sb.from('comments').insert({ post_id: postId, user_id: APP.user.id, parent_id: parentId, content: content.trim() });
    if (error) return toast(errText(error, '回复失败'), 'error');
    toast('回复已发送');
    APP.route();
}

async function deleteComment(commentId) {
    if (!confirm('确定删除这条评论？')) return;
    await sb.from('comments').update({ status: 'deleted' }).eq('id', commentId);
    toast('评论已删除');
    APP.route();
}

async function deletePost(postId) {
    if (!confirm('确定删除这个帖子？')) return;
    await sb.from('posts').update({ status: 'deleted' }).eq('id', postId);
    toast('帖子已删除');
    location.hash = '#/forum';
}

function showReportModal(type, id) {
    if (!requireLogin()) return;
    showModal('举报', `
        <p style="font-size:0.875rem;color:var(--color-text-secondary);margin-bottom:var(--space-4)">请描述举报原因（至少10个字符）：</p>
        <textarea class="textarea" id="report-reason" placeholder="举报理由..." rows="4"></textarea>`, `
        <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">取消</button>
        <button class="btn btn-danger btn-sm" onclick="submitReport('${type}','${id}')">提交举报</button>`);
}

async function submitReport(type, id) {
    if (!requireAgreement()) return;
    const reason = document.getElementById('report-reason').value.trim();
    if (reason.length < 10) return toast('举报理由至少需要10个字符', 'error');
    const { data, error } = await sb.from('reports').insert({ reporter_id: APP.user.id, target_type: type, target_id: id, reason }).select().maybeSingle();
    if (error) return toast(errText(error, '举报失败'), 'error');
    document.querySelector('.modal-overlay')?.remove();
    toast('举报已提交，AI 正在复核');
    // 交由 AI 复核，判定应删除时自动删除
    try {
        const { data: rv } = await sb.functions.invoke(AI_FN, { body: { action: 'review_report', report_id: data.id } });
        if (rv && rv.autoDeleted) toast('AI 已判定违规并自动删除相关内容', 'success');
    } catch { /* AI 未配置时静默 */ }
}

// ==================== 页面：发帖 ====================
function renderForumNew(app) {
    if (!requireLogin()) return;
    const cats = CATEGORIES.filter(c => c.key && (c.key !== 'announcement' || APP.isAdmin));
    app.innerHTML = `
    <div class="container" style="max-width:640px;margin:0 auto;padding:var(--space-8) var(--space-6)">
        <a href="#/forum" class="btn btn-ghost btn-sm mb-4">${icons.back} 返回列表</a>
        <h1 class="section-title" style="font-size:1.5rem">发布新帖</h1>
        <div class="form-group"><label class="form-label">分类</label>
            <select class="input" id="post-category">${cats.map(c => `<option value="${c.key}">${c.label}</option>`).join('')}</select></div>
        <div class="form-group"><label class="form-label">标题 <span class="text-tertiary">(5-100字)</span></label>
            <input class="input" id="post-title" placeholder="帖子标题" maxlength="100"></div>
        <div class="form-group"><label class="form-label">正文 <span class="text-tertiary">(支持基础 Markdown)</span></label>
            <textarea class="textarea" id="post-content" placeholder="帖子内容..." rows="10" style="min-height:200px"></textarea></div>
        <div style="display:flex;gap:var(--space-3);justify-content:flex-end">
            <a href="#/forum" class="btn btn-secondary">取消</a>
            <button class="btn btn-primary" onclick="submitPost()">发布</button></div>
    </div>`;
}

async function submitPost() {
    if (!requireLogin() || !requireAgreement()) return;
    const title = document.getElementById('post-title').value.trim();
    const content = document.getElementById('post-content').value.trim();
    const category = document.getElementById('post-category').value;
    if (title.length < 5) return toast('标题至少5个字符', 'error');
    if (content.length < 10) return toast('正文至少10个字符', 'error');

    // AI 审核（未配置模型时自动跳过）
    toast('正在审核内容…');
    const review = await aiModerate('post', `${title}\n${content}`);
    if (review && review.verdict === 'reject') {
        await sb.from('ai_reviews').insert({ target_type: 'post', target_id: APP.user.id, verdict: 'reject', reason: review.reason || '', model: review.model || '' });
        return toast('内容未通过审核：' + (review.reason || '疑似违规'), 'error');
    }

    const { error } = await sb.from('posts').insert({ user_id: APP.user.id, title, content, category });
    if (error) return toast(errText(error, '发布失败'), 'error');
    toast('帖子已发布');
    location.hash = '#/forum';
}

// 调用 AI 审核（失败或未配置时返回 null，不阻断发布）
async function aiModerate(targetType, content) {
    try {
        const { data, error } = await sb.functions.invoke(AI_FN, { body: { action: 'moderate', target_type: targetType, content } });
        if (error || !data || data.error) return null;
        return data;
    } catch { return null; }
}

// ==================== 页面：私信列表 ====================
async function renderMessages(app) {
    if (!requireLogin()) return;
    app.innerHTML = `<div class="container" style="max-width:800px;margin:0 auto;padding:var(--space-8) var(--space-6)">${loadingBlock()}</div>`;
    const { data: messages } = await sb.from('messages')
        .select('*')
        .or(`sender_id.eq.${APP.user.id},receiver_id.eq.${APP.user.id}`)
        .order('created_at', { ascending: false })
        .limit(500);
    const { data: allUsers } = await sb.from('profiles').select('id, username, avatar_url');
    const userMap = Object.fromEntries((allUsers || []).map(u => [u.id, u]));

    const convs = {};
    (messages || []).forEach(m => {
        if (m.status === 'recalled' && m.sender_id !== APP.user.id) return;
        const otherId = m.sender_id === APP.user.id ? m.receiver_id : m.sender_id;
        if (!convs[otherId]) {
            convs[otherId] = { other: userMap[otherId] || { username: '未知用户' }, last: m, unread: 0 };
        }
        if (m.receiver_id === APP.user.id && m.status === 'sent') convs[otherId].unread++;
    });
    const convList = Object.values(convs).sort((a, b) => new Date(b.last.created_at) - new Date(a.last.created_at));

    app.innerHTML = `
    <div class="container" style="max-width:800px;margin:0 auto;padding:var(--space-8) var(--space-6)">
        <div class="forum-toolbar" style="margin-bottom:var(--space-4)">
            <h1 class="section-title" style="font-size:1.5rem;margin-bottom:0">私信</h1>
            <button class="btn btn-primary btn-sm" onclick="showNewMessageModal()">发起私信</button>
        </div>
        <div class="card" style="padding:0;overflow:hidden">
            ${convList.length === 0 ? '<div style="padding:var(--space-12);text-align:center;color:var(--color-text-tertiary)">暂无私信，点击右上角发起对话</div>' :
            convList.map(c => `
                <div class="conversation-item" data-other="${Object.keys(convs).find(k => convs[k] === c)}">
                    ${avatarHtml(c.other, 32)}
                    <div style="flex:1;min-width:0">
                        <div class="conversation-name">${esc(c.other.username)}</div>
                        <div class="conversation-preview">${c.last.status === 'recalled' ? '[已撤回]' : esc(c.last.content.slice(0, 30))}</div>
                    </div>
                    ${c.unread > 0 ? `<span class="badge badge-blue conversation-badge">${c.unread}</span>` : ''}
                </div>`).join('')}
        </div>
    </div>`;

    app.querySelectorAll('.conversation-item').forEach(el => {
        el.onclick = () => { location.hash = '#/messages/' + el.dataset.other; };
    });
}

async function showNewMessageModal() {
    if (!requireLogin()) return;
    const { data: users } = await sb.from('profiles').select('id, username').neq('id', APP.user.id).eq('status', 'active').order('username');
    showModal('选择用户', `
        <input class="input" id="user-search" placeholder="搜索用户名..." oninput="filterUserList(this.value)" style="margin-bottom:var(--space-3)">
        <div id="user-list" style="max-height:300px;overflow-y:auto">
        ${(users || []).map(u => `<div class="conversation-item" data-uid="${u.id}">${avatarHtml(u, 24)}<span style="font-size:0.875rem">${esc(u.username)}</span></div>`).join('') || '<div style="padding:var(--space-6);color:var(--color-text-tertiary)">暂无其他用户</div>'}
        </div>`, `<button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">取消</button>`);
    document.querySelectorAll('#user-list .conversation-item').forEach(el => {
        el.onclick = () => { document.querySelector('.modal-overlay')?.remove(); location.hash = '#/messages/' + el.dataset.uid; };
    });
}
function filterUserList(q) {
    q = q.trim().toLowerCase();
    document.querySelectorAll('#user-list .conversation-item').forEach(el => {
        el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
}

// ==================== 页面：私信详情 ====================
async function renderMessageDetail(app, otherId) {
    if (!requireLogin()) return;
    app.innerHTML = `<div class="container" style="max-width:720px;margin:0 auto;padding:var(--space-8) var(--space-6)">${loadingBlock()}</div>`;
    const { data: other } = await sb.from('profiles').select('id, username, avatar_url').eq('id', otherId).maybeSingle();
    const { data: messages } = await sb.from('messages')
        .select('*')
        .or(`and(sender_id.eq.${APP.user.id},receiver_id.eq.${otherId}),and(sender_id.eq.${otherId},receiver_id.eq.${APP.user.id})`)
        .order('created_at', { ascending: true })
        .limit(200);
    sb.rpc('mark_messages_read', { p_other: otherId });

    app.innerHTML = `
    <div class="container" style="max-width:720px;margin:0 auto;padding:var(--space-8) var(--space-6)">
        <a href="#/messages" class="btn btn-ghost btn-sm mb-4">${icons.back} 返回私信</a>
        <div class="card" style="padding:0;overflow:hidden">
            <div class="chat-header"><div class="flex-center" style="gap:var(--space-3)">
                ${avatarHtml(other, 32)}<span>${esc(other?.username || '未知用户')}</span>
            </div></div>
            <div class="chat-messages" id="chat-messages" style="min-height:300px;max-height:60vh">
                ${(messages || []).map(m => {
                    if (m.status === 'recalled') return `<div class="chat-bubble-recalled">消息已撤回</div>`;
                    const isMine = m.sender_id === APP.user.id;
                    return `
                    <div class="chat-bubble ${isMine ? 'chat-bubble-mine' : 'chat-bubble-other'}">
                        ${esc(m.content)}
                        <div class="chat-bubble-time">${fmtTime(m.created_at)}</div>
                        ${isMine ? `
                        <div class="chat-bubble-actions">
                            <button class="btn-icon" style="background:rgba(255,255,255,0.2);width:24px;height:24px" onclick="recallMessage('${m.id}')" title="撤回（2分钟内）">${icons.undo}</button>
                        </div>` : `
                        <div class="chat-bubble-actions">
                            <button class="btn-icon" style="background:var(--color-bg-tertiary);width:24px;height:24px" onclick="copyMessage('${m.id}')" title="复制">${icons.copy}</button>
                            <button class="btn-icon" style="background:var(--color-bg-tertiary);width:24px;height:24px" onclick="showReportModal('message','${m.id}')" title="举报">${icons.flag}</button>
                        </div>`}
                    </div>`;
                }).join('')}
            </div>
            <div class="chat-input-area">
                <input class="input" id="msg-input" placeholder="输入消息..." onkeydown="if(event.key==='Enter')sendMessage('${otherId}')">
                <button class="btn btn-primary btn-sm" onclick="sendMessage('${otherId}')">${icons.send}</button>
            </div>
        </div>
    </div>`;
    const chatEl = document.getElementById('chat-messages');
    chatEl.scrollTop = chatEl.scrollHeight;
}

async function sendMessage(receiverId) {
    if (!requireLogin()) return;
    const input = document.getElementById('msg-input');
    const content = input.value.trim();
    if (!content) return;
    if (content.length > 5000) return toast('消息过长', 'error');
    input.value = '';
    const { error } = await sb.from('messages').insert({ sender_id: APP.user.id, receiver_id: receiverId, content });
    if (error) return toast(errText(error, '发送失败'), 'error');
    APP.route();
}

async function recallMessage(msgId) {
    const { data: ok } = await sb.rpc('recall_message', { p_id: msgId });
    if (!ok) return toast('只能撤回自己2分钟内发送的消息', 'error');
    toast('消息已撤回');
    APP.route();
}

async function copyMessage(msgId) {
    const { data: m } = await sb.from('messages').select('content, status').eq('id', msgId).maybeSingle();
    if (m && m.status !== 'recalled') navigator.clipboard.writeText(m.content).then(() => toast('已复制'));
}

// ==================== 页面：登录 / 注册 ====================
// 登录 / 注册 / 申请 / 邮箱验证这四页共用右侧主城实拍图
const AUTH_ROUTES = { '/login': true, '/register': true, '/apply': true, '/verify': true, '/reset': true, '/setpwd': true };

function mountAuthVisual(app) {
    const page = app.querySelector('.auth-page');
    if (!page || page.parentElement.classList.contains('auth-split')) return;
    const split = document.createElement('div');
    split.className = 'auth-split';
    app.insertBefore(split, page);
    split.appendChild(page);
    const side = document.createElement('aside');
    side.className = 'auth-visual';
    side.innerHTML = '<img src="assets/66qn-tower.jpg" alt="66qn 主城玻璃塔楼">';
    split.appendChild(side);
}

let LOGIN_MODE = 'pwd';        // pwd=密码登录 | otp=邮箱验证码登录
let OTP_LOGIN_ON = false;      // 由后台开关 site.otp_login_enabled 决定，默认关

function renderLogin(app) {
    app.innerHTML = `
    <div class="auth-page page-enter">
        <h1 class="auth-title">登录</h1>
        <p class="auth-subtitle">欢迎回到 66qn 服务器</p>
        <div id="login-form">${loginFormHtml(LOGIN_MODE)}</div>
        <p class="auth-link">还没有账号？<a href="#/register">邮箱注册</a> · <a href="#/apply">申请账号</a>（无需邮箱）</p>
        <p class="auth-link">已注册但没收到验证码？<a href="#/verify">去验证邮箱</a></p>
        <p class="auth-link">忘记密码？<a href="#/reset">看重置方式</a></p>
    </div>`;
    renderLoginExtra();
}

function loginFormHtml(mode) {
    const toggle = OTP_LOGIN_ON
        ? `<p class="auth-link"><a href="#/login" onclick="switchLoginMode('${mode === 'otp' ? 'pwd' : 'otp'}');return false">${mode === 'otp' ? '改用密码登录' : '用邮箱验证码登录（不用密码）'}</a></p>`
        : '';
    if (mode === 'otp') {
        return `
        <div class="form-group"><label class="form-label">注册邮箱</label>
            <input class="input" id="otp-email" type="email" placeholder="注册时填的邮箱" autocomplete="email"></div>
        <button class="btn btn-primary btn-lg" style="width:100%" id="otp-send" onclick="sendLoginOtp()">发送验证码</button>
        <div id="otp-step2" style="display:none">
            <div class="form-group" style="margin-top:var(--space-6)"><label class="form-label">邮件里的 6 位验证码</label>
                <input class="input" id="otp-code" inputmode="numeric" maxlength="6" placeholder="123456" autocomplete="one-time-code"></div>
            <button class="btn btn-primary btn-lg" style="width:100%" onclick="verifyLoginOtp()">验证并登录</button>
        </div>
        <p class="text-tertiary" style="font-size:.75rem;margin-top:var(--space-4);line-height:1.7">验证码只发给<strong>已注册</strong>的邮箱，不会凭它新建账号。收不到就去垃圾邮件箱看看，或直接改用密码登录。</p>
        ${toggle}`;
    }
    return `
        <button class="github-btn" onclick="githubLogin()">${icons.github} 使用 GitHub 登录</button>
        <div class="auth-divider">或</div>
        <div class="form-group"><label class="form-label">邮箱或用户名</label>
            <input class="input" id="login-email" type="text" placeholder="邮箱或用户名" autocomplete="username"></div>
        <div class="form-group"><label class="form-label">密码</label>
            <input class="input" id="login-password" type="password" placeholder="输入密码"></div>
        <button class="btn btn-primary btn-lg" style="width:100%" onclick="doLogin()">登录</button>
        ${toggle}`;
}

// 异步读后台开关，再决定要不要露出验证码入口
async function renderLoginExtra() {
    const info = await Settings.load();
    OTP_LOGIN_ON = !!(info.site && info.site.otp_login_enabled === true);
    const box = document.getElementById('login-form');
    if (box) box.innerHTML = loginFormHtml(LOGIN_MODE);
}

function switchLoginMode(mode) {
    LOGIN_MODE = mode;
    const box = document.getElementById('login-form');
    if (box) box.innerHTML = loginFormHtml(mode);
}

async function sendLoginOtp() {
    const email = document.getElementById('otp-email').value.trim();
    if (!email.includes('@')) return toast('请输入邮箱地址', 'error');
    const btn = document.getElementById('otp-send');
    btn.disabled = true;
    btn.textContent = '发送中…';
    // shouldCreateUser:false —— 只给已注册邮箱发码，堵住"凭邮箱白嫖建号"
    const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    btn.disabled = false;
    btn.textContent = '重新发送验证码';
    if (error) {
        if (/rate limit|too many|over/i.test(error.message || '')) return toast('发送太频繁，等一分钟再试', 'error');
        return toast(errText(error, '发送失败，请改用密码登录或联系管理员'), 'error');
    }
    document.getElementById('otp-step2').style.display = 'block';
    document.getElementById('otp-code').focus();
    toast('验证码已发送，请查收邮箱（含垃圾邮件箱）');
}

async function verifyLoginOtp() {
    const email = document.getElementById('otp-email').value.trim();
    const token = document.getElementById('otp-code').value.trim();
    if (!/^\d{6}$/.test(token)) return toast('请输入 6 位数字验证码', 'error');
    const { error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
    if (error) {
        if (/expired|invalid/i.test(error.message || '')) return toast('验证码不正确或已过期，重新发一个', 'error');
        return toast(errText(error, '验证失败，请重试'), 'error');
    }
    toast('登录成功');
    location.hash = '#/';
}

async function doLogin() {
    const identifier = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    if (!identifier || !password) return toast('请填写邮箱或用户名，以及密码', 'error');
    let email = identifier;
    if (!identifier.includes('@')) {
        const { data: profile } = await sb.from('profiles').select('email, status').eq('username', identifier).maybeSingle();
        if (!profile || !profile.email) return toast('找不到该用户名，请使用注册邮箱登录', 'error');
        if (profile.status === 'banned') return toast('该账户已被撤销注册资格', 'error');
        email = profile.email;
    }
    // 先让 Supabase Auth 验证邮箱和密码；协议检查不能放在这里之前，
    // 否则首次登录用户永远无法完成登录并同意协议。
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
        if (/email not confirmed/i.test(error.message || '')) {
            sessionStorage.setItem('66qn_verify_email', email);
            toast('邮箱尚未验证，正在跳转到验证页…', 'error');
            location.hash = '#/verify';
            return;
        }
        return toast('邮箱或密码错误，请检查后重试', 'error');
    }
    await APP.loadProfile((await sb.auth.getUser()).data.user.id);
    if (!(await checkAgreement())) {
        await showAgreementModal(true);
        return;
    }
    toast('登录成功');
    location.hash = '#/';
}

async function githubLogin() {
    if (!sb) return toast('Supabase 尚未配置', 'error');
    // redirectTo 必须是 Supabase URL Configuration 中允许的地址；不要把 hash 放进回调 URL。
    const redirectUrl = new URL(location.href);
    redirectUrl.search = '';
    redirectUrl.hash = '';
    const { error } = await sb.auth.signInWithOAuth({
        provider: 'github',
        options: { redirectTo: redirectUrl.toString(), skipBrowserRedirect: false }
    });
    if (error) {
        console.error('GitHub OAuth:', error.message);
        toast(errText(error, 'GitHub 登录失败：请检查 Supabase 的 GitHub 配置和回调地址'), 'error');
    }
}

async function doLogout() {
    await sb.auth.signOut();
    APP.user = null; APP.isAdmin = false;
    APP.updateNavbar();
    toast('已退出登录');
    location.hash = '#/';
}

function renderRegister(app) {
    app.innerHTML = `
    <div class="auth-page page-enter">
        <h1 class="auth-title">注册</h1>
        <p class="auth-subtitle">加入 66qn 服务器社区</p>

        <div class="apply-notice">
            <p><strong>使用邮箱注册</strong></p>
            <p class="text-tertiary">注册后会向你的邮箱发送验证码，验证通过即可登录。如果没收到，请检查垃圾邮件。</p>
        </div>

        <div class="auth-divider">或</div>
        <button class="github-btn" onclick="githubLogin()">${icons.github} 使用 GitHub 注册</button>
        <div class="auth-divider">或</div>
        <div class="form-group"><label class="form-label">用户名 <span class="text-tertiary">(3-20字符，昵称，不要填邮箱)</span></label>
            <input class="input" id="reg-username" placeholder="例如 wuu1212" maxlength="20" autocomplete="nickname"></div>
        <div class="form-group"><label class="form-label">邮箱</label>
            <input class="input" id="reg-email" type="email" placeholder="用于登录和验证" autocomplete="email"></div>
        <div class="form-group"><label class="form-label">游戏 ID</label>
            <input class="input" id="reg-game-id" placeholder="你的 Minecraft 游戏 ID" maxlength="32" autocomplete="off"></div>
        <div class="form-group"><label class="form-label">注册原因</label>
            <textarea class="textarea" id="reg-reason" rows="3" maxlength="500" placeholder="简单介绍你为什么想加入 66qn"></textarea></div>
        <div class="form-group"><label class="form-label">邀请码 <span class="text-tertiary">(选填)</span></label>
            <input class="input" id="reg-invite" placeholder="如有好友邀请，可填对方的6位邀请码" maxlength="6" autocomplete="off"></div>
        <div class="form-group"><label class="form-label">密码 <span class="text-tertiary">(至少6位)</span></label>
            <input class="input" id="reg-password" type="password" placeholder="设置密码" autocomplete="new-password"></div>
        <button class="btn btn-primary btn-lg" style="width:100%" onclick="doRegister()">注册</button>
        <p class="auth-link">已有账号？<a href="#/login">登录</a></p>
        <p class="auth-link">不想用邮箱？<a href="#/apply">申请账号</a>（管理员审核，无需邮箱）</p>
    </div>`;
}

async function doRegister() {
    const username = document.getElementById('reg-username').value.trim();
    const email = document.getElementById('reg-email').value.trim();
    const gameId = document.getElementById('reg-game-id').value.trim();
    const registerReason = document.getElementById('reg-reason').value.trim();
    const password = document.getElementById('reg-password').value;
    if (username.length < 3 || username.length > 20) return toast('用户名需3-20个字符', 'error');
    if (username.includes('@')) return toast('用户名不能包含 @，这里填昵称（例如 wuu1212），邮箱填在下一栏', 'error');
    if (/\s/.test(username)) return toast('用户名不能包含空格', 'error');
    if (!email.includes('@')) return toast('请输入有效的邮箱地址', 'error');
    if (username.toLowerCase() === email.toLowerCase()) return toast('用户名不能和邮箱相同，请填一个昵称', 'error');
    if (gameId.length < 2) return toast('请填写游戏 ID', 'error');
    if (registerReason.length < 5) return toast('请填写注册原因（至少5个字符）', 'error');
    if (password.length < 6) return toast('密码至少6位', 'error');
    // 邀请码选填：注册时还没有登录态，先验证存在性，等拿到 session 后再绑定
    let inviteCode = document.getElementById('reg-invite').value.trim();
    if (inviteCode) {
        if (!/^\d{6}$/.test(inviteCode)) return toast('邀请码为6位数字，请检查后重试', 'error');
        const { data: inviter, error: codeErr } = await sb.from('profiles').select('id').eq('invite_code', inviteCode).neq('status', 'banned').maybeSingle();
        if (codeErr) return toast('邀请码校验失败，请稍后重试', 'error');
        if (!inviter) return toast('邀请码不存在或无效', 'error');
    }

    // 邮件里的确认链接点击后回到首页（SDK 会自动完成登录）；验证码则在 #/verify 页面输入
    const redirectTo = location.origin + location.pathname + '#/';
    const { data, error } = await sb.auth.signUp({
        email, password,
        options: { emailRedirectTo: redirectTo, data: { username, game_id: gameId, register_reason: registerReason } },
    });
    if (error) {
        const m = String(error.message || '');
        if (/already registered|already been registered|user already exists/i.test(m)) {
            return toast('该邮箱已注册，请直接登录；忘记密码可联系管理员', 'error');
        }
        if (/password should be at least/i.test(m)) return toast('密码至少6位', 'error');
        if (/invalid format|unable to validate email/i.test(m)) return toast('邮箱格式不正确，请检查', 'error');
        if (/duplicate key|profiles_username_key/i.test(m)) return toast('该用户名已被占用，请换一个', 'error');
        if (/rate limit|too many/i.test(m)) return toast('操作过于频繁，请稍后再试', 'error');
        return toast(errText(error, '注册失败'), 'error');
    }

    if (data.session) {
        await APP.loadProfile(data.user.id);
        if (inviteCode) {
            try { await sb.rpc('bind_inviter', { p_code: inviteCode }); } catch { /* 邀请关系失败不影响注册 */ }
        }
        toast('注册成功，新用户赠送 5000 电力！');
        location.hash = '#/power';
    } else {
        // Confirm Email 开启：记住邮箱，验证页只填验证码即可
        sessionStorage.setItem('66qn_verify_email', email);
        if (inviteCode) sessionStorage.setItem('66qn_pending_invite', inviteCode);
        toast('验证码已发送到邮箱', 'success');
        location.hash = '#/verify';
    }
}

// ==================== 页面：申请账号 ====================
function renderApply(app) {
    app.innerHTML = `
    <div class="container" style="max-width:520px;margin:0 auto;padding:var(--space-12) var(--space-6)">
        <h1 class="auth-title">申请账号</h1>
        <p class="auth-subtitle">提交申请后由管理员审核，通过即可用昵称和密码登录</p>
        <div class="card">
            <div class="apply-notice mb-8">
                <p class="text-tertiary">申请无需邮箱。请留下一个能联系到你的方式（游戏 ID、QQ、微信均可），方便管理员与你核对。</p>
            </div>
            <div class="form-group"><label class="form-label">昵称 <span class="text-tertiary">(3-20字符，将作为登录名)</span></label>
                <input class="input" id="ap-nickname" placeholder="例如 wuu1212" maxlength="20" autocomplete="nickname"></div>
            <div class="form-group"><label class="form-label">联系方式 <span class="text-tertiary">(不能填邮箱)</span></label>
                <input class="input" id="ap-contact" placeholder="例如 游戏ID：Steve / QQ：123456789" maxlength="60" autocomplete="off"></div>
            <div class="form-group"><label class="form-label">保密问题 <span class="text-tertiary">(自定义)</span></label>
                <input class="input" id="ap-question" placeholder="例如 我最喜欢的方块是什么？" maxlength="80" autocomplete="off"></div>
            <div class="form-group"><label class="form-label">保密答案</label>
                <input class="input" id="ap-answer" placeholder="只有你自己知道的答案" maxlength="60" autocomplete="off"></div>
            <div class="grid-2">
                <div class="form-group"><label class="form-label">密码 <span class="text-tertiary">(至少6位)</span></label>
                    <input class="input" id="ap-password" type="password" placeholder="设置密码" autocomplete="new-password"></div>
                <div class="form-group"><label class="form-label">确认密码</label>
                    <input class="input" id="ap-password2" type="password" placeholder="再输一次" autocomplete="new-password"></div>
            </div>
            <button class="btn btn-primary btn-lg" style="width:100%" onclick="submitApply()">提交申请</button>
            <p class="auth-link">已有账号？<a href="#/login">去登录</a></p>
        </div>
    </div>`;
}

async function submitApply() {
    const nickname = document.getElementById('ap-nickname').value.trim();
    const contact = document.getElementById('ap-contact').value.trim();
    const question = document.getElementById('ap-question').value.trim();
    const answer = document.getElementById('ap-answer').value.trim();
    const password = document.getElementById('ap-password').value;
    const password2 = document.getElementById('ap-password2').value;

    if (nickname.length < 3 || nickname.length > 20) return toast('昵称需3-20个字符', 'error');
    if (nickname.includes('@')) return toast('昵称不能包含 @', 'error');
    if (contact.length < 2) return toast('请填写联系方式', 'error');
    if (contact.includes('@')) return toast('联系方式不能填邮箱，请填游戏ID、QQ或微信', 'error');
    if (question.length < 2) return toast('请设置保密问题', 'error');
    if (!answer) return toast('请填写保密答案', 'error');
    if (password.length < 6) return toast('密码至少6位', 'error');
    if (password !== password2) return toast('两次输入的密码不一致', 'error');

    const { error } = await sb.rpc('apply_account', {
        p_nickname: nickname, p_contact: contact, p_password: password,
        p_question: question, p_answer: answer,
    });
    if (error) return toast(errText(error, '提交失败'), 'error');
    showModal('申请已提交', `
        <p>申请已提交，管理员会尽快审核。</p>
        <p class="text-secondary" style="margin-top:.5rem">你填写的联系方式：<strong>${esc(contact)}</strong><br>申请用的昵称：<strong>${esc(nickname)}</strong></p>
        <p class="text-tertiary" style="margin-top:.5rem">审核通过后，用<strong>昵称 + 密码</strong>即可登录，无需邮箱。</p>`,
        `<button class="btn btn-primary" onclick="this.closest('.modal-overlay').remove();location.hash='#/login'">知道了，去登录页</button>`);
}

// ==================== 页面：邮箱验证 ====================
function renderVerify(app, email) {
    const known = email || sessionStorage.getItem('66qn_verify_email') || '';
    app.innerHTML = `
    <div class="container" style="max-width:460px;margin:0 auto;padding:var(--space-16) var(--space-6)">
        <h1 class="auth-title">邮箱验证</h1>
        <p class="auth-subtitle">验证码已发送至 <strong>${esc(known || '你的注册邮箱')}</strong>，请输入邮件中的验证码完成注册。</p>
        <p class="text-tertiary" style="text-align:center;font-size:.85rem;margin-bottom:var(--space-4)">没收到？请先检查垃圾邮件，再点下方重新发送。</p>
        <div class="form-group">
            <label class="form-label">验证码</label>
            <input class="input" id="verify-code" placeholder="邮件中的 6-8 位验证码" maxlength="12" autocomplete="one-time-code">
        </div>
        <button class="btn btn-primary btn-lg" style="width:100%" onclick="submitVerify()">验证并登录</button>
        <div class="auth-link">
            <a href="javascript:void(0)" onclick="resendVerify()">没有收到验证码？重新发送</a>
            <span class="text-tertiary"> · </span>
            <a href="javascript:void(0)" onclick="toggleVerifyEmail()">更换邮箱</a>
        </div>
        <div class="form-group" id="verify-email-wrap" style="display:${known ? 'none' : 'block'};margin-top:.5rem">
            <label class="form-label">注册邮箱（仅注册时填错邮箱才需要修改）</label>
            <input class="input" id="verify-email" type="email" value="${esc(known)}" placeholder="you@example.com" autocomplete="email">
        </div>
        <div class="auth-link">还没有账号？<a href="#/register">去注册</a> · 已验证？<a href="#/login">去登录</a></div>
    </div>`;
    if (known) sessionStorage.setItem('66qn_verify_email', known);
}

function toggleVerifyEmail() {
    const wrap = document.getElementById('verify-email-wrap');
    if (!wrap) return;
    wrap.style.display = 'block';
    document.getElementById('verify-email')?.focus();
}

async function submitVerify() {
    const email = document.getElementById('verify-email').value.trim();
    const token = document.getElementById('verify-code').value.trim();
    if (!email || !email.includes('@')) return toast('请输入注册时使用的邮箱', 'error');
    if (!token) return toast('请输入邮件中的验证码', 'error');
    sessionStorage.setItem('66qn_verify_email', email);
    const { data, error } = await sb.auth.verifyOtp({ email, token, type: 'signup' });
    if (error) return toast('验证码错误或已过期：' + error.message, 'error');
    sessionStorage.removeItem('66qn_verify_email');
    if (data.session) {
        await APP.loadProfile(data.session.user.id);
        // 邮箱验证通过，如有待绑定邀请码则绑定
        const pendingInvite = sessionStorage.getItem('66qn_pending_invite');
        sessionStorage.removeItem('66qn_pending_invite');
        if (pendingInvite) {
            try { await sb.rpc('bind_inviter', { p_code: pendingInvite }); } catch { /* 忽略 */ }
        }
        toast('验证成功，欢迎加入！');
        location.hash = '#/';
    } else {
        toast('验证成功，请登录', 'success');
        location.hash = '#/login';
    }
}

async function resendVerify() {
    const email = document.getElementById('verify-email').value.trim();
    if (!email || !email.includes('@')) return toast('请先填写注册时使用的邮箱', 'error');
    sessionStorage.setItem('66qn_verify_email', email);
    const { error } = await sb.auth.resend({ type: 'signup', email });
    if (error) return toast('重新发送失败：' + error.message, 'error');
    toast('验证码已重新发送，请查收邮件');
}

// ==================== 页面：个人主页 ====================
async function renderProfile(app, userId) {
    if (!userId) { location.hash = '#/login'; return; }
    app.innerHTML = `<div class="container" style="max-width:640px;margin:0 auto;padding:var(--space-8) var(--space-6)">${loadingBlock()}</div>`;
    const { data: user } = await sb.from('profiles').select('*').eq('id', userId).maybeSingle();
    if (!user) { app.innerHTML = '<div class="container" style="padding:var(--space-16);text-align:center">用户不存在</div>'; return; }
    const { data: posts } = await sb.from('posts').select('*').eq('user_id', userId).eq('status', 'published').order('created_at', { ascending: false });
    const isMe = APP.user && APP.user.id === userId;
    const ids = isMe ? await myIdentities() : null;
    const ghBound = !!(ids || []).find(i => i.provider === 'github');

    app.innerHTML = `
    <div class="container" style="max-width:640px;margin:0 auto;padding:var(--space-8) var(--space-6)">
        <div class="profile-header">
            ${avatarHtml(user, 48)}
            <div>
                <div class="profile-name">${esc(user.username)}</div>
                ${user.bio ? `<div class="profile-bio">${esc(user.bio)}</div>` : ''}
                <div class="profile-stats">
                    <div><span class="profile-stat-value">${(posts || []).length}</span> <span class="profile-stat-label">帖子</span></div>
                    <div><span class="profile-stat-value">${timeAgo(user.created_at)}</span> <span class="profile-stat-label">加入</span></div>
                </div>
            </div>
            ${APP.isAdmin ? `<a href="#/admin/users" class="btn btn-ghost btn-sm" style="margin-left:auto">${icons.settings} 管理</a>` : ''}
        </div>
        ${isMe ? `
        <div class="card mb-8">
            <h3 class="pc-card-title">资料</h3>
            <div class="form-group"><label class="form-label">用户名</label>
                <input class="input" value="${esc(user.username)}" disabled>
                <p class="text-tertiary" style="font-size:.75rem;margin-top:.35rem">用户名不能自己改，需要改请联系管理员</p></div>
            <div class="form-group"><label class="form-label">游戏 ID</label>
                <input class="input" id="my-game-id" value="${esc(user.game_id || '')}" maxlength="32" placeholder="进服用的游戏 ID">
                <button class="btn btn-secondary btn-sm" style="margin-top:.5rem" onclick="saveGameId()">保存游戏 ID</button></div>
            <div class="form-group"><label class="form-label">个人简介</label>
                <textarea class="textarea" id="my-bio" rows="2" maxlength="200">${esc(user.bio || '')}</textarea>
                <button class="btn btn-secondary btn-sm" style="margin-top:.5rem" onclick="saveBio()">保存简介</button></div>
        </div>

        <div class="card mb-8">
            <h3 class="pc-card-title">账号安全</h3>
            <div class="pc-row">
                <div><div class="pc-row-label">登录邮箱</div>
                    <div class="pc-row-value">${esc((APP.user && APP.user.email) || '未绑定')}</div></div>
                <button class="btn btn-ghost btn-sm" onclick="changeMyEmailFlow()">修改</button>
            </div>
            <div class="pc-row">
                <div><div class="pc-row-label">登录密码</div>
                    <div class="pc-row-value">••••••••</div></div>
                <button class="btn btn-ghost btn-sm" onclick="changeMyPasswordFlow()">修改</button>
            </div>
            <div class="pc-row">
                <div><div class="pc-row-label">GitHub 授权</div>
                    <div class="pc-row-value">${ghBound ? '已绑定，可用 GitHub 登录' : '未绑定'}</div></div>
                ${ghBound
                    ? `<span style="display:flex;gap:.5rem"><button class="btn btn-ghost btn-sm" onclick="githubBindFlow()">换个 GitHub</button><button class="btn btn-ghost btn-sm" onclick="githubUnbindFlow()">解绑</button></span>`
                    : `<button class="btn btn-ghost btn-sm" onclick="githubBindFlow()">绑定</button>`}
            </div>
        </div>

        <div class="card mb-8">
            <h3 class="pc-card-title">已授权的 AI</h3>
            <div id="my-grants">${loadingBlock()}</div>
        </div>` : ''}
        <h3 style="font-size:1rem;font-weight:600;margin-bottom:var(--space-4)">发布的帖子</h3>
        <div class="card" style="padding:0;overflow:hidden">
            ${!posts || posts.length === 0 ? '<div style="padding:var(--space-8);text-align:center;color:var(--color-text-tertiary)">暂无帖子</div>' :
            posts.map(p => `
                <div class="post-item" onclick="location.hash='#/forum/${p.id}'">
                    <div><div class="post-title">${esc(p.title)}</div>
                        <div class="post-meta"><span>${timeAgo(p.created_at)}</span><span class="badge badge-gray">${esc(CAT_LABEL[p.category] || p.category)}</span></div></div>
                    <div class="post-stats"><span class="post-stat">${icons.thumb} ${p.likes_count}</span><span class="post-stat">${icons.message} ${p.comments_count}</span></div>
                </div>`).join('')}
        </div>
    </div>`;
    if (isMe) loadMyGrants(document.getElementById('my-grants'));
}

async function saveBio() {
    const bio = document.getElementById('my-bio').value.trim();
    const { error } = await sb.from('profiles').update({ bio }).eq('id', APP.user.id);
    if (error) return toast(errText(error, '保存失败'), 'error');
    APP.user.bio = bio;
    toast('简介已保存');
}

async function saveGameId() {
    const el = document.getElementById('my-game-id');
    const gameId = el.value.trim();
    if (gameId.length < 2) return toast('游戏 ID 至少 2 个字符', 'error');
    const { error } = await sb.from('profiles').update({ game_id: gameId }).eq('id', APP.user.id);
    if (error) return toast(errText(error, '保存失败'), 'error');
    APP.user.game_id = gameId;
    toast('游戏 ID 已保存');
}

// ==================== 忘记密码 / 重置密码 ====================
async function renderReset(app) {
    const info = await Settings.load();
    const enabled = !!(info.site && info.site.email_reset_enabled === true);
    const groupUrl = (info.site && info.site.qq_group) || 'https://qm.qq.com/q/bZNAGK8Rs4';
    app.innerHTML = `
    <div class="auth-page page-enter">
        <h1 class="auth-title">忘记密码</h1>
        <p class="auth-subtitle">${enabled ? '输入注册邮箱，我们给你发一条重置链接' : '目前由管理员协助重置'}</p>
        ${enabled ? `
        <div class="form-group"><label class="form-label">注册邮箱</label>
            <input class="input" id="rs-email" type="email" placeholder="注册时填的邮箱" autocomplete="email"></div>
        <button class="btn btn-primary btn-lg" style="width:100%" onclick="sendResetLink()">发送重置链接</button>
        <p class="auth-link">没收到先去垃圾邮件看看；仍没有就 <a href="#/reset">过两分钟再发一次</a></p>` : `
        <div class="apply-notice">
            <p><strong>请联系管理员重置</strong></p>
            <p class="text-tertiary">把「用户名 + 注册邮箱 + 游戏 ID」发到 QQ 群，管理员核对身份后会给你一个新的临时密码，登录后请立刻在个人中心里改掉。</p>
        </div>
        <a class="btn btn-primary btn-lg" style="width:100%;display:flex;align-items:center;justify-content:center" href="${esc(groupUrl)}" target="_blank" rel="noopener">加入 QQ 群找管理员</a>`}
        <p class="auth-link"><a href="#/login">返回登录</a></p>
    </div>`;
}

async function sendResetLink() {
    const email = document.getElementById('rs-email').value.trim();
    if (!email.includes('@')) return toast('请输入邮箱地址', 'error');
    const redirectTo = location.origin + location.pathname + '#/setpwd';
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) return toast(errText(error, '发送失败，请稍后再试或联系管理员'), 'error');
    toast('重置链接已发送，请查收邮箱（含垃圾邮件箱）');
}

// 邮件链接回调、以及个人中心里手动进入都用这一页
function renderSetPassword(app) {
    if (!APP.user) { location.hash = '#/login'; return; }
    app.innerHTML = `
    <div class="auth-page page-enter">
        <h1 class="auth-title">设置新密码</h1>
        <p class="auth-subtitle">给 @${esc(APP.user.username)} 设置一个新密码</p>
        <div class="form-group"><label class="form-label">新密码 <span class="text-tertiary">(至少 6 位)</span></label>
            <input class="input" id="np-1" type="password" placeholder="输入新密码" autocomplete="new-password"></div>
        <div class="form-group"><label class="form-label">再输一遍</label>
            <input class="input" id="np-2" type="password" placeholder="确认新密码" autocomplete="new-password"></div>
        <button class="btn btn-primary btn-lg" style="width:100%" onclick="submitNewPassword()">保存新密码</button>
        <p class="auth-link"><a href="#/profile">返回个人中心</a></p>
    </div>`;
}

async function submitNewPassword() {
    const p1 = document.getElementById('np-1').value;
    const p2 = document.getElementById('np-2').value;
    if (p1.length < 6) return toast('密码至少 6 位', 'error');
    if (p1 !== p2) return toast('两次输入的密码不一致', 'error');
    const { error } = await sb.auth.updateUser({ password: p1 });
    if (error) {
        if (/recent|sign[- ]?in|reauthenticate/i.test(error.message || '')) {
            return toast('这太久没重新登录了：请先退出登录再进一次，然后到个人中心改密码', 'error');
        }
        return toast(errText(error, '修改失败，请稍后再试'), 'error');
    }
    showPasswordDone(p1);
}

// 改密成功后强制退出：退出前把新密码再显示一次并给复制，避免"改完就锁死"
function showPasswordDone(pw) {
    showModal('密码已修改', `
        <p class="text-secondary" style="font-size:.875rem">下面这行就是你的新密码，现在复制一份存好。点「退出登录」后必须用它才能再进来。</p>
        <div class="flex-center" style="gap:var(--space-3);margin-top:var(--space-4)">
            <code style="flex:1;font-size:.9375rem;background:var(--color-bg-tertiary);padding:.6rem .75rem;border-radius:6px;word-break:break-all">${esc(pw)}</code>
            <button class="btn btn-secondary btn-sm" onclick="copyText('${esc(pw)}').then(()=>toast('已复制'))">复制</button>
        </div>`,
        `<button class="btn btn-primary" onclick="document.querySelector('.modal-overlay').remove();doLogout()">我已存好，退出登录</button>`);
}

// ==================== 带旧密码校验的二次确认 ====================
// 用一次独立的 password grant 请求验证旧密码；不经过 supabase-js，当前会话不受影响。
function verifyPassword(email, password) {
    return fetch(CFG.SUPABASE_URL + '/auth/v1/token?grant_type=password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: CFG.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + CFG.SUPABASE_ANON_KEY },
        body: JSON.stringify({ email, password })
    }).then(r => r.ok);
}

function confirmWithPassword(desc, onPass) {
    const id = 'cwp-' + Date.now();
    const overlay = showModal('身份确认', `
        <p class="text-secondary" style="font-size:.875rem">${desc}</p>
        <div class="form-group" style="margin-top:var(--space-4)"><label class="form-label">输入当前登录密码以确认</label>
            <input class="input" id="${id}" type="password" placeholder="当前密码" autocomplete="current-password"></div>`,
        `<button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">取消</button>
         <button class="btn btn-primary" onclick="runConfirmPassword('${id}')">确认</button>`);
    window.__cwp = { overlay, onPass };
}

async function runConfirmPassword(inputId) {
    const pw = document.getElementById(inputId).value;
    if (!pw) return toast('请输入当前密码', 'error');
    const email = APP.user && APP.user.email;
    if (!email) return toast('这个账号没有绑定邮箱，无法这样确认，请联系管理员', 'error');
    const ok = await verifyPassword(email, pw);
    if (!ok) return toast('当前密码不正确', 'error');
    const ctx = window.__cwp;
    if (ctx && ctx.overlay) ctx.overlay.remove();
    if (ctx && ctx.onPass) await ctx.onPass(pw);
    window.__cwp = null;
}

// ==================== 个人中心：账号安全 ====================
async function changeMyEmailFlow() {
    const cur = (APP.user && APP.user.email) || '未绑定';
    const id = 'ce-' + Date.now();
    showModal('修改登录邮箱', `
        <p class="text-secondary" style="font-size:.875rem">当前邮箱：<code>${esc(cur)}</code></p>
        <div class="form-group" style="margin-top:var(--space-4)"><label class="form-label">新邮箱</label>
            <input class="input" id="${id}" type="email" placeholder="输入新邮箱" autocomplete="email"></div>
        <p class="text-tertiary" style="font-size:.8125rem;line-height:1.7">会向新邮箱发一封确认信，<strong>在你点确认之前，旧邮箱仍然是登录凭据</strong>。确认信没到的话，改动作废，不会有中间状态。</p>`,
        `<button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">取消</button>
         <button class="btn btn-primary" onclick="applyNewEmail('${id}')">发送确认信</button>`);
}

async function applyNewEmail(inputId) {
    const email = document.getElementById(inputId).value.trim();
    if (!email.includes('@')) return toast('请输入有效邮箱', 'error');
    const { error } = await sb.auth.updateUser({
        email,
        options: { redirectTo: location.origin + location.pathname + '#/verify' }
    });
    if (error) return toast(errText(error, '修改失败'), 'error');
    document.querySelector('.modal-overlay').remove();
    toast('确认信已发往新邮箱，去点一下才算改成功');
    setTimeout(doLogout, 1500);
}

function changeMyPasswordFlow() {
    confirmWithPassword('你要修改登录密码。改完当前会话会被退出，之后必须用新密码登录。', async () => {
        location.hash = '#/setpwd';
    });
}

async function myIdentities() {
    if (typeof sb.auth.userIdentities !== 'function') return null;
    const { data, error } = await sb.auth.userIdentities();
    return error ? null : (data || []);
}

async function githubBindFlow() {
    if (typeof sb.auth.linkIdentity !== 'function') return toast('当前 supabase-js 版本不支持绑定，请在 Supabase 控制台处理', 'error');
    const ids = await myIdentities();
    if (ids && ids.some(i => i.provider === 'github')) return toast('这个账号已经绑过 GitHub 了');
    if (!confirm('将跳转到 GitHub 授权。授权成功后，这个 GitHub 账号会和当前账号绑定，之后可以任选一种方式登录。')) return;
    const { error } = await sb.auth.linkIdentity({
        provider: 'github',
        options: { redirectTo: location.origin + location.pathname }
    });
    if (error) toast(errText(error, '绑定失败：请确认 Supabase 已开启 GitHub 提供方'), 'error');
}

async function githubUnbindFlow() {
    const ids = await myIdentities();
    if (!ids) return toast('当前 supabase-js 版本不支持解绑，请在后台处理', 'error');
    const gh = ids.find(i => i.provider === 'github');
    if (!gh) return toast('这个账号没有绑定 GitHub', 'error');
    const others = ids.filter(i => i.provider !== 'github');
    if (!others.length) return toast('这是该账号唯一的登录方式，解掉就进不去了。请先在上方设置邮箱和密码。', 'error');
    confirmWithPassword('你要解绑 GitHub。解绑后只能用邮箱密码登录，请确认邮箱密码都能正常用。', async () => {
        const { error } = await sb.auth.unlinkIdentity(gh);
        if (error) return toast(errText(error, '解绑失败'), 'error');
        toast('GitHub 已解绑');
        renderProfile(document.getElementById('app'), APP.user.id);
    });
}

// ==================== 个人中心：已授权的 AI ====================
async function loadMyGrants(el) {
    if (!el) return;
    const { data, error } = await sb.rpc('my_ai_grants');
    if (error) { el.innerHTML = `<p class="text-secondary" style="font-size:.875rem">读取失败：${esc(errText(error, '请确认已执行个人中心 SQL 补丁'))}</p>`; return; }
    if (!data || !data.length) {
        el.innerHTML = `<p class="text-secondary" style="font-size:.875rem">还没有授权出去的应用。到 <a href="#/skill">AI 技能</a> 页领取授权码，把它交给你的 AI 即可。</p>`;
        return;
    }
    el.innerHTML = `
        <table class="grant-table">
            <thead><tr><th>应用</th><th>权限</th><th>调用</th><th>状态</th><th></th></tr></thead>
            <tbody>${data.map(g => {
                const perms = [g.can_checkin && '签到', g.can_get_power && '查电力', g.can_get_info && '查信息'].filter(Boolean).join('、') || '无';
                const on = g.status === 'active';
                return `<tr>
                    <td><div style="font-weight:500">${esc(g.name)}</div>
                        <div class="text-tertiary" style="font-size:.75rem">${esc(g.public_id)} · ${timeAgo(g.created_at)}领${g.install_rewarded ? ' · 奖励已发' : ''}</div></td>
                    <td class="text-secondary" style="font-size:.8125rem">${esc(perms)}</td>
                    <td><div style="font-size:.8125rem">${g.call_count || 0} 次</div>
                        <div class="text-tertiary" style="font-size:.75rem">${g.last_call_at ? timeAgo(g.last_call_at) + '调用' : '尚未调用'}</div></td>
                    <td><span class="badge ${on ? 'badge-green' : 'badge-gray'}">${on ? '生效中' : '已停用'}</span></td>
                    <td style="text-align:right;white-space:nowrap">
                        <button class="btn btn-ghost btn-sm" onclick="showMyUid()">看授权码</button>
                        <button class="btn btn-ghost btn-sm" onclick="toggleMyGrant('${esc(g.public_id)}', ${on ? 'false' : 'true'})">${on ? '停用' : '启用'}</button>
                    </td></tr>`;
            }).join('')}</tbody>
        </table>
        <p class="text-tertiary" style="font-size:.75rem;margin-top:var(--space-4)">停用只是让这把授权码失效，记录还在，随时可以重新启用。</p>`;
}

async function toggleMyGrant(publicId, enable) {
    if (!enable && !confirm('停用后，那个 AI 立刻调不动你的账号（签到、查电力都会失败）。可以重新启用。确定停用？')) return;
    const { data, error } = await sb.rpc('set_my_ai_grant', { p_public_id: publicId, p_enabled: enable });
    if (error) return toast(errText(error, '操作失败'), 'error');
    if (!data) return toast('没找到属于你的这条授权', 'error');
    toast(enable ? '已启用' : '已停用');
    loadMyGrants(document.getElementById('my-grants'));
}

async function showMyUid() {
    const { data, error } = await sb.rpc('view_my_open_uid');
    if (error) return toast(errText(error, '读取失败'), 'error');
    if (!data) return toast('你还没有领取授权码', 'error');
    showModal('我的授权码', `
        <p class="text-secondary" style="font-size:.875rem">这是你专属的授权码，相当于交给 AI 的钥匙，别贴到公开场合。</p>
        <code style="display:block;font-size:.9375rem;background:var(--color-bg-tertiary);padding:.75rem;border-radius:6px;word-break:break-all;margin-top:var(--space-4)">${esc(data)}</code>`,
        `<button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">关闭</button>
         <button class="btn btn-primary" onclick="copyText('${esc(data)}').then(()=>toast('授权码已复制'))">复制</button>`);
}

// ==================== 页面：管理后台 ====================
async function renderAdmin(app, sub) {
    const navItems = [
        { key: 'dashboard', label: '仪表盘', icon: icons.dashboard },
        { key: 'users', label: '用户管理', icon: icons.users },
        { key: 'posts', label: '帖子管理', icon: icons.message },
        { key: 'comments', label: '评论管理', icon: icons.message },
        { key: 'reports', label: '举报管理', icon: icons.flag },
        { key: 'announcement', label: '公告管理', icon: icons.flag },
        { key: 'features', label: '玩法特色', icon: icons.cube },
        { key: 'commands', label: '服务器指令', icon: icons.settings },
        { key: 'applications', label: '注册申请审核', icon: icons.flag },
        { key: 'members', label: '成员管理', icon: icons.users },
        { key: 'mods', label: '模组管理', icon: icons.download },
        { key: 'launchers', label: '启动器管理', icon: icons.download },
        { key: 'events', label: '活动管理', icon: icons.users },
        { key: 'records', label: '游戏实录', icon: icons.download },
        { key: 'ai', label: 'AI 配置', icon: icons.shield },
        { key: 'open', label: '开放平台', icon: icons.shield },
        { key: 'agreement', label: '协议设置', icon: icons.flag },
        { key: 'server', label: '服务器设置', icon: icons.settings },
    ];
    app.innerHTML = `
    <div class="admin-layout">
        <div class="admin-sidebar">
            ${navItems.map(n => `<a href="#/admin/${n.key}" class="admin-nav-link ${sub === n.key ? 'active' : ''}">${n.icon} ${n.label}</a>`).join('')}
        </div>
        <div class="admin-content" id="admin-content">${loadingBlock()}</div>
    </div>`;
    const content = document.getElementById('admin-content');
    switch (sub) {
        case 'users': renderAdminUsers(content); break;
        case 'posts': renderAdminPosts(content); break;
        case 'comments': renderAdminComments(content); break;
        case 'reports': renderAdminReports(content); break;
        case 'announcement': renderAdminAnnouncement(content); break;
        case 'features': renderAdminTable(content, 'game_features'); break;
        case 'commands': renderAdminTable(content, 'server_commands'); break;
        case 'applications': renderAdminApplications(content); break;
        case 'members': renderAdminTable(content, 'members'); break;
        case 'mods': renderAdminMods(content); break;
        case 'launchers': renderAdminLaunchers(content); break;
        case 'events': renderAdminEvents(content); break;
        case 'records': renderAdminRecords(content); break;
        case 'ai': renderAdminAi(content); break;
        case 'open': renderAdminOpen(content); break;
        case 'agreement': renderAdminAgreement(content); break;
        case 'server': renderAdminServer(content); break;
        default: renderAdminDashboard(content);
    }
}

async function renderAdminDashboard(el) {
    const [u, p, c, r] = await Promise.all([
        sb.from('profiles').select('id', { count: 'exact', head: true }),
        sb.from('posts').select('id', { count: 'exact', head: true }).eq('status', 'published'),
        sb.from('comments').select('id', { count: 'exact', head: true }).eq('status', 'published'),
        sb.from('reports').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    ]);
    const { data: recent } = await sb.from('posts').select('title, created_at').order('created_at', { ascending: false }).limit(5);
    el.innerHTML = `
        <h2 style="font-size:1.25rem;font-weight:600;margin-bottom:var(--space-6)">仪表盘</h2>
        <div class="stat-cards">
            <div class="card stat-card"><div class="stat-card-value">${u.count || 0}</div><div class="stat-card-label">注册用户</div></div>
            <div class="card stat-card"><div class="stat-card-value">${p.count || 0}</div><div class="stat-card-label">发布帖子</div></div>
            <div class="card stat-card"><div class="stat-card-value">${c.count || 0}</div><div class="stat-card-label">评论数量</div></div>
            <div class="card stat-card"><div class="stat-card-value">${r.count || 0}</div><div class="stat-card-label">待处理举报</div></div>
        </div>
        <h3 style="font-size:1rem;font-weight:600;margin-bottom:var(--space-4)">最近帖子</h3>
        <div class="card" style="padding:0;overflow:hidden">
            <table class="data-table"><thead><tr><th>内容</th><th>时间</th></tr></thead>
            <tbody>${(recent || []).map(x => `<tr><td>${esc(x.title)}</td><td>${timeAgo(x.created_at)}</td></tr>`).join('')}</tbody></table>
        </div>`;
}

async function renderAdminUsers(el) {
    const { data: users } = await sb.from('profiles').select('*').order('created_at', { ascending: false });
    el.innerHTML = `
        <h2 style="font-size:1.25rem;font-weight:600;margin-bottom:var(--space-6)">用户管理</h2>
        <div class="card" style="padding:0;overflow:hidden">
            <table class="data-table">
                <thead><tr><th>用户名 / 游戏 ID</th><th>注册原因</th><th>角色</th><th>状态</th><th>注册时间</th><th>操作</th></tr></thead>
                <tbody>${(users || []).map(u => `
                    <tr>
                        <td><div class="flex-center" style="gap:8px">${avatarHtml(u, 24)}<div><a href="#/profile/${u.id}" style="color:var(--color-text)">${esc(u.username)}</a><div class="text-tertiary">${esc(u.game_id || '未填写')}</div></div></div></td>
                        <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(u.register_reason || '未填写')}</td>
                        <td><span class="badge ${u.role === 'admin' ? 'badge-blue' : 'badge-gray'}">${u.role}</span></td>
                        <td><span class="badge ${u.status === 'active' ? 'badge-green' : 'badge-red'}">${u.status === 'active' ? '正常' : '已封禁'}</span></td>
                        <td class="text-tertiary">${timeAgo(u.created_at)}</td>
                        <td><button class="btn btn-ghost btn-sm" onclick="adminResetPasswordFlow('${u.id}','${esc(u.username)}')">重置密码</button>
                            ${u.id !== APP.user.id ? `
                            <button class="btn btn-ghost btn-sm" onclick="adminToggleBan('${u.id}','${u.status}')">${u.status === 'active' ? '撤销资格' : '恢复资格'}</button>
                            <button class="btn btn-ghost btn-sm" onclick="adminSetRole('${u.id}','${u.role === 'admin' ? 'user' : 'admin'}')">${u.role === 'admin' ? '取消管理' : '设为管理'}</button>` : ''}
                        </td>
                    </tr>`).join('')}</tbody>
            </table>
        </div>`;
}

// 忘记密码的兜底通道：管理员直接给用户设一个新密码，不走邮件
function randPassword() {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const buf = new Uint32Array(9);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(buf);
    else for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 4294967296);
    let s = '';
    for (let i = 0; i < buf.length; i++) s += abc[buf[i] % abc.length];
    return s.slice(0, 4) + '-' + s.slice(4);
}

function adminResetPasswordFlow(uid, username) {
    const id = 'arp-' + Date.now();
    showModal('重置密码', `
        <p class="text-secondary" style="font-size:.875rem">给 <strong>${esc(username)}</strong> 设置一个新密码。玩家拿到的这串要当场复制发给他，之后你自己也看不到。</p>
        <div class="form-group" style="margin-top:var(--space-4)"><label class="form-label">新密码（至少 6 位）</label>
            <div class="flex-center" style="gap:var(--space-3)">
                <input class="input" id="${id}" value="${randPassword()}">
                <button class="btn btn-secondary btn-sm" onclick="document.getElementById('${id}').value=randPassword()">换一组</button>
            </div></div>
        <p class="text-tertiary" style="font-size:.75rem">注意：这不会踢掉该玩家其他设备上的旧会话，对方登录态会自然过期。</p>`,
        `<button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">取消</button>
         <button class="btn btn-primary" onclick="applyAdminReset('${uid}','${id}','${esc(username)}')">确认重置</button>`);
}

async function applyAdminReset(uid, inputId, username) {
    const pw = document.getElementById(inputId).value.trim();
    if (pw.length < 6) return toast('密码至少 6 位', 'error');
    const { data, error } = await sb.rpc('admin_reset_password', { p_user_id: uid, p_new_password: pw });
    if (error) return toast(errText(error, '重置失败：请确认已执行个人中心 SQL 补丁'), 'error');
    document.querySelector('.modal-overlay').remove();
    showModal('已重置', `
        <p class="text-secondary" style="font-size:.875rem"><strong>${esc(data || username)}</strong> 的新密码是下面这行，复制发给他，并提醒他登录后立刻去个人中心改掉。</p>
        <div class="flex-center" style="gap:var(--space-3);margin-top:var(--space-4)">
            <code style="flex:1;font-size:.9375rem;background:var(--color-bg-tertiary);padding:.6rem .75rem;border-radius:6px;word-break:break-all">${esc(pw)}</code>
            <button class="btn btn-secondary btn-sm" onclick="copyText('${esc(pw)}').then(()=>toast('已复制'))">复制</button>
        </div>`,
        `<button class="btn btn-primary" onclick="this.closest('.modal-overlay').remove()">知道了</button>`);
}

async function adminToggleBan(uid, current) {
    const next = current === 'active' ? 'banned' : 'active';
    const { error } = await sb.from('profiles').update({ status: next }).eq('id', uid);
    if (error) return toast(errText(error, '操作失败'), 'error');
    toast(next === 'banned' ? '已封禁' : '已解封');
    renderAdminUsers(document.getElementById('admin-content'));
}

async function adminSetRole(uid, role) {
    const { error } = await sb.from('profiles').update({ role }).eq('id', uid);
    if (error) return toast(errText(error, '操作失败'), 'error');
    toast('角色已更新');
    renderAdminUsers(document.getElementById('admin-content'));
}

async function renderAdminPosts(el) {
    const { data: posts } = await sb.from('posts').select('*, author:profiles!posts_user_id_fkey(username)').order('created_at', { ascending: false }).limit(200);
    el.innerHTML = `
        <h2 style="font-size:1.25rem;font-weight:600;margin-bottom:var(--space-6)">帖子管理</h2>
        <div class="card" style="padding:0;overflow:hidden">
            <table class="data-table">
                <thead><tr><th>标题</th><th>作者</th><th>分类</th><th>状态</th><th>操作</th></tr></thead>
                <tbody>${(posts || []).map(p => `
                    <tr>
                        <td><a href="#/forum/${p.id}" style="color:var(--color-accent)">${esc(p.title)}</a></td>
                        <td>${esc(p.author?.username || '未知')}</td>
                        <td><span class="badge badge-gray">${esc(CAT_LABEL[p.category] || p.category)}</span></td>
                        <td><span class="badge ${p.status === 'published' ? 'badge-green' : 'badge-red'}">${p.status}</span></td>
                        <td>
                            <button class="btn btn-ghost btn-sm" onclick="adminTogglePost('${p.id}','${p.status}')">${p.status === 'published' ? '隐藏' : '恢复'}</button>
                            <button class="btn btn-ghost btn-sm" onclick="adminTogglePin('${p.id}',${p.is_pinned ? 'false' : 'true'})">${p.is_pinned ? '取消置顶' : '置顶'}</button>
                            <button class="btn btn-ghost btn-sm" onclick="adminDeletePost('${p.id}')">删除</button>
                        </td>
                    </tr>`).join('')}</tbody>
            </table>
        </div>`;
}

async function adminTogglePost(pid, current) {
    const next = current === 'published' ? 'hidden' : 'published';
    await sb.from('posts').update({ status: next }).eq('id', pid);
    toast('状态已更新'); renderAdminPosts(document.getElementById('admin-content'));
}
async function adminTogglePin(pid, val) {
    await sb.from('posts').update({ is_pinned: val }).eq('id', pid);
    toast('操作成功'); renderAdminPosts(document.getElementById('admin-content'));
}
async function adminDeletePost(pid) {
    if (!confirm('确定删除该帖子？删除后社区不再显示。')) return;
    const { error } = await sb.from('posts').update({ status: 'deleted' }).eq('id', pid);
    if (error) return toast(errText(error, '删除失败'), 'error');
    toast('帖子已删除'); renderAdminPosts(document.getElementById('admin-content'));
}
async function adminDeleteComment(cid) {
    if (!confirm('确定删除该评论？')) return;
    const { error } = await sb.from('comments').update({ status: 'deleted' }).eq('id', cid);
    if (error) return toast(errText(error, '删除失败'), 'error');
    toast('评论已删除'); renderAdminComments(document.getElementById('admin-content'));
}

async function renderAdminComments(el) {
    const { data: comments } = await sb.from('comments')
        .select('*, author:profiles!comments_user_id_fkey(username), post:posts(title)')
        .order('created_at', { ascending: false }).limit(200);
    el.innerHTML = `
        <h2 style="font-size:1.25rem;font-weight:600;margin-bottom:var(--space-6)">评论管理</h2>
        <div class="card" style="padding:0;overflow:hidden">
            <table class="data-table">
                <thead><tr><th>内容</th><th>作者</th><th>状态</th><th>操作</th></tr></thead>
                <tbody>${(comments || []).map(c => `
                    <tr>
                        <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.content)}</td>
                        <td>${esc(c.author?.username || '未知')}</td>
                        <td><span class="badge ${c.status === 'published' ? 'badge-green' : 'badge-red'}">${c.status}</span></td>
                        <td><button class="btn btn-ghost btn-sm" onclick="adminDeleteComment('${c.id}')">删除</button></td>
                    </tr>`).join('')}</tbody>
            </table>
        </div>`;
}

async function renderAdminReports(el) {
    const { data: reports } = await sb.from('reports')
        .select('*, reporter:profiles!reports_reporter_id_fkey(username)')
        .order('created_at', { ascending: false }).limit(200);
    el.innerHTML = `
        <h2 style="font-size:1.25rem;font-weight:600;margin-bottom:var(--space-6)">举报管理</h2>
        <div class="card" style="padding:0;overflow:hidden">
            ${!reports || reports.length === 0 ? '<div style="padding:var(--space-8);text-align:center;color:var(--color-text-tertiary)">暂无举报</div>' : `
            <table class="data-table">
                <thead><tr><th>对象</th><th>举报人</th><th>理由</th><th>状态</th><th>操作</th></tr></thead>
                <tbody>${reports.map(r => `
                    <tr>
                        <td><span class="badge badge-gray">${r.target_type}</span></td>
                        <td>${esc(r.reporter?.username || '未知')}</td>
                        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.reason)}</td>
                        <td><span class="badge ${r.status === 'pending' ? 'badge-yellow' : 'badge-green'}">${r.status}</span></td>
                        <td>${r.status === 'pending' ? `
                            <button class="btn btn-ghost btn-sm" onclick="reportAction('${r.id}','delete')">禁止使用</button>
                            <button class="btn btn-ghost btn-sm" onclick="reportAction('${r.id}','ban')">封禁用户</button>
                            <button class="btn btn-ghost btn-sm" onclick="reportAction('${r.id}','dismiss')">驳回</button>` : '<span class="text-tertiary">已处理</span>'}</td>
                    </tr>`).join('')}</tbody>
            </table>`}
        </div>`;
}

async function resolveReport(rid, status) {
    const { error } = await sb.from('reports').update({ status, admin_note: '处理人：' + APP.user.username }).eq('id', rid);
    if (error) return toast(errText(error, '操作失败'), 'error');
    toast('举报已处理');
    renderAdminReports(document.getElementById('admin-content'));
}

// 举报处理：禁止使用（删除内容）/ 封禁用户 / 驳回
async function reportAction(rid, action) {
    const label = action === 'delete' ? '禁止使用并删除该内容' : (action === 'ban' ? '封禁该用户' : '驳回该举报');
    if (!confirm(`确定要${label}吗？`)) return;
    const { error } = await sb.rpc('resolve_report_action', { p_report: rid, p_action: action });
    if (error) return toast(errText(error, '操作失败'), 'error');
    toast(action === 'dismiss' ? '已驳回' : '已处理，内容已移除');
    renderAdminReports(document.getElementById('admin-content'));
}

async function renderAdminAnnouncement(el) {
    const { data } = await sb.from('server_settings').select('value').eq('key','site').maybeSingle();
    const s = data?.value || {};
    el.innerHTML = `<h2 style="font-size:1.25rem;font-weight:600;margin-bottom:var(--space-6)">公告管理</h2><div class="card">
      <div class="form-group"><label class="form-label">公告内容</label><textarea class="textarea" id="ann-text" rows="4">${esc(s.announcement || '')}</textarea></div>
      <div class="form-group"><label class="form-label">详情链接（可选）</label><input class="input" id="ann-url" value="${esc(s.announcement_url || '')}"></div>
      <label class="flex-center gap-4"><input id="ann-enabled" type="checkbox" ${s.announcement_enabled !== false ? 'checked' : ''}> 启用公告</label>
      <div style="border-top:1px solid var(--color-border);margin-top:var(--space-6);padding-top:var(--space-5)">
        <label class="flex-center gap-4"><input id="ann-emailreset" type="checkbox" ${s.email_reset_enabled === true ? 'checked' : ''}> 开放「忘记密码」邮件自助重置</label>
        <p class="text-tertiary" style="font-size:.75rem;margin-top:.4rem;line-height:1.7">只有确认阿里云 SMTP 已经能正常收信之后再打开。没打开时，登录页的「忘记密码」走管理员后台重置。</p>
        <label class="flex-center gap-4" style="margin-top:var(--space-4)"><input id="ann-otplogin" type="checkbox" ${s.otp_login_enabled === true ? 'checked' : ''}> 开放「邮箱验证码」免密登录</label>
        <p class="text-tertiary" style="font-size:.75rem;margin-top:.4rem;line-height:1.7">打开后登录页多一个「用邮箱验证码登录」入口。前提同样是邮件能收到，并且 Supabase 的 Auth → Email Templates → <strong>Magic Link</strong> 模板里要有 <code>{{ .Token }}</code>，否则邮件只有链接没有码。</p>
      </div>
      <button class="btn btn-primary" style="margin-top:1rem" onclick="saveAnnouncement()">保存公告</button></div>`;
    draftBind('announcement', ['ann-text', 'ann-url', 'ann-enabled']);
}
async function saveAnnouncement() {
    const { data } = await sb.from('server_settings').select('value').eq('key','site').maybeSingle();
    const value = {...(data?.value || {}), announcement: document.getElementById('ann-text').value.trim(), announcement_url: document.getElementById('ann-url').value.trim(), announcement_enabled: document.getElementById('ann-enabled').checked, email_reset_enabled: document.getElementById('ann-emailreset').checked, otp_login_enabled: document.getElementById('ann-otplogin').checked};
    const { error } = await sb.from('server_settings').upsert({key:'site', value, updated_at:new Date().toISOString()});
    if (error) return toast(errText(error, '公告保存失败'), 'error'); Settings.cache = null; refreshAnnouncement(); draftClear('announcement'); toast('公告已保存');
}
// ==================== 后台表单草稿（防止误刷新丢内容）====================
function draftBind(key, ids) {
    let store = {};
    try { store = JSON.parse(localStorage.getItem('66qn_draft_' + key) || '{}'); } catch { store = {}; }
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        if (store[id] != null && el.type !== 'checkbox') el.value = store[id];
        if (store[id] != null && el.type === 'checkbox') el.checked = !!store[id];
        el.addEventListener('input', () => {
            let s = {};
            try { s = JSON.parse(localStorage.getItem('66qn_draft_' + key) || '{}'); } catch { s = {}; }
            s[id] = el.type === 'checkbox' ? el.checked : el.value;
            try { localStorage.setItem('66qn_draft_' + key, JSON.stringify(s)); } catch { /* 忽略 */ }
        });
    });
}
function draftClear(key) { localStorage.removeItem('66qn_draft_' + key); }

// ==================== 后台：通用内容表（中文标签）====================
const ADMIN_FIELDS = {
    game_features: [
        { key: 'title', label: '标题', ph: '例如 纯净原版', required: true },
        { key: 'description', label: '说明', type: 'textarea', ph: '一句话介绍这个玩法' },
        { key: 'sort_order', label: '排序', type: 'number', ph: '数字越小越靠前' },
    ],
    server_commands: [
        { key: 'command', label: '指令', ph: '例如 /spawn', required: true },
        { key: 'description', label: '说明', type: 'textarea', ph: '这个指令的作用' },
        { key: 'permission', label: '权限', ph: '玩家 / VIP / 管理员' },
    ],
    members: [
        { key: 'name', label: '游戏 ID', ph: '必须与游戏内 ID 完全一致，用于判断在线状态', required: true },
        { key: 'display_name', label: '展示名', ph: '留空则显示游戏 ID' },
        { key: 'role', label: '称号', ph: '服主 / 管理 / 成员' },
        { key: 'description', label: '说明', type: 'textarea', ph: '一句话介绍' },
        { key: 'avatar_url', label: '头像链接', ph: 'https://...（留空则用首字母头像）' },
        { key: 'sort_order', label: '排序', type: 'number', ph: '数字越小越靠前' },
    ],
};
const ADMIN_TITLES = { game_features: '玩法特色', server_commands: '服务器指令', members: '成员管理' };

function adminFieldInput(f, prefix, value) {
    const v = value == null ? '' : String(value);
    if (f.type === 'textarea') {
        return `<textarea class="textarea" id="${prefix}-${f.key}" rows="2" placeholder="${esc(f.ph || '')}">${esc(v)}</textarea>`;
    }
    return `<input class="input" id="${prefix}-${f.key}" type="${f.type === 'number' ? 'number' : 'text'}" value="${esc(v)}" placeholder="${esc(f.ph || '')}">`;
}

async function renderAdminTable(el, table) {
    const fields = ADMIN_FIELDS[table] || [];
    const title = ADMIN_TITLES[table] || table;
    const { data, error } = await sb.from(table).select('*').order('created_at', { ascending: false });
    if (error) { el.innerHTML = `<div class="card">${esc(errText(error, '读取失败'))}</div>`; return; }
    el.innerHTML = `
        <h2 style="font-size:1.25rem;font-weight:600;margin-bottom:var(--space-6)">${title}</h2>
        <div class="card mb-8">
            <h3 style="font-size:1rem;font-weight:600;margin-bottom:var(--space-4)">新增${title}</h3>
            <div class="grid-2">${fields.map(f => `
                <div class="form-group"><label class="form-label">${f.label}${f.required ? ' <span class="text-tertiary">(必填)</span>' : ''}</label>
                    ${adminFieldInput(f, 'new', '')}</div>`).join('')}</div>
            <button class="btn btn-primary" onclick="adminCreateRow('${table}')">新增</button>
        </div>
        <div class="card" style="padding:0;overflow:auto">
            <table class="data-table">
                <thead><tr>${fields.map(f => `<th>${f.label}</th>`).join('')}<th>状态</th><th>操作</th></tr></thead>
                <tbody>${(data || []).map(row => `
                    <tr>
                        ${fields.map(f => `<td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(row[f.key] == null ? '' : String(row[f.key]))}</td>`).join('')}
                        <td><span class="badge ${row.enabled !== false ? 'badge-green' : 'badge-gray'}">${row.enabled !== false ? '启用' : '停用'}</span></td>
                        <td>
                            <button class="btn btn-ghost btn-sm" onclick="adminToggleRow('${table}','${row.id}',${row.enabled !== false ? 'false' : 'true'})">${row.enabled !== false ? '停用' : '启用'}</button>
                            <button class="btn btn-ghost btn-sm" onclick="adminEditRow('${table}','${row.id}')">编辑</button>
                            <button class="btn btn-ghost btn-sm" onclick="adminDeleteRow('${table}','${row.id}')">删除</button>
                        </td>
                    </tr>`).join('') || `<tr><td colspan="${fields.length + 2}" style="text-align:center;padding:2rem;color:var(--color-text-tertiary)">暂无数据，请在上方新增</td></tr>`}</tbody>
            </table>
        </div>`;
    draftBind('tbl_' + table, fields.map(f => 'new-' + f.key));
}

async function adminCreateRow(table) {
    const fields = ADMIN_FIELDS[table] || [];
    const payload = { enabled: true };
    for (const f of fields) {
        const raw = document.getElementById('new-' + f.key)?.value.trim() || '';
        if (f.required && !raw) return toast('请填写「' + f.label + '」', 'error');
        payload[f.key] = f.type === 'number' ? (parseInt(raw) || 0) : raw;
    }
    const { error } = await sb.from(table).insert(payload);
    if (error) return toast(errText(error, '新增失败'), 'error');
    toast('已新增');
    draftClear('tbl_' + table);
    renderAdminTable(document.getElementById('admin-content'), table);
}

async function adminEditRow(table, id) {
    const fields = ADMIN_FIELDS[table] || [];
    const { data: row } = await sb.from(table).select('*').eq('id', id).maybeSingle();
    if (!row) return;
    showModal('编辑' + (ADMIN_TITLES[table] || ''), `
        ${fields.map(f => `<div class="form-group"><label class="form-label">${f.label}</label>${adminFieldInput(f, 'ed', row[f.key])}</div>`).join('')}`,
        `<button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">取消</button>
         <button class="btn btn-primary" onclick="adminUpdateRow('${table}','${id}')">保存</button>`);
}

async function adminUpdateRow(table, id) {
    const fields = ADMIN_FIELDS[table] || [];
    const payload = {};
    for (const f of fields) {
        const raw = document.getElementById('ed-' + f.key)?.value.trim() || '';
        if (f.required && !raw) return toast('请填写「' + f.label + '」', 'error');
        payload[f.key] = f.type === 'number' ? (parseInt(raw) || 0) : raw;
    }
    const { error } = await sb.from(table).update(payload).eq('id', id);
    if (error) return toast(errText(error, '保存失败'), 'error');
    document.querySelector('.modal-overlay')?.remove();
    toast('已保存');
    renderAdminTable(document.getElementById('admin-content'), table);
}

async function adminToggleRow(table, id, enabled) {
    const { error } = await sb.from(table).update({ enabled }).eq('id', id);
    if (error) return toast(errText(error, '操作失败'), 'error');
    toast(enabled ? '已启用' : '已停用');
    renderAdminTable(document.getElementById('admin-content'), table);
}

async function adminDeleteRow(table, id) {
    if (!confirm('确定删除该条内容？')) return;
    const { error } = await sb.from(table).delete().eq('id', id);
    if (error) return toast(errText(error, '删除失败'), 'error');
    toast('已删除');
    renderAdminTable(document.getElementById('admin-content'), table);
}
async function renderAdminEvents(el) {
    const { data } = await sb.from('events').select('*, signups:event_signups(count)').order('created_at', { ascending: false });
    el.innerHTML = `
        <h2 style="font-size:1.25rem;font-weight:600;margin-bottom:var(--space-6)">活动管理</h2>
        <div class="card mb-8">
            <h3 style="font-size:1rem;font-weight:600;margin-bottom:var(--space-4)">发布新活动</h3>
            <div class="form-group"><label class="form-label">活动名称</label><input class="input" id="ev-name" placeholder="例如 秋季建筑大赛"></div>
            <div class="form-group"><label class="form-label">活动说明</label><textarea class="textarea" id="ev-desc" rows="3"></textarea></div>
            <div class="grid-2">
                <div class="form-group"><label class="form-label">开始时间</label><input class="input" id="ev-start" type="datetime-local"></div>
                <div class="form-group"><label class="form-label">结束时间</label><input class="input" id="ev-end" type="datetime-local"></div>
            </div>
            <label class="flex-center" style="gap:.35rem;margin-bottom:1rem"><input type="checkbox" id="ev-signup" checked> 开启活动报名（用户可上传图片和文字）</label>
            <button class="btn btn-primary" onclick="saveEvent()">发布活动</button>
        </div>
        <div class="card" style="padding:0;overflow:auto">
            <table class="data-table">
                <thead><tr><th>活动</th><th>报名</th><th>报名人数</th><th>状态</th><th>操作</th></tr></thead>
                <tbody>${(data || []).map(e => `
                    <tr>
                        <td><a href="#/events/${e.id}" style="color:var(--color-accent)">${esc(e.name)}</a></td>
                        <td>${e.signup_enabled ? '<span class="badge badge-blue">已开启</span>' : '<span class="badge badge-gray">未开启</span>'}</td>
                        <td>${e.signups?.[0]?.count ?? 0}</td>
                        <td><span class="badge ${e.enabled ? 'badge-green' : 'badge-red'}">${e.enabled ? '进行中' : '已关闭'}</span></td>
                        <td>
                            <button class="btn btn-ghost btn-sm" onclick="adminToggleEvent('${e.id}',${e.enabled ? 'false' : 'true'})">${e.enabled ? '关闭活动' : '开启活动'}</button>
                            <button class="btn btn-ghost btn-sm" onclick="adminToggleEventSignup('${e.id}',${e.signup_enabled ? 'false' : 'true'})">${e.signup_enabled ? '关闭报名' : '开启报名'}</button>
                            <button class="btn btn-ghost btn-sm" onclick="adminDeleteEvent('${e.id}')">删除</button>
                        </td>
                    </tr>`).join('') || '<tr><td colspan="5" style="text-align:center;padding:2rem;color:var(--color-text-tertiary)">暂无活动</td></tr>'}</tbody>
            </table>
        </div>`;
    draftBind('event', ['ev-name', 'ev-desc', 'ev-start', 'ev-end', 'ev-signup']);
}
async function saveEvent() {
    const name = document.getElementById('ev-name').value.trim();
    if (!name) return toast('请填写活动名称', 'error');
    const payload = {
        name,
        description: document.getElementById('ev-desc').value.trim(),
        starts_at: document.getElementById('ev-start').value || null,
        ends_at: document.getElementById('ev-end').value || null,
        signup_enabled: document.getElementById('ev-signup').checked,
        enabled: true,
    };
    const { error } = await sb.from('events').insert(payload);
    if (error) return toast(errText(error, '发布失败'), 'error');
    toast('活动已发布');
    draftClear('event');
    renderAdminEvents(document.getElementById('admin-content'));
}
async function adminToggleEvent(id, enabled) {
    await sb.from('events').update({ enabled }).eq('id', id);
    toast(enabled ? '活动已开启' : '活动已关闭');
    renderAdminEvents(document.getElementById('admin-content'));
}
async function adminToggleEventSignup(id, on) {
    await sb.from('events').update({ signup_enabled: on }).eq('id', id);
    toast(on ? '已开启报名' : '已关闭报名');
    renderAdminEvents(document.getElementById('admin-content'));
}
async function adminDeleteEvent(id) {
    if (!confirm('确定删除该活动及其报名？')) return;
    await sb.from('events').delete().eq('id', id);
    toast('已删除');
    renderAdminEvents(document.getElementById('admin-content'));
}

// ==================== 后台：注册申请审核 ====================
async function renderAdminApplications(el) {
    const { data: apps } = await sb.from('account_applications').select('*').order('created_at', { ascending: false }).limit(300);
    const pending = (apps || []).filter(a => a.status === 'pending');
    el.innerHTML = `
        <h2 style="font-size:1.25rem;font-weight:600;margin-bottom:var(--space-4)">注册申请审核</h2>
        <p class="text-secondary mb-8" style="font-size:.875rem">用户在「申请账号」页提交资料，你审核通过后系统会自动创建账号；之后用户用<strong>昵称 + 密码</strong>即可登录。待审核申请：<strong>${pending.length}</strong> 条。</p>
        <div class="card" style="padding:0;overflow:auto">
            <table class="data-table">
                <thead><tr><th>申请时间</th><th>昵称</th><th>联系方式</th><th>保密问题</th><th>状态</th><th>操作</th></tr></thead>
                <tbody>${(apps || []).map(a => `
                    <tr>
                        <td class="text-tertiary">${new Date(a.created_at).toLocaleString('zh-CN')}</td>
                        <td><strong>${esc(a.nickname)}</strong></td>
                        <td class="text-tertiary">${esc(a.contact)}</td>
                        <td>${esc(a.secret_q)}</td>
                        <td>${a.status === 'pending' ? '<span class="badge badge-yellow">待审核</span>'
                            : (a.status === 'approved' ? '<span class="badge badge-green">已通过</span>' : '<span class="badge badge-gray">已驳回</span>')}</td>
                        <td>
                            ${a.status === 'pending' ? `
                            <button class="btn btn-primary btn-sm" onclick="approveApplication('${a.id}')">通过并创建账号</button>
                            <button class="btn btn-ghost btn-sm" onclick="rejectApplication('${a.id}')">驳回</button>` : `
                            <button class="btn btn-ghost btn-sm" onclick="setUserPassword('${a.user_id}', '${esc(a.nickname)}')">设置登录密码</button>`}
                            ${a.note ? `<div class="text-tertiary" style="font-size:.75rem;margin-top:.25rem">${esc(a.note)}</div>` : ''}
                        </td>
                    </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--color-text-tertiary)">还没有人提交申请</td></tr>'}</tbody>
            </table>
        </div>`;
}

async function approveApplication(appId) {
    if (!confirm('通过该申请并立即创建账号？创建后用户即可用昵称+密码登录。')) return;
    const { data, error } = await sb.functions.invoke(AI_FN, { body: { action: 'create_account', app_id: appId } });
    if (error || !data || data.error) {
        return toast('创建失败：' + ((error && error.message) || (data && data.error) || '未知错误'), 'error');
    }
    toast('账号已创建，昵称：' + (data.nickname || ''));
    renderAdminApplications(document.getElementById('admin-content'));
}

async function rejectApplication(appId) {
    const note = prompt('驳回原因（可选）：', '');
    if (note === null) return;
    const { error } = await sb.rpc('review_application', { p_app: appId, p_action: 'reject', p_note: note });
    if (error) return toast(errText(error, '操作失败'), 'error');
    toast('已驳回');
    renderAdminApplications(document.getElementById('admin-content'));
}

async function setUserPassword(userId, nickname) {
    const pwd = prompt('为「' + nickname + '」设置新的登录密码（至少6位）：', '');
    if (pwd === null) return;
    if (pwd.length < 6) return toast('密码至少6位', 'error');
    const { data, error } = await sb.functions.invoke(AI_FN, { body: { action: 'set_password', user_id: userId, password: pwd } });
    if (error || !data || data.error) {
        return toast('修改失败：' + ((error && error.message) || (data && data.error) || '未知错误'), 'error');
    }
    toast('密码已修改，请告知用户新密码');
}

// ==================== 后台：自有模组管理 ====================
async function renderAdminMods(el) {
    const { data } = await sb.from('mods').select('*').order('sort_order', { ascending: true }).order('created_at', { ascending: false });
    el.innerHTML = `
        <h2 style="font-size:1.25rem;font-weight:600;margin-bottom:var(--space-6)">模组管理（下载页 · 自有模组）</h2>
        <div class="card mb-8">
            <h3 style="font-size:1rem;font-weight:600;margin-bottom:var(--space-4)">新增模组</h3>
            <div class="grid-2">
                <div class="form-group"><label class="form-label">模组名称</label><input class="input" id="mod-name" placeholder="例如 66qn 整合包" maxlength="80"></div>
                <div class="form-group"><label class="form-label">版本（可选）</label><input class="input" id="mod-version" placeholder="例如 1.0.0" maxlength="32"></div>
            </div>
            <div class="form-group"><label class="form-label">下载链接</label><input class="input" id="mod-url" placeholder="https://..."></div>
            <div class="form-group"><label class="form-label">说明（可选）</label><textarea class="textarea" id="mod-desc" rows="2" maxlength="300"></textarea>
                <p class="text-tertiary" style="font-size:.75rem;margin-top:.25rem">支持 <code>**词语</code><code>**</code> 语法，渲染为蓝色加粗强调。</p></div>
            <div class="form-group"><label class="form-label">排序（数字越小越靠前）</label><input class="input" id="mod-sort" type="number" value="0"></div>
            <button class="btn btn-primary" onclick="saveMod()">添加模组</button>
        </div>
        <div class="card" style="padding:0;overflow:auto">
            <table class="data-table">
                <thead><tr><th>名称</th><th>版本</th><th>链接</th><th>排序</th><th>状态</th><th>操作</th></tr></thead>
                <tbody>${(data || []).map(m => `
                    <tr>
                        <td>${esc(m.name)}${m.description ? `<div class="text-tertiary">${esc(m.description)}</div>` : ''}</td>
                        <td>${esc(m.version || '-')}</td>
                        <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${m.url ? `<a href="${esc(m.url)}" target="_blank" rel="noopener" style="color:var(--color-accent)">${esc(m.url)}</a>` : '<span class="text-tertiary">未填写</span>'}</td>
                        <td>${m.sort_order}</td>
                        <td><span class="badge ${m.enabled ? 'badge-green' : 'badge-gray'}">${m.enabled ? '上架' : '下架'}</span></td>
                        <td>
                            <button class="btn btn-ghost btn-sm" onclick="toggleMod('${m.id}',${m.enabled ? 'false' : 'true'})">${m.enabled ? '下架' : '上架'}</button>
                            <button class="btn btn-ghost btn-sm" onclick="editMod('${m.id}')">编辑</button>
                            <button class="btn btn-ghost btn-sm" onclick="deleteMod('${m.id}')">删除</button>
                        </td>
                    </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--color-text-tertiary)">还没有模组</td></tr>'}</tbody>
            </table>
        </div>`;
    draftBind('mod', ['mod-name', 'mod-version', 'mod-url', 'mod-desc', 'mod-sort']);
}
async function saveMod() {
    const payload = {
        name: document.getElementById('mod-name').value.trim(),
        version: document.getElementById('mod-version').value.trim(),
        url: document.getElementById('mod-url').value.trim(),
        description: document.getElementById('mod-desc').value.trim(),
        sort_order: parseInt(document.getElementById('mod-sort').value) || 0,
        enabled: true,
    };
    if (!payload.name) return toast('请填写模组名称', 'error');
    if (!payload.url) return toast('请填写下载链接', 'error');
    const { error } = await sb.from('mods').insert(payload);
    if (error) return toast(errText(error, '添加失败'), 'error');
    toast('模组已添加');
    draftClear('mod');
    renderAdminMods(document.getElementById('admin-content'));
}
async function toggleMod(id, enabled) {
    await sb.from('mods').update({ enabled }).eq('id', id);
    toast(enabled ? '已上架' : '已下架');
    renderAdminMods(document.getElementById('admin-content'));
}
async function editMod(id) {
    const { data: m } = await sb.from('mods').select('*').eq('id', id).maybeSingle();
    if (!m) return;
    showModal('编辑模组', `
        <div class="form-group"><label class="form-label">模组名称</label><input class="input" id="em-name" value="${esc(m.name)}" maxlength="80"></div>
        <div class="form-group"><label class="form-label">版本</label><input class="input" id="em-version" value="${esc(m.version || '')}" maxlength="32"></div>
        <div class="form-group"><label class="form-label">下载链接</label><input class="input" id="em-url" value="${esc(m.url || '')}"></div>
        <div class="form-group"><label class="form-label">说明</label><textarea class="textarea" id="em-desc" rows="2" maxlength="300">${esc(m.description || '')}</textarea></div>
        <div class="form-group"><label class="form-label">排序</label><input class="input" id="em-sort" type="number" value="${m.sort_order}"></div>`,
        `<button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">取消</button>
         <button class="btn btn-primary" onclick="updateMod('${m.id}')">保存</button>`);
}
async function updateMod(id) {
    const payload = {
        name: document.getElementById('em-name').value.trim(),
        version: document.getElementById('em-version').value.trim(),
        url: document.getElementById('em-url').value.trim(),
        description: document.getElementById('em-desc').value.trim(),
        sort_order: parseInt(document.getElementById('em-sort').value) || 0,
    };
    if (!payload.name) return toast('请填写模组名称', 'error');
    const { error } = await sb.from('mods').update(payload).eq('id', id);
    if (error) return toast(errText(error, '保存失败'), 'error');
    document.querySelector('.modal-overlay')?.remove();
    toast('已保存');
    renderAdminMods(document.getElementById('admin-content'));
}
async function deleteMod(id) {
    if (!confirm('确定删除该模组？')) return;
    const { error } = await sb.from('mods').delete().eq('id', id);
    if (error) return toast(errText(error, '删除失败'), 'error');
    toast('已删除');
    renderAdminMods(document.getElementById('admin-content'));
}

// ==================== 后台：启动器管理 ====================
async function renderAdminLaunchers(el) {
    const { data } = await sb.from('launchers').select('*').order('sort_order', { ascending: true }).order('created_at', { ascending: false });
    el.innerHTML = `
        <h2 style="font-size:1.25rem;font-weight:600;margin-bottom:var(--space-6)">启动器管理（下载页 · 启动器）</h2>
        <div class="card mb-8">
            <h3 style="font-size:1rem;font-weight:600;margin-bottom:var(--space-4)">新增启动器</h3>
            <div class="grid-2">
                <div class="form-group"><label class="form-label">启动器名称</label><input class="input" id="lc-name" placeholder="例如 HMCL" maxlength="40"></div>
                <div class="form-group"><label class="form-label">全称（可选）</label><input class="input" id="lc-subtitle" placeholder="例如 Hello Minecraft! Launcher" maxlength="80"></div>
            </div>
            <div class="form-group"><label class="form-label">下载链接</label><input class="input" id="lc-url" placeholder="https://..."></div>
            <div class="form-group">
                <label class="form-label">说明</label>
                <textarea class="textarea" id="lc-desc" rows="2" maxlength="300"></textarea>
                <p class="text-tertiary" style="font-size:.75rem;margin-top:.25rem">支持 <code>**词语</code><code>**</code> 语法（前后各两个星号包裹），渲染为蓝色加粗强调，例如：支持 <code>**微软账户登录**</code>。</p>
            </div>
            <div class="grid-2">
                <div class="form-group"><label class="form-label">标签（逗号分隔，第一个为蓝色）</label><input class="input" id="lc-tags" placeholder="例如 推荐,Windows,macOS" maxlength="120"></div>
                <div class="form-group"><label class="form-label">排序（数字越小越靠前）</label><input class="input" id="lc-sort" type="number" value="0"></div>
            </div>
            <button class="btn btn-primary" onclick="saveLauncher()">添加启动器</button>
        </div>
        <div class="card" style="padding:0;overflow:auto">
            <table class="data-table">
                <thead><tr><th>名称</th><th>标签</th><th>链接</th><th>排序</th><th>状态</th><th>操作</th></tr></thead>
                <tbody>${(data || []).map(l => `
                    <tr>
                        <td>${esc(l.name)}${l.description ? `<div class="text-tertiary">${esc(l.description)}</div>` : ''}</td>
                        <td>${esc(l.tags || '-')}</td>
                        <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${l.url ? `<a href="${esc(l.url)}" target="_blank" rel="noopener" style="color:var(--color-accent)">${esc(l.url)}</a>` : '<span class="text-tertiary">未填写</span>'}</td>
                        <td>${l.sort_order}</td>
                        <td><span class="badge ${l.enabled ? 'badge-green' : 'badge-gray'}">${l.enabled ? '上架' : '下架'}</span></td>
                        <td>
                            <button class="btn btn-ghost btn-sm" onclick="toggleLauncher('${l.id}',${l.enabled ? 'false' : 'true'})">${l.enabled ? '下架' : '上架'}</button>
                            <button class="btn btn-ghost btn-sm" onclick="editLauncher('${l.id}')">编辑</button>
                            <button class="btn btn-ghost btn-sm" onclick="deleteLauncher('${l.id}')">删除</button>
                        </td>
                    </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--color-text-tertiary)">还没有启动器</td></tr>'}</tbody>
            </table>
        </div>`;
    draftBind('launcher', ['lc-name', 'lc-subtitle', 'lc-url', 'lc-desc', 'lc-tags', 'lc-sort']);
}
async function saveLauncher() {
    const payload = {
        name: document.getElementById('lc-name').value.trim(),
        subtitle: document.getElementById('lc-subtitle').value.trim(),
        url: document.getElementById('lc-url').value.trim(),
        description: document.getElementById('lc-desc').value.trim(),
        tags: document.getElementById('lc-tags').value.trim(),
        sort_order: parseInt(document.getElementById('lc-sort').value) || 0,
        enabled: true,
    };
    if (!payload.name) return toast('请填写启动器名称', 'error');
    const { error } = await sb.from('launchers').insert(payload);
    if (error) return toast(errText(error, '添加失败'), 'error');
    toast('启动器已添加');
    draftClear('launcher');
    renderAdminLaunchers(document.getElementById('admin-content'));
}
async function toggleLauncher(id, enabled) {
    await sb.from('launchers').update({ enabled }).eq('id', id);
    toast(enabled ? '已上架' : '已下架');
    renderAdminLaunchers(document.getElementById('admin-content'));
}
async function editLauncher(id) {
    const { data: l } = await sb.from('launchers').select('*').eq('id', id).maybeSingle();
    if (!l) return;
    showModal('编辑启动器', `
        <div class="form-group"><label class="form-label">启动器名称</label><input class="input" id="el-name" value="${esc(l.name)}" maxlength="40"></div>
        <div class="form-group"><label class="form-label">全称</label><input class="input" id="el-subtitle" value="${esc(l.subtitle || '')}" maxlength="80"></div>
        <div class="form-group"><label class="form-label">下载链接</label><input class="input" id="el-url" value="${esc(l.url || '')}"></div>
        <div class="form-group">
            <label class="form-label">说明</label>
            <textarea class="textarea" id="el-desc" rows="2" maxlength="300">${esc(l.description || '')}</textarea>
            <p class="text-tertiary" style="font-size:.75rem;margin-top:.25rem">支持 <code>**词语</code><code>**</code> 语法，渲染为蓝色加粗强调。</p>
        </div>
        <div class="form-group"><label class="form-label">标签（逗号分隔，第一个为蓝色）</label><input class="input" id="el-tags" value="${esc(l.tags || '')}" maxlength="120"></div>
        <div class="form-group"><label class="form-label">排序</label><input class="input" id="el-sort" type="number" value="${l.sort_order}"></div>`,
        `<button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">取消</button>
         <button class="btn btn-primary" onclick="updateLauncher('${l.id}')">保存</button>`);
}
async function updateLauncher(id) {
    const payload = {
        name: document.getElementById('el-name').value.trim(),
        subtitle: document.getElementById('el-subtitle').value.trim(),
        url: document.getElementById('el-url').value.trim(),
        description: document.getElementById('el-desc').value.trim(),
        tags: document.getElementById('el-tags').value.trim(),
        sort_order: parseInt(document.getElementById('el-sort').value) || 0,
    };
    if (!payload.name) return toast('请填写启动器名称', 'error');
    const { error } = await sb.from('launchers').update(payload).eq('id', id);
    if (error) return toast(errText(error, '保存失败'), 'error');
    document.querySelector('.modal-overlay')?.remove();
    toast('已保存');
    renderAdminLaunchers(document.getElementById('admin-content'));
}
async function deleteLauncher(id) {
    if (!confirm('确定删除该启动器？')) return;
    const { error } = await sb.from('launchers').delete().eq('id', id);
    if (error) return toast(errText(error, '删除失败'), 'error');
    toast('已删除');
    renderAdminLaunchers(document.getElementById('admin-content'));
}

// ==================== 后台：游戏实录审核 ====================
async function renderAdminRecords(el) {
    const { data } = await sb.from('game_records').select('*, user:profiles!game_records_user_id_fkey(username)').order('created_at', { ascending: false }).limit(200);
    el.innerHTML = `
        <h2 style="font-size:1.25rem;font-weight:600;margin-bottom:var(--space-6)">游戏实录审核</h2>
        <div class="card" style="padding:0;overflow:auto">
            <table class="data-table">
                <thead><tr><th>截图</th><th>玩家</th><th>坐标</th><th>提交人</th><th>状态</th><th>操作</th></tr></thead>
                <tbody>${(data || []).map(r => `
                    <tr>
                        <td><a href="${esc(r.image_url)}" target="_blank" rel="noopener"><img src="${esc(r.image_url)}" alt="" style="width:64px;height:64px;object-fit:cover;border-radius:6px"></a></td>
                        <td>${esc(r.player_name)}</td>
                        <td>${esc(r.coordinates)}</td>
                        <td>${esc(r.user?.username || '')}</td>
                        <td><span class="badge ${r.status === 'approved' ? 'badge-green' : (r.status === 'rejected' ? 'badge-red' : 'badge-yellow')}">${r.status}</span></td>
                        <td>
                            ${r.status !== 'approved' ? `<button class="btn btn-ghost btn-sm" onclick="adminReviewRecord('${r.id}','approved')">通过</button>` : ''}
                            ${r.status !== 'rejected' ? `<button class="btn btn-ghost btn-sm" onclick="adminReviewRecord('${r.id}','rejected')">拒绝</button>` : ''}
                            <button class="btn btn-ghost btn-sm" onclick="adminDeleteRecord('${r.id}')">删除</button>
                        </td>
                    </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--color-text-tertiary)">暂无实录</td></tr>'}</tbody>
            </table>
        </div>`;
}
async function adminReviewRecord(id, status) {
    const { error } = await sb.from('game_records').update({ status }).eq('id', id);
    if (error) return toast(errText(error, '操作失败'), 'error');
    toast(status === 'approved' ? '已通过' : '已拒绝');
    renderAdminRecords(document.getElementById('admin-content'));
}
async function adminDeleteRecord(id) {
    if (!confirm('确定删除该实录？')) return;
    const { error } = await sb.from('game_records').delete().eq('id', id);
    if (error) return toast(errText(error, '删除失败'), 'error');
    toast('已删除');
    renderAdminRecords(document.getElementById('admin-content'));
}

// ==================== 后台：开放平台 ====================
const OPEN_CAPS = [
    { key: 'get_info',     col: 'can_get_info',     label: '查询账号信息' },
    { key: 'get_power',    col: 'can_get_power',    label: '查询电力' },
    { key: 'checkin',      col: 'can_checkin',      label: '每日签到' },
    { key: 'add_power',    col: 'can_add_power',    label: '增加电力' },
    { key: 'deduct_power', col: 'can_deduct_power', label: '扣减电力' },
];
async function renderAdminOpen(el) {
    const { data: accounts, error } = await sb.from('open_accounts').select('*').order('created_at', { ascending: false });
    if (error) {
        el.innerHTML = `<h2 style="font-size:1.25rem;font-weight:600;margin-bottom:var(--space-4)">开放平台</h2>
        <p class="text-secondary">${esc(errText(error, '加载失败：请先在 Supabase SQL Editor 运行开放平台 SQL 补丁'))}</p>`;
        return;
    }
    el.innerHTML = `
        <h2 style="font-size:1.25rem;font-weight:600;margin-bottom:var(--space-4)">开放平台</h2>
        <p class="text-secondary mb-8" style="font-size:.875rem">
            为第三方模组 / AI 助手创建开放账号。每个账号有一个<b>公开 ID</b>（可对外展示）和一个<b>UID</b>（保密，创建时展示一次，之后可点「查看 UID」找回）。
            第三方调用 <code>POST {window.APP_CONFIG.SUPABASE_URL}/rest/v1/rpc/open_api</code>，参数 <code>p_uid / p_action / p_username / p_amount</code>，
            action 支持 ping、get_info、get_power、checkin、add_power、deduct_power。每个功能可单独开关，限频每小时 120 次。
        </p>
        <div class="mb-8"><button class="btn btn-primary" onclick="openCreateOpenAccount()">新建开放账号</button></div>
        ${(accounts || []).map(a => `
        <div class="card mb-8">
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:var(--space-2)">
                <div>
                    <div style="font-weight:600">${esc(a.name)} <span class="badge ${a.status === 'active' ? 'badge-green' : 'badge-gray'}">${a.status === 'active' ? '启用中' : '已停用'}</span></div>
                    <div class="text-secondary" style="font-size:.8125rem;margin-top:var(--space-1)">
                        公开 ID：<code>${esc(a.public_id)}</code>
                        ${a.bind_username ? ` · 绑定玩家：<b>${esc(a.bind_username)}</b>` : ' · 未绑定（调用时需指定玩家）'}
                        · 已调用 ${a.call_count || 0} 次
                    </div>
                </div>
                <div style="display:flex;gap:var(--space-2);flex-wrap:wrap">
                    <button class="btn btn-sm btn-secondary" onclick="viewOpenUid('${a.id}')">查看 UID</button>
                    <button class="btn btn-sm btn-secondary" onclick="showOpenLogs('${a.id}', '${esc(a.public_id)}')">调用日志</button>
                    <button class="btn btn-sm ${a.status === 'active' ? 'btn-danger' : 'btn-primary'}" onclick="toggleOpenStatus('${a.id}', '${a.status === 'active' ? 'disabled' : 'active'}')">${a.status === 'active' ? '停用' : '启用'}</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteOpenAccount('${a.id}')">删除</button>
                </div>
            </div>
            <div style="display:flex;gap:var(--space-2);flex-wrap:wrap;margin-top:var(--space-3)">
                ${OPEN_CAPS.map(c => `<button class="btn btn-sm ${a[c.col] ? 'btn-primary' : 'btn-secondary'}" onclick="toggleOpenCap('${a.id}', '${c.col}', ${!a[c.col]})" title="点击${a[c.col] ? '关闭' : '开启'}该功能">${a[c.col] ? '✓' : '✗'} ${c.label}</button>`).join('')}
            </div>
        </div>`).join('') || '<p class="text-secondary">还没有开放账号，点上面的按钮新建一个。</p>'}
    `;
}
function openCreateOpenAccount() {
    showModal('新建开放账号', `
        <div class="form-group"><label class="form-label">应用名称（备注）</label><input class="input" id="oa-name" placeholder="例如 AI 签到助手"></div>
        <div class="form-group"><label class="form-label">绑定玩家昵称（可选）</label><input class="input" id="oa-bind" placeholder="填了就只能操作这个玩家；留空 = 调用时指定任意玩家"></div>
        <div class="form-group"><label class="form-label">开放功能（之后可随时开关）</label>
            ${OPEN_CAPS.map(c => `<label style="display:block;margin-bottom:var(--space-1)"><input type="checkbox" id="oa-cap-${c.key}"> ${c.label}</label>`).join('')}
        </div>`,
        `<button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">取消</button>
         <button class="btn btn-primary" onclick="createOpenAccount()">创建</button>`);
}
async function createOpenAccount() {
    const name = document.getElementById('oa-name').value.trim();
    const bind = document.getElementById('oa-bind').value.trim();
    if (!name) return toast('请填写应用名称', 'error');
    const caps = {};
    OPEN_CAPS.forEach(c => caps[c.key] = document.getElementById('oa-cap-' + c.key).checked);
    const btn = document.querySelector('.modal-actions .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = '创建中…'; }
    const { data, error } = await sb.rpc('admin_create_open_account', { p_name: name, p_bind_username: bind, p_caps: caps });
    if (error) {
        if (btn) { btn.disabled = false; btn.textContent = '创建'; }
        return toast(errText(error, '创建失败'), 'error');
    }
    document.querySelectorAll('.modal-overlay').forEach(m => m.remove());
    showModal('开放账号已创建', `
        <p class="mb-8">公开 ID：<code>${esc(data.public_id)}</code>（可对外展示）</p>
        <p class="mb-8" style="font-weight:600;color:var(--color-danger)">UID 只展示这一次，请立即复制保存：</p>
        <div style="display:flex;gap:var(--space-2);margin-bottom:var(--space-4)">
            <input class="input" id="oa-uid" readonly value="${esc(data.uid)}" style="font-family:monospace;font-size:.8125rem">
            <button class="btn btn-secondary" onclick="copyOpenUid()">复制</button>
        </div>
        <p class="text-secondary" style="font-size:.8125rem">UID 已加密存储，忘了也能在列表里点「查看 UID」找回。</p>`,
        `<button class="btn btn-primary" onclick="this.closest('.modal-overlay').remove();renderAdminOpen(document.getElementById('admin-content'))">完成</button>`);
}
function copyOpenUid() {
    const v = document.getElementById('oa-uid').value;
    const ok = () => toast('已复制');
    if (navigator.clipboard) navigator.clipboard.writeText(v).then(ok).catch(() => { document.getElementById('oa-uid').select(); document.execCommand('copy'); ok(); });
    else { document.getElementById('oa-uid').select(); document.execCommand('copy'); ok(); }
}
async function viewOpenUid(id) {
    const { data, error } = await sb.rpc('admin_view_open_uid', { p_account: id });
    if (error) return toast(errText(error, '读取失败'), 'error');
    showModal('UID', `
        <div style="display:flex;gap:var(--space-2)">
            <input class="input" id="oa-uid" readonly value="${esc(data)}" style="font-family:monospace;font-size:.8125rem">
            <button class="btn btn-secondary" onclick="copyOpenUid()">复制</button>
        </div>`,
        `<button class="btn btn-primary" onclick="this.closest('.modal-overlay').remove()">关闭</button>`);
}
async function toggleOpenCap(id, col, val) {
    const { error } = await sb.from('open_accounts').update({ [col]: val }).eq('id', id);
    if (error) return toast(errText(error, '操作失败'), 'error');
    renderAdminOpen(document.getElementById('admin-content'));
}
async function toggleOpenStatus(id, status) {
    const { error } = await sb.from('open_accounts').update({ status }).eq('id', id);
    if (error) return toast(errText(error, '操作失败'), 'error');
    toast(status === 'active' ? '已启用' : '已停用');
    renderAdminOpen(document.getElementById('admin-content'));
}
async function deleteOpenAccount(id) {
    if (!confirm('确定删除该开放账号？使用它的第三方将立即失效。')) return;
    const { error } = await sb.from('open_accounts').delete().eq('id', id);
    if (error) return toast(errText(error, '删除失败'), 'error');
    toast('已删除');
    renderAdminOpen(document.getElementById('admin-content'));
}
async function showOpenLogs(id, pubId) {
    const { data: logs } = await sb.from('open_api_logs').select('*').eq('account_id', id).order('created_at', { ascending: false }).limit(20);
    showModal(`调用日志 · ${pubId}（最近 20 条）`, `
        ${(logs || []).map(l => `<div style="padding:var(--space-2) 0;border-bottom:1px solid var(--color-border);font-size:.8125rem">
            <span style="color:${l.ok ? 'var(--color-success)' : 'var(--color-danger)'}">${l.ok ? '✓' : '✗'}</span>
            <b>${esc(l.action)}</b>
            ${l.target_username ? ' · ' + esc(l.target_username) : ''}
            ${l.amount != null ? ' · ' + l.amount : ''}
            ${!l.ok && l.err ? ' · ' + esc(l.err) : ''}
            <span class="text-secondary" style="float:right">${new Date(l.created_at).toLocaleString('zh-CN')}</span>
        </div>`).join('') || '<p class="text-secondary">还没有调用记录。</p>'}`,
        `<button class="btn btn-primary" onclick="this.closest('.modal-overlay').remove()">关闭</button>`);
}

// ==================== 后台：AI 配置 ====================
const AI_SCOPES = [
    { key: 'chat', label: 'AI 客服' },
    { key: 'posts', label: '帖子审核' },
    { key: 'comments', label: '评论审核' },
    { key: 'reports', label: '举报复核' },
];
function parseStandardAnswers(text) {
    return (text || '').split('\n').map(l => l.trim()).filter(Boolean).map(line => {
        const [kw, ans] = line.split('=>');
        if (!ans) return null;
        return { keywords: kw.split(/[,，]/).map(s => s.trim()).filter(Boolean), answer: ans.trim() };
    }).filter(Boolean);
}
function formatStandardAnswers(list) {
    if (!Array.isArray(list)) return '';
    return list.map(x => `${(x.keywords || []).join(',')} => ${x.answer || ''}`).join('\n');
}
async function renderAdminAi(el) {
    const { data: configs } = await sb.from('ai_configs').select('*').order('priority', { ascending: true });
    el.innerHTML = `
        <h2 style="font-size:1.25rem;font-weight:600;margin-bottom:var(--space-4)">AI 配置</h2>
        <p class="text-secondary mb-8" style="font-size:.875rem">支持配置多个模型，按"负责板块"自动分配。密钥使用 pgcrypto 加密存储，前端无法读回明文。需先部署 Edge Function <code>ai</code>。</p>
        <div class="card mb-8">
            <h3 style="font-size:1rem;font-weight:600;margin-bottom:var(--space-4)">新增模型配置</h3>
            <div class="grid-2">
                <div class="form-group"><label class="form-label">配置名称</label><input class="input" id="ai-name" placeholder="例如 主力模型"></div>
                <div class="form-group"><label class="form-label">优先级（数字越小越优先）</label><input class="input" id="ai-priority" type="number" value="10"></div>
            </div>
            <div class="form-group"><label class="form-label">API 地址</label><input class="input" id="ai-url" placeholder="https://api.openai.com/v1 或完整 /chat/completions 地址"></div>
            <div class="grid-2">
                <div class="form-group"><label class="form-label">模型名称</label><input class="input" id="ai-model" placeholder="gpt-4o-mini / qwen-plus / deepseek-chat"></div>
                <div class="form-group"><label class="form-label">温度</label><input class="input" id="ai-temp" type="number" step="0.1" value="0.3"></div>
            </div>
            <div class="form-group"><label class="form-label">API Key（保存后不可查看，只能覆盖）</label><input class="input" id="ai-key" type="password" placeholder="sk-..."></div>
            <div class="form-group"><label class="form-label">客服提示词（AI 客服）</label><textarea class="textarea" id="ai-prompt" rows="3" placeholder="你是 66qn 服务器的客服助手，用简洁友好的中文回答玩家问题…"></textarea></div>
            <div class="form-group"><label class="form-label">帖子审核提示词 <span class="text-tertiary">(留空则用内置默认)</span></label>
                <textarea class="textarea" id="ai-prompt-post" rows="2" placeholder="例如：对广告和引战内容从严，正常讨论一律通过"></textarea>
                <p class="text-tertiary" style="margin-top:.35rem;font-size:.75rem">只需写判断标准，系统会自动追加固定输出格式，返回 pass（通过）或 reject（打回）。</p></div>
            <div class="form-group"><label class="form-label">评论审核提示词 <span class="text-tertiary">(留空则用内置默认)</span></label>
                <textarea class="textarea" id="ai-prompt-comment" rows="2" placeholder="例如：短评、语气词一律通过，辱骂和刷屏打回"></textarea></div>
            <div class="form-group"><label class="form-label">举报复核提示词 <span class="text-tertiary">(留空则用内置默认)</span></label>
                <textarea class="textarea" id="ai-prompt-report" rows="2" placeholder="例如：证据不足时倾向保留，仅明显违规才删除"></textarea></div>
            <div class="form-group"><label class="form-label">标准回答（每行一条，格式：关键词1,关键词2 => 回答）</label>
                <textarea class="textarea" id="ai-std" rows="3" placeholder="服务器地址,ip,怎么进 => 服务器地址是 66qnmc.top，端口 25565"></textarea></div>
            <div class="form-group"><label class="form-label">负责板块</label>
                <div class="flex" style="gap:1rem;flex-wrap:wrap">${AI_SCOPES.map(s => `<label class="flex-center" style="gap:.35rem"><input type="checkbox" class="ai-scope" value="${s.key}" ${s.key === 'chat' ? 'checked' : ''}> ${s.label}</label>`).join('')}</div></div>
            <label class="flex-center" style="gap:.35rem;margin-bottom:1rem"><input type="checkbox" id="ai-enabled" checked> 启用</label>
            <button class="btn btn-primary" onclick="saveAiConfig()">保存配置</button>
        </div>
        <h3 style="font-size:1rem;font-weight:600;margin-bottom:var(--space-4)">已配置模型</h3>
        <div class="card" style="padding:0;overflow:auto">
            <table class="data-table">
                <thead><tr><th>名称</th><th>模型</th><th>负责板块</th><th>优先级</th><th>状态</th><th>操作</th></tr></thead>
                <tbody>${(configs || []).map(c => `
                    <tr>
                        <td>${esc(c.name)}</td>
                        <td>${esc(c.model || '-')}</td>
                        <td>${(Array.isArray(c.scopes) ? c.scopes : String(c.scopes || '').replace(/[{}]/g, '').split(',')).filter(Boolean).map(s => esc(s)).join('、') || '-'}</td>
                        <td>${c.priority}</td>
                        <td><span class="badge ${c.enabled ? 'badge-green' : 'badge-gray'}">${c.enabled ? '启用' : '停用'}</span></td>
                        <td>
                            <button class="btn btn-ghost btn-sm" onclick="editAiConfig('${c.id}')">编辑</button>
                            <button class="btn btn-ghost btn-sm" onclick="testAiConfig('${c.id}')">测试</button>
                            <button class="btn btn-ghost btn-sm" onclick="toggleAiConfig('${c.id}',${c.enabled ? 'false' : 'true'})">${c.enabled ? '停用' : '启用'}</button>
                            <button class="btn btn-ghost btn-sm" onclick="deleteAiConfig('${c.id}')">删除</button>
                        </td>
                    </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--color-text-tertiary)">还没有配置模型</td></tr>'}</tbody>
            </table>
        </div>`;
    draftBind('ai', ['ai-name', 'ai-priority', 'ai-url', 'ai-model', 'ai-temp', 'ai-prompt', 'ai-prompt-post', 'ai-prompt-comment', 'ai-prompt-report', 'ai-std', 'ai-key', 'ai-enabled']);
}
async function saveAiConfig() {
    const scopes = Array.from(document.querySelectorAll('.ai-scope:checked')).map(x => x.value);
    const payload = {
        name: document.getElementById('ai-name').value.trim(),
        api_url: document.getElementById('ai-url').value.trim(),
        model: document.getElementById('ai-model').value.trim(),
        prompt: document.getElementById('ai-prompt').value.trim(),
        prompt_post: document.getElementById('ai-prompt-post').value.trim(),
        prompt_comment: document.getElementById('ai-prompt-comment').value.trim(),
        prompt_report: document.getElementById('ai-prompt-report').value.trim(),
        standard_answers: parseStandardAnswers(document.getElementById('ai-std').value),
        scopes, priority: parseInt(document.getElementById('ai-priority').value) || 10,
        temperature: Number(document.getElementById('ai-temp').value) || 0.3,
        enabled: document.getElementById('ai-enabled').checked,
    };
    if (!payload.name) return toast('请填写配置名称', 'error');
    if (!payload.api_url) return toast('请填写 API 地址', 'error');
    if (!scopes.length) return toast('请至少选择一个负责板块', 'error');
    const { data, error } = await sb.from('ai_configs').insert(payload).select().maybeSingle();
    if (error) return toast(errText(error, '保存失败'), 'error');
    const key = document.getElementById('ai-key').value.trim();
    if (key) {
        const { error: kerr } = await sb.rpc('admin_set_ai_key', { p_config: data.id, p_key: key });
        if (kerr) toast('配置已保存，但密钥写入失败：' + kerr.message, 'error');
    }
    toast('AI 配置已保存');
    draftClear('ai');
    renderAdminAi(document.getElementById('admin-content'));
}
async function toggleAiConfig(id, enabled) {
    await sb.from('ai_configs').update({ enabled }).eq('id', id);
    toast('已更新'); renderAdminAi(document.getElementById('admin-content'));
}

// 编辑已有模型配置
async function editAiConfig(id) {
    const { data: c } = await sb.from('ai_configs').select('*').eq('id', id).maybeSingle();
    if (!c) return;
    const scopes = Array.isArray(c.scopes) ? c.scopes : String(c.scopes || '').replace(/[{}]/g, '').split(',').map(s => s.trim()).filter(Boolean);
    showModal('编辑模型配置', `
        <div class="grid-2">
            <div class="form-group"><label class="form-label">配置名称</label><input class="input" id="ea-name" value="${esc(c.name || '')}"></div>
            <div class="form-group"><label class="form-label">优先级（数字越小越优先）</label><input class="input" id="ea-priority" type="number" value="${c.priority ?? 10}"></div>
        </div>
        <div class="form-group"><label class="form-label">API 地址</label><input class="input" id="ea-url" value="${esc(c.api_url || '')}"></div>
        <div class="grid-2">
            <div class="form-group"><label class="form-label">模型名称</label><input class="input" id="ea-model" value="${esc(c.model || '')}"></div>
            <div class="form-group"><label class="form-label">温度</label><input class="input" id="ea-temp" type="number" step="0.1" value="${c.temperature ?? 0.3}"></div>
        </div>
        <div class="form-group"><label class="form-label">API Key <span class="text-tertiary">(留空表示不修改)</span></label><input class="input" id="ea-key" type="password" placeholder="不填则保持原密钥不变"></div>
        <div class="form-group"><label class="form-label">客服提示词（AI 客服）</label><textarea class="textarea" id="ea-prompt" rows="3">${esc(c.prompt || '')}</textarea></div>
        <div class="form-group"><label class="form-label">帖子审核提示词</label><textarea class="textarea" id="ea-prompt-post" rows="2" placeholder="留空则用内置默认">${esc(c.prompt_post || '')}</textarea></div>
        <div class="form-group"><label class="form-label">评论审核提示词</label><textarea class="textarea" id="ea-prompt-comment" rows="2" placeholder="留空则用内置默认">${esc(c.prompt_comment || '')}</textarea></div>
        <div class="form-group"><label class="form-label">举报复核提示词</label><textarea class="textarea" id="ea-prompt-report" rows="2" placeholder="留空则用内置默认">${esc(c.prompt_report || '')}</textarea></div>
        <div class="form-group"><label class="form-label">标准回答（每行一条：关键词1,关键词2 => 回答）</label>
            <textarea class="textarea" id="ea-std" rows="3">${esc(formatStandardAnswers(c.standard_answers))}</textarea></div>
        <div class="form-group"><label class="form-label">负责板块</label>
            <div class="flex" style="gap:1rem;flex-wrap:wrap">${AI_SCOPES.map(s => `<label class="flex-center" style="gap:.35rem"><input type="checkbox" class="ai-scope-ed" value="${s.key}" ${scopes.includes(s.key) ? 'checked' : ''}> ${s.label}</label>`).join('')}</div></div>
        <label class="flex-center" style="gap:.35rem"><input type="checkbox" id="ea-enabled" ${c.enabled ? 'checked' : ''}> 启用</label>`,
        `<button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">取消</button>
         <button class="btn btn-primary" onclick="updateAiConfig('${id}')">保存修改</button>`);
}

async function updateAiConfig(id) {
    const scopes = Array.from(document.querySelectorAll('.ai-scope-ed:checked')).map(x => x.value);
    const payload = {
        name: document.getElementById('ea-name').value.trim(),
        api_url: document.getElementById('ea-url').value.trim(),
        model: document.getElementById('ea-model').value.trim(),
        prompt: document.getElementById('ea-prompt').value.trim(),
        prompt_post: document.getElementById('ea-prompt-post').value.trim(),
        prompt_comment: document.getElementById('ea-prompt-comment').value.trim(),
        prompt_report: document.getElementById('ea-prompt-report').value.trim(),
        standard_answers: parseStandardAnswers(document.getElementById('ea-std').value),
        scopes,
        priority: parseInt(document.getElementById('ea-priority').value) || 10,
        temperature: Number(document.getElementById('ea-temp').value) || 0.3,
        enabled: document.getElementById('ea-enabled').checked,
    };
    if (!payload.name) return toast('请填写配置名称', 'error');
    if (!payload.api_url) return toast('请填写 API 地址', 'error');
    if (!scopes.length) return toast('请至少选择一个负责板块', 'error');
    const { error } = await sb.from('ai_configs').update(payload).eq('id', id);
    if (error) return toast(errText(error, '保存失败'), 'error');
    const key = document.getElementById('ea-key').value.trim();
    if (key) {
        const { error: kerr } = await sb.rpc('admin_set_ai_key', { p_config: id, p_key: key });
        if (kerr) return toast('配置已保存，但密钥更新失败：' + kerr.message, 'error');
    }
    document.querySelector('.modal-overlay')?.remove();
    toast('已保存修改');
    renderAdminAi(document.getElementById('admin-content'));
}
async function deleteAiConfig(id) {
    if (!confirm('确定删除该 AI 配置？')) return;
    await sb.from('ai_configs').delete().eq('id', id);
    toast('已删除'); renderAdminAi(document.getElementById('admin-content'));
}
async function testAiConfig(id) {
    toast('正在测试…');
    const { data, error } = await sb.functions.invoke(AI_FN, { body: { action: 'chat', message: '你好，请回复“测试成功”' } });
    if (error || data?.error) return toast('测试失败：' + (error?.message || data?.error), 'error');
    toast('测试成功：' + String(data.reply || '').slice(0, 40));
}

// ==================== 后台：协议设置 ====================
async function renderAdminAgreement(el) {
    const { data } = await sb.from('server_settings').select('value').eq('key', 'legal').maybeSingle();
    const v = data?.value || {};
    el.innerHTML = `
        <h2 style="font-size:1.25rem;font-weight:600;margin-bottom:var(--space-6)">协议设置</h2>
        <div class="card">
            <div class="form-group"><label class="form-label">协议标题</label><input class="input" id="ag-title" value="${esc(v.agreement_title || '服务协议与免责声明')}"></div>
            <div class="form-group"><label class="form-label">协议正文</label><textarea class="textarea" id="ag-text" rows="12" style="min-height:260px">${esc(v.agreement_text || defaultAgreement())}</textarea></div>
            <label class="flex-center" style="gap:.35rem;margin-bottom:1rem"><input type="checkbox" id="ag-required" ${v.agreement_required !== false ? 'checked' : ''}> 首次访问必须同意后才能使用</label>
            <button class="btn btn-primary" onclick="saveAgreement()">保存协议</button>
        </div>`;
    draftBind('agreement', ['ag-title', 'ag-text', 'ag-required']);
}
async function saveAgreement() {
    const { data } = await sb.from('server_settings').select('value').eq('key', 'legal').maybeSingle();
    const value = { ...(data?.value || {}), agreement_title: document.getElementById('ag-title').value.trim(), agreement_text: document.getElementById('ag-text').value, agreement_required: document.getElementById('ag-required').checked };
    const { error } = await sb.from('server_settings').upsert({ key: 'legal', value, updated_at: new Date().toISOString() });
    if (error) return toast(errText(error, '保存失败'), 'error');
    AGREEMENT_TEXT = null;
    draftClear('agreement');
    toast('协议已保存');
}

async function renderAdminServer(el) {
    const info = await Settings.load(true);
    const s = info.server || {};
    el.innerHTML = `
        <h2 style="font-size:1.25rem;font-weight:600;margin-bottom:var(--space-6)">服务器设置</h2>
        <div class="card">
            <div class="form-group"><label class="form-label">服务器名称</label><input class="input" id="si-name" value="${esc(s.name || '')}"></div>
            <div class="form-group"><label class="form-label">服务器地址 (IP)</label><input class="input" id="si-ip" value="${esc(s.ip || '')}"></div>
            <div class="grid-2">
                <div class="form-group"><label class="form-label">端口</label><input class="input" id="si-port" value="${esc(s.port || '25565')}"></div>
                <div class="form-group"><label class="form-label">版本</label><input class="input" id="si-version" value="${esc(s.version || '')}"></div>
            </div>
            <div class="grid-2">
                <div class="form-group"><label class="form-label">在线人数</label><input class="input" id="si-online" type="number" value="${s.players || 0}"></div>
                <div class="form-group"><label class="form-label">最大人数</label><input class="input" id="si-max" type="number" value="${s.maxPlayers || 20}"></div>
            </div>
            <div class="form-group"><label class="form-label">服务器描述 (MOTD)</label><textarea class="textarea" id="si-motd" rows="3">${esc(s.motd || '')}</textarea></div>
            <button class="btn btn-primary" onclick="saveServerInfo()">保存</button>
        </div>`;
    draftBind('server', ['si-name', 'si-ip', 'si-port', 'si-version', 'si-online', 'si-max', 'si-motd']);
}

async function saveServerInfo() {
    const value = {
        name: document.getElementById('si-name').value.trim(),
        ip: document.getElementById('si-ip').value.trim(),
        port: document.getElementById('si-port').value.trim(),
        version: document.getElementById('si-version').value.trim(),
        players: parseInt(document.getElementById('si-online').value) || 0,
        maxPlayers: parseInt(document.getElementById('si-max').value) || 20,
        motd: document.getElementById('si-motd').value.trim(),
    };
    const { error } = await sb.from('server_settings').upsert({ key: 'server', value, updated_at: new Date().toISOString() });
    if (error) return toast(errText(error, '保存失败'), 'error');
    Settings.cache = null;
    toast('服务器信息已保存');
    draftClear('server');
}

// ==================== 404 ====================
function render404(app) {
    app.innerHTML = `
    <div style="text-align:center;padding:var(--space-20) var(--space-6)">
        <h1 style="font-size:3rem;font-weight:700;color:var(--color-text-tertiary)">404</h1>
        <p class="text-secondary" style="margin-top:var(--space-4)">页面不存在</p>
        <a href="#/" class="btn btn-primary" style="margin-top:var(--space-6)">返回首页</a>
    </div>`;
}

// ==================== 启动 ====================
if (location.protocol === 'file:') {
    document.getElementById('app').innerHTML = '<div class="container" style="padding:var(--space-16);text-align:center"><p class="text-secondary">请通过本地服务器或线上域名访问本页面（不要直接双击打开）。</p></div>';
} else {
    APP.init();
}
