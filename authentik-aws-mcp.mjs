#!/usr/bin/env node
/**
 * authentik-aws-mcp.mjs
 *
 * MCP Server for authentik API v3:
 * - list_groups
 * - list_users
 * - create_group
 * - create_user
 * - delete_user
 * - disable_user / enable_user
 * - upsert_user
 * - add_user_to_group
 * - remove_user_from_group
 * - sync_user_groups
 * - provision_user_default
 *
 * Required env vars (configure in MCP JSON):
 * - AUTHENTIK_TOKEN
 *
 * Optional env vars:
 * - AUTHENTIK_BASE_URL (default: https://authsso.verycloud.cn/api/v3)
 * - AUTHENTIK_DEFAULT_GROUPS (comma-separated group names)
 * - AUTHENTIK_PASSWORD_MIN_LENGTH (default: 12)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = (process.env.AUTHENTIK_BASE_URL || "https://authsso.verycloud.cn/api/v3").replace(/\/$/, "");
const TOKEN = process.env.AUTHENTIK_TOKEN;
const PASSWORD_MIN_LENGTH = Number(process.env.AUTHENTIK_PASSWORD_MIN_LENGTH || 12);
const DEFAULT_GROUPS = (process.env.AUTHENTIK_DEFAULT_GROUPS || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

if (!TOKEN) {
  console.error("[authentik-mcp] Missing AUTHENTIK_TOKEN. Please configure it in MCP JSON env.");
  process.exit(1);
}

function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

function validateUsername(username) {
  // Traditional username: 3-64 chars, letters/numbers/_/.-
  const re = /^[a-zA-Z0-9_.-]{3,64}$/;
  if (re.test(username)) return true;
  // Also accept valid email format as username (for AWS SCIM sync compatibility)
  if (username.length <= 254 && validateEmail(username)) return true;
  return false;
}

function validateDisplayName(name) {
  return typeof name === "string" && name.trim().length >= 1 && name.trim().length <= 128;
}

function validatePasswordComplexity(password) {
  if (typeof password !== "string") {
    return { ok: false, reason: "password 必须是字符串" };
  }
  if (/\s/.test(password)) {
    return { ok: false, reason: "password 不能包含空白字符（空格/换行/制表符）" };
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, reason: `password 长度至少 ${PASSWORD_MIN_LENGTH} 位` };
  }
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasNumber = /\d/.test(password);
  const hasSpecial = /[^A-Za-z0-9]/.test(password);

  if (!hasUpper || !hasLower || !hasNumber || !hasSpecial) {
    return {
      ok: false,
      reason: "password 必须包含大写字母、小写字母、数字、特殊字符",
    };
  }

  return { ok: true };
}

function generateComplexPassword(length = PASSWORD_MIN_LENGTH) {
  const finalLength = Math.max(Number(length) || PASSWORD_MIN_LENGTH, PASSWORD_MIN_LENGTH, 12);
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const nums = "23456789";
  // 仅使用在表格/markdown/IM 中不易被转义或破坏的字符
  const special = "!@#$%^&*_-+=.";
  const all = `${upper}${lower}${nums}${special}`;

  function pick(chars) {
    return chars[Math.floor(Math.random() * chars.length)];
  }

  const pwd = [pick(upper), pick(lower), pick(nums), pick(special)];
  while (pwd.length < finalLength) {
    pwd.push(pick(all));
  }

  // shuffle
  for (let i = pwd.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pwd[i], pwd[j]] = [pwd[j], pwd[i]];
  }

  return pwd.join("");
}

function toBase64(text) {
  return Buffer.from(String(text), "utf8").toString("base64");
}

async function apiRequest(path, { method = "GET", body } = {}) {
  const url = `${BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const contentType = res.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  const data = isJson ? await res.json() : await res.text();

  if (!res.ok) {
    const msg =
      typeof data === "string"
        ? data
        : data?.detail || data?.message || JSON.stringify(data, null, 2);
    throw new Error(`authentik API error ${res.status}: ${msg}`);
  }

  return data;
}

async function listGroups({ search = "", page = 1, page_size = 50 } = {}) {
  const query = new URLSearchParams();
  if (search) query.set("search", search);
  if (page) query.set("page", String(page));
  if (page_size) query.set("page_size", String(page_size));

  const q = query.toString();
  return apiRequest(`/core/groups/${q ? `?${q}` : ""}`);
}

async function getGroupByName(name) {
  const data = await listGroups({ search: name, page: 1, page_size: 100 });
  const items = data?.results || [];
  return items.find((g) => g.name === name) || null;
}

async function createGroup(name, isSuperuser = false) {
  return apiRequest("/core/groups/", {
    method: "POST",
    body: {
      name,
      is_superuser: isSuperuser,
    },
  });
}

async function listUsers({ search = "", page = 1, page_size = 50 } = {}) {
  const query = new URLSearchParams();
  if (search) query.set("search", search);
  if (page) query.set("page", String(page));
  if (page_size) query.set("page_size", String(page_size));
  const q = query.toString();
  return apiRequest(`/core/users/${q ? `?${q}` : ""}`);
}

async function getUserByUsernameOrEmail({ username, email }) {
  const search = username || email;
  const data = await listUsers({ search, page: 1, page_size: 100 });
  const items = data?.results || [];
  return (
    items.find((u) => (username ? u.username === username : false)) ||
    items.find((u) => (email ? u.email === email : false)) ||
    null
  );
}

async function createUser({ username, name, email, password, is_active = true }) {
  return apiRequest("/core/users/", {
    method: "POST",
    body: {
      username,
      name,
      email,
      is_active,
      password,
    },
  });
}

async function updateUserByPk(userPk, fields) {
  return apiRequest(`/core/users/${userPk}/`, {
    method: "PATCH",
    body: fields,
  });
}

async function deleteUserByPk(userPk) {
  return apiRequest(`/core/users/${userPk}/`, {
    method: "DELETE",
  });
}

async function addUserToGroup({ userPk, groupPk }) {
  // authentik API v3 generally supports PATCH with groups as list of group PKs on user
  const current = await apiRequest(`/core/users/${userPk}/`);
  const existing = Array.isArray(current?.groups) ? current.groups : [];
  const next = Array.from(new Set([...existing, groupPk]));

  return apiRequest(`/core/users/${userPk}/`, {
    method: "PATCH",
    body: {
      groups: next,
    },
  });
}

async function setUserActiveStatus({ userPk, isActive }) {
  return apiRequest(`/core/users/${userPk}/`, {
    method: "PATCH",
    body: {
      is_active: isActive,
    },
  });
}

async function removeUserFromGroup({ userPk, groupPk }) {
  const current = await apiRequest(`/core/users/${userPk}/`);
  const existing = Array.isArray(current?.groups) ? current.groups : [];
  const next = existing.filter((x) => String(x) !== String(groupPk));

  return apiRequest(`/core/users/${userPk}/`, {
    method: "PATCH",
    body: {
      groups: next,
    },
  });
}

async function resetUserPassword({ userPk, password }) {
  // Preferred endpoint in authentik v3
  try {
    await apiRequest(`/core/users/${userPk}/set_password/`, {
      method: "POST",
      body: { password },
    });
    return { ok: true, method: "set_password" };
  } catch (_e) {
    // Fallback for setups where password is patchable
    await apiRequest(`/core/users/${userPk}/`, {
      method: "PATCH",
      body: { password },
    });
    return { ok: true, method: "patch" };
  }
}

async function sendPasswordResetNotification({ userPk, email, username, password }) {
  const attempts = [
    {
      path: `/core/users/${userPk}/recovery_email/`,
      method: "POST",
      body: { email, username, password },
    },
    {
      path: `/core/users/${userPk}/send_recovery/`,
      method: "POST",
      body: { email, username, password },
    },
    {
      path: `/core/users/${userPk}/send_reset_email/`,
      method: "POST",
      body: { email, username },
    },
    {
      path: `/core/users/${userPk}/reset_email/`,
      method: "POST",
      body: { email, username },
    },
  ];

  const errors = [];
  for (const x of attempts) {
    try {
      const data = await apiRequest(x.path, { method: x.method, body: x.body });
      return {
        ok: true,
        endpoint: x.path,
        response: data,
      };
    } catch (e) {
      errors.push({ endpoint: x.path, error: String(e?.message || e) });
    }
  }

  return {
    ok: false,
    errors,
  };
}

async function listEvents({ search = "", action = "", actions = [], username = "", page = 1, page_size = 20, ordering = "-created" } = {}) {
  const query = new URLSearchParams();
  if (search) query.set("search", search);
  if (action) query.set("action", action);
  if (username) query.set("username", username);
  if (page) query.set("page", String(page));
  if (page_size) query.set("page_size", String(page_size));
  if (ordering) query.set("ordering", ordering);
  // authentik supports repeated `actions` query params for multi-action filtering
  for (const a of actions || []) {
    if (a) query.append("actions", a);
  }
  const q = query.toString();
  return apiRequest(`/events/events/${q ? `?${q}` : ""}`);
}

async function getEventVolume({ history_days = 7, actions = [], query = "" } = {}) {
  const params = new URLSearchParams();
  if (history_days) params.set("history_days", String(history_days));
  if (query) params.set("query", query);
  for (const a of actions || []) {
    if (a) params.append("actions", a);
  }
  const q = params.toString();
  return apiRequest(`/events/events/volume/${q ? `?${q}` : ""}`);
}

async function listApplications({ search = "", page = 1, page_size = 50 } = {}) {
  const query = new URLSearchParams();
  if (search) query.set("search", search);
  if (page) query.set("page", String(page));
  if (page_size) query.set("page_size", String(page_size));
  const q = query.toString();
  return apiRequest(`/core/applications/${q ? `?${q}` : ""}`);
}

async function getApplicationBySlug(slug) {
  return apiRequest(`/core/applications/${encodeURIComponent(slug)}/`);
}

async function findApplication({ slug, name }) {
  // 优先按 slug 精确取；否则按名称搜索
  if (slug) {
    try {
      return await getApplicationBySlug(slug);
    } catch (_e) {
      // 落到搜索兜底
    }
  }
  const search = name || slug || "";
  const data = await listApplications({ search, page: 1, page_size: 100 });
  const items = data?.results || [];
  if (name) {
    return items.find((a) => a.name === name) || items.find((a) => a.slug === name) || null;
  }
  if (slug) {
    return items.find((a) => a.slug === slug) || null;
  }
  return items[0] || null;
}

async function listProviders({ search = "", page = 1, page_size = 100, application_isnull } = {}) {
  const query = new URLSearchParams();
  if (search) query.set("search", search);
  if (page) query.set("page", String(page));
  if (page_size) query.set("page_size", String(page_size));
  if (application_isnull !== undefined) {
    query.set("application__isnull", application_isnull ? "true" : "false");
  }
  const q = query.toString();
  return apiRequest(`/core/providers/${q ? `?${q}` : ""}`);
}

function summarizeProvider(p) {
  if (!p) return null;
  return {
    pk: p.pk,
    name: p.name,
    // component 形如 oauth2provider / saml-provider / proxyprovider 等，用于判断类型
    type: p.component || p.meta_model_name,
    verbose_name: p.verbose_name,
    assigned_application_name: p.assigned_application_name,
    assigned_application_slug: p.assigned_application_slug,
    authorization_flow: p.authorization_flow,
    authentication_flow: p.authentication_flow,
    invalidation_flow: p.invalidation_flow,
  };
}

function summarizeApplication(a) {
  if (!a) return null;
  return {
    pk: a.pk,
    name: a.name,
    slug: a.slug,
    provider_pk: a.provider,
    provider: summarizeProvider(a.provider_obj),
    backchannel_providers: Array.isArray(a.backchannel_providers_obj)
      ? a.backchannel_providers_obj.map(summarizeProvider)
      : [],
    launch_url: a.launch_url,
    meta_launch_url: a.meta_launch_url,
    meta_description: a.meta_description,
    meta_publisher: a.meta_publisher,
    group: a.group,
  };
}

async function getOAuth2Provider(providerId) {
  // OAuth2 类型专属端点，返回 client_id/client_secret/redirect_uris/signing_key 等完整配置
  return apiRequest(`/providers/oauth2/${encodeURIComponent(providerId)}/`);
}

async function getOAuth2SetupUrls(providerId) {
  // OIDC 端点 URL（issuer/authorize/token/userinfo/jwks/logout）
  // 该端点要求 provider 已绑定 application，否则 404
  try {
    return await apiRequest(`/providers/oauth2/${encodeURIComponent(providerId)}/setup_urls/`);
  } catch (e) {
    return { _error: String(e?.message || e) };
  }
}

async function getScopeMappingById(pmId) {
  // 将 property mapping / scope mapping 的 ID 解析为可读的 scope 名称
  try {
    return await apiRequest(`/propertymappings/provider/scope/${encodeURIComponent(pmId)}/`);
  } catch (e) {
    return { pk: pmId, _error: String(e?.message || e) };
  }
}

async function resolveScopeMappings(ids = []) {
  const list = Array.isArray(ids) ? ids : [];
  const resolved = await Promise.all(
    list.map(async (id) => {
      const m = await getScopeMappingById(id);
      if (m && m._error) {
        return { pk: id, resolved: false, error: m._error };
      }
      return {
        pk: m.pk,
        resolved: true,
        scope_name: m.scope_name,
        name: m.name,
        description: m.description,
      };
    })
  );
  return resolved;
}

const server = new McpServer({
  name: "authentik-aws-mcp",
  version: "1.0.0",
});

server.tool(
  "list_groups",
  "列出 authentik 组",
  {
    search: z.string().optional().describe("可选：按组名模糊搜索"),
    page: z.coerce.number().int().positive().optional(),
    page_size: z.coerce.number().int().positive().max(200).optional(),
  },
  async ({ search, page, page_size }) => {
    const data = await listGroups({ search, page, page_size });
    const results = (data?.results || []).map((g) => ({
      pk: g.pk,
      name: g.name,
      is_superuser: g.is_superuser,
      user_count: g.users_obj?.length ?? undefined,
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              count: data?.count ?? results.length,
              results,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "list_users",
  "列出 authentik 用户（支持搜索、分页、按组过滤）",
  {
    search: z.string().optional().describe("可选：按用户名/邮箱搜索"),
    group_name: z.string().optional().describe("可选：按组名过滤"),
    group_pk: z.string().optional().describe("可选：按组 PK 过滤"),
    page: z.coerce.number().int().positive().optional(),
    page_size: z.coerce.number().int().positive().max(200).optional(),
  },
  async ({ search = "", group_name, group_pk, page = 1, page_size = 50 }) => {
    let usersData = await listUsers({ search, page, page_size });
    let users = usersData?.results || [];

    let targetGroupPk = group_pk;
    if (!targetGroupPk && group_name) {
      const g = await getGroupByName(group_name);
      if (!g) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ count: 0, results: [], message: `组不存在: ${group_name}` }, null, 2),
            },
          ],
        };
      }
      targetGroupPk = g.pk;
    }

    if (targetGroupPk) {
      users = users.filter((u) => Array.isArray(u.groups) && u.groups.map(String).includes(String(targetGroupPk)));
    }

    const results = users.map((u) => ({
      pk: u.pk,
      username: u.username,
      name: u.name,
      email: u.email,
      is_active: u.is_active,
      groups: u.groups,
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              count: targetGroupPk ? results.length : usersData?.count ?? results.length,
              page,
              page_size,
              filtered_by_group_pk: targetGroupPk || undefined,
              results,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "create_group",
  "创建 authentik 组",
  {
    name: z.string().min(1).max(150).describe("组名"),
    is_superuser: z.boolean().optional().describe("是否超级管理员组（默认 false）"),
    if_not_exists: z.boolean().optional().describe("已存在时不报错并直接返回"),
  },
  async ({ name, is_superuser = false, if_not_exists = true }) => {
    const existing = await getGroupByName(name);
    if (existing) {
      if (if_not_exists) {
        return {
          content: [{ type: "text", text: `组已存在: ${name} (pk=${existing.pk})` }],
        };
      }
      throw new Error(`组已存在: ${name}`);
    }

    const created = await createGroup(name, is_superuser);
    return {
      content: [
        {
          type: "text",
          text: `创建组成功: ${created.name} (pk=${created.pk}, is_superuser=${created.is_superuser})`,
        },
      ],
    };
  }
);

server.tool(
  "create_user",
  "创建 authentik 用户（要求邮箱、用户名、显示名、复杂密码）",
  {
    username: z.string().min(3).max(64),
    name: z.string().min(1).max(128).describe("显示名"),
    email: z.string().email(),
    password: z.string().min(1),
    is_active: z.boolean().optional(),
    if_not_exists: z.boolean().optional().describe("已存在时不报错并直接返回"),
  },
  async ({ username, name, email, password, is_active = true, if_not_exists = true }) => {
    if (!validateUsername(username)) {
      throw new Error("用户名不合法：仅允许 3-64 位字母/数字/._-");
    }
    if (!validateDisplayName(name)) {
      throw new Error("显示名不合法：1-128 字符");
    }
    if (!validateEmail(email)) {
      throw new Error("邮箱格式不合法");
    }

    const pwd = validatePasswordComplexity(password);
    if (!pwd.ok) {
      throw new Error(`密码复杂度不满足: ${pwd.reason}`);
    }

    const existing = await getUserByUsernameOrEmail({ username, email });
    if (existing) {
      if (if_not_exists) {
        return {
          content: [
            {
              type: "text",
              text: `用户已存在: username=${existing.username}, email=${existing.email}, pk=${existing.pk}`,
            },
          ],
        };
      }
      throw new Error(`用户已存在: username=${existing.username}, email=${existing.email}`);
    }

    const user = await createUser({ username, name, email, password, is_active });
    return {
      content: [
        {
          type: "text",
          text: `创建用户成功: username=${user.username}, email=${user.email}, pk=${user.pk}`,
        },
      ],
    };
  }
);

server.tool(
  "delete_user",
  "删除 authentik 用户（支持 username/email/user_pk）",
  {
    username: z.string().optional(),
    email: z.string().email().optional(),
    user_pk: z.coerce.number().int().positive().optional(),
    if_not_exists: z.boolean().optional().describe("用户不存在时是否不报错，默认 true"),
  },
  async ({ username, email, user_pk, if_not_exists = true }) => {
    let resolvedUserPk = user_pk;
    let userObj = null;

    if (!resolvedUserPk) {
      if (!username && !email) {
        throw new Error("请提供 user_pk 或 username/email");
      }
      userObj = await getUserByUsernameOrEmail({ username, email });
      if (!userObj) {
        if (if_not_exists) {
          return {
            content: [{ type: "text", text: "用户不存在，已跳过删除" }],
          };
        }
        throw new Error("未找到用户");
      }
      resolvedUserPk = userObj.pk;
    } else {
      try {
        userObj = await apiRequest(`/core/users/${resolvedUserPk}/`);
      } catch (e) {
        if (if_not_exists) {
          return {
            content: [{ type: "text", text: `用户 pk=${resolvedUserPk} 不存在，已跳过删除` }],
          };
        }
        throw e;
      }
    }

    await deleteUserByPk(resolvedUserPk);
    return {
      content: [
        {
          type: "text",
          text: `删除用户成功: pk=${resolvedUserPk}, username=${userObj?.username || "-"}, email=${userObj?.email || "-"}`,
        },
      ],
    };
  }
);

server.tool(
  "bulk_delete_users",
  "批量删除用户（支持 email/username/user_pk，支持不存在跳过）",
  {
    users: z
      .array(
        z.object({
          email: z.string().email().optional(),
          username: z.string().optional(),
          user_pk: z.coerce.number().int().positive().optional(),
        })
      )
      .min(1),
    if_not_exists: z.boolean().optional().describe("用户不存在时是否跳过，默认 true"),
    continue_on_error: z.boolean().optional().describe("单个失败是否继续，默认 true"),
  },
  async ({ users, if_not_exists = true, continue_on_error = true }) => {
    const results = [];
    let deleted = 0;
    let skipped = 0;
    let failed = 0;

    for (const item of users) {
      try {
        let resolvedUserPk = item.user_pk;
        let userObj = null;

        if (!resolvedUserPk) {
          if (!item.username && !item.email) {
            throw new Error("缺少定位字段（需要 user_pk 或 username/email）");
          }
          userObj = await getUserByUsernameOrEmail({ username: item.username, email: item.email });
          if (!userObj) {
            if (if_not_exists) {
              skipped += 1;
              results.push({ target: item, status: "skipped", message: "用户不存在，已跳过" });
              continue;
            }
            throw new Error("未找到用户");
          }
          resolvedUserPk = userObj.pk;
        } else {
          try {
            userObj = await apiRequest(`/core/users/${resolvedUserPk}/`);
          } catch (e) {
            if (if_not_exists) {
              skipped += 1;
              results.push({ target: item, status: "skipped", message: "用户不存在，已跳过" });
              continue;
            }
            throw e;
          }
        }

        await deleteUserByPk(resolvedUserPk);
        deleted += 1;
        results.push({
          target: item,
          status: "deleted",
          user: { pk: resolvedUserPk, username: userObj?.username, email: userObj?.email },
        });
      } catch (e) {
        failed += 1;
        results.push({ target: item, status: "failed", error: String(e?.message || e) });
        if (!continue_on_error) {
          throw new Error(`批量删除终止: ${String(e?.message || e)}`);
        }
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              message: "批量删除完成",
              summary: { total: users.length, deleted, skipped, failed },
              results,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "upsert_user",
  "用户存在则更新，不存在则创建",
  {
    username: z.string().min(3).max(64),
    name: z.string().min(1).max(128),
    email: z.string().email(),
    password: z.string().optional().describe("可选：创建时建议传；更新时传则重置密码"),
    is_active: z.boolean().optional(),
    reset_password_on_update: z.boolean().optional().describe("更新用户时是否重置密码，默认 false"),
  },
  async ({ username, name, email, password, is_active = true, reset_password_on_update = false }) => {
    if (!validateUsername(username)) throw new Error("用户名不合法：仅允许 3-64 位字母/数字/._-");
    if (!validateDisplayName(name)) throw new Error("显示名不合法：1-128 字符");
    if (!validateEmail(email)) throw new Error("邮箱格式不合法");

    let existing = await getUserByUsernameOrEmail({ username, email });
    if (!existing) {
      const createPassword = password || generateComplexPassword();
      const pwd = validatePasswordComplexity(createPassword);
      if (!pwd.ok) throw new Error(`密码复杂度不满足: ${pwd.reason}`);

      const created = await createUser({ username, name, email, password: createPassword, is_active });
      await resetUserPassword({ userPk: created.pk, password: createPassword });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                action: "created",
                user: { pk: created.pk, username: created.username, email: created.email, is_active: created.is_active },
                generated_password: password ? undefined : createPassword,
                generated_password_b64: password ? undefined : toBase64(createPassword),
              },
              null,
              2
            ),
          },
        ],
      };
    }

    const updated = await updateUserByPk(existing.pk, {
      username,
      name,
      email,
      is_active,
    });

    let passwordReset = false;
    if (password && reset_password_on_update) {
      const pwd = validatePasswordComplexity(password);
      if (!pwd.ok) throw new Error(`密码复杂度不满足: ${pwd.reason}`);
      await resetUserPassword({ userPk: existing.pk, password });
      passwordReset = true;
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              action: "updated",
              user: { pk: updated.pk, username: updated.username, email: updated.email, is_active: updated.is_active },
              password_reset: passwordReset,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "disable_user",
  "禁用用户（is_active=false）",
  {
    username: z.string().optional(),
    email: z.string().email().optional(),
    user_pk: z.coerce.number().int().positive().optional(),
  },
  async ({ username, email, user_pk }) => {
    let resolvedUserPk = user_pk;
    if (!resolvedUserPk) {
      if (!username && !email) throw new Error("请提供 user_pk 或 username/email");
      const user = await getUserByUsernameOrEmail({ username, email });
      if (!user) throw new Error("未找到用户");
      resolvedUserPk = user.pk;
    }

    const updated = await setUserActiveStatus({ userPk: resolvedUserPk, isActive: false });
    return {
      content: [
        {
          type: "text",
          text: `已禁用用户: pk=${updated.pk}, username=${updated.username}, email=${updated.email}`,
        },
      ],
    };
  }
);

server.tool(
  "enable_user",
  "启用用户（is_active=true）",
  {
    username: z.string().optional(),
    email: z.string().email().optional(),
    user_pk: z.coerce.number().int().positive().optional(),
  },
  async ({ username, email, user_pk }) => {
    let resolvedUserPk = user_pk;
    if (!resolvedUserPk) {
      if (!username && !email) throw new Error("请提供 user_pk 或 username/email");
      const user = await getUserByUsernameOrEmail({ username, email });
      if (!user) throw new Error("未找到用户");
      resolvedUserPk = user.pk;
    }

    const updated = await setUserActiveStatus({ userPk: resolvedUserPk, isActive: true });
    return {
      content: [
        {
          type: "text",
          text: `已启用用户: pk=${updated.pk}, username=${updated.username}, email=${updated.email}`,
        },
      ],
    };
  }
);

server.tool(
  "add_user_to_group",
  "将用户添加到组（可用用户名/邮箱+组名，或直接用 user_pk/group_pk）",
  {
    username: z.string().optional(),
    email: z.string().email().optional(),
    user_pk: z.coerce.number().int().positive().optional(),
    group_name: z.string().optional(),
    group_pk: z.string().optional(),
  },
  async ({ username, email, user_pk, group_name, group_pk }) => {
    let resolvedUserPk = user_pk;
    if (!resolvedUserPk) {
      if (!username && !email) {
        throw new Error("请提供 user_pk 或 username/email");
      }
      const user = await getUserByUsernameOrEmail({ username, email });
      if (!user) throw new Error("未找到用户");
      resolvedUserPk = user.pk;
    }

    let resolvedGroupPk = group_pk;
    if (!resolvedGroupPk) {
      if (!group_name) {
        throw new Error("请提供 group_pk 或 group_name");
      }
      const group = await getGroupByName(group_name);
      if (!group) throw new Error(`未找到组: ${group_name}`);
      resolvedGroupPk = group.pk;
    }

    const patched = await addUserToGroup({ userPk: resolvedUserPk, groupPk: resolvedGroupPk });

    return {
      content: [
        {
          type: "text",
          text: `已将用户 ${patched.username} (pk=${patched.pk}) 添加到组 ${resolvedGroupPk}`,
        },
      ],
    };
  }
);

server.tool(
  "remove_user_from_group",
  "将用户从组中移除（可用用户名/邮箱+组名，或直接用 user_pk/group_pk）",
  {
    username: z.string().optional(),
    email: z.string().email().optional(),
    user_pk: z.coerce.number().int().positive().optional(),
    group_name: z.string().optional(),
    group_pk: z.string().optional(),
  },
  async ({ username, email, user_pk, group_name, group_pk }) => {
    let resolvedUserPk = user_pk;
    if (!resolvedUserPk) {
      if (!username && !email) {
        throw new Error("请提供 user_pk 或 username/email");
      }
      const user = await getUserByUsernameOrEmail({ username, email });
      if (!user) throw new Error("未找到用户");
      resolvedUserPk = user.pk;
    }

    let resolvedGroupPk = group_pk;
    if (!resolvedGroupPk) {
      if (!group_name) {
        throw new Error("请提供 group_pk 或 group_name");
      }
      const group = await getGroupByName(group_name);
      if (!group) throw new Error(`未找到组: ${group_name}`);
      resolvedGroupPk = group.pk;
    }

    const patched = await removeUserFromGroup({ userPk: resolvedUserPk, groupPk: resolvedGroupPk });

    return {
      content: [
        {
          type: "text",
          text: `已将用户 ${patched.username} (pk=${patched.pk}) 从组 ${resolvedGroupPk} 移除`,
        },
      ],
    };
  }
);

server.tool(
  "sync_user_groups",
  "同步用户组：merge（并集）或 replace（完全替换）",
  {
    username: z.string().optional(),
    email: z.string().email().optional(),
    user_pk: z.coerce.number().int().positive().optional(),
    groups: z.array(z.string().min(1)).describe("目标组名列表"),
    mode: z.enum(["merge", "replace"]).optional().describe("merge=并集，replace=完全替换，默认 merge"),
    create_missing_groups: z.boolean().optional().describe("缺失组是否自动创建，默认 true"),
  },
  async ({ username, email, user_pk, groups, mode = "merge", create_missing_groups = true }) => {
    let resolvedUserPk = user_pk;
    if (!resolvedUserPk) {
      if (!username && !email) throw new Error("请提供 user_pk 或 username/email");
      const user = await getUserByUsernameOrEmail({ username, email });
      if (!user) throw new Error("未找到用户");
      resolvedUserPk = user.pk;
    }

    const userCurrent = await apiRequest(`/core/users/${resolvedUserPk}/`);
    const currentGroupPks = Array.isArray(userCurrent.groups) ? userCurrent.groups.map(String) : [];

    const targetGroupPks = [];
    const targetGroupsResolved = [];
    for (const gName of groups) {
      let g = await getGroupByName(gName);
      if (!g) {
        if (!create_missing_groups) throw new Error(`组不存在: ${gName}`);
        g = await createGroup(gName, false);
      }
      targetGroupPks.push(String(g.pk));
      targetGroupsResolved.push({ name: g.name, pk: g.pk });
    }

    let nextGroupPks = [];
    if (mode === "replace") {
      nextGroupPks = Array.from(new Set(targetGroupPks));
    } else {
      nextGroupPks = Array.from(new Set([...currentGroupPks, ...targetGroupPks]));
    }

    const patched = await apiRequest(`/core/users/${resolvedUserPk}/`, {
      method: "PATCH",
      body: { groups: nextGroupPks },
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              message: "用户组同步成功",
              mode,
              user: { pk: patched.pk, username: patched.username, email: patched.email },
              current_groups: currentGroupPks,
              target_groups: targetGroupsResolved,
              final_groups: nextGroupPks,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "provision_user_default",
  "默认开通用户：创建用户并加入默认组（来自 AUTHENTIK_DEFAULT_GROUPS 或入参 groups）",
  {
    username: z.string().min(3).max(64),
    name: z.string().min(1).max(128),
    email: z.string().email(),
    password: z.string().min(1),
    groups: z.array(z.string().min(1)).optional().describe("可选：指定要加入的组名列表"),
    create_missing_groups: z.boolean().optional().describe("组不存在时是否自动创建，默认 true"),
  },
  async ({ username, name, email, password, groups = [], create_missing_groups = true }) => {
    const targetGroups = groups.length ? groups : DEFAULT_GROUPS;

    if (!targetGroups.length) {
      throw new Error("未配置默认组。请设置 AUTHENTIK_DEFAULT_GROUPS 或在入参提供 groups");
    }

    // Create or get user
    let user = await getUserByUsernameOrEmail({ username, email });
    if (!user) {
      if (!validateUsername(username)) {
        throw new Error("用户名不合法：仅允许 3-64 位字母/数字/._-");
      }
      if (!validateDisplayName(name)) {
        throw new Error("显示名不合法：1-128 字符");
      }
      if (!validateEmail(email)) {
        throw new Error("邮箱格式不合法");
      }

      const pwd = validatePasswordComplexity(password);
      if (!pwd.ok) {
        throw new Error(`密码复杂度不满足: ${pwd.reason}`);
      }

      user = await createUser({ username, name, email, password, is_active: true });
    }

    const attached = [];
    for (const gName of targetGroups) {
      let group = await getGroupByName(gName);
      if (!group) {
        if (!create_missing_groups) {
          throw new Error(`组不存在: ${gName}`);
        }
        group = await createGroup(gName, false);
      }

      await addUserToGroup({ userPk: user.pk, groupPk: group.pk });
      attached.push({ name: group.name, pk: group.pk });
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              message: "默认开通成功",
              user: {
                pk: user.pk,
                username: user.username,
                email: user.email,
              },
              groups: attached,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "quick_add_user_to_group",
  "一句话开通：按邮箱创建用户并加入组；组不存在自动创建；返回随机密码",
  {
    email: z.string().email().describe("用户邮箱（必填）"),
    group_name: z.string().min(1).describe("目标组名（必填）"),
    username: z.string().min(3).max(64).optional().describe("可选：用户名，不传则用邮箱前缀"),
    name: z.string().min(1).max(128).optional().describe("可选：显示名，不传则用邮箱前缀"),
    is_active: z.boolean().optional(),
  },
  async ({ email, group_name, username, name, is_active = true }) => {
    if (!validateEmail(email)) {
      throw new Error("邮箱格式不合法");
    }

    const emailPrefix = email.split("@")[0] || "user";
    const resolvedUsername = username || email;
    const resolvedName = name || emailPrefix;

    if (!validateUsername(resolvedUsername)) {
      throw new Error("用户名不合法：仅允许 3-64 位字母/数字/._-");
    }
    if (!validateDisplayName(resolvedName)) {
      throw new Error("显示名不合法：1-128 字符");
    }

    // 组不存在就自动创建（静默处理）
    let group = await getGroupByName(group_name);
    if (!group) {
      group = await createGroup(group_name, false);
    }

    // 用户已存在：提示已存在，并确保在组里
    let user = await getUserByUsernameOrEmail({ username: resolvedUsername, email });
    if (user) {
      await addUserToGroup({ userPk: user.pk, groupPk: group.pk });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                message: "用户已存在，已确保加入目标组",
                user: { pk: user.pk, username: user.username, email: user.email },
                group: { pk: group.pk, name: group.name },
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // 创建新用户并返回随机密码
    const randomPassword = generateComplexPassword();
    const pwd = validatePasswordComplexity(randomPassword);
    if (!pwd.ok) {
      throw new Error(`随机密码生成失败: ${pwd.reason}`);
    }

    user = await createUser({
      username: resolvedUsername,
      name: resolvedName,
      email,
      password: randomPassword,
      is_active,
    });

    // 某些 authentik 配置下，创建用户时传入 password 可能不会作为最终登录密码生效
    // 为确保可登录，这里再强制执行一次 set_password/reset。
    await resetUserPassword({ userPk: user.pk, password: randomPassword });

    await addUserToGroup({ userPk: user.pk, groupPk: group.pk });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              message: "创建用户并加入组成功",
              user: { pk: user.pk, username: user.username, email: user.email },
              group: { pk: group.pk, name: group.name },
              generated_password: randomPassword,
              generated_password_b64: toBase64(randomPassword),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "bulk_quick_add_users_to_group",
  "批量一句话开通：批量创建用户并加入同一组（组不存在自动创建）",
  {
    group_name: z.string().min(1).describe("目标组名（必填）"),
    users: z
      .array(
        z.object({
          email: z.string().email(),
          username: z.string().min(3).max(64).optional(),
          name: z.string().min(1).max(128).optional(),
        })
      )
      .min(1)
      .describe("用户列表"),
    is_active: z.boolean().optional(),
    continue_on_error: z.boolean().optional().describe("遇到单个失败是否继续，默认 true"),
  },
  async ({ group_name, users, is_active = true, continue_on_error = true }) => {
    let group = await getGroupByName(group_name);
    if (!group) {
      group = await createGroup(group_name, false);
    }

    const results = [];
    let createdCount = 0;
    let existedCount = 0;
    let failedCount = 0;

    for (const item of users) {
      try {
        const email = item.email;
        const emailPrefix = email.split("@")[0] || "user";
        const resolvedUsername = item.username || email;
        const resolvedName = item.name || emailPrefix;

        if (!validateEmail(email)) throw new Error("邮箱格式不合法");
        if (!validateUsername(resolvedUsername)) throw new Error("用户名不合法");
        if (!validateDisplayName(resolvedName)) throw new Error("显示名不合法");

        let user = await getUserByUsernameOrEmail({ username: resolvedUsername, email });
        if (user) {
          await addUserToGroup({ userPk: user.pk, groupPk: group.pk });
          existedCount += 1;
          results.push({
            email,
            username: user.username,
            status: "exists",
            message: "用户已存在，已确保加入组",
          });
          continue;
        }

        const randomPassword = generateComplexPassword();
        user = await createUser({
          username: resolvedUsername,
          name: resolvedName,
          email,
          password: randomPassword,
          is_active,
        });

        await resetUserPassword({ userPk: user.pk, password: randomPassword });
        await addUserToGroup({ userPk: user.pk, groupPk: group.pk });

        createdCount += 1;
        results.push({
          email,
          username: user.username,
          status: "created",
          generated_password: randomPassword,
          generated_password_b64: toBase64(randomPassword),
        });
      } catch (e) {
        failedCount += 1;
        results.push({ email: item.email, status: "failed", error: String(e?.message || e) });
        if (!continue_on_error) {
          throw new Error(`批量处理终止，失败用户 ${item.email}: ${String(e?.message || e)}`);
        }
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              message: "批量处理完成",
              group: { pk: group.pk, name: group.name },
              summary: {
                total: users.length,
                created: createdCount,
                existed: existedCount,
                failed: failedCount,
              },
              results,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "reset_user_password",
  "重置用户密码（可自动生成随机复杂密码并返回）",
  {
    username: z.string().optional(),
    email: z.string().email().optional(),
    user_pk: z.coerce.number().int().positive().optional(),
    password: z.string().optional().describe("可选：不传则自动生成随机复杂密码"),
  },
  async ({ username, email, user_pk, password }) => {
    let resolvedUserPk = user_pk;
    let userObj = null;

    if (!resolvedUserPk) {
      if (!username && !email) {
        throw new Error("请提供 user_pk 或 username/email");
      }
      userObj = await getUserByUsernameOrEmail({ username, email });
      if (!userObj) {
        throw new Error("未找到用户");
      }
      resolvedUserPk = userObj.pk;
    }

    const nextPassword = password || generateComplexPassword();
    const pwdCheck = validatePasswordComplexity(nextPassword);
    if (!pwdCheck.ok) {
      throw new Error(`密码复杂度不满足: ${pwdCheck.reason}`);
    }

    const result = await resetUserPassword({ userPk: resolvedUserPk, password: nextPassword });
    const finalUser = userObj || (await apiRequest(`/core/users/${resolvedUserPk}/`));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              message: "密码重置成功",
              method: result.method,
              user: {
                pk: finalUser.pk,
                username: finalUser.username,
                email: finalUser.email,
              },
              new_password: nextPassword,
              new_password_b64: toBase64(nextPassword),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "bulk_reset_password",
  "批量重置密码（支持 email/username/user_pk 混合输入）",
  {
    users: z
      .array(
        z.object({
          email: z.string().email().optional(),
          username: z.string().optional(),
          user_pk: z.coerce.number().int().positive().optional(),
          password: z.string().optional().describe("可选：该用户指定新密码；不传则自动生成"),
        })
      )
      .min(1),
    continue_on_error: z.boolean().optional().describe("单个失败是否继续，默认 true"),
  },
  async ({ users, continue_on_error = true }) => {
    const results = [];
    let success = 0;
    let failed = 0;

    for (const item of users) {
      try {
        let resolvedUserPk = item.user_pk;
        let userObj = null;

        if (!resolvedUserPk) {
          if (!item.username && !item.email) {
            throw new Error("缺少定位字段（需要 user_pk 或 username/email）");
          }
          userObj = await getUserByUsernameOrEmail({ username: item.username, email: item.email });
          if (!userObj) throw new Error("未找到用户");
          resolvedUserPk = userObj.pk;
        } else {
          userObj = await apiRequest(`/core/users/${resolvedUserPk}/`);
        }

        const nextPassword = item.password || generateComplexPassword();
        const pwdCheck = validatePasswordComplexity(nextPassword);
        if (!pwdCheck.ok) {
          throw new Error(`密码复杂度不满足: ${pwdCheck.reason}`);
        }

        const resetResult = await resetUserPassword({ userPk: resolvedUserPk, password: nextPassword });

        success += 1;
        results.push({
          target: { email: item.email, username: item.username, user_pk: item.user_pk },
          status: "success",
          method: resetResult.method,
          user: { pk: userObj.pk, username: userObj.username, email: userObj.email },
          new_password: nextPassword,
          new_password_b64: toBase64(nextPassword),
        });
      } catch (e) {
        failed += 1;
        results.push({
          target: { email: item.email, username: item.username, user_pk: item.user_pk },
          status: "failed",
          error: String(e?.message || e),
        });
        if (!continue_on_error) {
          throw new Error(`批量重置终止: ${String(e?.message || e)}`);
        }
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              message: "批量重置密码完成",
              summary: {
                total: users.length,
                success,
                failed,
              },
              results,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "force_reset_password_and_notify",
  "强制重置用户密码，并尝试发送邮件通知（若邮件接口不可用会返回失败原因）",
  {
    username: z.string().optional(),
    email: z.string().email().optional(),
    user_pk: z.coerce.number().int().positive().optional(),
    password: z.string().optional().describe("可选：不传则自动生成随机复杂密码"),
    require_email_success: z.boolean().optional().describe("是否要求邮件必须发送成功，默认 false"),
  },
  async ({ username, email, user_pk, password, require_email_success = false }) => {
    let resolvedUserPk = user_pk;
    let userObj = null;

    if (!resolvedUserPk) {
      if (!username && !email) {
        throw new Error("请提供 user_pk 或 username/email");
      }
      userObj = await getUserByUsernameOrEmail({ username, email });
      if (!userObj) {
        throw new Error("未找到用户");
      }
      resolvedUserPk = userObj.pk;
    }

    const nextPassword = password || generateComplexPassword();
    const pwdCheck = validatePasswordComplexity(nextPassword);
    if (!pwdCheck.ok) {
      throw new Error(`密码复杂度不满足: ${pwdCheck.reason}`);
    }

    const resetResult = await resetUserPassword({ userPk: resolvedUserPk, password: nextPassword });
    const finalUser = userObj || (await apiRequest(`/core/users/${resolvedUserPk}/`));

    const notifyResult = await sendPasswordResetNotification({
      userPk: resolvedUserPk,
      email: finalUser.email,
      username: finalUser.username,
      password: nextPassword,
    });

    if (require_email_success && !notifyResult.ok) {
      throw new Error(
        `密码已重置，但邮件通知失败（已尝试多个端点）: ${JSON.stringify(notifyResult.errors, null, 2)}`
      );
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              message: notifyResult.ok
                ? "密码重置成功，邮件通知已发送"
                : "密码重置成功，但邮件通知未发送（请检查 authentik 邮件配置或端点权限）",
              reset: {
                ok: true,
                method: resetResult.method,
              },
              notify: notifyResult,
              user: {
                pk: finalUser.pk,
                username: finalUser.username,
                email: finalUser.email,
              },
              new_password: nextPassword,
              new_password_b64: toBase64(nextPassword),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "list_recent_events",
  "查看最近事件（Recent events）：按时间倒序返回 authentik 审计事件，可按 action/actions/username 过滤",
  {
    action: z.string().optional().describe("可选：按单个事件动作过滤（模糊匹配），如 login、logout、authorize_application"),
    actions: z.array(z.string()).optional().describe("可选：按多个事件动作精确过滤（任一命中）"),
    username: z.string().optional().describe("可选：按用户名过滤"),
    search: z.string().optional().describe("可选：全文搜索（用户/动作/IP/上下文等）"),
    limit: z.coerce.number().int().positive().max(200).optional().describe("返回条数，默认 20"),
    page: z.coerce.number().int().positive().optional().describe("分页页码，默认 1"),
  },
  async ({ action, actions = [], username, search, limit = 20, page = 1 }) => {
    const data = await listEvents({
      search,
      action,
      actions,
      username,
      page,
      page_size: limit,
      ordering: "-created",
    });

    const results = (data?.results || []).map((e) => ({
      pk: e.pk,
      action: e.action,
      user: e.user
        ? { pk: e.user.pk, username: e.user.username, email: e.user.email }
        : null,
      app: e.app,
      client_ip: e.client_ip,
      created: e.created,
      brand: e.brand?.name,
      context: e.context,
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              count: data?.count ?? results.length,
              page,
              page_size: limit,
              results,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "get_logins_authorizations_volume",
  "登录与授权时间序列（Logins and authorizations over the last week）：默认统计最近 7 天的 login 与 authorize_application 事件量，后端按小时聚合并对齐到时间桶",
  {
    history_days: z
      .number()
      .int()
      .positive()
      .max(90)
      .optional()
      .describe("统计天数，默认 7（最近一周），最大 90"),
    actions: z
      .array(z.string())
      .optional()
      .describe("要统计的事件动作，默认 [login, authorize_application]"),
    query: z.string().optional().describe("可选：AKQL 高级过滤表达式"),
  },
  async ({ history_days = 7, actions, query }) => {
    const targetActions =
      actions && actions.length ? actions : ["login", "authorize_application"];

    const data = await getEventVolume({ history_days, actions: targetActions, query });

    // API 返回形如 [{ action, time, count }]，按时间桶聚合成图表友好的序列
    const series = Array.isArray(data) ? data : [];
    const buckets = {};
    for (const row of series) {
      const t = row.time;
      if (!buckets[t]) buckets[t] = { time: t, total: 0, by_action: {} };
      buckets[t].by_action[row.action] = (buckets[t].by_action[row.action] || 0) + row.count;
      buckets[t].total += row.count;
    }
    const timeseries = Object.values(buckets).sort((a, b) =>
      String(a.time).localeCompare(String(b.time))
    );

    const totalByAction = {};
    let grandTotal = 0;
    for (const row of series) {
      totalByAction[row.action] = (totalByAction[row.action] || 0) + row.count;
      grandTotal += row.count;
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              message: "登录与授权事件量统计",
              history_days,
              actions: targetActions,
              summary: {
                grand_total: grandTotal,
                by_action: totalByAction,
                bucket_count: timeseries.length,
              },
              timeseries,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "get_security_overview",
  "最近安全统计（Security overview）：一次性汇总输出两个维度——最近事件（Recent events）与最近一周登录/授权时间序列（Logins and authorizations）。用户说“查看最近的安全统计”时使用",
  {
    history_days: z
      .number()
      .int()
      .positive()
      .max(90)
      .optional()
      .describe("时间序列统计天数，默认 7（最近一周），最大 90"),
    recent_limit: z
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .describe("最近事件返回条数，默认 20"),
    volume_actions: z
      .array(z.string())
      .optional()
      .describe("时间序列统计的事件动作，默认 [login, authorize_application]"),
  },
  async ({ history_days = 7, recent_limit = 20, volume_actions }) => {
    const targetActions =
      volume_actions && volume_actions.length
        ? volume_actions
        : ["login", "authorize_application"];

    // 两个维度并行获取，互不依赖
    const [eventsData, volumeData] = await Promise.all([
      listEvents({ page: 1, page_size: recent_limit, ordering: "-created" }),
      getEventVolume({ history_days, actions: targetActions }),
    ]);

    // ---- 维度一：最近事件 ----
    const recentEvents = (eventsData?.results || []).map((e) => ({
      pk: e.pk,
      action: e.action,
      user: e.user
        ? { pk: e.user.pk, username: e.user.username, email: e.user.email }
        : null,
      app: e.app,
      client_ip: e.client_ip,
      created: e.created,
      brand: e.brand?.name,
    }));

    // ---- 维度二：登录/授权时间序列 ----
    const series = Array.isArray(volumeData) ? volumeData : [];
    const buckets = {};
    for (const row of series) {
      const t = row.time;
      if (!buckets[t]) buckets[t] = { time: t, total: 0, by_action: {} };
      buckets[t].by_action[row.action] = (buckets[t].by_action[row.action] || 0) + row.count;
      buckets[t].total += row.count;
    }
    const timeseries = Object.values(buckets).sort((a, b) =>
      String(a.time).localeCompare(String(b.time))
    );

    const totalByAction = {};
    let grandTotal = 0;
    for (const row of series) {
      totalByAction[row.action] = (totalByAction[row.action] || 0) + row.count;
      grandTotal += row.count;
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              message: "最近安全统计概览",
              generated_at: new Date().toISOString(),
              recent_events: {
                count: eventsData?.count ?? recentEvents.length,
                returned: recentEvents.length,
                results: recentEvents,
              },
              logins_and_authorizations: {
                history_days,
                actions: targetActions,
                summary: {
                  grand_total: grandTotal,
                  by_action: totalByAction,
                  bucket_count: timeseries.length,
                },
                timeseries,
              },
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "list_applications",
  "列出应用（Applications）：每个应用附带其绑定的 Provider 概要（类型/名称/流程）",
  {
    search: z.string().optional().describe("可选：按名称/slug/描述搜索"),
    limit: z.coerce.number().int().positive().max(200).optional().describe("返回条数，默认 50"),
    page: z.coerce.number().int().positive().optional().describe("分页页码，默认 1"),
  },
  async ({ search, limit = 50, page = 1 }) => {
    const data = await listApplications({ search, page, page_size: limit });
    const results = (data?.results || []).map(summarizeApplication);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { count: data?.count ?? results.length, page, page_size: limit, results },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "get_application",
  "查看单个应用详情（按 slug 或名称），含绑定的 Provider 完整信息",
  {
    slug: z.string().optional().describe("应用 slug（精确）"),
    name: z.string().optional().describe("应用名称（模糊/精确匹配）"),
  },
  async ({ slug, name }) => {
    if (!slug && !name) {
      throw new Error("请提供 slug 或 name");
    }
    const app = await findApplication({ slug, name });
    if (!app) {
      throw new Error(`未找到应用: ${slug || name}`);
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              application: summarizeApplication(app),
              raw_provider_obj: app.provider_obj || null,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "list_providers",
  "列出提供程序（Providers）：含类型（component）、所属应用等信息",
  {
    search: z.string().optional().describe("可选：按名称/所属应用名搜索"),
    unassigned_only: z
      .boolean()
      .optional()
      .describe("可选：为 true 时仅返回未绑定任何应用的 provider"),
    limit: z.coerce.number().int().positive().max(200).optional().describe("返回条数，默认 100"),
    page: z.coerce.number().int().positive().optional().describe("分页页码，默认 1"),
  },
  async ({ search, unassigned_only, limit = 100, page = 1 }) => {
    const data = await listProviders({
      search,
      page,
      page_size: limit,
      application_isnull: unassigned_only === undefined ? undefined : unassigned_only,
    });
    const results = (data?.results || []).map(summarizeProvider);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { count: data?.count ?? results.length, page, page_size: limit, results },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "get_application_with_provider",
  "查看应用及其绑定的 Provider 详细信息：输入应用 slug 或名称，返回应用信息 + 绑定 Provider（含类型与流程）的完整详情",
  {
    slug: z.string().optional().describe("应用 slug（精确）"),
    name: z.string().optional().describe("应用名称"),
  },
  async ({ slug, name }) => {
    if (!slug && !name) {
      throw new Error("请提供 slug 或 name");
    }
    const app = await findApplication({ slug, name });
    if (!app) {
      throw new Error(`未找到应用: ${slug || name}`);
    }

    const provider = summarizeProvider(app.provider_obj);
    const backchannel = Array.isArray(app.backchannel_providers_obj)
      ? app.backchannel_providers_obj.map(summarizeProvider)
      : [];

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              message: provider
                ? `应用 ${app.name} 绑定了 Provider: ${provider.name}（${provider.type}）`
                : `应用 ${app.name} 当前未绑定主 Provider`,
              application: {
                pk: app.pk,
                name: app.name,
                slug: app.slug,
                launch_url: app.launch_url,
                meta_launch_url: app.meta_launch_url,
                meta_description: app.meta_description,
                meta_publisher: app.meta_publisher,
                group: app.group,
              },
              bound_provider: provider,
              backchannel_providers: backchannel,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "get_oauth2_provider_config",
  "获取 OAuth2/OpenID Provider 完整配置：client_id、client_secret、回调地址（redirect URIs）、签名密钥、scope 明细与 OIDC 端点 URL。可传 provider_id（数字 PK），也可传应用 slug/名称自动解析其绑定的 Provider。注意：返回内容包含 client_secret 等敏感凭证，请在安全渠道使用",
  {
    provider_id: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe("OAuth2 Provider 的 PK（数字 ID），例如 22。与 application_slug/application_name 三选一"),
    application_slug: z
      .string()
      .optional()
      .describe("应用 slug，例如 newapi。将自动解析该应用绑定的 Provider"),
    application_name: z
      .string()
      .optional()
      .describe("应用名称。将自动解析该应用绑定的 Provider"),
    include_setup_urls: z
      .boolean()
      .optional()
      .describe("是否附带 OIDC 端点 URL（issuer/authorize/token 等），默认 true"),
    resolve_scopes: z
      .boolean()
      .optional()
      .describe("是否把 property_mappings 的 ID 解析为 scope 名称，默认 true"),
  },
  async ({ provider_id, application_slug, application_name, include_setup_urls = true, resolve_scopes = true }) => {
    let resolvedProviderId = provider_id;

    // 未直接给 provider_id 时，尝试从应用 slug/名称解析其绑定的 Provider
    if (!resolvedProviderId) {
      if (!application_slug && !application_name) {
        throw new Error("请提供 provider_id，或提供 application_slug / application_name 以自动解析绑定的 Provider");
      }
      const app = await findApplication({ slug: application_slug, name: application_name });
      if (!app) {
        throw new Error(`未找到应用: ${application_slug || application_name}`);
      }
      if (!app.provider) {
        throw new Error(`应用 ${app.name} 未绑定主 Provider，无法获取 OAuth2 配置`);
      }
      resolvedProviderId = app.provider;
    }

    const provider = await getOAuth2Provider(resolvedProviderId);

    const setupUrls = include_setup_urls ? await getOAuth2SetupUrls(resolvedProviderId) : undefined;

    let scopes;
    if (resolve_scopes) {
      scopes = await resolveScopeMappings(provider.property_mappings || []);
    }

    const redirectUris = Array.isArray(provider.redirect_uris)
      ? provider.redirect_uris.map((r) =>
          typeof r === "string"
            ? { url: r }
            : { matching_mode: r.matching_mode, url: r.url, redirect_uri_type: r.redirect_uri_type }
        )
      : provider.redirect_uris;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              message: `OAuth2 Provider 完整配置: ${provider.name} (pk=${provider.pk})`,
              warning: "包含 client_secret 等敏感凭证，请勿在不安全渠道传播",
              provider: {
                pk: provider.pk,
                name: provider.name,
                type: provider.component,
                client_type: provider.client_type,
                client_id: provider.client_id,
                client_secret: provider.client_secret,
                grant_types: provider.grant_types,
                redirect_uris: redirectUris,
                signing_key: provider.signing_key,
                encryption_key: provider.encryption_key,
                sub_mode: provider.sub_mode,
                issuer_mode: provider.issuer_mode,
                include_claims_in_id_token: provider.include_claims_in_id_token,
                access_code_validity: provider.access_code_validity,
                access_token_validity: provider.access_token_validity,
                refresh_token_validity: provider.refresh_token_validity,
                authorization_flow: provider.authorization_flow,
                authentication_flow: provider.authentication_flow,
                invalidation_flow: provider.invalidation_flow,
                assigned_application_name: provider.assigned_application_name,
                assigned_application_slug: provider.assigned_application_slug,
              },
              scopes: resolve_scopes
                ? scopes
                : (provider.property_mappings || []).map((id) => ({ pk: id, resolved: false })),
              oidc_endpoints: include_setup_urls ? setupUrls : undefined,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
