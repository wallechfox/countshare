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

// ---------- 初始化 ----------
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ files: [], downloads: [] }));

function loadData() { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }
function fmtSize(s) { return s < 1048576 ? (s/1024).toFixed(1)+' KB' : (s/1048576).toFixed(1)+' MB'; }
function nowBeijing() { return new Date(Date.now() + 8*3600000).toISOString().replace('T',' ').substring(0,16); }

// ---------- 读取 .meta.json ----------
function readMeta(filepath) {
    const metaPath = filepath + '.meta.json';
    try {
        if (fs.existsSync(metaPath)) {
            const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            return {
                expire_hours: m.expire_hours || null,
                max_downloads: m.max_downloads || null,
                password: m.password || null
            };
        }
    } catch (e) {}
    return { expire_hours: null, max_downloads: null, password: null };
}

// ---------- 文件状态判定 ----------
// 返回: 'active' | 'expired' | 'deleted'
function fileStatus(f, meta) {
    if (!fs.existsSync(f.filepath)) return 'deleted';
    if (meta.expire_hours) {
        const created = new Date(f.created_at || Date.now()).getTime();
        if (Date.now() > created + meta.expire_hours * 3600000) return 'expired';
    }
    return 'active';
}

// ---------- 扫描 / 同步 ----------
function syncFiles() {
    if (!fs.existsSync(FILES_DIR)) return;
    const data = loadData();
    const existing = new Set(data.files.map(f => f.filepath));

    // 新增文件（仅根目录，不递归，不处理隐藏文件与 .meta.json）
    fs.readdirSync(FILES_DIR, { withFileTypes: true }).forEach(entry => {
        if (entry.isDirectory()) return;
        if (entry.name.startsWith('.')) return;
        if (entry.name.endsWith('.meta.json')) return;
        const fp = path.join(FILES_DIR, entry.name);
        if (existing.has(fp)) return;
        try {
            const stat = fs.statSync(fp);
            data.files.push({
                id: crypto.randomBytes(4).toString('hex'),
                filename: entry.name,
                filepath: fp,
                filesize: stat.size,
                download_count: 0,
                created_at: new Date().toISOString()
            });
        } catch (e) {}
    });

    // 处理已记录但物理文件消失的文件
    data.files.forEach(f => {
        if (f._gone) return;
        if (!fs.existsSync(f.filepath)) {
            // 手动删除：删配套 .meta.json，日志保留
            const metaPath = f.filepath + '.meta.json';
            try { if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath); } catch (e) {}
            f._gone = true;
            f.gone_reason = 'deleted';
        }
    });

    saveData(data);
}

// 把 _gone 的记录清理出"文件列表"，但保留在日志关联里
function activeFiles(data) {
    return data.files.filter(f => !f._gone);
}

// ---------- fs.watch + 防抖 ----------
let debounceTimer = null;
function scheduleScan() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        debounceTimer = null;
        syncFiles();
    }, DEBOUNCE_MS);
}

function startWatcher() {
    if (!fs.existsSync(FILES_DIR)) return;
    try {
        fs.watch(FILES_DIR, { persistent: false }, (eventType, filename) => {
            if (!filename) return;
            if (filename.startsWith('.')) return;
            if (filename.endsWith('.meta.json')) return;
            scheduleScan();
        });
    } catch (e) {
        console.error('fs.watch failed, falling back to scan only:', e.message);
    }
}

// ---------- 渲染：首页 ----------
function renderIndex() {
    syncFiles();
    const data = loadData();
    const files = activeFiles(data);
    let content = '';

    if (files.length === 0) {
        content = '<div class="container"><div class="icon">📂</div><h1>暂无分享文件</h1><p class="size">请把文件放到 files 目录</p></div>';
    } else if (files.length === 1) {
        const f = files[0];
        const meta = readMeta(f.filepath);
        const tags = statusTags(meta, f);
        content = `<div class="container">
            <div class="icon">📄</div>
            <h1>${f.filename}</h1>
            <p class="size">${fmtSize(f.filesize)}</p>
            ${tags}
            <div class="count">↓ ${f.download_count} 次下载</div><br>
            <a class="btn" href="/d/${f.id}">下载文件</a>
            <p class="footer">COUNTSHARE</p>
        </div>`;
    } else {
        const items = files.map(f => {
            const meta = readMeta(f.filepath);
            const tags = inlineTags(meta, f);
            return `<div class="item">
                <div class="ico">📄</div>
                <div class="info"><div class="name">${f.filename}</div><div class="meta">${fmtSize(f.filesize)} · ↓ ${f.download_count} 次 ${tags}</div></div>
                <a class="dl-btn" href="/d/${f.id}">下载</a>
            </div>`;
        }).join('');
        content = `<div class="container" style="max-width:600px;padding:40px 32px"><h1 style="margin-bottom:24px">文件分享</h1><div class="multi-list">${items}</div></div>`;
    }

    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    const title = files.length === 1 ? files[0].filename : 'CountShare';
    return html
        .replace('{{PAGE_TITLE}}', title)
        .replace('{{OG_TITLE}}', title)
        .replace('{{PAGE_CONTENT}}', content);
}

function statusTags(meta, f) {
    let h = '';
    if (meta.expire_hours) {
        const exp = new Date((new Date(f.created_at || Date.now())).getTime() + meta.expire_hours*3600000);
        h += `<div class="tag">⏳ 有效至 ${exp.toISOString().replace('T',' ').substring(0,16)}</div>`;
    }
    if (meta.max_downloads) h += `<div class="tag">📊 剩余 ${meta.max_downloads - f.download_count} 次</div>`;
    if (meta.password) h += `<div class="tag">🔒 需要密码</div>`;
    return h;
}
function inlineTags(meta, f) {
    let h = '';
    if (meta.expire_hours) h += '· ⏳有时限';
    if (meta.max_downloads) h += `· 📊限${meta.max_downloads}次`;
    if (meta.password) h += '· 🔒密码';
    return h;
}

// ---------- 渲染：管理页 ----------
function renderAdmin() {
    syncFiles();
    const data = loadData();
    const files = data.files; // 含已删除/过期的，用于展示状态
    const downloads = data.downloads;

    const fileRows = files.length === 0 ? '<p class="empty">暂无文件</p>' :
        `<table><tr><th>文件名</th><th>大小</th><th>下载</th><th>状态</th><th>配置</th><th>操作</th>${files.map(f => {
            const meta = readMeta(f.filepath);
            const gone = !fs.existsSync(f.filepath);
            const st = gone ? `<span class="red">${f.gone_reason === 'deleted' ? '🔴 已删除' : '🔴 已过期/丢失'}</span>` : '正常';
            const cfg = `${meta.expire_hours?'⏳'+meta.expire_hours+'h ':''}${meta.max_downloads?'📊'+meta.max_downloads+'次 ':''}${meta.password?'🔒已设':''}` || '无';
            return `<tr data-fileid="${f.id}"><td>${f.filename}${gone?'</td>':'</td>'}<td>${fmtSize(f.filesize)}</td><td>${f.download_count}</td><td>${st}</td><td>${cfg}</td><td><button class="act-btn" onclick="openSettings('${f.id}')">⚙ 设置</button> <button class="act-btn" onclick="filterLogs('${f.id}')">📋 日志</button></td></tr>`;
        }).join('')}</table>`;

    const logRows = downloads.length === 0 ? '<p class="empty">暂无下载记录</p>' :
        `<table id="log-table"><tr><th>时间</th><th>文件</th><th>IP</th><th>浏览器</th>${downloads.slice().reverse().map(l => {
            const f = files.find(x => x.id === l.file_id);
            const fname = f ? f.filename : '(未知)';
            const cls = (f && !fs.existsSync(f.filepath)) ? 'red' : '';
            return `<tr data-fileid="${l.file_id||''}"><td>${l.timestamp}</td><td class="${cls}">${fname}${cls?' 🔴':''}</td><td>${l.ip}</td><td class="ua">${l.user_agent}</td></tr>`;
        }).join('')}</table>`;

    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'admin.html'), 'utf8');
    return html
        .replace('{{FILE_ROWS}}', fileRows)
        .replace('{{LOG_ROWS}}', logRows);
}

// ---------- HTTP 服务 ----------
const server = http.createServer((req, res) => {
    const pathname = url.parse(req.url).pathname;
    const method = req.method;

    // API: 保存设置（管理页弹窗提交）
    if (pathname === '/api/settings' && method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const p = JSON.parse(body);
                const data = loadData();
                const f = data.files.find(x => x.id === p.file_id);
                if (!f) { res.writeHead(404); return res.end('文件不存在'); }
                const metaPath = f.filepath + '.meta.json';
                const meta = {
                    expire_hours: p.expire_hours ? Number(p.expire_hours) : null,
                    max_downloads: p.max_downloads ? Number(p.max_downloads) : null,
                    password: p.password || null
                };
                // 全空则删除 .meta.json
                if (!meta.expire_hours && !meta.max_downloads && !meta.password) {
                    try { if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath); } catch (e) {}
                } else {
                    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
                }
                res.writeHead(200, { 'Content-Type':'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type':'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    // 下载
    if (pathname.startsWith('/d/')) {
        const id = pathname.slice(3);
        const data = loadData();
        const file = data.files.find(f => f.id === id);
        if (!file) { res.writeHead(404); return res.end('文件不存在'); }

        // 文件已物理消失
        if (!fs.existsSync(file.filepath)) {
            file._gone = true; file.gone_reason = 'deleted';
            try { const mp = file.filepath+'.meta.json'; if(fs.existsSync(mp))fs.unlinkSync(mp); }catch(e){}
            saveData(data);
            res.writeHead(404); return res.end('文件已被移除');
        }

        const meta = readMeta(file.filepath);

        // 过期判定
        if (meta.expire_hours) {
            const created = new Date(file.created_at || Date.now()).getTime();
            if (Date.now() > created + meta.expire_hours * 3600000) {
                // 移到 _expired/
                const expiredDir = path.join(FILES_DIR, '_expired');
                try {
                    if (!fs.existsSync(expiredDir)) fs.mkdirSync(expiredDir, { recursive: true });
                    fs.renameSync(file.filepath, path.join(expiredDir, path.basename(file.filepath)));
                    const oldMeta = file.filepath + '.meta.json';
                    if (fs.existsSync(oldMeta)) fs.renameSync(oldMeta, path.join(expiredDir, path.basename(file.filepath)+'.meta.json'));
                } catch (e) {}
                file._gone = true; file.gone_reason = 'expired';
                saveData(data);
                res.writeHead(410); return res.end('链接已过期');
            }
        }

        // 密码校验（POST 提交密码）
        if (meta.password) {
            const params = url.parse(req.url, true).query;
            if (params.pwd !== meta.password) {
                res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8' });
                return res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>需要密码</title>
                <style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#fafafa;display:flex;align-items:center;justify-content:center;min-height:100vh}
                .box{background:white;border:1px solid #eaeaea;border-radius:12px;padding:40px;text-align:center}
                input{padding:10px 14px;border:1px solid #ddd;border-radius:8px;font-size:15px;width:240px;margin:12px 0}
                button{background:#2563eb;color:white;border:none;padding:10px 28px;border-radius:8px;font-size:15px;cursor:pointer}</style>
                </head><body><div class="box"><h2>🔒 此文件需要密码</h2>
                <form method="GET" action="/d/${file.id}"><input name="pwd" type="password" placeholder="请输入访问密码" autofocus><br><button type="submit">确认</button></form>
                </div></body></html>`);
            }
        }

        // 次数用尽判定
        if (meta.max_downloads && file.download_count >= meta.max_downloads) {
            const expiredDir = path.join(FILES_DIR, '_expired');
            try {
                if (!fs.existsSync(expiredDir)) fs.mkdirSync(expiredDir, { recursive: true });
                fs.renameSync(file.filepath, path.join(expiredDir, path.basename(file.filepath)));
                const oldMeta = file.filepath + '.meta.json';
                if (fs.existsSync(oldMeta)) fs.renameSync(oldMeta, path.join(expiredDir, path.basename(file.filepath)+'.meta.json'));
            } catch (e) {}
            file._gone = true; file.gone_reason = 'expired';
            saveData(data);
            res.writeHead(410); return res.end('下载次数已用尽');
        }

        // 记录下载
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const ua = req.headers['user-agent'] || 'Unknown';
        data.downloads.push({
            timestamp: nowBeijing(),
            file_id: file.id, filename: file.filename, ip, user_agent: ua
        });
        file.download_count++;
        saveData(data);

        // 下载后若次数用尽 → 归档
        if (meta.max_downloads && file.download_count >= meta.max_downloads) {
            setImmediate(() => {
                try {
                    if (!fs.existsSync(file.filepath)) return;
                    const expiredDir = path.join(FILES_DIR, '_expired');
                    if (!fs.existsSync(expiredDir)) fs.mkdirSync(expiredDir, { recursive: true });
                    fs.renameSync(file.filepath, path.join(expiredDir, path.basename(file.filepath)));
                    const oldMeta = file.filepath + '.meta.json';
                    if (fs.existsSync(oldMeta)) fs.renameSync(oldMeta, path.join(expiredDir, path.basename(file.filepath)+'.meta.json'));
                    const d = loadData();
                    const tf = d.files.find(x => x.id === file.id);
                    if (tf) { tf._gone = true; tf.gone_reason = 'expired'; saveData(d); }
                } catch (e) {}
            });
        }

        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
            'Content-Length': file.filesize
        });
        fs.createReadStream(file.filepath).pipe(res);
        return;
    }

    // 管理页
    if (pathname === '/' + ADMIN_PATH) {
        res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8' });
        return res.end(renderAdmin());
    }

    // 首页
    res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8' });
    res.end(renderIndex());
});

// ---------- 启动 ----------
syncFiles();
startWatcher();
server.listen(PORT, () => {
    console.log('CountShare running on port ' + PORT);
    console.log('Admin page: /' + ADMIN_PATH);
});
