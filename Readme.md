# CountShare 极简文件分享 V2.4

一个极简的文件分享工具：上传文件或文件夹到服务器，生成分享链接，别人下载后你能看到下载次数和访问者信息。无需登录，无需数据库，单容器轻量部署。

![CountShare](https://img.shields.io/badge/CountShare-v2.4-blue) ![Docker Hub](https://img.shields.io/badge/Registry-docker.io-blue) ![GHCR](https://img.shields.io/badge/Registry-ghcr.io-green) ![License](https://img.shields.io/badge/License-MIT-yellow)

## ✨ 功能特性

- **主动分享**：通过管理页选择文件或文件夹，主动创建分享链接
- **文件夹分享**：支持分享整个文件夹，子文件可单独下载，也可一键打包下载（zip）
- **灵活的分享设置**：每个分享项可独立设置密码、有效期、最大下载次数
- **下载计数**：实时记录每个分享项的下载次数
- **访问明细（v2.3 增强）**：同时记录**访客 IP、直连 IP、完整代理链、浏览器型号、下载时间（北京时间）**，完美兼容直连与 Nginx 反代环境
- **下载记录后端分页（v2.4 新增）**：下载记录改为后端分页，支持每页 50 / 100 / 200 条切换，可翻页浏览任意历史记录；前端不再一次性加载全量数据，轻松应对上万条记录，便于后续扩展
- **隐藏管理页**：通过随机/自定义路径访问管理面板
- **文件管理器**：在管理页直接上传文件、新建文件夹、重命名、删除
- **密码保护**：可为文件或文件夹设置访问密码，支持服务端验证
- **有效期限制**：可设置分享链接的过期时间（北京时间），过期后提示用户
- **下载次数限制**：可设置最大下载次数，用尽后自动提示
- **数据集中存储**：所有分享配置和下载记录统一存储在 `data.json` 中
- **统计 API（v2.1 新增）**：通过 RESTful API 暴露下载统计，支持 Token 鉴权，方便同服务器其他 Docker 容器或外部网站调用读取
- **三 IP 记录（v2.3 新增）**：下载日志同时保存访客 IP、直连 IP、代理链，反代环境下一目了然
- **零依赖**：纯 Node.js 内置模块，不需要 `npm install`
- **极轻量**：基于 `node:20-alpine`，镜像约 50MB（解压后约 129MB）
- **多架构支持**：单次构建产出 amd64 + arm64 双架构原生镜像，x64 服务器与树莓派等 ARM 设备均可一行命令拉取运行

## 🐳 镜像仓库

| 仓库 | 地址 | 说明 |
|------|------|------|
| **Docker Hub（推荐）** | `wallechfox/countshare:latest` | 国内拉取速度通常优于 GHCR |
| GitHub Container Registry | `ghcr.io/wallechfox/countshare:latest` | 备选仓库，与 Docker Hub 内容完全一致 |

> 💡 **推荐优先使用 Docker Hub**：两个仓库的镜像内容、版本、Tag 完全一致，可任选其一。

## 🚀 快速开始

### 方式一：Docker Run

```bash
# 1. 拉取镜像（Docker Hub，推荐）
docker pull wallechfox/countshare:latest

# 2. 运行容器
docker run -d \
  --name countshare \
  -p 8000:8000 \
  -v /www/countshare/files:/files \
  -v countshare-data:/data \
  -e ADMIN_PATH=my-secret-admin \
  -e API_TOKEN=你的随机长密码 \
  --restart unless-stopped \
  wallechfox/countshare:latest
```

> 如需使用 GHCR 备选仓库，把镜像名换成 `ghcr.io/wallechfox/countshare:latest` 即可，其余参数完全一致。

> ⚠️ **安全提醒**：`API_TOKEN` 用于保护统计 API 不被未授权访问。如果不设置，统计 API 将完全开放，**任何人都可以读取你的下载数据**。强烈建议设置。

### 方式二：Docker Compose

```yaml
version: "3.8"

services:
  countshare:
    image: wallechfox/countshare:latest       # Docker Hub（推荐）
    # image: ghcr.io/wallechfox/countshare:latest  # 备选：GHCR
    container_name: countshare
    ports:
      - "8000:8000"
    volumes:
      - /www/countshare/files:/files
      - countshare-data:/data
    environment:
      - ADMIN_PATH=my-secret-admin
      - API_TOKEN=你的随机长密码
      # - ALLOWED_ORIGINS=https://your-site.com,https://another-site.com
    restart: unless-stopped

volumes:
  countshare-data:
```

> 💡 **关于 `ADMIN_PATH`**：此环境变量用于指定管理页面的访问路径。如果你设置 `-e ADMIN_PATH=my-secret-admin`，则管理页地址为 `http://你的服务器IP:8000/my-secret-admin`。**如果不设置**，系统会自动生成一个 12 位随机字符串作为路径（如 `a3f8k2d1e5f6`），启动日志中会打印完整地址。建议首次使用后设置为固定值，方便记忆。

## 📖 详细使用指南

### 第一步：启动容器并获取管理地址

启动容器后，查看启动日志获取管理页地址：

```bash
docker logs countshare
```

输出示例：

```
========================================
  CountShare running
  FILES_DIR = /files
  DATA_DIR  = /data
  PORT      = 8000
  首页      : http://localhost:8000
  管理页    : http://localhost:8000/a3f8k2d1e5f6
========================================
```

如果设置了 `ADMIN_PATH=my-secret-admin`，管理页地址则为 `http://localhost:8000/my-secret-admin`。

### 第二步：访问管理页

在浏览器中打开管理页地址，你会看到三个主要区域：

1. **文件列表**：显示 `/files` 目录下的所有文件和文件夹
2. **分享列表**：显示所有已创建的分享链接及其状态
3. **下载记录**：显示所有文件的下载历史

### 第三步：上传文件或新建文件夹

在「文件列表」区域顶部，有三个操作按钮：

- **上传**：点击后选择本地文件，上传到当前目录
- **新建文件夹**：在当前目录创建一个新文件夹
- **刷新**：刷新文件列表

你可以像使用文件管理器一样，点击文件夹名称进入子目录，点击面包屑导航返回上级目录。

### 第四步：创建分享链接

在文件列表中，每个文件或文件夹右侧都有一个「分享」按钮：

1. 点击目标文件或文件夹的「分享」按钮
2. 在弹出的对话框中配置分享参数：
   - **密码**（可选）：设置访问密码，留空则无需密码
   - **过期时间**（可选）：点击「1天/3天/7天」快捷按钮，或手动选择日期时间
   - **最大下载次数**（可选）：设置允许下载的总次数，留空则不限制
3. 点击「确认分享」，系统会生成一个 6 位随机 ID 的分享链接
4. 弹窗会显示完整的分享链接，点击「确定」后即可复制使用

分享链接格式：`http://你的服务器IP:8000/s/abc123`

### 第五步：管理已创建的分享

在「分享列表」区域，你可以：

- **查看所有分享**：列表显示路径、状态（正常/已过期/次数用尽）、是否有密码、有效期、下载情况
- **复制链接**：点击「复制」按钮，链接会自动复制到剪贴板（v2.2 起兼容 HTTP / HTTPS 环境）
- **修改设置**：点击「设置」按钮，可修改密码、有效期、最大下载次数
- **取消分享**：点击「取消」按钮，该分享链接将立即失效
- **批量取消**：勾选多个分享项，点击「批量取消」一次性取消多个分享

### 第六步：查看下载记录

在「下载记录」区域（v2.3 已升级为三列 IP，v2.4 升级为后端分页）：

- 默认显示最近 50 条记录，可按时间倒序翻页浏览**全部**历史记录
- 可通过下拉菜单筛选特定分享链接的下载记录
- 每条记录包含：**下载时间、文件名、访客 IP、直连 IP、代理链、浏览器型号**
- 分页栏支持切换每页条数（50 / 100 / 200 条），并提供首页 / 上一页 / 下一页 / 末页按钮
- 切换筛选条件时自动回到第一页；点击刷新保留在当前页

> 💡 **为何要分页**：早期版本会把全部下载记录一次性加载到浏览器，记录多了既慢又占内存。v2.4 改为后端分页，每次只请求当前页数据，记录再多也流畅，并为未来按时间区间查询、导出等扩展打好基础。

> 三列 IP 的含义：经 Nginx 等反代时，「访客 IP」取自 `X-Forwarded-For` 最左值（真实访客），「直连 IP」为 TCP 对端（反代时为 Nginx 的 `127.0.0.1`），「代理链」为完整 `X-Forwarded-For` 内容。直连环境下「访客 IP」与「直连 IP」相同。旧版记录的新字段显示 `-`，完全兼容。

## 📊 统计 API（v2.1 新增）

CountShare 提供了只读的统计 API，方便你在同服务器的其他 Docker 容器、网站后端或前端页面中读取下载数据。

### 端点列表

| 端点 | 说明 | 返回示例 |
|------|------|----------|
| `GET /api/stats/total` | 获取总下载次数 | `{"total_downloads": 42}` |
| `GET /api/stats` | 获取所有分享的统计 | 包含每个分享的下载次数、剩余次数等 |
| `GET /api/stats/shareId` | 获取单个分享的统计 | 包含文件名、下载次数、分享链接等 |
| `GET /api/logs` | 获取下载记录（v2.4 分页） | 见下方「分页参数」 |

### 下载记录分页（v2.4 新增）

`GET /api/logs` 现支持分页查询，便于前端按需加载：

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `shareId` | string | 无 | 可选，按分享项筛选 |
| `page` | int | `1` | 页码，从 1 开始 |
| `size` | int | `50` | 每页条数，最大 500 |

响应体：

```json
{
  "success": true,
  "logs": [ { "time": "...", "ip": "...", "ua": "...", ... } ],
  "total": 1234,
  "page": 1,
  "size": 50
}
```

同时会在响应头中返回总数与分页信息：`X-Total-Count`、`X-Page`、`X-Page-Size`。

> 调用示例：`curl "http://localhost:8000/api/logs?page=2&size=100"`

> 结果默认按时间**倒序**（最新的在前）。不传 `page` / `size` 时返回第一页 50 条，**向后兼容**旧调用方。

### 鉴权方式

如果设置了环境变量 `API_TOKEN`，所有 `/api/` 请求**必须**携带 Token，否则返回 `401 Unauthorized`。

**方式一：URL 参数**

```bash
curl "http://localhost:8000/api/stats/total?token=你的随机长密码"
```

**方式二：HTTP Header**

```bash
curl -H "X-API-Token: 你的随机长密码" http://localhost:8000/api/stats/total
```

> ⚠️ **如果不设置 `API_TOKEN`，API 将完全开放，任何人都可以访问。** 生产环境务必设置。

### 🔒 推荐用法：Nginx 反代 + 隐藏 Token（v2.3 建议）

如果你的网站前端需要展示下载次数，**不建议**在前端 JS 里直接带 Token（会被用户看到）。推荐用 Nginx 反代，由服务端自动注入 Token：

**宝塔反向代理配置示例：**

```nginx
location /cs-api {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # ★ 服务器端自动注入 Token，前端完全不感知 ★
    proxy_set_header X-API-Token 你的随机长密码;
}
```

**前端调用（不带 Token，安全）：**

```javascript
fetch('/cs-api/api/stats/total')
  .then(r => r.json())
  .then(data => {
    document.getElementById('download-count').textContent = data.total_downloads;
  });
```

如需进一步限制，只允许透传特定端点（如仅 `/api/stats/total`），可在 Nginx 中精确匹配，其余路径直接 `return 403`。这样即使反代地址暴露，也不会泄露单个分享的明细。

### 跨域（CORS）配置

如果你的前端页面（JavaScript）需要**绕过反代、直接**调用 CountShare 的 API，需要设置 `ALLOWED_ORIGINS` 环境变量：

```bash
-e ALLOWED_ORIGINS=https://your-site.com,https://www.your-site.com
```

设置后，浏览器跨域请求将被允许。未设置的域名会被浏览器拦截。**若已采用上方 Nginx 反代方案（同域调用），则无需设置此项。**

### 调用示例

**同服务器其他 Docker 容器调用**（两个容器在同一网络）：

```bash
curl http://countshare:8000/api/stats/total?token=你的随机长密码
```

**服务器本机调用**：

```bash
curl http://localhost:8000/api/stats/total?token=你的随机长密码
```

**前端 JavaScript 调用**（直连 API，需配合 `ALLOWED_ORIGINS`）：

```javascript
fetch('https://your-domain.com:8000/api/stats/total', {
  headers: { 'X-API-Token': '你的随机长密码' }
})
.then(r => r.json())
.then(data => {
  console.log('总下载次数:', data.total_downloads);
});
```

## 🔧 环境变量

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `ADMIN_PATH` | 随机生成（12位） | 管理页面的访问路径。设置后管理地址为 `/你的路径`，不设置则随机生成并在日志中打印 |
| `API_TOKEN` | 无（不鉴权） | **统计 API 的访问 Token**。设置后，所有 `/api/stats` 请求必须携带此 Token。强烈建议设置 |
| `ALLOWED_ORIGINS` | 无（不跨域） | 允许跨域访问 API 的网站域名，逗号分隔。仅在需要浏览器前端直接调用 API 时设置 |
| `PORT` | 8000 | 服务监听端口 |

## 📂 目录说明

| 容器路径 | 宿主机挂载建议 | 说明 |
|---|---|---|
| `/files` | `/www/countshare/files` | 存放要分享的文件和文件夹 |
| `/data` | 匿名 volume `countshare-data` | 持久化存储 `data.json`（分享配置和下载记录） |

## 📋 使用场景

- 临时分享一个文件给客户或朋友
- 分享整个文件夹（如资料包、代码仓库、照片合集）
- 发布软件安装包并统计下载量
- 分享文档/资料并了解谁下载了
- 对敏感文件设置密码保护
- **（v2.1）** 通过 API 将下载次数集成到自己的网站或监控面板中
- **（v2.3）** 经 Nginx 反代部署，借助三 IP 记录精准识别真实访客与代理链路
- **（v2.4）** 下载记录海量时，借助后端分页顺畅翻页查阅任意历史
- 任何不需要复杂权限管理的文件分享需求

## 🔒 安全说明

- 管理页面路径完全随机且不公开，他人无法猜测
- 下载链接使用随机 ID，不暴露真实文件名
- 程序不进行路径遍历，无法访问 `/files` 目录之外的文件
- 管理页地址只存在于服务端，前端 HTML 中无任何泄露
- 密码在服务端比对，前端 JS 不包含密码明文
- **统计 API 支持 Token 鉴权**：设置 `API_TOKEN` 后，只有持有 Token 的调用方才能读取统计数据
- **X-Forwarded-For 可信链**：`ip` 取 `forwarded_for` 最左值，**仅在可信反代后安全**。若 CountShare 同时可被公网直连，恶意客户端可伪造该头；建议上 Nginx 后仅对可信代理解析。详情见 [UPGRADE-v2.2-to-v2.3.md](UPGRADE-v2.2-to-v2.3.md)
- **分页接口防护**：`/api/logs` 的 `size` 参数上限为 500，防止一次性拉取过量数据导致内存压力
- 所有配置和日志集中在 `data.json`，便于备份和管理

## 🐛 常见问题

**Q：时间显示不对，差 8 小时？**

A：程序已内置北京时间（+8h）修正。如仍有问题请提交 Issue。

**Q：国内服务器拉取镜像慢？**

A：推荐从 Docker Hub 拉取（`wallechfox/countshare:latest`）。如 Docker Hub 访问受限，可使用 GHCR 备选：
```bash
docker pull ghcr.io/wallechfox/countshare:latest
```
或使用公共加速前缀：
```bash
docker pull ghcr.nju.edu.cn/wallechfox/countshare:latest
```

**Q：GitHub 推送代码后，Docker Hub 镜像会自动更新吗？**

A：是的。仓库已配置 GitHub Actions 工作流（`docker-publish.yml`），每次 push 到 `main` 分支时，会自动构建并推送镜像到 Docker Hub。同时 `build.yml` 会同步推送到 GHCR，两个 registry 都会更新。

**Q：如何查看随机生成的管理页地址？**

A：运行 `docker logs countshare`，启动日志中会打印完整地址。

**Q：分享的文件过期后会怎样？**

A：过期或次数用尽的文件不会自动移走，而是保留在原位置。用户访问时会提示「链接已过期」或「下载次数已用尽」。

**Q：如何给文件设置密码/有效期/次数限制？**

A：在管理页的文件列表中，点击文件行的「分享」按钮，在弹窗中配置即可。已分享的项可在「分享列表」中点击「设置」修改参数。

**Q：统计 API 不设置 API_TOKEN 会有风险吗？**

A：是的。如果不设置 `API_TOKEN`，任何人只要知道你的服务器地址和端口，就可以直接访问 `/api/stats` 获取所有分享的下载数据。生产环境**务必设置 `API_TOKEN`**。若前端需要展示，建议采用上方「Nginx 反代 + 隐藏 Token」方案。

**Q：下载记录里的「直连 IP」和「访客 IP」有什么区别？**

A：直连 IP 是 TCP 层的真实对端；经过 Nginx 等反代时，它变成代理服务器的 IP（如 `127.0.0.1`），而「访客 IP」会从 `X-Forwarded-For` 里解析出真实访客。两者结合可以一眼判断请求是否经过了代理。详见 [UPGRADE-v2.2-to-v2.3.md](UPGRADE-v2.2-to-v2.3.md)。

**Q：下载记录改成分页后，我之前的数据会丢吗？**

A：不会。`data.json` 结构完全兼容，v2.4 只是改变了读取和展示方式，历史记录全部保留，分页接口对旧调用方也向后兼容（不传 `page`/`size` 即返回第一页 50 条）。

**Q：如何更新到最新版本？**

A：见 [UPGRADE.md](UPGRADE.md) 升级说明。

## 📜 开源协议

[MIT](LICENSE) © 2026 wallechfox

---

⭐ 如果这个项目对你有帮助，欢迎 Star 和 Fork！
