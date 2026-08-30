# Security Policy · 安全策略

## English

This project sits in front of a private service on your machine — treat vulnerabilities
seriously.

- **Do not** open public issues for security problems (they may leak exploit details).
- Report privately via GitHub: repository → *Security* → *Report a vulnerability*, or email the
  owner (see the git commit author email).
- Please include: affected script/command, environment (OS/arch), reproduction steps, and the
  log segment (`dsh-web logs`).

What counts as a security issue here: auth-bypass of the password gate, cookie/token handling
flaws, secret leakage in repo or logs, command injection via `rc.env` values, tunnel exposure
without authentication.

Supported: latest `main`. Best effort for older commits.

## 中文

本项目挡在你机器上的私人服务前面，安全问题请严肃对待。

- **不要**在公开 issue 里描述安全问题（可能泄露利用细节）。
- 请通过 GitHub 私密上报：仓库 → *Security* → *Report a vulnerability*，或邮件联系仓库所有者
  （见 git 提交作者邮箱）。
- 请附：涉及脚本/命令、环境（系统/架构）、复现步骤、日志片段（`dsh-web logs`）。

属于安全问题的例子：密码门被绕过、Cookie/令牌处理缺陷、仓库或日志泄露密钥、`rc.env` 值导致
的命令注入、无认证的隧道暴露。

支持范围：最新 `main` 分支，旧提交尽力而为。
