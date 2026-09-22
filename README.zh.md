# sparkDash — 中文说明

> English: [README.md](./README.md) · 更新日志(中文): [CHANGELOG.zh.md](./CHANGELOG.zh.md)

多台 DGX Spark(GPU 一体机)的统一监控面板:实时 GPU / CPU / 内存 / 网络 / 存储曲线,LLM 推理速率与前后端延迟、ComfyUI 队列、Hermes Agent 版本巡检,以及远程开机 / 关机。

本文覆盖**部署、登录、账号管理、HTTPS、远程访问与排障**;功能细节、API 全表与设置项见英文 [README.md](./README.md)。

---

## 1. 快速开始(原生部署)

```bash
git clone https://github.com/zswll2/sparkDash.git && cd sparkDash
npm install
cp .env.example .env
npm run tls:gen                # 生成自签证书到 config/tls/(SAN 含本机 IP)
npm run auth:init -- zswll2    # 设置登录账号,密码交互输入、不回显
npm run build                  # 构建前端到 dist/
npm start                      # 或用 systemd:systemctl restart sparkdash
```

浏览器打开 `https://<服务器IP>:5555` → 提示证书不受信任(自签属正常)→ 信任后进入登录页。

---

## 2. 环境变量(`.env`)

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `5555` | HTTP/HTTPS 与 WebSocket 端口 |
| `BIND_HOST` | `127.0.0.1` | 监听地址。绑非本机地址时,**必须**有账号(`config/auth.json` 或下面的 `SPARKDASH_ADMIN_*`)或 `SPARKDASH_TOKEN`,否则拒绝启动 |
| `TLS_ENABLED` | `1` | 用 `config/tls/server.crt|key` 提供 HTTPS/WSS;设为 `0` 只允许绑本机 |
| `TLS_CERT_PATH` / `TLS_KEY_PATH` | `config/tls/server.{crt,key}` | 证书/私钥路径覆盖 |
| `SPARKDASH_ADMIN_USER` | `admin` | 账号名(与下面的密码变量配套) |
| `SPARKDASH_ADMIN_PASSWORD_HASH` | 空 | `npm run auth:hash` 输出的 `scrypt:N:r:p:<salt>:<hash>`;仅在 `config/auth.json` 不存在时生效 |
| `SPARKDASH_ADMIN_PASSWORD` | 空 | 明文便捷方式:首次启动自动种入 `config/auth.json`,之后请删掉该行并改用哈希 |
| `SPARKDASH_TOKEN` | 空 | 可选 Bearer 令牌,供脚本调用;与登录会话并存 |
| `TRUST_PROXY` | 空 | 反代/frpc 主机地址(IP 或 CIDR,逗号分隔),允许信任其 `X-Forwarded-For`。**不设则不信任该头**(防伪造),直连部署保持默认 |
| `SESSION_TTL_MS` | `43200000` | 登录会话有效期(12 小时,滑动续期) |
| `LOGIN_MAX_FAILS` / `LOGIN_LOCK_MS` | `5` / `900000` | 同一来源连错 5 次锁定 15 分钟 |
| `SPARKDASH_AUTH_JSON` | `config/auth.json` | 账号文件路径(测试用) |
| `SPARKDASH_SECRETS_KEY` | 自动生成 | SSH 密码加密密钥的口令或 64 位 hex,**不要删 `config/.secrets-key`** |

轮询间隔等其余变量见 [`.env.example`](./.env.example)。

---

## 3. 登录与安全

- **单账户**。凭据存在 `config/auth.json`:scrypt 加盐哈希(不可逆),文件权限必须是 `600`,权限过宽会**拒绝启动**。
- **会话**:12 小时滑动过期;服务重启即全部失效(内存会话,不落盘)。
- **Cookie**:`HttpOnly` + `SameSite=Strict`,HTTPS 下追加 `Secure`。
- **防盗用**:所有写请求校验请求来源,跨站请求直接 403。
- **防爆破**:同一来源连错 5 次锁 15 分钟,锁定期内即使密码正确也返回 429。
- **WebSocket**:`/ws` 使用同一套登录 Cookie,未登录直接拒绝。
- **匿名可访问**的只有:登录页与前端静态文件、`GET /api/auth/session`、`POST /api/auth/login`;其余 `/api/*` 一律需要登录。

---

## 4. 账号管理(三种方式)

**方式一:环境变量 + 哈希(推荐,方便分发)**

```bash
npm run auth:hash            # 输入密码(不回显)→ 打印两行
# 把这两行粘进 .env:
#   SPARKDASH_ADMIN_USER=zswll2
#   SPARKDASH_ADMIN_PASSWORD_HASH=scrypt:16384:8:1:<salt>:<hash>
chmod 600 .env               # 明文密码文件务必 600
systemctl restart sparkdash
```

磁盘上没有任何可还原密码的内容;同一份 `.env` 换台机器即可用同一账号登录。

**方式二:环境变量 + 明文(仅用于首次初始化)**

在 `.env` 写 `SPARKDASH_ADMIN_PASSWORD=<密码>`。首次启动会自动生成 `config/auth.json`(600),并在日志里提醒改用哈希、删除明文行。

**方式三:交互式改密(本机运维)**

```bash
cd /www/project/sparkDash && node tools/auth-init.mjs zswll2
```

**优先级**:只要 `config/auth.json` 存在,就以它为准,`SPARKDASH_ADMIN_*` 会被忽略。想让环境变量生效,先删除该文件(或改用方式三直接改文件)。

---

## 5. HTTPS

- `TLS_ENABLED=1`(默认)时用 `config/tls/` 下的自签证书提供 HTTPS/WSS;证书缺失会**拒绝启动**,不会静默退回明文。
- 生成证书:`npm run tls:gen`(SAN 默认含 `192.168.10.100`、`127.0.0.1`、`localhost`,有效期 825 天;已存在则不覆盖,`--force` 可强制重建)。
- 浏览器首次访问需手动信任自签证书;手机需安装该证书。
- 关掉 TLS 只允许绑 `127.0.0.1`(避免明文暴露到网络)。

---

## 6. 远程访问

- 默认只监听内网地址或 `127.0.0.1`。
- 需要从外部访问时:用 SSH 隧道(`ssh -N -L 5555:127.0.0.1:5555 root@<host>`,然后访问 `http://127.0.0.1:5555`),或放在带认证的反向代理 / Tailscale 后面。
- **不要把 5555 直接暴露到公网** —— 面板带有远程关机、改 SSH 密码等能力。

---

## 6.5 走反向代理对外开放(可选)

外部入口用 frps + nginx 443 + `*.simin.work` 真实证书,回源到应用的 5555(自签,需 `proxy_ssl_verify off`)。四条硬要求:

1. **隧道端口不要放进 ufw**:frps 的 ufw 默认 DROP,不开端口则公网连不上,但 nginx 走 loopback 可以 —— 应用端口对公网零暴露。
2. **把该隧道排除出 `frps-scan`**:该 jail 在 frps 上读 `/var/log/frps.log`,**60 秒内同 IP 对任意隧道连接 >3 次即永久封该 IP 全端口**。单页面板正常访问就会踩线,必须在该 jail 的 filter 忽略名单里加上隧道名(如 `SparkDash`)。
3. **必须设 `TRUST_PROXY=<frpc/nginx 地址>`**:反代后应用看到的来源全变成代理地址,不设会导致「一个人密码猜错 5 次 → 所有人被锁 15 分钟」,日志也失去真实来源。
4. **加 nginx 层限流**:`limit_req` 对 `/api/auth/login` 单独收紧;应用内限流只按来源 IP 计数,挡不住多 IP 分布式尝试。

安全提醒:这是能关机集群、改各节点 SSH 密码的面板。开放公网前请确认已加 2FA 或 IP 白名单类额外防护(当前版本没有)。

## 7. 常用命令

| 命令 | 用途 |
|---|---|
| `npm start` | 启动服务(生产用 systemd) |
| `npm run build` | 构建前端到 `dist/`(改前端后必须) |
| `npm test` | 服务端 + 前端测试 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run tls:gen` | 生成自签证书 |
| `npm run auth:init -- <user>` | 交互式设置/修改账号 |
| `npm run auth:hash` | 生成 `SPARKDASH_ADMIN_PASSWORD_HASH` |
| `npm run i18n:extract` / `i18n:build` / `i18n:check` | 界面文案与中文字典 |

---

## 8. 排障与回滚

**服务起不来** → `journalctl -u sparkdash -n 50`,常见原因(都会明确报错并拒绝启动):

| 报错关键词 | 处理 |
|---|---|
| `certificate files are missing` | 跑 `npm run tls:gen` |
| `Refusing auth.json with insecure permissions` | `chmod 600 config/auth.json` |
| `SPARKDASH_ADMIN_PASSWORD_HASH must look like scrypt:...` | 用 `npm run auth:hash` 重新生成 |
| `Remote bind ... requires` | 配账号或 `SPARKDASH_TOKEN`,或改回 `BIND_HOST=127.0.0.1` |

**忘记密码** → `node tools/auth-init.mjs <user>` 重设。

**回滚** → 恢复 `.env` 备份 → `git checkout <上一个可用提交>` → `systemctl restart sparkdash`。注意:单独删除 `config/auth.json` 会让服务按设计拒绝启动。

---

## 9. 上线自查清单

- [ ] `.env` 权限 `600`(含明文密码时必须)
- [ ] `git check-ignore config/auth.json config/tls/server.key` 命中(私钥与密码哈希不入库)
- [ ] 5555 仅在内网或隧道/反代之后可达
- [ ] 已修改初始密码,并确认登录、登出、限流都符合预期
