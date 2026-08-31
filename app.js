const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// ----- 路径自适应 -----
const FILES_DIR = fs.existsSync('/files') ? '/files' : path.join(__dirname, 'files');
const DATA_DIR  = fs.existsSync('/data')  ? '/data'  : path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const PORT = process.env.PORT || 8000;
const ADMIN_PATH = process.env.ADMIN_PATH || crypto.randomBytes(6).toString('hex');

// ----- 确保目录存在 -----
if (!fs.existsSync(FILES_DIR)) {
  console.error(`[ERROR] FILES_DIR 不存在: ${FILES_DIR}`);
  process.exit(1);
}
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const TMP_DIR = path.join(DATA_DIR, 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// ----- 数据加载 -----
let data = { shares: {}, logs: [] };
if (fs.existsSync(DATA_FILE)) {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    data.shares = parsed.shares || {};
    data.logs = parsed.logs || [];
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

// ----- 工具函数 -----
function formatSize(bytes) {
  if (!bytes) return '-';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/1024/1024).toFixed(1) + ' MB';
}

function safePath(base, sub) {
  const target = path.resolve(base, sub);
  if (!target.startsWith(base)) throw new Error('Forbidden');
  return target;
}

function generateId() {
  return crypto.randomBytes(3).toString('hex');
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ----- 解析 multipart/form-data（修复中文文件名）-----
function parseMultipart(req, callback) {
  const contentType = req.headers['content-type'];
  if (!contentType || !contentType.startsWith('multipart/form-data')) {
    return callback(new Error('Expected multipart/form-data'));
  }
  const boundary = contentType.split('boundary=')[1];
  if (!boundary) return callback(new Error('No boundary found'));

  const boundaryBuffer = Buffer.from('--' + boundary);
  let buffer = Buffer.alloc(0);
  req.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); });
  req.on('end', () => {
    // 拆分 parts
    const parts = splitBuffer(buffer, boundaryBuffer);
    for (const part of parts) {
      if (part.length === 0) continue;
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;
      const headers = part.slice(0, headerEnd);
      const content = part.slice(headerEnd + 4);

      let filename = null;

      // 1. 尝试 filename*=UTF-8''
      const fnStarMatch = headers.toString('binary').match(/filename\*=UTF-8''([^;\r\n]+)/i);
      if (fnStarMatch) {
        try { filename = decodeURIComponent(fnStarMatch[1]); } catch (_) {}
      }

      // 2. 尝试 filename="..."
      if (!filename) {
        const fnMatch = headers.toString('binary').match(/filename="([^"]*)"/i);
        if (fnMatch) {
          const raw = fnMatch[1];
          // 尝试 UTF-8 解码（部分浏览器直接发送 UTF-8 字节）
          try {
            filename = Buffer.from(raw, 'binary').toString('utf8');
          } catch (_) {
            try {
              filename = decodeURIComponent(raw);
            } catch (_2) {
              filename = raw;
            }
          }
        }
      }

      if (filename) {
        callback(null, { filename, data: content });
        return;
      }
    }
    callback(new Error('No file found'));
  });
}

function splitBuffer(buffer, delimiter) {
  const parts = [];
  let offset = 0;
  let index = buffer.indexOf(delimiter, offset);
  while (index !== -1) {
    parts.push(buffer.slice(offset, index));
    offset = index + delimiter.length;
    // 跳过 CRLF
    if (buffer[offset] === 0x0D && buffer[offset+1] === 0x0A) offset += 2;
    index = buffer.indexOf(delimiter, offset);
  }
  // 移除最后的 -- 和 CRLF
  const last = parts[parts.length-1];
  if (last.length > 2 && last[last.length-2] === 0x2D && last[last.length-1] === 0x2D) {
    parts[parts.length-1] = last.slice(0, last.length-2);
  }
  return parts;
}

// ----- 文件系统操作 -----
function getStat(relPath) {
  try {
    const full = safePath(FILES_DIR, relPath);
    const stat = fs.statSync(full);
    return { exists: true, stat, full };
  } catch (e) {
    return { exists: false };
  }
}

function listDirectory(relPath) {
  const full = safePath(FILES_DIR, relPath);
  const items = [];
  const entries = fs.readdirSync(full, { withFileTypes: true });
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith('.')) continue;
    const itemPath = path.join(relPath, name).replace(/\\/g, '/');
    const stat = fs.statSync(path.join(full, name));
    items.push({
      name,
      path: itemPath,
      isDirectory: entry.isDirectory(),
      size: entry.isFile() ? stat.size : 0,
      mtime: stat.mtime
    });
  }
  items.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name);
  });
  return items;
}

function getShareByPath(targetPath) {
  for (const sid in data.shares) {
    if (data.shares[sid].path === targetPath) return data.shares[sid];
  }
  return null;
}

function deleteShareByPath(targetPath) {
  let found = false;
  for (const sid in data.shares) {
    if (data.shares[sid].path === targetPath) {
      delete data.shares[sid];
      found = true;
    }
  }
  if (found) saveData();
  return found;
}

function addLog(shareId, relPath, ip, ua) {
  data.logs.push({
    time: new Date().toISOString(),
    shareId,
    path: relPath,
    ip: ip || '',
    ua: ua || ''
  });
  saveData();
}

// ----- 渲染分享页（公开页）-----
function renderSharePage(share, relPath, items, errorMsg = '', passwordRequired = false) {
  const isFile = share.type === 'file';
  const settings = share.settings || {};
  const stats = share.stats || { download_count: 0 };

  let infoLines = [];
  if (isFile) {
    const size = getStat(relPath).stat?.size || 0;
    infoLines.push(`📄 大小：${formatSize(size)}`);
  } else {
    const totalFiles = items.filter(i => !i.isDirectory).length;
    infoLines.push(`📁 包含 ${totalFiles} 个文件`);
  }
  infoLines.push(`⬇️ 已下载 ${stats.download_count} 次`);
  if (settings.max_downloads) infoLines.push(`📊 限制 ${settings.max_downloads} 次`);
  if (settings.expire_at) infoLines.push(`⏳ 有效至 ${settings.expire_at}`);

  let contentHtml = '';
  if (passwordRequired) {
    contentHtml = `
      <form method="POST" action="/s/${share.shareId}">
        <input type="password" name="pwd" placeholder="请输入访问密码" required autofocus>
        <button type="submit">确认下载</button>
      </form>
    `;
  } else if (isFile) {
    const encodedName = encodeURIComponent(path.basename(relPath));
    contentHtml = `
      <p><a href="/download/${share.shareId}?file=${encodeURIComponent(relPath)}" class="btn">⬇️ 下载文件</a></p>
    `;
  } else {
    // 文件夹：表格显示文件列表 + 打包下载
    const fileItems = items.filter(i => !i.isDirectory);
    let listHtml = '';
    if (fileItems.length === 0) {
      listHtml = '<p style="color:#999;">此文件夹为空</p>';
    } else {
      listHtml = `
        <table style="width:100%;border-collapse:collapse;margin:12px 0;font-size:13px;">
          <thead>
            <tr style="background:#f8f9fa;">
              <th style="padding:6px;text-align:left;border-bottom:1px solid #ddd;">文件名</th>
              <th style="padding:6px;text-align:right;border-bottom:1px solid #ddd;">大小</th>
            </tr>
          </thead>
          <tbody>
            ${fileItems.map(item => `
              <tr>
                <td style="padding:4px 6px;border-bottom:1px solid #f0f0f0;text-align:left;">
                  <a href="/download/${share.shareId}?file=${encodeURIComponent(item.path)}">${escapeHtml(item.name)}</a>
                </td>
                <td style="padding:4px 6px;border-bottom:1px solid #f0f0f0;text-align:right;">
                  ${formatSize(item.size)}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    }
    contentHtml = `
      <p><a href="/zip/${share.shareId}" class="btn">📦 打包下载全部</a></p>
      ${listHtml}
    `;
  }

  return `
    <!DOCTYPE html>
    <html><head><meta charset="UTF-8"><title>${path.basename(relPath)} - CountShare</title>
    <style>
      body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; max-width:600px; margin:100px auto; padding:20px; text-align:center; background:#f5f5f5; }
      .card { background:white; border-radius:12px; padding:24px; box-shadow:0 2px 8px rgba(0,0,0,0.1); }
      .card h1 { font-size:20px; word-break:break-all; margin-bottom:8px; }
      .card .info { font-size:14px; color:#666; margin-bottom:16px; line-height:1.6; }
      .error { color:red; background:#fee; padding:8px; border-radius:4px; margin-bottom:10px; }
      input { padding:8px; width:200px; margin:8px 0; border:1px solid #ddd; border-radius:4px; font-size:16px; }
      .btn, button { display:inline-block; padding:8px 16px; background:#007bff; color:white; border:none; border-radius:4px; cursor:pointer; font-size:16px; text-decoration:none; }
      .btn:hover, button:hover { background:#0056b3; }
      a { color:#007bff; text-decoration:none; }
      ul li { padding:4px 0; border-bottom:1px solid #eee; }
      table { width:100%; }
      th, td { padding:4px 6px; }
    </style>
    </head>
    <body>
    <div class="card">
      <h1>📄 ${path.basename(relPath)}</h1>
      <div class="info">${infoLines.join(' · ')}</div>
      ${errorMsg ? `<div class="error">${errorMsg}</div>` : ''}
      ${contentHtml}
    </div>
    </body></html>
  `;
}

// ----- HTTP 服务器 -----
const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;
  const method = req.method;

  // ----- 管理页 -----
  if (pathname === '/' + ADMIN_PATH) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'public', 'admin.html'), 'utf8'));
    return;
  }

  // ----- 首页（简介）-----
  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <!DOCTYPE html>
      <html lang="zh-CN">
      <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>CountShare</title>
      <style>
        body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; max-width:640px; margin:80px auto; padding:20px; background:#f5f5f5; }
        .card { background:white; border-radius:12px; padding:32px; box-shadow:0 2px 12px rgba(0,0,0,0.08); }
        h1 { font-size:28px; margin-bottom:8px; }
        .sub { color:#666; font-size:16px; margin-bottom:20px; }
        ul { text-align:left; line-height:1.8; color:#444; }
        li { margin:8px 0; }
        .footer { margin-top:24px; color:#999; font-size:14px; border-top:1px solid #eee; padding-top:16px; }
      </style>
      </head>
      <body>
      <div class="card">
        <h1>📂 CountShare</h1>
        <p class="sub">极简文件分享工具</p>
        <ul>
          <li>📤 上传文件或文件夹到服务器，生成分享链接</li>
          <li>🔗 每个链接对应一个文件或文件夹，可设置密码、有效期、下载次数</li>
          <li>📊 实时统计下载次数，记录访问者 IP 和浏览器</li>
          <li>📁 支持文件夹打包下载（自动 zip 压缩）</li>
          <li>⚙️ 管理面板集中管理所有分享和下载记录</li>
        </ul>
        <div class="footer">CountShare v2.2 · 纯 Node.js 实现 · 零依赖</div>
      </div>
      </body>
      </html>
    `);
    return;
  }

  // ----- 公开分享页 (/s/{shareId}) -----
  const shareMatch = pathname.match(/^\/s\/([a-f0-9]{6})$/);
  if (shareMatch) {
    const shareId = shareMatch[1];
    const share = data.shares[shareId];
    if (!share) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<h1>分享不存在</h1>');
      return;
    }

    const relPath = share.path;
    const settings = share.settings || {};
    const stats = share.stats || { download_count: 0 };

    // 检查过期
    if (settings.expire_at) {
      const expireTime = new Date(settings.expire_at.replace(' ', 'T') + '+08:00').getTime();
      if (Date.now() > expireTime) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(renderSharePage(share, relPath, [], '此分享链接已过期', false));
        return;
      }
    }
    // 检查次数
    if (settings.max_downloads && stats.download_count >= settings.max_downloads) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(renderSharePage(share, relPath, [], '下载次数已用尽', false));
      return;
    }

    // 检查实体
    const stat = getStat(relPath);
    if (!stat.exists) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(renderSharePage(share, relPath, [], '文件或文件夹已丢失', false));
      return;
    }

    // 密码处理
    if (settings.password) {
      if (method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          const params = new URLSearchParams(body);
          const pwd = params.get('pwd') || '';
          if (pwd === settings.password) {
            if (share.type === 'file') {
              res.writeHead(302, { Location: `/download/${shareId}?file=${encodeURIComponent(relPath)}` });
              res.end();
            } else {
              const items = listDirectory(relPath);
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end(renderSharePage(share, relPath, items, '', false));
            }
          } else {
            const items = share.type === 'folder' ? listDirectory(relPath) : [];
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(renderSharePage(share, relPath, items, '密码错误，请重试', true));
          }
        });
        return;
      } else {
        const items = share.type === 'folder' ? listDirectory(relPath) : [];
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(renderSharePage(share, relPath, items, '', true));
        return;
      }
    }

    // 无密码
    if (share.type === 'file') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(renderSharePage(share, relPath, [], '', false));
    } else {
      const items = listDirectory(relPath);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(renderSharePage(share, relPath, items, '', false));
    }
    return;
  }

  // ----- 下载单个文件 (/download/{shareId}?file=路径) -----
  const downloadMatch = pathname.match(/^\/download\/([a-f0-9]{6})$/);
  if (downloadMatch) {
    const shareId = downloadMatch[1];
    const share = data.shares[shareId];
    if (!share) {
      res.writeHead(404);
      res.end('分享不存在');
      return;
    }

    // 获取文件路径
    const fileParam = urlObj.searchParams.get('file');
    if (!fileParam) {
      res.writeHead(400);
      res.end('缺少 file 参数');
      return;
    }

    // 安全检查
    let targetPath;
    try {
      targetPath = safePath(FILES_DIR, fileParam);
      // 确保路径在 FILES_DIR 内且是文件
      const stat = getStat(fileParam);
      if (!stat.exists || stat.stat.isDirectory()) {
        res.writeHead(404);
        res.end('文件不存在');
        return;
      }
    } catch (e) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    // 检查分享限制（再次）
    const settings = share.settings || {};
    const stats = share.stats || { download_count: 0 };
    if (settings.expire_at) {
      const expireTime = new Date(settings.expire_at.replace(' ', 'T') + '+08:00').getTime();
      if (Date.now() > expireTime) {
        res.writeHead(410);
        res.end('链接已过期');
        return;
      }
    }
    if (settings.max_downloads && stats.download_count >= settings.max_downloads) {
      res.writeHead(410);
      res.end('下载次数已用尽');
      return;
    }

    // 更新计数
    stats.download_count = (stats.download_count || 0) + 1;
    saveData();
    addLog(shareId, targetPath, req.socket.remoteAddress, req.headers['user-agent']);

    // 返回文件
    const fullPath = safePath(FILES_DIR, targetPath);
    const fileStat = fs.statSync(fullPath);
    const encodedName = encodeURIComponent(path.basename(targetPath));
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': fileStat.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodedName}`
    });
    fs.createReadStream(fullPath).pipe(res);
    return;
  }

  // ----- 打包下载 (/zip/{shareId}) -----
  const zipMatch = pathname.match(/^\/zip\/([a-f0-9]{6})$/);
  if (zipMatch) {
    const shareId = zipMatch[1];
    const share = data.shares[shareId];
    if (!share || share.type !== 'folder') {
      res.writeHead(404);
      res.end('无效分享');
      return;
    }

    const settings = share.settings || {};
    const stats = share.stats || { download_count: 0 };
    if (settings.expire_at) {
      const expireTime = new Date(settings.expire_at.replace(' ', 'T') + '+08:00').getTime();
      if (Date.now() > expireTime) {
        res.writeHead(410);
        res.end('链接已过期');
        return;
      }
    }
    if (settings.max_downloads && stats.download_count >= settings.max_downloads) {
      res.writeHead(410);
      res.end('下载次数已用尽');
      return;
    }

    const folderPath = safePath(FILES_DIR, share.path);
    if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
      res.writeHead(404);
      res.end('文件夹不存在');
      return;
    }

    // 生成临时 zip
    const zipName = `${shareId}-${Date.now()}.zip`;
    const zipPath = path.join(TMP_DIR, zipName);
    try {
      const cmd = `cd "${folderPath}" && zip -r "${zipPath}" .`;
      await execAsync(cmd, { shell: '/bin/sh' });
    } catch (err) {
      console.error('zip 打包失败:', err);
      res.writeHead(500);
      res.end('打包失败');
      return;
    }

    stats.download_count = (stats.download_count || 0) + 1;
    saveData();
    addLog(shareId, share.path, req.socket.remoteAddress, req.headers['user-agent']);

    const stat = fs.statSync(zipPath);
    const encodedName = encodeURIComponent(path.basename(share.path) + '.zip');
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodedName}`
    });
    const stream = fs.createReadStream(zipPath);
    stream.pipe(res);
    stream.on('close', () => {
      fs.unlink(zipPath, () => {});
    });
    return;
  }

  // ----- API 路由 -----
  if (pathname === '/api/files' && method === 'GET') {
    const relPath = urlObj.searchParams.get('path') || '';
    try {
      const items = listDirectory(relPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, items }));
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  if (pathname === '/api/upload' && method === 'POST') {
    const relPath = urlObj.searchParams.get('path') || '';
    parseMultipart(req, (err, result) => {
      if (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: err.message }));
        return;
      }
      const filename = result.filename;
      try {
        const targetDir = safePath(FILES_DIR, relPath);
        if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: '目标目录不存在' }));
          return;
        }
        const targetPath = path.join(targetDir, filename);
        if (fs.existsSync(targetPath)) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: '文件已存在' }));
          return;
        }
        fs.writeFileSync(targetPath, result.data);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  if (pathname === '/api/folder' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const parent = params.get('path') || '';
      const name = params.get('name');
      if (!name) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: '缺少文件夹名' }));
        return;
      }
      try {
        const target = safePath(FILES_DIR, path.join(parent, name));
        if (fs.existsSync(target)) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: '已存在' }));
          return;
        }
        fs.mkdirSync(target, { recursive: true });
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  if (pathname === '/api/rename' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const oldPath = params.get('old');
      const newName = params.get('new');
      if (!oldPath || !newName) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: '参数缺失' }));
        return;
      }
      try {
        const oldFull = safePath(FILES_DIR, oldPath);
        if (!fs.existsSync(oldFull)) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: '原文件不存在' }));
          return;
        }
        const newFull = safePath(FILES_DIR, path.join(path.dirname(oldPath), newName));
        if (fs.existsSync(newFull)) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: '新名称已存在' }));
          return;
        }
        fs.renameSync(oldFull, newFull);
        // 更新分享路径
        const newRelPath = path.join(path.dirname(oldPath), newName).replace(/\\/g, '/');
        const share = getShareByPath(oldPath);
        if (share) {
          share.path = newRelPath;
          saveData();
        }
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  if (pathname === '/api/delete' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const target = params.get('path');
      if (!target) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: '缺少路径' }));
        return;
      }
      try {
        const full = safePath(FILES_DIR, target);
        if (!fs.existsSync(full)) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: '不存在' }));
          return;
        }
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          const files = fs.readdirSync(full);
          if (files.length > 0) {
            res.writeHead(400);
            res.end(JSON.stringify({ success: false, error: '文件夹非空' }));
            return;
          }
          fs.rmdirSync(full);
        } else {
          fs.unlinkSync(full);
        }
        deleteShareByPath(target);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  if (pathname === '/api/shares' && method === 'GET') {
    const list = Object.values(data.shares).map(s => ({
      shareId: s.shareId,
      path: s.path,
      type: s.type,
      created_at: s.created_at,
      ...s.settings,
      download_count: s.stats.download_count
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, shares: list }));
    return;
  }

  if (pathname === '/api/share' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const targetPath = params.get('path');
      const type = params.get('type');
      const password = params.get('password') || '';
      const expire_at = params.get('expire_at') || '';
      const max_downloads = params.get('max_downloads') ? parseInt(params.get('max_downloads')) : null;

      if (!targetPath || !type) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: '参数缺失' }));
        return;
      }
      if (getShareByPath(targetPath)) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: '该文件/文件夹已被分享' }));
        return;
      }
      const stat = getStat(targetPath);
      if (!stat.exists) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: '文件或文件夹不存在' }));
        return;
      }

      const shareId = generateId();
      const share = {
        shareId,
        path: targetPath,
        type,
        created_at: new Date().toISOString(),
        settings: {},
        stats: { download_count: 0 }
      };
      if (password) share.settings.password = password;
      if (expire_at) share.settings.expire_at = expire_at.replace('T', ' ') + ':00';
      if (max_downloads) share.settings.max_downloads = max_downloads;

      data.shares[shareId] = share;
      saveData();
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, shareId }));
    });
    return;
  }

  if (pathname === '/api/share/update' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const shareId = params.get('shareId');
      const password = params.get('password');
      const expire_at = params.get('expire_at');
      const max_downloads = params.get('max_downloads');

      const share = data.shares[shareId];
      if (!share) {
        res.writeHead(404);
        res.end(JSON.stringify({ success: false, error: '分享不存在' }));
        return;
      }

      if (password !== undefined) {
        if (password) share.settings.password = password;
        else delete share.settings.password;
      }
      if (expire_at !== undefined) {
        if (expire_at) share.settings.expire_at = expire_at.replace('T', ' ') + ':00';
        else delete share.settings.expire_at;
      }
      if (max_downloads !== undefined) {
        if (max_downloads) share.settings.max_downloads = parseInt(max_downloads);
        else delete share.settings.max_downloads;
      }
      saveData();
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }

  if (pathname === '/api/share/cancel' && method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const shareIds = params.get('shareIds') ? params.get('shareIds').split(',') : [];
      if (shareIds.length === 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: '缺少参数' }));
        return;
      }
      let count = 0;
      for (const sid of shareIds) {
        if (data.shares[sid]) {
          delete data.shares[sid];
          count++;
        }
      }
      if (count > 0) saveData();
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, count }));
    });
    return;
  }

  if (pathname === '/api/logs' && method === 'GET') {
    const shareId = urlObj.searchParams.get('shareId') || null;
    let logs = data.logs;
    if (shareId) {
      logs = logs.filter(l => l.shareId === shareId);
    }
    logs.sort((a, b) => new Date(b.time) - new Date(a.time));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, logs }));
    return;
  }

  // ========== 统计 API（供外部调用） ==========
  
  // --- /api/stats/total（总下载次数） ---
  if (pathname === '/api/stats/total' && method === 'GET') {
    // 可选鉴权
    const apiToken = process.env.API_TOKEN;
    if (apiToken) {
      const providedToken = urlObj.searchParams.get('token') || req.headers['x-api-token'];
      if (providedToken !== apiToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }
    // CORS
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
    const origin = req.headers.origin;
    if (allowedOrigins.length > 0 && origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET');
    }
    // 汇总
    const total = Object.values(data.shares).reduce((sum, s) => sum + (s.stats?.download_count || 0), 0);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ total_downloads: total }));
    return;
  }

  // --- /api/stats（所有分享统计） ---
  if (pathname === '/api/stats' && method === 'GET') {
    const apiToken = process.env.API_TOKEN;
    if (apiToken) {
      const providedToken = urlObj.searchParams.get('token') || req.headers['x-api-token'];
      if (providedToken !== apiToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
    const origin = req.headers.origin;
    if (allowedOrigins.length > 0 && origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET');
    }
    const total = Object.values(data.shares).reduce((sum, s) => sum + (s.stats?.download_count || 0), 0);
    const list = Object.entries(data.shares).map(([id, s]) => ({
      share_id: id,
      path: s.path,
      type: s.type,
      download_count: s.stats?.download_count || 0,
      max_downloads: s.settings?.max_downloads || null,
      remaining: s.settings?.max_downloads ? s.settings.max_downloads - (s.stats?.download_count || 0) : null,
      share_url: `http://${req.headers.host}/s/${id}`
    }));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({
      total_downloads: total,
      share_count: list.length,
      shares: list,
      updated_at: new Date().toISOString()
    }));
    return;
  }

  // --- /api/stats/:shareId（单个分享统计） ---
  const statMatch = pathname.match(/^\/api\/stats\/([a-f0-9]{6})$/);
  if (statMatch && method === 'GET') {
    const apiToken = process.env.API_TOKEN;
    if (apiToken) {
      const providedToken = urlObj.searchParams.get('token') || req.headers['x-api-token'];
      if (providedToken !== apiToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
    const origin = req.headers.origin;
    if (allowedOrigins.length > 0 && origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET');
    }
    const shareId = statMatch[1];
    const share = data.shares[shareId];
    if (!share) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Share not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({
      share_id: shareId,
      path: share.path,
      type: share.type,
      download_count: share.stats?.download_count || 0,
      max_downloads: share.settings?.max_downloads || null,
      remaining: share.settings?.max_downloads ? share.settings.max_downloads - (share.stats?.download_count || 0) : null,
      share_url: `http://${req.headers.host}/s/${shareId}`
    }));
    return;
  }
  // ========== 统计 API 结束 ==========


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
