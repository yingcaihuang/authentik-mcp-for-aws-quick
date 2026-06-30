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
  // authentik username can be flexible; here we enforce readable safe pattern
  // 3-64 chars, letters/numbers/_/.-
  const re = /^[a-zA-Z0-9_.-]{3,64}$/;
  return re.test(username);
}

function validateDisplayName(name) {
  return typeof name === "string" && name.trim().length >= 1 && name.trim().length <= 128;
}

function validatePasswordComplexity(password) {
  if (typeof password !== "string") {
    return { ok: false, reason: "password 必须是字符串" };
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
  // 避免使用容易复制/输入出错的字符（如 []{}<>`'"\\）
  const special = "!@#$%^&*()-_=+?.:,;";
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

const server = new McpServer({
  name: "authentik-aws-mcp",
  version: "1.0.0",
});

server.tool(
  "list_groups",
  "列出 authentik 组",
  {
    search: z.string().optional().describe("可选：按组名模糊搜索"),
    page: z.number().int().positive().optional(),
    page_size: z.number().int().positive().max(200).optional(),
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
    page: z.number().int().positive().optional(),
    page_size: z.number().int().positive().max(200).optional(),
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
    user_pk: z.number().int().positive().optional(),
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
          user_pk: z.number().int().positive().optional(),
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
    user_pk: z.number().int().positive().optional(),
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
    user_pk: z.number().int().positive().optional(),
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
    user_pk: z.number().int().positive().optional(),
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
    user_pk: z.number().int().positive().optional(),
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
    user_pk: z.number().int().positive().optional(),
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
    const resolvedUsername = username || emailPrefix;
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
        const resolvedUsername = item.username || emailPrefix;
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
    user_pk: z.number().int().positive().optional(),
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
    user_pk: z.number().int().positive().optional(),
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
