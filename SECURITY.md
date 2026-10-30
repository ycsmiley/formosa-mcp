# 安全政策 / Security policy

## 繁體中文

支援版本：最新的 npm 發行版本（0.1.x）。請透過 [GitHub Security Advisories 的「Report a vulnerability」](https://github.com/ycsmiley/formosa-mcp/security/advisories/new) 私下通報漏洞，勿開公開 issue。

請勿在通報、issue 或聊天中貼上 API 金鑰或 token（包括 TDX、Cloudflare、GitHub fine-grained PAT，即 Worker secret `GH_DISPATCH_TOKEN`）。若金鑰已外洩，請先向供應商撤銷並重新產生。

本機 npx 伺服器只在程序記憶體中保存 TDX 金鑰，不會記錄金鑰；遠端 Worker 只讀取快取快照，並依 IP 限制請求速率。

## English

Supported version: the latest npm release (0.1.x). Report vulnerabilities privately through [GitHub Security Advisories using “Report a vulnerability”](https://github.com/ycsmiley/formosa-mcp/security/advisories/new); do not open public issues.

Never paste API keys or tokens (including TDX, Cloudflare, and the GitHub fine-grained PAT stored as Worker secret `GH_DISPATCH_TOKEN`) into reports, issues, or chats. If a key has been exposed, revoke and regenerate it at the provider first.

The local npx server keeps TDX keys only in process memory and never logs them. The remote Worker reads only cached snapshots and is rate limited per IP.
