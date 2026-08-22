const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

const FILES_DIR = '/files';
const DATA_DIR = '/data';
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_PATH = process.env.ADMIN_PATH || crypto.randomBytes(6).toString('hex');
const PORT = 8000;
const DEBOUNCE_MS = 500;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ files: [], downloads: [] }));

function loadData() { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }
function fmtSize(s) { return s < 1048576 ? (s/1024).toFixed(1)+' KB' : (s/1048576).toFixed(1)+' MB'; }

// ---------- 解析 expire_at（北京时间字符串 YYYY-MM-DD HH:mm:ss）----------
function parseExpireAt(str) {
    if (!str) return null;
    try {
        const iso = str.replace(' ', 'T') + '+08:00';
        const d = new Date(iso);
        return isNaN(d.getTime()) ? null : d;
    } catch (e) { return null; }
}
// 当前北京时间（用于判断过期/次数）
function nowBJT() { return new Date(Date.now() + 8*3600000); }

// ---------- 读取文件配套 meta ----------
function readMeta(filepath) {
    const metaPath = filepath + '.meta.json';
    if (!fs.existsSync(metaPath)) return {};
    try {
        return JSON.parse(fs.readFileSync(metaPath, 'utf8')) || {};
    } catch (e) { return {}; }
}
function writeMeta(filepath, meta) {
    const metaPath = filepath + '.meta.json';
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

// ---------- 扫描 + 清理 ----------
function scanFiles() {
    if (!fs.existsSync(FILES_DIR)) return;
    const data = loadData();
    const existing = new Set(data.files.map(f => f.filepath));
    const validIds = new Set();
    fs.readdirSync(FILES_DIR, { withFileTypes: true }).forEach(entry => {
        if (entry.name.startsWith('.')) return;
        if (entry.name.startsWith('_')) return;
        if (!entry.isFile()) return;
        const fp = path.join(FILES_DIR, entry.name);
        validIds.add(fp);
        if (!existing.has(fp)) {
            try {
                const stat = fs.statSync(fp);
                data.files.push({
                    id: crypto.randomBytes(4).toString('hex'),
                    filename: entry.name, filepath: fp,
                    filesize: stat.size, download_count: 0,
                    status: 'active'
                });
            } catch (e) {}
        }
    });
    // 将不存在的文件标记 deleted（保留日志），不删记录
    data.files.forEach(f => {
        if (!validIds.has(f.filepath) && f.status === 'active') {
            f.status = 'deleted';
            // 同步删除配套 meta
            try { fs.unlinkSync(f.filepath + '.meta.json'); } catch (e) {}
        }
    });
    saveData(data);
}

function cleanExpiredAndOverQuota() {
    const data = loadData();
    data.files.forEach(f => {
        if (f.status !== 'active') return;
        if (!fs.existsSync(f.filepath)) { f.status = 'deleted'; return; }
        const meta = readMeta(f.filepath);
        // 过期
        const exp = parseExpireAt(meta.expire_at);
        if (exp && exp.getTime() <= nowBJT().getTime()) {
            moveToExpired(f);
            return;
        }
        // 次数用尽
        if (meta.max_downloads && f.download_count >= meta.max_downloads) {
            moveToExpired(f);
        }
    });
    saveData(data);
}
function moveToExpired(f) {
    const expiredDir = path.join(FILES_DIR, '_expired');
    try {
        if (!fs.existsSync(expiredDir)) fs.mkdirSync(expiredDir, { recursive: true });
        const dest = path.join(expiredDir, path.basename(f.filepath));
        fs.renameSync(f.filepath, dest);
        try { fs.renameSync(f.filepath + '.meta.json', dest + '.meta.json'); } catch (e) {}
        f.status = 'expired';
    } catch (e) {}
}

// ---------- 渲染首页 ----------
function renderIndex() {
    scanFiles();
    cleanExpiredAndOverQuota();
    const data = loadData();
    const active = data.files.filter(f => f.status === 'active');
    let content = '';
    if (active.length === 0) {
        content = '<div class="container"><div class="icon">📂</div><h1>暂无分享文件</h1><p class="size">请把文件放到 files 目录</p></div>';
    } else if (active.length === 1) {
        const f = active[0];
        const meta = readMeta(f.filepath);
        const tags = buildStatusTags(meta, f);
        content = `<div class="container">
            <div class="icon">📄</div>
            <h1>${f.filename}</h1>
            <p class="size">${fmtSize(f.filesize)}</p>
            ${tags}
            <div class="count">已下载 ${f.download_count} 次</div><br>
            ${downloadActionHtml(f, meta)}
            <p class="footer">COUNTSHARE</p>
        </div>`;
    } else {
        const items = active.map(f => {
            const meta = readMeta(f.filepath);
            const tags = buildStatusTags(meta, f);
            return `<div class="item">
                <div class="ico">📄</div>
                <div class="info"><div class="name">${f.filename}</div><div class="meta">${fmtSize(f.filesize)} · 已下载 ${f.download_count} 次 ${tags}</div></div>
                ${downloadActionHtml(f, meta)}
            </div>`;
        }).join('');
        content = `<div class="container" style="max-width:600px;padding:40px 32px"><h1 style="margin-bottom:24px">文件分享</h1><div class="multi-list">${items}</div></div>`;
    }
    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    return html
        .replace('{{PAGE_TITLE}}', active.length === 1 ? active[0].filename : 'CountShare')
        .replace('{{PAGE_CONTENT}}', content);
}

function buildStatusTags(meta, f) {
    let tags = '';
    if (meta.expire_at) tags += `<span class="tag">⏳ 有效至 ${meta.expire_at.replace(':00+08:00','').replace('T',' ')}</span>`;
    if (meta.max_downloads) tags += `<span class="tag">📊 限制下载 ${meta.max_downloads} 次</span>`;
    if (meta.password) tags += `<span class="tag">🔒 需要密码</span>`;
    return tags ? `<div class="tags">${tags}</div>` : '';
}

// 下载按钮：有密码时首页用弹窗（fetch），无密码时直接跳 /d/:id
function downloadActionHtml(f, meta) {
    if (meta.password) {
        return `<button class="btn" onclick="openPwd('${f.id}','${f.filename}')">下载文件</button>`;
    }
    return `<a class="btn" href="/d/${f.id}">下载文件</a>`;
}

// ---------- 渲染管理页 ----------
function renderAdmin() {
    scanFiles();
    cleanExpiredAndOverQuota();
    const data = loadData();
    const fileRows = data.files.length === 0 ? '<p class="empty">暂无文件</p>' :
        `<table><tr><th>文件名</th><th>大小</th><th>下载次数</th><th>状态</th><th>有效期</th><th>密码</th><th>操作</th>${data.files.map(f => {
            const meta = readMeta(f.filepath);
            const statusText = f.status === 'active' ? '正常' : (f.status === 'expired' ? '<span class="red">已过期/用尽</span>' : '<span class="red">已删除</span>');
            const expText = meta.expire_at ? meta.expire_at.replace(':00+08:00','').replace('T',' ') : '无';
            const pwdText = meta.password ? '🔒 已设' : '无';
            const logBtn = `<button class="linkbtn" onclick="filterLog('${f.id}')">📋 日志</button>`;
            const setBtn = f.status === 'active' ? `<button class="linkbtn" onclick="openSet('${f.id}')">⚙ 设置</button>` : '';
            return `<tr><td>${f.filename}</td><td>${fmtSize(f.filesize)}</td><td>${f.download_count}</td><td>${statusText}</td><td>${expText}</td><td>${pwdText}</td><td>${setBtn} ${logBtn}</td></tr>`;
        }).join('')}</table>`;
    const logRows = data.downloads.length === 0 ? '<p class="empty">暂无下载记录</p>' :
        `<table id="logtable"><tr><th>时间</th><th>文件</th><th>IP</th><th>浏览器</th>${data.downloads.slice().reverse().map(l => {
            const f = data.files.find(x => x.id === l.file_id);
            const fname = f ? f.filename : '?';
            const cls = (f && f.status !== 'active') ? 'red' : '';
            return `<tr data-fid="${l.file_id||''}" class="${cls}"><td>${l.timestamp}</td><td class="${cls}">${fname}${f && f.status!=='active'?' ['+(f.status==='deleted'?'已删除':'已过期')+']':''}</td><td>${l.ip}</td><td class="ua">${l.user_agent}</td></tr>`;
        }).join('')}</table>`;
    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'admin.html'), 'utf8');
    const filesJson = JSON.stringify(data.files.map(f => ({id:f.id, filename:f.filename, status:f.status})));
    return html.replace('{{FILE_ROWS}}', fileRows).replace('{{LOG_ROWS}}', logRows)
              .replace('</script>', 'var ALL_FILES = ' + filesJson + ';\n</script>');
}

// ---------- fs.watch 实时监听 + 防抖 ----------
let watchTimer = null;
function debouncedScan() {
    if (watchTimer) clearTimeout(watchTimer);
    watchTimer = setTimeout(() => { scanFiles(); watchTimer = null; }, DEBOUNCE_MS);
}
try {
    if (fs.existsSync(FILES_DIR)) {
        fs.watch(FILES_DIR, { persistent: false }, (eventType, filename) => {
            if (!filename) return;
            if (filename.startsWith('.')) return;
            if (filename.startsWith('_')) return;
            debouncedScan();
        });
    }
} catch (e) { console.error('fs.watch failed:', e.message); }

// ---------- HTTP 服务 ----------
const server = http.createServer((req, res) => {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname;

    // 下载 / 密码验证
    if (pathname.startsWith('/d/')) {
        const id = pathname.slice(3);
        const data = loadData();
        const file = data.files.find(f => f.id === id);
        if (!file || file.status !== 'active') {
            res.writeHead(404, {'Content-Type':'text/html; charset=utf-8'});
            return res.end(`<h2>文件不存在或已失效</h2><p><a href="/">← 返回主页</a></p>`);
        }
        if (!fs.existsSync(file.filepath)) {
            file.status = 'deleted';
            try { fs.unlinkSync(file.filepath + '.meta.json'); } catch (e) {}
            saveData(data);
            res.writeHead(404, {'Content-Type':'text/html; charset=utf-8'});
            return res.end(`<h2>文件已被移除</h2><p><a href="/">← 返回主页</a></p>`);
        }
        const meta = readMeta(file.filepath);
        const exp = parseExpireAt(meta.expire_at);
        if (exp && exp.getTime() <= nowBJT().getTime()) {
            moveToExpired(file); saveData(data);
            res.writeHead(410, {'Content-Type':'text/html; charset=utf-8'});
            return res.end(`<h2>链接已过期</h2><p><a href="/">← 返回主页</a></p>`);
        }
        if (meta.max_downloads && file.download_count >= meta.max_downloads) {
            moveToExpired(file); saveData(data);
            res.writeHead(410, {'Content-Type':'text/html; charset=utf-8'});
            return res.end(`<h2>下载次数已用尽</h2><p><a href="/">← 返回主页</a></p>`);
        }

        // 有密码：GET 返回密码输入页；POST 校验
        if (meta.password) {
            if (req.method === 'POST') {
                let body = '';
                req.on('data', c => body += c);
                req.on('end', () => {
                    const params = new URLSearchParams(body);
                    const pwd = params.get('pwd') || '';
                    if (pwd === meta.password) {
                        sendFile(req, res, file, data);
                    } else {
                        res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
                        res.end(passwordPage(file, true));
                    }
                });
                return;
            }
            res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
            return res.end(passwordPage(file, false));
        }

        sendFile(req, res, file, data);
        return;
    }

    // 管理页
    if (pathname === '/' + ADMIN_PATH) {
        res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
        return res.end(renderAdmin());
    }

    // 管理页 API：保存/读取设置
    if (pathname === '/api/settings' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const p = JSON.parse(body);
                const data = loadData();
                const file = data.files.find(f => f.id === p.id);
                if (!file) { res.writeHead(404); return res.end('file not found'); }
                const meta = readMeta(file.filepath);
                // 仅读取：没传任何设置字段时返回当前 meta
                const hasSet = ('expire_at' in p) || ('max_downloads' in p) || ('password' in p);
                if (hasSet) {
                    if (p.expire_at === '' || p.expire_at == null) delete meta.expire_at;
                    else meta.expire_at = String(p.expire_at).replace('T',' ').replace(':00+08:00','').replace(':00','').trim() + ':00';
                    if (p.max_downloads === '' || p.max_downloads == null) delete meta.max_downloads;
                    else meta.max_downloads = Number(p.max_downloads);
                    if (p.password === '' || p.password == null) delete meta.password;
                    else meta.password = String(p.password);
                    writeMeta(file.filepath, meta);
                }
                res.writeHead(200, {'Content-Type':'application/json'});
                res.end(JSON.stringify({ok:true, meta}));
            } catch (e) { res.writeHead(400); res.end('bad request'); }
        });
        return;
    }

    // 首页
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    res.end(renderIndex());
});

function sendFile(req, res, file, data) {
    const ip = reqHeaders(req, 'x-forwarded-for') || '';
    const ua = reqHeaders(req, 'user-agent') || 'Unknown';
    data.downloads.push({
        timestamp: nowBJT().toISOString().replace('T',' ').substring(0,16),
        file_id: file.id, filename: file.filename, ip, user_agent: ua
    });
    file.download_count++;
    saveData(data);
    res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        'Content-Length': file.filesize
    });
    fs.createReadStream(file.filepath).pipe(res);
}
function reqHeaders(req, name) { return req.headers[name]; }

function passwordPage(file, wrong) {
    const err = wrong ? '<div class="err">密码错误，请重试</div>' : '';
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>需要密码</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;background:#fafafa;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{background:white;border:1px solid #eaeaea;border-radius:12px;padding:40px;max-width:380px;width:100%;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,.04)}
h2{font-size:17px;margin:0 0 6px}.sub{color:#888;font-size:13px;margin-bottom:20px;word-break:break-all}
input{padding:11px 14px;width:100%;border:1px solid #ddd;border-radius:8px;font-size:15px;margin-bottom:14px;box-sizing:border-box}
.btn{background:#2563eb;color:white;border:0;padding:11px 28px;border-radius:8px;font-size:15px;font-weight:500;cursor:pointer}
.btn:hover{background:#1d4ed8}.err{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;padding:9px 12px;border-radius:8px;font-size:13px;margin-bottom:14px;text-align:left}
.back{display:block;margin-top:18px;color:#888;font-size:13px;text-decoration:none}.back:hover{color:#2563eb}</style></head>
<body><div class="box"><h2>🔒 需要密码</h2><p class="sub">${file.filename}</p>${err}
<form method="POST" action="/d/${file.id}"><input name="pwd" type="password" placeholder="请输入访问密码" autofocus><button class="btn" type="submit">确认下载</button></form>
<a class="back" href="/">← 返回主页</a></div></body></html>`;
}

server.listen(PORT, () => {
    scanFiles();
    console.log('CountShare running on port ' + PORT);
    console.log('Admin page: /' + ADMIN_PATH);
});
