# 更新日志(中文)

> 完整英文条目见 [CHANGELOG.md](./CHANGELOG.md)。本文件记录 **zswll2 fork** 相对上游 `MiaAI-Lab/sparkDash` 的变更,供内部运维查阅。

---

## 2026-09-21 — 登录认证 + 自签 HTTPS + 环境变量账号

### 新增

- **单账户登录**:用户名 + 密码(密码以 scrypt 加盐哈希存入 `config/auth.json`,权限强制 600)。
- **Cookie 会话**:`HttpOnly` + `SameSite=Strict`,HTTPS 下带 `Secure`;12 小时滑动过期,服务重启即失效。
- **登录限流**:同一来源连错 5 次锁定 15 分钟;错误提示统一为 `Invalid credentials`(不区分账号不存在与密码错误)。
- **跨站写保护**:所有写请求校验请求来源,跨站请求返回 403。
- **WebSocket 鉴权**:`/ws` 使用同一套登录会话,未登录直接拒绝。
- **自签 HTTPS/WSS**:`TLS_ENABLED=1`(默认)从 `config/tls/` 读取证书;证书缺失拒绝启动;`TLS_ENABLED=0` 仅允许绑本机。
- **环境变量提供账号**:`SPARKDASH_ADMIN_USER` + `SPARKDASH_ADMIN_PASSWORD_HASH`(由 `npm run auth:hash` 生成,磁盘无可还原内容);便捷的明文 `SPARKDASH_ADMIN_PASSWORD` 仅用于首次初始化,会自动种入 `config/auth.json` 并在启动日志提醒改用哈希。
- **配套工具**:`npm run auth:init`(交互式设置/改密)、`npm run auth:hash`(生成哈希)、`npm run tls:gen`(生成证书)。
- **中文文档**:本文件与 [README.zh.md](./README.zh.md)。

### 新增(反代支持)

- **反代后识别真实客户端 IP**:新增 `TRUST_PROXY`(IP/CIDR 列表)。设置后,登录限流、loopback 判定与日志均使用真实来源地址;不设置则完全忽略 `X-Forwarded-For`,直连部署无法伪造 IP 绕过限流。
  背景:接入 nginx 反代后,应用看到的来源全部变成代理地址,会导致「一个人密码猜错 5 次 → 全体被锁 15 分钟」,且日志失去真实来源。

### 修复

- **测试隔离**:三个测试原先依赖"运行环境里没有账号 / 证书",在配置齐全的部署机上必然失败;现改为显式指向临时路径。
- **WebSocket 快照用例竞态**:原先在连接 `open` 时立刻关闭,再等待消息,导致快照丢失 / 超时;现改为先注册监听再等待。
- **登录字段兼容**:登录接口同时接受 `username` 与 `user` 两种字段名。

### 安全(相对上游的语义变化)

- **移除 fail-open**:绑定非本机地址且既无账号、又无 `SPARKDASH_TOKEN` 时**拒绝启动**(上游默认放行所有请求)。
- 未认证状态下不再能读写任何 `/api/*` 与 `/ws`;匿名仅可访问登录页、前端静态文件、`GET /api/auth/session`、`POST /api/auth/login`。
- **`.gitignore` 加固**:`.env.*` 各变体(保留 `.env.example`)、`config/auth.json*`、`config/*.password.txt`、`*.key`、`*.pem`、`*.bak` 一律不入库。

### 说明

- 上游英文 README 声称"HTTP/WebSocket API 没有应用认证",该表述已在本分支更新为登录说明。
- `typecheck` 仍有 9 个错误,全部位于 `src/components/OverviewPage/OverviewPage.tsx`,为 `main` 基线既有问题,与本次改动无关。
