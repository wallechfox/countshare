# CountShare 极简文件分享

一个极简的文件分享工具：把文件放进目录，生成下载链接，别人下载后你能看到下载次数和访问者信息。无需登录，无需数据库，单容器轻量部署。

![Docker Pulls](https://img.shields.io/badge/CountShare-v1.1-blue) ![GHCR](https://img.shields.io/badge/Registry-ghcr.io-green) ![License](https://img.shields.io/badge/License-MIT-yellow)

## ✨ 功能特性

- **极简分享**：把文件放入挂载目录，自动生成 6 位随机下载链接（如 `/d/a3f8k2`）
- **下载计数**：实时记录每个文件的下载次数
- **访问明细**：记录下载者的 IP、浏览器型号、下载时间（北京时间）
- **隐藏管理页**：通过随机/自定义路径查看所有文件状态和下载记录
- **单文件优化**：只分享一个文件时，页面以大卡片居中展示
- **文件信息页**：访问下载链接先展示文件详情，点击「下载文件」才触发下载
- **密码保护**：可为文件设置访问密码，支持前端弹窗/服务端验证两种模式
- **有效期限制**：可设置文件过期时间（北京时间），到期后文件自动移入 `_expired` 目录
- **下载次数限制**：可设置最大下载次数，用尽后文件自动移入 `_expired` 目录
- **配置文件**：`文件.meta.json` 与文件同目录，支持 `expire_at` / `max_downloads` / `password`
- **实时监听**：新增、删除、移动文件自动同步，无需重启服务
- **管理页增强**：
  - 过期时间快捷按钮（1天/3天/7天/自定义），自动计算北京时间
  - 复制链接按钮带「✅ 已复制」反馈
  - 文件日志筛选：点击文件行「📋 日志」仅查看该文件记录
  - 日志中已过期/已删除文件标记为红色
- **零依赖**：纯 Node.js 内置模块，不需要 `npm install`
- **极轻量**：基于 `node:20-alpine`，镜像仅约 50MB

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

> 💡 如果不设置 `ADMIN_PATH` 环境变量，程序会自动生成一个 **12 位随机路径**，通过 `docker logs countshare` 查看。

## 🔧 环境变量

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `ADMIN_PATH` | 随机生成（12位） | 管理页面的隐藏路径 |
| `PORT` | 8000 | 服务监听端口 |

## 📂 目录说明

| 容器路径 | 宿主机挂载建议 | 说明 |
|---|---|---|
| `/files` | `/www/countshare/files` | 放入要分享的文件，支持 `.meta.json` 配置文件 |
| `/files/_expired` | 自动创建 | 过期/次数用尽文件自动移入，可手动清理 |
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
- 对特定文件设置密码/有效期后分享
- 任何不需要复杂权限管理的文件分享需求

## 🔒 安全说明

- 管理页面路径完全随机且不公开，他人无法猜测
- 下载链接使用随机 ID，不暴露真实文件名
- 程序不进行路径遍历，无法访问 `/files` 目录之外的文件
- 管理页地址只存在于服务端，前端 HTML 中无任何泄露
- 密码在服务端比对，前端 JS 不包含密码明文
- `.meta.json` 配置文件不可通过 URL 直接访问

## 🐛 常见问题

**Q：时间显示不对，差 8 小时？**

A：程序已内置北京时间（+8h）修正，且管理页快捷按钮也基于 UTC 明确计算。如仍有问题请提交 Issue。

**Q：国内服务器拉取 GHCR 镜像慢？**

A：可使用公共加速前缀，例如：

```bash
docker pull ghcr.nju.edu.cn/wallechfox/countshare:latest
```

**Q：如何查看随机生成的管理页地址？**

A：运行 `docker logs countshare`，启动日志中会打印完整地址。

**Q：文件设置了有效期，到期后文件去哪了？**

A：文件会自动移入 `/files/_expired/` 目录，对应的 `.meta.json` 也会一起移动。你可以定期清理该目录。

**Q：如何给文件设置密码/有效期/次数限制？**

A：进入管理页，点击文件行的「⚙ 设置」按钮，在弹窗中配置即可。配置保存在 `文件.meta.json` 中，与文件同目录。

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
