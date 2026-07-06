# Bugfix Requirements Document

## Introduction

当用户通过 `quick_add_user_to_group` 或 `bulk_quick_add_users_to_group` 工具创建新用户且未显式传入 `username` 参数时，系统将邮箱前缀（如 "ping.wang"）作为默认用户名。由于 AWS SCIM 同步要求 username 为邮箱格式，这导致同步失败或异常。同时，`validateUsername` 函数的正则表达式 `/^[a-zA-Z0-9_.-]{3,64}$/` 不允许 `@` 字符，因此需要同步修改验证逻辑以支持邮箱格式的用户名。

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN `quick_add_user_to_group` is called with an email but without an explicit username THEN the system uses the email prefix (e.g. "ping.wang") as the username via `const resolvedUsername = username || emailPrefix`

1.2 WHEN `bulk_quick_add_users_to_group` is called with user entries that have an email but no explicit username THEN the system uses the email prefix (e.g. "ping.wang") as the username via `const resolvedUsername = item.username || emailPrefix`

1.3 WHEN `validateUsername` is called with a full email address (e.g. "ping.wang@verycloud.cn") THEN the system rejects it as invalid because the regex `/^[a-zA-Z0-9_.-]{3,64}$/` does not allow the `@` character

### Expected Behavior (Correct)

2.1 WHEN `quick_add_user_to_group` is called with an email but without an explicit username THEN the system SHALL use the full email address (e.g. "ping.wang@verycloud.cn") as the username

2.2 WHEN `bulk_quick_add_users_to_group` is called with user entries that have an email but no explicit username THEN the system SHALL use the full email address (e.g. "ping.wang@verycloud.cn") as the username

2.3 WHEN `validateUsername` is called with a valid email address as username THEN the system SHALL accept it as a valid username

### Unchanged Behavior (Regression Prevention)

3.1 WHEN `quick_add_user_to_group` is called with an explicit username parameter THEN the system SHALL CONTINUE TO use the provided username as-is

3.2 WHEN `bulk_quick_add_users_to_group` is called with user entries that have an explicit username THEN the system SHALL CONTINUE TO use the provided username as-is

3.3 WHEN `validateUsername` is called with a traditional username (letters, numbers, dots, underscores, hyphens, 3-64 chars) THEN the system SHALL CONTINUE TO accept it as valid

3.4 WHEN `validateUsername` is called with an invalid username (e.g. empty string, special characters other than allowed ones, too short, too long) THEN the system SHALL CONTINUE TO reject it as invalid

3.5 WHEN `provision_user_default` or `create_user` tools are called THEN the system SHALL CONTINUE TO require the caller to explicitly provide a username (no default derivation)
