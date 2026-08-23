const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ----- 路径自适应 -----
const FILES_DIR = fs.existsSync('/files') ? '/files' : path.join(__dirname, 'files');
const DATA_DIR  = fs.existsSync('/data')  ? '/data'  : path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const PORT = process.env.PORT || 8000;
const ADMIN_PATH = process.env.ADMIN_PATH || crypto.randomBytes(6).toString('hex'); // 12位

// ----- 确保目录存在 -----
if (!fs.existsSync(FILES_DIR)) {
  console.error(`[ERROR] FILES_DIR 不存在: ${FILES_DIR}`);
  process.exit(1);
}
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const EXPIRED_DIR = path.join(FILES_DIR, '_expired');
if (!fs.existsSync(EXPIRED_DIR)) fs.mkdirSync(EXPIRED_DIR, { recursive: true });

// ----- 数据加载 -----
let data = { files: {}, logs: [], archived: {} };
if (fs.existsSync(DATA_FILE)) {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    data.files   = parsed.files   || {};
    data.logs    = parsed.logs    || [];
    data.archived = parsed.archived || {};
  } catch (e) {
    console.error('[ERROR] data.json 损坏，已重置', e.message);
  }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[ERROR] 保存 data.json 失败:', e.message);
  }
}

// ----- 辅助函数 -----
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/1024/1024).toFixed(1) + ' MB';
}

function readMeta(filename) {
  const metaPath = path.join(FILES_DIR, filename + '.meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch (_) {}
  }
  return {};
}

function writeMeta(filename, meta) {
  const metaPath = path.join(FILES_DIR, filename + '.meta.json');
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
}

function moveToExpired(filename, reason) {
  const src = path.join(FILES_DIR, filename);
  const srcMeta = src + '.meta.json';
  const dst = path.join(EXPIRED_DIR, filename);
  const dstMeta = dst + '.meta.json';
  try {
    fs.renameSync(src, dst);
    if (fs.existsSync(srcMeta)) fs.renameSync(srcMeta, dstMeta);
    data.archived[filename] = { reason, time: new Date().toISOString() };
    delete data.files[filename];
    saveData();
    console.log(`[move] 文件 ${filename} 已归档 (${reason})`);
  } catch (e) {
    console.error(`[move] 移动 ${filename} 失败:`, e.message);
  }
}

function errorPage(message, detail = '') {
  return `
    <!DOCTYPE html>
    <html><head><meta charset="UTF-8"><title>CountShare</title></head>
    <body style="font-family:sans-serif;max-width:400px;margin:100px auto;text-align:center">
      <h1>${message}</h1>
      ${detail ? `<p>${detail}</p>` : ''}
      <p><a href="/" style="color:#007bff">← 返回首页</a></p>
    </body></html>
  `;
}

// ----- 统一的文件信息页面渲染 -----
function renderFileInfoPage(file, meta, showPasswordForm = false, errorMessage = '') {
  const expireStr = meta.expire_at ? `⏳ 有效至 ${meta.expire_at}` : '';
  const limitStr = meta.max_downloads ? `📊 限制下载 ${meta.max_downloads} 次` : '';
  const infoParts = [];
  if (expireStr) infoParts.push(expireStr);
  if (limitStr) infoParts.push(limitStr);
  const infoLine = infoParts.length ? ` · ${infoParts.join(' · ')}` : '';

  let formHtml = '';
  if (showPasswordForm) {
    formHtml = `
      <form method="POST" action="/d/${file.id}">
        <input type="password" name="pwd" placeholder="请输入访问密码" required autofocus>
        <br>
        <button type="submit">确认下载</button>
      </form>
    `;
  } else {
    formHtml = `<a href="/d/${file.id}?download=true" class="btn">下载文件</a>`;
  }

  return `
    <!DOCTYPE html>
    <html><head><meta charset="UTF-8"><title>${file.filename} - CountShare</title>
    <style>
      body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; max-width:400px; margin:100px auto; padding:20px; text-align:center; background:#f5f5f5; }
      .card { background:white; border-radius:12px; padding:24px; box-shadow:0 2px 8px rgba(0,0,0,0.1); }
      .card h1 { font-size:20px; word-break:break-all; margin-bottom:8px; }
      .card .info { font-size:14px; color:#666; margin-bottom:16px; line-height:1.6; }
      .error { color:red; background:#fee; padding:8px; border-radius:4px; margin-bottom:10px; font-size:14px; }
      input { padding:8px; width:200px; margin:8px 0; border:1px solid #ddd; border-radius:4px; font-size:16px; }
      button, .btn { display:inline-block; padding:8px 16px; background:#007bff; color:white; border:none; border-radius:4px; cursor:pointer; font-size:16px; text-decoration:none; }
      button:hover, .btn:hover { background:#0056b3; }
      a { color:#007bff; text-decoration:none; }
    </style>
    </head>
    <body>
    <div class="card">
      <h1>📄 ${file.filename}</h1>
      <div class="info">${formatSize(file.filesize)} · 已下载 ${file.download_count} 次${infoLine}</div>
      ${errorMessage ? `<div class="error">${errorMessage}</div>` : ''}
      ${formHtml}
      <p style="margin-top:16px;font-size:14px;"><a href="/">← 返回首页</a></p>
    </div>
    </body></html>
  `;
}

// ----- 扫描文件 -----
function scanFiles() {
  const entries = fs.readdirSync(FILES_DIR, { withFileTypes: true });
  const validFiles = new Set();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name.startsWith('.') || name === '_expired' || name.endsWith('.meta.json')) continue;
    validFiles.add(name);
  }

  for (const filename of validFiles) {
    if (!data.files[filename]) {
      const fullPath = path.join(FILES_DIR, filename);
      data.files[filename] = {
        id: crypto.randomBytes(3).toString('hex'),
        filename,
        filesize: fs.statSync(fullPath).size,
        download_count: 0,
        created_at: new Date().toISOString()
      };
    }
  }

  for (const key of Object.keys(data.files)) {
    if (!validFiles.has(key)) {
      delete data.files[key];
    }
  }
  saveData();
}

scanFiles();

// ----- 文件监听 -----
let watchTimer = null;
let watchPending = new Set();

try {
  fs.watch(FILES_DIR, (eventType, filename) => {
    if (!filename) return;
    if (filename.startsWith('.') || filename === '_expired') return;
    if (filename.endsWith('.meta.json')) {
      const realName = filename.slice(0, -10);
      watchPending.add(realName);
    } else {
      watchPending.add(filename);
    }
    if (watchTimer) clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      const names = [...watchPending];
      watchPending.clear();
      processWatchEvents(names);
    }, 500);
  });
} catch (e) {
  console.warn('[WARN] fs.watch 启动失败:', e.message);
}

function processWatchEvents(filenames) {
  for (const filename of filenames) {
    const fullPath = path.join(FILES_DIR, filename);
    const metaPath = fullPath + '.meta.json';
    const expiredPath = path.join(EXPIRED_DIR, filename);
    const exists = fs.existsSync(fullPath) && fs.statSync(fullPath).isFile();
    const inExpired = fs.existsSync(expiredPath) && fs.statSync(expiredPath).isFile();

    if (exists) {
      if (!data.files[filename]) {
        data.files[filename] = {
          id: crypto.randomBytes(3).toString('hex'),
          filename,
          filesize: fs.statSync(fullPath).size,
          download_count: 0,
          created_at: new Date().toISOString()
        };
        console.log(`[watch] 新增文件: ${filename}`);
        if (data.archived[filename]) delete data.archived[filename];
      }
    } else if (inExpired) {
      // 在 _expired 中，忽略
    } else {
      if (data.files[filename]) {
        delete data.files[filename];
        console.log(`[watch] 删除文件: ${filename}`);
      }
      if (fs.existsSync(metaPath)) {
        try { fs.unlinkSync(metaPath); } catch (_) {}
      }
    }
  }
  saveData();
}

// ----- HTTP 服务器 -----
const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;
  const method = req.method;

  // 管理页
  if (pathname === '/' + ADMIN_PATH) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'public', 'admin.html'), 'utf8'));
    return;
  }

  // API: 获取文件列表 + 日志 + 归档
  if (pathname === '/api/files' && method === 'GET') {
    const fileList = Object.values(data.files).map(f => {
      const meta = readMeta(f.filename);
      return {
        id: f.id,
        filename: f.filename,
        filesize: f.filesize,
        download_count: f.download_count,
        expire_at: meta.expire_at || null,
        max_downloads: meta.max_downloads || null,
        password_set: !!meta.password,
        share_url: `${req.headers.host}/d/${f.id}`
      };
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      files: fileList,
      logs: data.logs,
      archived: data.archived
    }));
    return;
  }

  // API: 保存设置
  if (pathname === '/api/settings' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const id = params.get('id');
      const file = Object.values(data.files).find(f => f.id === id);
      if (!file) {
        res.writeHead(404);
        res.end('File not found');
        return;
      }
      const meta = readMeta(file.filename);
      const expireAt = params.get('expire_at');
      const maxDownloads = params.get('max_downloads');
      const password = params.get('password');

      if (expireAt) meta.expire_at = expireAt.replace('T', ' ') + ':00';
      if (maxDownloads) meta.max_downloads = parseInt(maxDownloads);
      if (password) meta.password = password;

      writeMeta(file.filename, meta);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }

  // 下载处理
  const match = pathname.match(/^\/d\/([a-f0-9]{6})$/);
  if (match) {
    const id = match[1];
    const file = Object.values(data.files).find(f => f.id === id);
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(errorPage('文件不存在或已被移除'));
      return;
    }

    const meta = readMeta(file.filename);
    const filePath = path.join(FILES_DIR, file.filename);

    // 有效期检查
    if (meta.expire_at) {
      const expireTime = new Date(meta.expire_at.replace(' ', 'T') + '+08:00').getTime();
      if (Date.now() > expireTime) {
        moveToExpired(file.filename, 'expired');
        res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(errorPage('链接已过期'));
        return;
      }
    }

    // 次数检查
    if (meta.max_downloads && file.download_count >= meta.max_downloads) {
      moveToExpired(file.filename, 'max_downloads');
      res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(errorPage('下载次数已用尽'));
      return;
    }

    // 判断是否要求直接下载（有 ?download=true 参数）
    const wantDownload = urlObj.searchParams.get('download') === 'true';

    // 如果有密码
    if (meta.password) {
      if (method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          const params = new URLSearchParams(body);
          const pwd = params.get('pwd') || '';
          if (pwd === meta.password) {
            // 密码正确，返回文件流
            const stat = fs.statSync(filePath);
            const encodedName = encodeURIComponent(file.filename);
            res.writeHead(200, {
              'Content-Type': 'application/octet-stream',
              'Content-Length': stat.size,
              'Content-Disposition': `attachment; filename*=UTF-8''${encodedName}`
            });
            file.download_count++;
            data.logs.push({
              time: new Date().toISOString(),
              file: file.filename,
              ip: req.socket.remoteAddress,
              ua: req.headers['user-agent'] || ''
            });
            saveData();
            fs.createReadStream(filePath).pipe(res);
          } else {
            // 密码错误，返回密码页并显示错误
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderFileInfoPage(file, meta, true, '密码错误，请重试'));
          }
        });
        return;
      } else {
        // GET 请求，显示密码输入页
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderFileInfoPage(file, meta, true));
        return;
      }
    }

    // 无密码
    if (wantDownload) {
      // 直接下载
      const stat = fs.statSync(filePath);
      const encodedName = encodeURIComponent(file.filename);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodedName}`
      });
      file.download_count++;
      data.logs.push({
        time: new Date().toISOString(),
        file: file.filename,
        ip: req.socket.remoteAddress,
        ua: req.headers['user-agent'] || ''
      });
      saveData();
      fs.createReadStream(filePath).pipe(res);
    } else {
      // 显示文件信息页（无密码，带下载按钮）
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderFileInfoPage(file, meta, false));
    }
    return;
  }

  // 首页
  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8'));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('========================================');
  console.log('  CountShare running');
  console.log('  FILES_DIR =', FILES_DIR);
  console.log('  DATA_DIR  =', DATA_DIR);
  console.log('  PORT      =', PORT);
  console.log('  首页      : http://localhost:' + PORT);
  console.log('  管理页    : http://localhost:' + PORT + '/' + ADMIN_PATH);
  console.log('========================================');
});
