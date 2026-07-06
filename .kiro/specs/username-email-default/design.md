# Username Email Default Bugfix Design

## Overview

When users are created via `quick_add_user_to_group` or `bulk_quick_add_users_to_group` without an explicit `username` parameter, the system derives the default username from the email prefix (e.g. `"ping.wang"` from `"ping.wang@verycloud.cn"`). This causes AWS SCIM synchronization failures because SCIM expects usernames in email format. Additionally, `validateUsername` rejects email-format usernames since its regex disallows the `@` character. The fix changes the default username to the full email address and relaxes `validateUsername` to accept valid email-format usernames.

## Glossary

- **Bug_Condition (C)**: The condition where a user is created without an explicit `username` parameter, causing the system to incorrectly derive the username from the email prefix instead of using the full email address
- **Property (P)**: When no explicit username is provided, the full email address shall be used as the default username, and `validateUsername` shall accept it
- **Preservation**: Explicit username parameters, traditional username validation, display name defaults, and all other tool behaviors must remain unchanged
- **validateUsername**: The function in `authentik-aws-mcp.mjs` (line ~52) that validates username format using a regex pattern
- **emailPrefix**: The portion of an email before `@`, currently used as default username (the bug)
- **resolvedUsername**: The local variable in `quick_add_user_to_group` and `bulk_quick_add_users_to_group` that holds the final username value

## Bug Details

### Bug Condition

The bug manifests when `quick_add_user_to_group` or `bulk_quick_add_users_to_group` is called with an email but without an explicit `username` parameter. The system uses `emailPrefix` (the part before `@`) as the default username, which breaks AWS SCIM sync that requires email-format usernames. Furthermore, even if the caller tries to pass a full email as username, `validateUsername` rejects it because `@` is not in the allowed character set.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type { email: string, username?: string, tool: string }
  OUTPUT: boolean
  
  RETURN input.tool IN ['quick_add_user_to_group', 'bulk_quick_add_users_to_group']
         AND input.email IS a valid email address
         AND (input.username IS undefined OR input.username IS null OR input.username IS empty)
END FUNCTION
```

**Secondary Bug Condition (validateUsername rejection):**
```
FUNCTION isValidationBugCondition(input)
  INPUT: input of type { username: string }
  OUTPUT: boolean

  RETURN input.username contains '@'
         AND input.username IS a valid email address
END FUNCTION
```

### Examples

- `quick_add_user_to_group({ email: "ping.wang@verycloud.cn", group_name: "aws-dev" })` → username defaults to `"ping.wang"` instead of `"ping.wang@verycloud.cn"`
- `bulk_quick_add_users_to_group({ group_name: "aws-dev", users: [{ email: "li.wei@verycloud.cn" }] })` → username defaults to `"li.wei"` instead of `"li.wei@verycloud.cn"`
- `validateUsername("ping.wang@verycloud.cn")` → returns `false` (should return `true`)
- `validateUsername("ping.wang")` → returns `true` (should remain `true` — unchanged behavior)

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- When an explicit `username` is provided to `quick_add_user_to_group` or `bulk_quick_add_users_to_group`, it must be used as-is
- `validateUsername` must continue to accept traditional usernames (3-64 chars of `[a-zA-Z0-9_.-]`)
- `validateUsername` must continue to reject empty strings, strings with disallowed special characters (spaces, `#`, `!`, etc.), strings shorter than 3 chars
- The default `name` (display name) should continue to use `emailPrefix` since that's a reasonable display name
- `provision_user_default` and `create_user` tools must continue to require explicit username — no default derivation
- Password generation, group creation, and all other side effects must remain unchanged
- The `create_user` tool's existing validation flow must remain unchanged

**Scope:**
All inputs where an explicit `username` IS provided, or where the tool is NOT `quick_add_user_to_group`/`bulk_quick_add_users_to_group`, should be completely unaffected by this fix. This includes:
- Direct `create_user` calls
- `provision_user_default` calls
- `upsert_user` calls
- Mouse/UI interactions with authentik admin panel (out of scope)

## Hypothesized Root Cause

Based on the bug description, the issues are:

1. **Incorrect Default Username Derivation**: In both `quick_add_user_to_group` (line ~1000) and `bulk_quick_add_users_to_group` (line ~1130), the code uses `const resolvedUsername = username || emailPrefix` instead of `const resolvedUsername = username || email`. This was likely an intentional design choice at the time that didn't account for AWS SCIM requirements.

2. **Overly Restrictive Username Validation**: The `validateUsername` function uses regex `/^[a-zA-Z0-9_.-]{3,64}$/` which does not include `@`. This was designed for traditional usernames but needs to also accept email-format usernames to support SCIM sync.

3. **Length Constraint Too Short**: The current 64-char max may be too short for some email addresses (e.g. `very.long.firstname.lastname@subdomain.company-name.co.uk` could exceed 64 chars). Email addresses can be up to 254 characters per RFC 5321.

## Correctness Properties

Property 1: Bug Condition - Default Username Uses Full Email

_For any_ call to `quick_add_user_to_group` or `bulk_quick_add_users_to_group` where the email is valid and no explicit username is provided, the system SHALL use the full email address as the username AND `validateUsername` SHALL accept this email-format username as valid.

**Validates: Requirements 2.1, 2.2, 2.3**

Property 2: Preservation - Explicit Username and Traditional Validation Unchanged

_For any_ call where an explicit username IS provided, OR where `validateUsername` is called with a traditional username (no `@`), the fixed code SHALL produce exactly the same behavior as the original code, preserving explicit username pass-through and traditional validation rules.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

**File**: `authentik-aws-mcp.mjs`

**Function 1**: `validateUsername`

**Specific Changes**:
1. **Accept email-format usernames**: Modify `validateUsername` to also accept valid email addresses as usernames. The function should first check if the input matches the traditional pattern, and if not, check if it's a valid email format.
2. **Increase max length for email usernames**: Allow up to 254 characters when the username is an email address (per RFC 5321).

**Implementation approach**:
```javascript
function validateUsername(username) {
  // Traditional username: 3-64 chars, letters/numbers/_/.-
  const traditionalRe = /^[a-zA-Z0-9_.-]{3,64}$/;
  if (traditionalRe.test(username)) return true;
  // Also accept valid email format as username (for SCIM sync)
  // Email can be up to 254 chars per RFC 5321
  if (username.length <= 254 && validateEmail(username)) return true;
  return false;
}
```

**Function 2**: `quick_add_user_to_group` handler

**Specific Changes**:
3. **Change default username from emailPrefix to email**: Change `const resolvedUsername = username || emailPrefix` to `const resolvedUsername = username || email`

**Function 3**: `bulk_quick_add_users_to_group` handler

**Specific Changes**:
4. **Change default username from emailPrefix to email**: Change `const resolvedUsername = item.username || emailPrefix` to `const resolvedUsername = item.username || email`

**Preserved behavior**:
5. **Keep emailPrefix for display name**: Both functions already use `const resolvedName = name || emailPrefix` (or `item.name || emailPrefix`) — this stays unchanged since email prefix is a good display name.

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code, then verify the fix works correctly and preserves existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: Write tests that call `quick_add_user_to_group` and `bulk_quick_add_users_to_group` without explicit usernames, and verify what username is passed to `createUser`. Also test `validateUsername` with email inputs. Run these tests on the UNFIXED code to observe failures.

**Test Cases**:
1. **Default Username Test (single)**: Call `quick_add_user_to_group({ email: "test@example.com", group_name: "g" })` — observe that `resolvedUsername` is `"test"` not `"test@example.com"` (will fail on unfixed code)
2. **Default Username Test (bulk)**: Call `bulk_quick_add_users_to_group` with email-only entries — observe emailPrefix used (will fail on unfixed code)
3. **Validation Rejection Test**: Call `validateUsername("test@example.com")` — observe it returns `false` (will fail on unfixed code)
4. **Long Email Test**: Call `validateUsername("very.long.name@subdomain.company.co.uk")` — observe it returns `false` (will fail on unfixed code)

**Expected Counterexamples**:
- `resolvedUsername` resolves to `emailPrefix` instead of full email
- `validateUsername` rejects valid email addresses
- Possible causes: regex character class missing `@`, default derivation logic uses `emailPrefix`

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := quick_add_user_to_group_fixed(input)
  ASSERT result.user.username == input.email
END FOR

FOR ALL input WHERE isValidationBugCondition(input) DO
  result := validateUsername_fixed(input.username)
  ASSERT result == true
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT quick_add_user_to_group_original(input) = quick_add_user_to_group_fixed(input)
END FOR

FOR ALL username WHERE NOT isValidationBugCondition(username) DO
  ASSERT validateUsername_original(username) = validateUsername_fixed(username)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the input domain
- It catches edge cases that manual unit tests might miss (e.g. unusual but valid traditional usernames)
- It provides strong guarantees that `validateUsername` behavior is unchanged for all non-email inputs

**Test Plan**: Observe behavior on UNFIXED code first for explicit usernames and traditional validation patterns, then write property-based tests capturing that behavior.

**Test Cases**:
1. **Explicit Username Preservation**: Verify that when `username` is explicitly passed, it is used as-is regardless of whether it matches the email
2. **Traditional Username Validation Preservation**: Verify that `validateUsername` continues to accept `[a-zA-Z0-9_.-]{3,64}` patterns
3. **Invalid Username Rejection Preservation**: Verify that `validateUsername` continues to reject strings with spaces, `#`, `!` (non-email special chars), empty strings, and too-short strings
4. **Display Name Preservation**: Verify that `resolvedName` still defaults to `emailPrefix`

### Unit Tests

- Test `validateUsername` with traditional valid usernames (unchanged behavior)
- Test `validateUsername` with valid email addresses (new behavior)
- Test `validateUsername` with invalid inputs (unchanged rejections)
- Test default username derivation in `quick_add_user_to_group` without explicit username
- Test default username derivation in `bulk_quick_add_users_to_group` without explicit username
- Test that explicit username parameter overrides the default in both tools
- Test that display name continues to default to `emailPrefix`

### Property-Based Tests

- Generate random valid email addresses and verify `validateUsername` accepts them after fix
- Generate random traditional usernames (matching `[a-zA-Z0-9_.-]{3,64}`) and verify `validateUsername` still accepts them (preservation)
- Generate random invalid strings (too short, containing disallowed chars other than `@`) and verify `validateUsername` still rejects them (preservation)
- Generate random `{ email, username? }` inputs and verify the correct default username selection logic

### Integration Tests

- Test full flow: call `quick_add_user_to_group` with only email, verify the created user has email as username
- Test full flow: call `bulk_quick_add_users_to_group` with multiple email-only entries, verify all get email as username
- Test that a user created with email-as-username can be found by `getUserByUsernameOrEmail` using both username and email lookup paths
