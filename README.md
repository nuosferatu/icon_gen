# 画境 · 图像预设工作室

一个 Cloudflare Worker + HTML 应用：使用 DeepSeek Chat Completions 生成 SVG 图标，支持多轮修改、访问密码、结构化预设整理和 D1 存储。DeepSeek 生成的是 SVG 代码，适合图标和矢量插画，效果与专门的照片生成模型不同。

D1 持久化结构化预设，不保存图片和未保存的对话；图片可以下载为 SVG。

## 部署

需要 Node.js、Cloudflare 账户和 DeepSeek API Key。Workers、D1 和 DeepSeek 的使用可能产生费用，请查看各服务的计费规则。

1. 安装并登录：

   ```sh
   npm install
   npx wrangler login
   npx wrangler whoami
   ```

2. 创建持久化数据库：

   ```sh
   npx wrangler d1 create image-preset-studio
   ```

   将命令输出中的 `database_id` 填入 `wrangler.jsonc`，替换 `REPLACE_WITH_D1_DATABASE_ID`。如果 Worker 名称与已有项目冲突，也请修改该文件中的 `name`。

3. 初始化远程数据库：

   ```sh
   npx wrangler d1 migrations apply image-preset-studio --remote
   ```

4. 配置服务端密钥（按照交互提示输入；不要把密钥提交到仓库）：

   ```sh
   npx wrangler secret put APP_PASSWORD
   npx wrangler secret put DEEPSEEK_API_KEY
   ```

   `APP_PASSWORD` 为工作室的共享访问密码，至少 16 个字符，建议使用随机长密码。所有使用该密码的访问者共享全部预设。密钥保存在 Worker 服务端，不发送给浏览器。登录会话有效期为 7 天，退出登录可撤销当前会话。更换密码不会自动撤销其他已有会话；如需立即撤销，可清空 D1 的 `sessions` 表。

5. 构建检查并部署：

   ```sh
   npm run check
   npm run deploy
   ```

   使用 Wrangler 输出的 `workers.dev` 地址访问。部署时如提示配置 workers.dev 子域，请按 Cloudflare 提示操作。

## 本地开发

将 `wrangler.jsonc` 中的 D1 ID 配置好后：

```sh
npx wrangler d1 migrations apply image-preset-studio --local
```

在项目根目录创建 `.dev.vars`，内容如下（不要提交该文件）：

```dotenv
APP_PASSWORD=替换为至少16字符的随机密码
DEEPSEEK_API_KEY=替换为你的DeepSeek密钥
```

运行 `npm run dev`。本地 D1 与远程 D1 相互独立。DeepSeek 使用真实远程调用。`npm test` 运行不依赖外部服务的接口测试。

可选：配置 Worker 环境变量 `DEEPSEEK_MODEL` 来更换 DeepSeek 模型；默认为 `deepseek-flash`。模型需要支持 Chat Completions JSON 模式。

## 安全和限制

这是单用户或可信小组使用的共享密码应用，不提供用户隔离、密码重置或多因素认证。会话存放在 D1，Cookie 使用 HttpOnly、SameSite=Strict，HTTPS 下启用 Secure；写入请求校验 Origin，登录按客户端 IP 限制尝试次数。对公网使用时，建议额外通过 Cloudflare Access 和 WAF 保护，并定期备份 D1。API 的使用会产生外部调用费用。对话仅保留在当前页面内，刷新或开始新创作会丢失；预设是独立保存的。多轮修改会把上一版 SVG 发给 DeepSeek；预设保存创作规范，不保存 SVG 原图。
