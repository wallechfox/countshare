# CountShare 极简文件分享

一个极简的文件分享工具：把文件放进目录，生成下载链接，别人下载后你能看到下载次数和访问者信息。无需登录，无需数据库，单容器轻量部署。

![Docker Pulls](https://img.shields.io/badge/CountShare-v1.0-blue) ![GHCR](https://img.shields.io/badge/Registry-ghcr.io-green) ![License](https://img.shields.io/badge/License-MIT-yellow)

## ✨ 功能特性

- **极简分享**：把文件放入挂载目录，自动生成下载链接
- **下载计数**：实时记录每个文件的下载次数
- **访问明细**：记录下载者的 IP、浏览器型号、下载时间（北京时间）
- **隐藏管理页**：通过一个不公开的 URL 查看所有下载数据
- **单文件优化**：只分享一个文件时，页面以大卡片居中展示
- **零依赖**：纯 Node.js 内置模块，不需要 `npm install`
- **极轻量**：基于 `node:20-alpine`，镜像仅约 50MB
- **自动清理**：文件被移动或删除后，页面自动同步

## 🚀 快速开始

### 方式一：Docker Run

```bash
docker run -d \
  --name countshare \
  -p 8000:8000 \
  -v /www/countshare/files:/files \
  -v countshare-data:/data \
  -e ADMIN_PATH=my-secret-admin \
  --restart unless-stopped \
  ghcr.io/wallechfox/countshare:latest
```

### 方式二：Docker Compose

```yaml
version: "3.8"

services:
  countshare:
    image: ghcr.io/wallechfox/countshare:latest
    container_name: countshare
    ports:
      - "8000:8000"
    volumes:
      - /www/countshare/files:/files
      - countshare-data:/data
    environment:
      - ADMIN_PATH=my-secret-admin
    restart: unless-stopped

volumes:
  countshare-data:
```

启动后：

1. 把要分享的文件放入 `/www/countshare/files/` 目录
2. 浏览器访问 `http://你的服务器IP:8000` 查看下载页
3. 管理页访问 `http://你的服务器IP:8000/my-secret-admin` 查看下载明细

> 💡 如果不设置 `ADMIN_PATH` 环境变量，程序会自动生成一个随机路径，通过 `docker logs countshare` 查看。

## 🔧 环境变量

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `ADMIN_PATH` | 随机生成 | 管理页面的隐藏路径 |
| `PORT` | 8000 | 服务监听端口 |

## 📂 目录说明

| 容器路径 | 宿主机挂载建议 | 说明 |
|---|---|---|
| `/files` | `/www/countshare/files` | 放入要分享的文件 |
| `/data` | 匿名 volume `countshare-data` | 下载计数和访问记录持久化存储 |

## 🎨 自定义页面

页面模板位于容器内的 `public/` 目录：

- `public/index.html` — 公开下载页
- `public/admin.html` — 隐藏管理页

如果需要自定义样式，可以通过挂载替换：

```bash
docker run -d \
  --name countshare \
  -p 8000:8000 \
  -v /www/countshare/files:/files \
  -v countshare-data:/data \
  -v /www/countshare/public/index.html:/app/public/index.html \
  -v /www/countshare/public/admin.html:/app/public/admin.html \
  -e ADMIN_PATH=my-secret-admin \
  --restart unless-stopped \
  ghcr.io/wallechfox/countshare:latest
```

修改宿主机上的 HTML 文件后，执行 `docker restart countshare` 即可生效，无需重新构建镜像。

## 📋 使用场景

- 临时分享一个大文件给客户/朋友
- 发布软件安装包并统计下载量
- 分享文档/资料并了解谁下载了
- 任何不需要复杂权限管理的文件分享需求

## 🔒 安全说明

- 管理页面路径完全随机且不公开，他人无法猜测
- 下载链接使用随机 ID，不暴露真实文件名
- 程序不进行路径遍历，无法访问 `/files` 目录之外的文件
- 管理页地址只存在于服务端，前端 HTML 中无任何泄露

## 🐛 常见问题

**Q：时间显示不对，差 8 小时？**

A：程序已内置北京时间（+8h）修正，如仍有问题请提交 Issue。

**Q：国内服务器拉取 GHCR 镜像慢？**

A：可使用公共加速前缀，例如：

```bash
docker pull ghcr.nju.edu.cn/wallechfox/countshare:latest
```

**Q：如何更新到最新版本？**

A：重新拉取镜像并重启：

```bash
docker pull ghcr.io/wallechfox/countshare:latest
docker stop countshare && docker rm countshare
docker run -d \
  --name countshare \
  -p 8000:8000 \
  -v /www/countshare/files:/files \
  -v countshare-data:/data \
  -e ADMIN_PATH=my-secret-admin \
  --restart unless-stopped \
  ghcr.io/wallechfox/countshare:latest
```

## 📜 开源协议

[MIT](LICENSE) © 2026 wallechfox

---

⭐ 如果这个项目对你有帮助，欢迎 Star 和 Fork！
