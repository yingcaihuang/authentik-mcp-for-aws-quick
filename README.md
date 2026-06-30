# authentik-aws-mcp

用于通过 `https://authsso.verycloud.cn/api/v3/` 管理 authentik 的 MCP Server。

支持：

- 列出组
- 添加组
- 创建用户
- 删除用户
- 批量删除用户
- 列出用户
- 禁用/启用用户
- 用户存在则更新，不存在则创建（upsert）
- 在组中添加用户
- 从组中移除用户
- 同步用户组（merge/replace）
- 默认开通用户（创建用户并加入默认组）
- 一句话开通并自动加组（组不存在自动创建，返回随机密码）
- 批量一句话开通（批量创建并加入同组）
- 重置用户密码（支持自动生成随机密码并返回）
- 批量重置用户密码（支持 email/username/user_pk 混合输入）
- 强制重置并尝试发送邮件通知

服务脚本：`authentik-aws-mcp.mjs`

---

## 1) 安装依赖

在项目目录执行：

```bash
npm init -y
npm i @modelcontextprotocol/sdk zod
npm pkg set type=module
```

---

## 2) MCP 配置示例（token 从 JSON 传入）

将以下配置加入你的 MCP 客户端配置文件：

```json
{
  "mcpServers": {
    "authentik-aws": {
      "command": "node",
      "args": [
        "/Users/betty/Downloads/authentik-mcp-for-aws-quick/authentik-aws-mcp.mjs"
      ],
      "env": {
        "AUTHENTIK_BASE_URL": "https://authsso.verycloud.cn/api/v3",
        "AUTHENTIK_TOKEN": "<你的token>",
        "AUTHENTIK_DEFAULT_GROUPS": "aws-users,developers",
        "AUTHENTIK_PASSWORD_MIN_LENGTH": "12"
      }
    }
  }
}
```

### 环境变量说明

- `AUTHENTIK_TOKEN`：**必填**，authentik API token
- `AUTHENTIK_BASE_URL`：可选，默认 `https://authsso.verycloud.cn/api/v3`
- `AUTHENTIK_DEFAULT_GROUPS`：可选，默认开通用户时加入的组（逗号分隔）
- `AUTHENTIK_PASSWORD_MIN_LENGTH`：可选，密码最小长度，默认 `12`

---

## 3) 输入校验规则

创建用户/默认开通时要求：

- `username`：3-64 位，允许 `字母/数字/._-`
- `name`：显示名，1-128 字符
- `email`：合法邮箱格式
- `password`：满足复杂度：
  - 长度 >= `AUTHENTIK_PASSWORD_MIN_LENGTH`
  - 包含大写、小写、数字、特殊字符

---

## 4) 工具与使用示例

> 以下为工具参数示例（在 MCP 客户端里调用时使用对应 JSON）。

### 4.1 `list_groups`

```json
{
  "search": "aws",
  "page": 1,
  "page_size": 50
}
```

### 4.2 `create_group`

```json
{
  "name": "aws-readonly",
  "is_superuser": false,
  "if_not_exists": true
}
```

### 4.3 `create_user`

```json
{
  "username": "zhangsan",
  "name": "张三",
  "email": "zhangsan@example.com",
  "password": "Aa123456!@#",
  "is_active": true,
  "if_not_exists": true
}
```

### 4.4 `delete_user`

删除用户，支持按 `email` / `username` / `user_pk`。

方式 A：按邮箱删除（推荐）

```json
{
  "email": "dev@qq.com",
  "if_not_exists": true
}
```

方式 B：按用户名删除

```json
{
  "username": "dev",
  "if_not_exists": true
}
```

方式 C：按 user_pk 删除

```json
{
  "user_pk": 123,
  "if_not_exists": true
}
```

### 4.5 `add_user_to_group`

方式 A（用户名 + 组名）：

```json
{
  "username": "zhangsan",
  "group_name": "aws-readonly"
}
```

方式 B（邮箱 + 组名）：

```json
{
  "email": "zhangsan@example.com",
  "group_name": "aws-readonly"
}
```

方式 C（user_pk + group_pk）：

```json
{
  "user_pk": 123,
  "group_pk": "f6d8a1d2-xxxx-xxxx-xxxx-1a2b3c4d5e6f"
}
```

### 4.6 `provision_user_default`

使用默认组（来自 `AUTHENTIK_DEFAULT_GROUPS`）：

```json
{
  "username": "lisi",
  "name": "李四",
  "email": "lisi@example.com",
  "password": "Aa123456!@#"
}
```

### 4.7 `quick_add_user_to_group`（推荐：一句话开通）

场景：你希望一句话完成“如果组不存在就创建、再创建用户、并自动加到组里、最后返回随机密码”。

示例（你的场景）：

```json
{
  "email": "dev@qq.com",
  "group_name": "awsv1"
}
```

行为说明：

- `awsv1` 不存在：自动创建（不提示“组不存在”）
- 用户不存在：创建用户并加入组
- 用户存在：提示“用户已存在”，并确保用户在组内
- 新建用户时：返回 `generated_password`

可选传参（覆盖默认用户名/显示名）：

```json
{
  "email": "dev@qq.com",
  "group_name": "awsv1",
  "username": "dev",
  "name": "Dev User"
}
```

### 4.8 `reset_user_password`

重置用户密码，支持指定密码或自动随机生成。

方式 A：按邮箱重置并自动生成随机密码（推荐）

```json
{
  "email": "dev@qq.com"
}
```

方式 B：按用户名并指定新密码

```json
{
  "username": "dev",
  "password": "Aa123456!@#"
}
```

方式 C：按 `user_pk`

```json
{
  "user_pk": 123
}
```

### 4.9 `force_reset_password_and_notify`

强制重置密码，并尝试调用 authentik 邮件通知端点发送通知。

示例 A：按邮箱重置并通知（不强制邮件一定成功）

```json
{
  "email": "dev@qq.com"
}
```

示例 B：要求“邮件必须发送成功”，否则报错

```json
{
  "email": "dev@qq.com",
  "require_email_success": true
}
```

示例 C：指定密码并通知

```json
{
  "username": "dev",
  "password": "Aa123456!@#",
  "require_email_success": false
}
```

返回说明：

- `reset`：密码是否重置成功
- `notify.ok`：邮件通知是否成功
- `notify.endpoint`：成功使用的通知端点
- `notify.errors`：通知失败时，各尝试端点的错误
- `new_password`：新密码（请妥善保存）

### 4.10 `list_users`

列出用户，支持搜索、分页、按组过滤。

```json
{
  "search": "dev",
  "group_name": "awsv1",
  "page": 1,
  "page_size": 50
}
```

### 4.11 `disable_user` / `enable_user`

禁用用户：

```json
{
  "email": "dev@qq.com"
}
```

启用用户：

```json
{
  "email": "dev@qq.com"
}
```

### 4.12 `remove_user_from_group`

把用户从组中移除：

```json
{
  "email": "dev@qq.com",
  "group_name": "awsv1"
}
```

### 4.13 `bulk_quick_add_users_to_group`

批量开通并加入同一组（组不存在自动创建）：

```json
{
  "group_name": "awsv1",
  "users": [
    { "email": "dev1@qq.com", "username": "dev1", "name": "Dev 1" },
    { "email": "dev2@qq.com", "username": "dev2", "name": "Dev 2" }
  ],
  "continue_on_error": true
}
```

返回中会同时包含：
- `generated_password`：明文密码
- `generated_password_b64`：Base64 密码（用于避免聊天/表格转义导致复制错误）

### 4.14 `bulk_delete_users`

批量删除用户（支持 `email` / `username` / `user_pk`，支持不存在跳过）：

```json
{
  "users": [
    { "email": "dev1@qq.com" },
    { "username": "dev2" },
    { "user_pk": 123 }
  ],
  "if_not_exists": true,
  "continue_on_error": true
}
```

### 4.15 `upsert_user`

用户存在则更新，不存在则创建：

```json
{
  "username": "dev",
  "name": "Dev User",
  "email": "dev@qq.com",
  "is_active": true
}
```

更新时顺便重置密码：

```json
{
  "username": "dev",
  "name": "Dev User",
  "email": "dev@qq.com",
  "password": "Aa123456!@#",
  "reset_password_on_update": true
}
```

### 4.16 `sync_user_groups`

同步用户组（`merge` 并集 / `replace` 完全替换）：

```json
{
  "email": "dev@qq.com",
  "groups": ["awsv1", "developers"],
  "mode": "replace",
  "create_missing_groups": true
}
```

### 4.17 `bulk_reset_password`

批量重置密码（支持混合输入）：

```json
{
  "users": [
    { "email": "admin1@qq.com" },
    { "username": "admin2" },
    { "user_pk": 123 }
  ],
  "continue_on_error": true
}
```

每个成功项会返回：
- `new_password`
- `new_password_b64`

`provision_user_default` 调用时指定组示例：

```json
{
  "username": "wangwu",
  "name": "王五",
  "email": "wangwu@example.com",
  "password": "Aa123456!@#",
  "groups": ["aws-users", "aws-admin"],
  "create_missing_groups": true
}
```

---

## 5) 自检

```bash
node --check authentik-aws-mcp.mjs
```

---

## 6) 所有 MCP 调用方法总览（可直接复制给大模型）

下面给你每个工具的两种调用方式：

- **自然语言口令**：你在对话里直接发给大模型
- **参数 JSON**：大模型实际调用工具时使用的参数

### 6.1 `list_groups`

自然语言：

> 请调用 `list_groups`，搜索 `aws`，第 1 页，每页 50 条。

参数 JSON：

```json
{
  "search": "aws",
  "page": 1,
  "page_size": 50
}
```

### 6.2 `create_group`

自然语言：

> 帮我创建组 `awsv1`，已存在就跳过。

参数 JSON：

```json
{
  "name": "awsv1",
  "is_superuser": false,
  "if_not_exists": true
}
```

### 6.3 `create_user`

自然语言：

> 创建用户 dev（显示名 Dev，邮箱 dev@qq.com），密码 Aa123456!@#，已存在就跳过。

参数 JSON：

```json
{
  "username": "dev",
  "name": "Dev",
  "email": "dev@qq.com",
  "password": "Aa123456!@#",
  "is_active": true,
  "if_not_exists": true
}
```

### 6.4 `delete_user`

自然语言：

> 删除用户 dev@qq.com；如果不存在就直接跳过，不要报错。

参数 JSON：

```json
{
  "email": "dev@qq.com",
  "if_not_exists": true
}
```

### 6.5 `add_user_to_group`

自然语言：

> 把用户 dev@qq.com 加入 awsv1 组。

参数 JSON：

```json
{
  "email": "dev@qq.com",
  "group_name": "awsv1"
}
```

### 6.6 `provision_user_default`

自然语言：

> 默认开通用户：dev01（Dev 01，dev01@qq.com），密码 Aa123456!@#，并加入默认组。

参数 JSON：

```json
{
  "username": "dev01",
  "name": "Dev 01",
  "email": "dev01@qq.com",
  "password": "Aa123456!@#"
}
```

### 6.7 `quick_add_user_to_group`（一句话开通推荐）

自然语言：

> 帮我添加 dev@qq.com 到 awsv1 组；如果组不存在就自动创建；如果用户不存在就创建并返回随机密码。

参数 JSON：

```json
{
  "email": "dev@qq.com",
  "group_name": "awsv1"
}
```

### 6.8 `reset_user_password`

自然语言：

> 帮我重置 dev@qq.com 的密码，并返回新密码。

参数 JSON：

```json
{
  "email": "dev@qq.com"
}
```

返回中同时包含：
- `new_password`
- `new_password_b64`

若你怀疑复制时被转义，建议优先使用 b64 还原。

### 6.9 `force_reset_password_and_notify`

自然语言：

> 强制重置 dev@qq.com 的密码并发送通知邮件，邮件必须成功。

参数 JSON：

```json
{
  "email": "dev@qq.com",
  "require_email_success": true
}
```

### 6.10 `list_users`

自然语言：

> 列出 awsv1 组里的用户，搜索 dev，第 1 页每页 50 条。

参数 JSON：

```json
{
  "search": "dev",
  "group_name": "awsv1",
  "page": 1,
  "page_size": 50
}
```

### 6.11 `disable_user`

自然语言：

> 禁用用户 dev@qq.com。

参数 JSON：

```json
{
  "email": "dev@qq.com"
}
```

### 6.12 `enable_user`

自然语言：

> 启用用户 dev@qq.com。

参数 JSON：

```json
{
  "email": "dev@qq.com"
}
```

### 6.13 `remove_user_from_group`

自然语言：

> 把 dev@qq.com 从 awsv1 组移除。

参数 JSON：

```json
{
  "email": "dev@qq.com",
  "group_name": "awsv1"
}
```

### 6.14 `bulk_quick_add_users_to_group`

自然语言：

> 批量开通 dev1@qq.com 和 dev2@qq.com 到 awsv1，组不存在自动创建。

参数 JSON：

```json
{
  "group_name": "awsv1",
  "users": [
    { "email": "dev1@qq.com", "username": "dev1", "name": "Dev 1" },
    { "email": "dev2@qq.com", "username": "dev2", "name": "Dev 2" }
  ],
  "continue_on_error": true
}
```

### 6.15 `bulk_delete_users`

自然语言：

> 批量删除 dev1@qq.com、dev2 和 user_pk=123，不存在就跳过。

参数 JSON：

```json
{
  "users": [
    { "email": "dev1@qq.com" },
    { "username": "dev2" },
    { "user_pk": 123 }
  ],
  "if_not_exists": true,
  "continue_on_error": true
}
```

### 6.16 `upsert_user`

自然语言：

> upsert 用户 dev@qq.com：存在就更新，不存在就创建。

参数 JSON：

```json
{
  "username": "dev",
  "name": "Dev User",
  "email": "dev@qq.com",
  "is_active": true
}
```

### 6.17 `sync_user_groups`

自然语言：

> 把 dev@qq.com 的组同步为 awsv1 和 developers（replace 模式，不在列表里的组都移除）。

参数 JSON：

```json
{
  "email": "dev@qq.com",
  "groups": ["awsv1", "developers"],
  "mode": "replace",
  "create_missing_groups": true
}
```

### 6.18 `bulk_reset_password`

自然语言：

> 批量重置 admin1@qq.com 到 admin10@qq.com 的密码，并返回每个人的新密码和 b64。

参数 JSON：

```json
{
  "users": [
    { "email": "admin1@qq.com" },
    { "email": "admin2@qq.com" },
    { "email": "admin3@qq.com" }
  ],
  "continue_on_error": true
}
```

### 6.19 通用对话模板（推荐）

你可以固定这样对大模型说：

> 使用 `authentik-aws` MCP 完成：
> 1) 工具名：`<tool_name>`
> 2) 参数：`<json>`
> 3) 输出要求：返回关键结果（用户、组、密码、是否成功）

示例：

> 使用 `authentik-aws` MCP，调用 `quick_add_user_to_group`，参数 `{ "email": "dev@qq.com", "group_name": "awsv1" }`，返回用户、组和生成密码。

---

## 7) 常见问题

### 启动时报 `Missing AUTHENTIK_TOKEN`

说明 MCP JSON 的 `env` 没传 `AUTHENTIK_TOKEN`，或变量名写错。

### 创建用户报密码复杂度不满足

请确认密码同时包含：大写、小写、数字、特殊字符，并且长度达到最小值。

### 加组报未找到组

先调用 `create_group`，或在 `provision_user_default` 里传 `create_missing_groups: true`。

### 我想一句话开通用户到组，还要随机密码

请直接调用 `quick_add_user_to_group`，例如：

```json
{
  "email": "dev@qq.com",
  "group_name": "awsv1"
}
```

### 我想重置密码并拿到新密码

调用 `reset_user_password`，如果不传 `password`，系统会自动生成随机复杂密码并返回。

### 我想“重置密码 + 发通知邮件”一步完成

调用 `force_reset_password_and_notify`。

如果你要求“邮件必须成功才算成功”，请传：

```json
{
  "email": "dev@qq.com",
  "require_email_success": true
}
```

### 创建后提示密码不对怎么办

请直接调用 `reset_user_password` 重新设置一次，并使用返回的 `new_password` 登录。

示例：

```json
{
  "email": "dev@qq.com"
}
```

### 批量创建后密码登录失败怎么办

优先排查是否“复制时被转义/变形”：

1. 使用结果里的 `generated_password_b64`（或 `new_password_b64`）进行还原后再登录
2. 若仍失败，直接调用 `reset_user_password` 重新生成一次密码再试

Node 本地还原示例：

```bash
node -e "console.log(Buffer.from('这里放b64','base64').toString('utf8'))"
```
