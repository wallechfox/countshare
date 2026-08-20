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

// ---------- 初始化 ----------
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ files: [], downloads: [] }));

function loadData() { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }

function fmtSize(s) { return s < 1048576 ? (s/1024).toFixed(1)+' KB' : (s/1048576).toFixed(1)+' MB'; }

// ---------- 扫描 + 清理 ----------
function scanFiles() {
    if (!fs.existsSync(FILES_DIR)) return;
    const data = loadData();
    const existing = new Set(data.files.map(f => f.filepath));
    fs.readdirSync(FILES_DIR, { withFileTypes: true }).forEach(entry => {
        if (!entry.isFile()) return;
        const fname = entry.name;
        const fp = path.join(FILES_DIR, fname);
        if (!existing.has(fp)) {
            try {
                const stat = fs.statSync(fp);
                data.files.push({
                    id: crypto.randomBytes(4).toString('hex'),
                    filename: fname, filepath: fp,
                    filesize: stat.size, download_count: 0
                });
            } catch (e) {}
        }
    });
    saveData(data);
}

function cleanMissingFiles() {
    const data = loadData();
    const before = data.files.length;
    data.files = data.files.filter(f => {
        try { return fs.existsSync(f.filepath); } catch (e) { return false; }
    });
    if (data.files.length !== before) {
        const validIds = new Set(data.files.map(f => f.id));
        data.downloads = data.downloads.filter(d => validIds.has(d.file_id));
        saveData(data);
    }
}

// ---------- 读取并填充 HTML ----------
function renderIndex() {
    scanFiles();
    cleanMissingFiles();
    const data = loadData();
    let content = '';

    if (data.files.length === 0) {
        content = '<div class="container"><div class="icon">📂</div><h1>暂无分享文件</h1><p class="size">请把文件放到 files 目录</p></div>';
    } else if (data.files.length === 1) {
        const f = data.files[0];
        content = `<div class="container">
            <div class="icon">📄</div>
            <h1>${f.filename}</h1>
            <p class="size">${fmtSize(f.filesize)}</p>
            <div class="count">↓ ${f.download_count} 次下载</div><br>
            <a class="btn" href="/d/${f.id}">下载文件</a>
            <p class="footer">COUNTSHARE</p>
        </div>`;
    } else {
        const items = data.files.map(f => `
            <div class="item">
                <div class="ico">📄</div>
                <div class="info"><div class="name">${f.filename}</div><div class="meta">${fmtSize(f.filesize)} · ↓ ${f.download_count} 次</div></div>
                <a class="dl-btn" href="/d/${f.id}">下载</a>
            </div>`).join('');
        content = `<div class="container" style="max-width:600px;padding:40px 32px"><h1 style="margin-bottom:24px">文件分享</h1><div class="multi-list">${items}</div></div>`;
    }

    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    return html
        .replace('{{PAGE_TITLE}}', data.files.length === 1 ? data.files[0].filename : 'CountShare')
        .replace('{{PAGE_CONTENT}}', content);
}

function renderAdmin() {
    cleanMissingFiles();
    const data = loadData();

    let fileRows = '<p class="empty">暂无文件</p>';
    if (data.files.length > 0) {
        const rows = data.files.map(f => `<tr><td>${f.filename}</td><td>${fmtSize(f.filesize)}</td><td><b>${f.download_count}</b></td></tr>`).join('');
        fileRows = `<table><tr><th>文件名</th><th>大小</th><th>下载次数</th>${rows}</table>`;
    }

    let logRows = '<p class="empty">暂无下载记录</p>';
    if (data.downloads.length > 0) {
        const rows = data.downloads.slice().reverse().map(l => `<tr><td>${l.timestamp}</td><td>${l.filename}</td><td>${l.ip}</td><td class="ua">${l.user_agent}</td></tr>`).join('');
        logRows = `<table><tr><th>时间</th><th>文件</th><th>IP</th><th>浏览器</th>${rows}</table>`;
    }

    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'admin.html'), 'utf8');
    return html
        .replace('{{FILE_ROWS}}', fileRows)
        .replace('{{LOG_ROWS}}', logRows);
}

// ---------- HTTP 服务 ----------
const server = http.createServer((req, res) => {
    const pathname = url.parse(req.url).pathname;

    // 下载
    if (pathname.startsWith('/d/')) {
        const id = pathname.slice(3);
        const data = loadData();
        const file = data.files.find(f => f.id === id);
        if (!file) { res.writeHead(404); return res.end('文件不存在'); }

        if (!fs.existsSync(file.filepath)) {
            data.files = data.files.filter(f => f.id !== id);
            saveData(data);
            res.writeHead(404);
            return res.end('文件已被移除');
        }

        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const ua = req.headers['user-agent'] || 'Unknown';
        data.downloads.push({
            timestamp: new Date(Date.now() + 8 * 3600000).toISOString().replace('T',' ').substring(0,16),
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
        return;
    }

    // 管理页
    if (pathname === '/' + ADMIN_PATH) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(renderAdmin());
    }

    // 首页
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderIndex());
});

server.listen(PORT, () => {
    console.log('CountShare running on port ' + PORT);
    console.log('Admin page: /' + ADMIN_PATH);
});