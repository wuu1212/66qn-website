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
        this.updateNavbar();
        if (!sb) return;
        // OAuth 回调可能先返回 code，再由 SDK 换取 session；必须在首次路由前处理。
        const callbackError = new URLSearchParams(location.search).get('error_description');
        if (callbackError) {
            history.replaceState({}, document.title, location.pathname);
            setTimeout(() => toast('GitHub 登录失败：' + callbackError, 'error'), 0);
        }
        await this.loadSession();
        sb.auth.onAuthStateChange(async (event, session) => {
            if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') {
                if (session) {
                    await this.loadProfile(session.user.id);
                    if (location.hash === '#/login' || location.hash === '#/register' || !location.hash) location.hash = '#/';
                    else this.route();
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

        if (!CONFIGURED && route !== '/login' && route !== '/register') {
            app.innerHTML = `<div class="container" style="padding:var(--space-16) var(--space-6);text-align:center">
                <h2 class="section-title">还没完成 Supabase 配置</h2>
                <p class="text-secondary">请编辑 <code>frontend/config.js</code>，把 SUPABASE_ANON_KEY 换成你的 anon 公开密钥。</p></div>`;
            return;
        }

        switch (route) {
            case '/': renderHome(app); break;
            case '/launcher': renderLauncher(app); break;
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
            case '/profile': renderProfile(app, params[0] || (this.user && this.user.id)); break;
            case '/admin':
                if (!this.isAdmin) { toast('需要管理员权限', 'error'); location.hash = '#/'; return; }
                renderAdmin(app, params[0] || 'dashboard');
                break;
            default: render404(app);
        }
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

// ==================== 工具函数 ====================
function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
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
        <a href="#/launcher" class="nav-link" onclick="toggleMobileNav()">启动器</a>
        <a href="#/forum" class="nav-link" onclick="toggleMobileNav()">社区</a>
        <a href="#/messages" class="nav-link" onclick="toggleMobileNav()">私信</a>
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
async function renderHome(app) {
    app.innerHTML = `<div class="container"><div style="padding:var(--space-16) 0;text-align:center;color:var(--color-text-tertiary)">加载中…</div></div>`;
    const info = await Settings.load();
    const s = info.server || {};
    const site = info.site || {};

    app.innerHTML = `
    <div class="container">
        <section class="hero">
            <h1 class="hero-title">${esc(site.title || '66qn')}</h1>
            <p class="hero-subtitle">${esc(site.slogan || '纯净原版生存 · 回归游戏本真')}</p>
            <div class="hero-actions">
                <button class="btn btn-primary btn-lg" onclick="copyAddress()">复制服务器地址</button>
                <a href="#/launcher" class="btn btn-secondary btn-lg">下载启动器</a>
            </div>
        </section>
        <section class="section" style="padding-top:0">
            <div class="status-cards">
                <div class="card status-card">
                    <div class="status-card-value">${esc(s.version || '—')}</div>
                    <div class="status-card-label">游戏版本</div>
                </div>
                <div class="card status-card">
                    <div class="status-card-value">${(s.players != null ? s.players : 0)}/${esc(s.maxPlayers || 20)}</div>
                    <div class="status-card-label">在线人数</div>
                </div>
                <div class="card status-card">
                    <div class="status-card-value" style="font-size:1rem;word-break:break-all">${esc(s.ip || '待填写')}:${esc(s.port || '25565')}</div>
                    <div class="status-card-label">服务器地址</div>
                </div>
            </div>
        </section>
        <section class="section">
            <h2 class="section-title text-center">玩法特色</h2>
            <div class="grid-4">
                <div class="card feature-card"><div class="feature-icon">${icons.cube}</div><h3>纯净原版</h3><p>不添加任何模组和插件，保留 Minecraft 最原汁原味的生存体验。</p></div>
                <div class="card feature-card"><div class="feature-icon">${icons.heart}</div><h3>友善社区</h3><p>玩家之间互帮互助，共同打造一个温暖的游戏社区。</p></div>
                <div class="card feature-card"><div class="feature-icon">${icons.shield}</div><h3>长期稳定</h3><p>服务器 7x24 小时运行，数据定期备份，永不删档。</p></div>
                <div class="card feature-card"><div class="feature-icon">${icons.users}</div><h3>自由建造</h3><p>广阔的世界等你探索，建造属于你的梦想家园。</p></div>
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
            </div>
        </section>
    </div>`;
}

async function copyAddress() {
    const info = await Settings.load();
    const s = info.server || {};
    const addr = (s.ip || '') + ':' + (s.port || '25565');
    navigator.clipboard.writeText(addr).then(() => toast('地址已复制到剪贴板'));
}

// ==================== 页面：启动器 ====================
function renderLauncher(app) {
    app.innerHTML = `
    <div class="container" style="max-width:640px;margin:0 auto;padding:var(--space-16) var(--space-6)">
        <h1 class="section-title" style="font-size:1.875rem">启动器下载</h1>
        <p class="text-secondary mb-8">选择适合你的启动器来加入 66qn 服务器。以下链接均跳转到各启动器的官方下载页面。</p>
        <div style="display:flex;flex-direction:column;gap:var(--space-4)">
            <div class="card launcher-card">
                <div class="launcher-info">
                    <h3>HMCL <span class="text-tertiary" style="font-weight:400">(Hello Minecraft! Launcher)</span></h3>
                    <p>跨平台、功能丰富的 Java 版启动器，支持多版本管理、微软账户登录、模组加载器。</p>
                    <div class="launcher-tags"><span class="badge badge-blue">推荐</span><span class="badge badge-gray">Windows</span><span class="badge badge-gray">macOS</span><span class="badge badge-gray">Linux</span></div>
                </div>
                <a href="https://hmcl.huangyuhui.net/download/" target="_blank" rel="noopener" class="btn btn-primary" style="flex-shrink:0">${icons.download} 前往下载</a>
            </div>
            <div class="card launcher-card">
                <div class="launcher-info">
                    <h3>FCL <span class="text-tertiary" style="font-weight:400">(Fold Craft Launcher)</span></h3>
                    <p>安卓专属启动器，触屏优化，支持在手机上运行 Minecraft Java 版。</p>
                    <div class="launcher-tags"><span class="badge badge-gray">Android</span><span class="badge badge-gray">开源</span></div>
                </div>
                <a href="https://github.com/FCL-Team/FoldCraftLauncher/releases" target="_blank" rel="noopener" class="btn btn-secondary" style="flex-shrink:0">${icons.download} 前往下载</a>
            </div>
            <div class="card launcher-card">
                <div class="launcher-info">
                    <h3>PCL <span class="text-tertiary" style="font-weight:400">(Plain Craft Launcher 2)</span></h3>
                    <p>Windows 平台启动器，界面简洁，操作高效，国内开发者维护。</p>
                    <div class="launcher-tags"><span class="badge badge-gray">Windows</span><span class="badge badge-gray">免费</span></div>
                </div>
                <a href="https://github.com/Meloong-Git/PCL/releases" target="_blank" rel="noopener" class="btn btn-secondary" style="flex-shrink:0">${icons.download} 前往下载</a>
            </div>
        </div>
        <div class="disclaimer"><strong>免责声明</strong><br>以上启动器均为第三方开发的 Minecraft 启动工具，与本站无关。上述链接仅跳转到各启动器的官方网站或 GitHub Releases 页面，本站不提供任何启动器文件的直接下载。请从官方渠道下载以确保安全。使用第三方启动器所产生的任何风险由用户自行承担。</div>
    </div>`;
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
    if (!requireLogin()) return;
    const input = document.getElementById('comment-input');
    const content = input.value.trim();
    if (!content) return toast('请输入评论内容', 'error');
    if (content.length > 2000) return toast('评论不能超过2000字', 'error');
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
    const reason = document.getElementById('report-reason').value.trim();
    if (reason.length < 10) return toast('举报理由至少需要10个字符', 'error');
    const { error } = await sb.from('reports').insert({ reporter_id: APP.user.id, target_type: type, target_id: id, reason });
    if (error) return toast(errText(error, '举报失败'), 'error');
    document.querySelector('.modal-overlay')?.remove();
    toast('举报已提交，管理员将尽快处理');
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
    if (!requireLogin()) return;
    const title = document.getElementById('post-title').value.trim();
    const content = document.getElementById('post-content').value.trim();
    const category = document.getElementById('post-category').value;
    if (title.length < 5) return toast('标题至少5个字符', 'error');
    if (content.length < 10) return toast('正文至少10个字符', 'error');
    const { error } = await sb.from('posts').insert({ user_id: APP.user.id, title, content, category });
    if (error) return toast(errText(error, '发布失败'), 'error');
    toast('帖子已发布');
    location.hash = '#/forum';
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
function renderLogin(app) {
    app.innerHTML = `
    <div class="auth-page page-enter">
        <h1 class="auth-title">登录</h1>
        <p class="auth-subtitle">欢迎回到 66qn 服务器</p>
        <button class="github-btn" onclick="githubLogin()">${icons.github} 使用 GitHub 登录</button>
        <div class="auth-divider">或</div>
        <div class="form-group"><label class="form-label">邮箱</label>
            <input class="input" id="login-email" type="email" placeholder="your@email.com"></div>
        <div class="form-group"><label class="form-label">密码</label>
            <input class="input" id="login-password" type="password" placeholder="输入密码"></div>
        <button class="btn btn-primary btn-lg" style="width:100%" onclick="doLogin()">登录</button>
        <p class="auth-link">还没有账号？<a href="#/register">注册</a></p>
    </div>`;
}

async function doLogin() {
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    if (!email || !password) return toast('请填写邮箱和密码', 'error');
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) return toast('邮箱或密码错误', 'error');
    await APP.loadProfile((await sb.auth.getUser()).data.user.id);
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
        <button class="github-btn" onclick="githubLogin()">${icons.github} 使用 GitHub 注册</button>
        <div class="auth-divider">或</div>
        <div class="form-group"><label class="form-label">用户名 <span class="text-tertiary">(3-20字符)</span></label>
            <input class="input" id="reg-username" placeholder="你的用户名" maxlength="20"></div>
        <div class="form-group"><label class="form-label">邮箱</label>
            <input class="input" id="reg-email" type="email" placeholder="your@email.com"></div>
        <div class="form-group"><label class="form-label">密码 <span class="text-tertiary">(至少6位)</span></label>
            <input class="input" id="reg-password" type="password" placeholder="设置密码"></div>
        <button class="btn btn-primary btn-lg" style="width:100%" onclick="doRegister()">注册</button>
        <p class="auth-link">已有账号？<a href="#/login">登录</a></p>
    </div>`;
}

async function doRegister() {
    const username = document.getElementById('reg-username').value.trim();
    const email = document.getElementById('reg-email').value.trim();
    const password = document.getElementById('reg-password').value;
    if (username.length < 3 || username.length > 20) return toast('用户名需3-20个字符', 'error');
    if (!email.includes('@')) return toast('请输入有效的邮箱地址', 'error');
    if (password.length < 6) return toast('密码至少6位', 'error');

    const { data, error } = await sb.auth.signUp({ email, password, options: { data: { username } } });
    if (error) return toast(errText(error, '注册失败'), 'error');
    if (data.session) {
        await APP.loadProfile(data.user.id);
        toast('注册成功，欢迎！');
        location.hash = '#/';
    } else {
        toast('注册成功！请前往邮箱完成验证', 'success');
        location.hash = '#/login';
    }
}

// ==================== 页面：个人主页 ====================
async function renderProfile(app, userId) {
    if (!userId) { location.hash = '#/login'; return; }
    app.innerHTML = `<div class="container" style="max-width:640px;margin:0 auto;padding:var(--space-8) var(--space-6)">${loadingBlock()}</div>`;
    const { data: user } = await sb.from('profiles').select('*').eq('id', userId).maybeSingle();
    if (!user) { app.innerHTML = '<div class="container" style="padding:var(--space-16);text-align:center">用户不存在</div>'; return; }
    const { data: posts } = await sb.from('posts').select('*').eq('user_id', userId).eq('status', 'published').order('created_at', { ascending: false });
    const isMe = APP.user && APP.user.id === userId;

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
            <div class="form-group"><label class="form-label">个人简介</label>
                <textarea class="textarea" id="my-bio" rows="2" maxlength="200">${esc(user.bio || '')}</textarea></div>
            <button class="btn btn-primary btn-sm" onclick="saveBio()">保存简介</button>
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
}

async function saveBio() {
    const bio = document.getElementById('my-bio').value.trim();
    const { error } = await sb.from('profiles').update({ bio }).eq('id', APP.user.id);
    if (error) return toast(errText(error, '保存失败'), 'error');
    APP.user.bio = bio;
    toast('简介已保存');
}

// ==================== 页面：管理后台 ====================
async function renderAdmin(app, sub) {
    const navItems = [
        { key: 'dashboard', label: '仪表盘', icon: icons.dashboard },
        { key: 'users', label: '用户管理', icon: icons.users },
        { key: 'posts', label: '帖子管理', icon: icons.message },
        { key: 'comments', label: '评论管理', icon: icons.message },
        { key: 'reports', label: '举报管理', icon: icons.flag },
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
                <thead><tr><th>用户名</th><th>角色</th><th>状态</th><th>注册时间</th><th>操作</th></tr></thead>
                <tbody>${(users || []).map(u => `
                    <tr>
                        <td><div class="flex-center" style="gap:8px">${avatarHtml(u, 24)}<a href="#/profile/${u.id}" style="color:var(--color-text)">${esc(u.username)}</a></div></td>
                        <td><span class="badge ${u.role === 'admin' ? 'badge-blue' : 'badge-gray'}">${u.role}</span></td>
                        <td><span class="badge ${u.status === 'active' ? 'badge-green' : 'badge-red'}">${u.status === 'active' ? '正常' : '已封禁'}</span></td>
                        <td class="text-tertiary">${timeAgo(u.created_at)}</td>
                        <td>${u.id !== APP.user.id ? `
                            <button class="btn btn-ghost btn-sm" onclick="adminToggleBan('${u.id}','${u.status}')">${u.status === 'active' ? '封禁' : '解封'}</button>
                            <button class="btn btn-ghost btn-sm" onclick="adminSetRole('${u.id}','${u.role === 'admin' ? 'user' : 'admin'}')">${u.role === 'admin' ? '取消管理' : '设为管理'}</button>` : '<span class="text-tertiary">本人</span>'}
                        </td>
                    </tr>`).join('')}</tbody>
            </table>
        </div>`;
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
                        <td><button class="btn btn-ghost btn-sm" onclick="deleteComment('${c.id}');renderAdminComments(document.getElementById('admin-content'))">删除</button></td>
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
                            <button class="btn btn-ghost btn-sm" onclick="resolveReport('${r.id}','resolved')">处理</button>
                            <button class="btn btn-ghost btn-sm" onclick="resolveReport('${r.id}','dismissed')">驳回</button>` : '-'}</td>
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
