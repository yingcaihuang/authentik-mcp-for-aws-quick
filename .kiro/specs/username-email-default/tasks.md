# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Default Username Uses Email Prefix Instead of Full Email
  - **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior - it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the bug exists
  - **Scoped PBT Approach**: Scope the property to concrete failing cases: any valid email without explicit username passed to `quick_add_user_to_group` or `bulk_quick_add_users_to_group`
  - Test that `validateUsername("test@example.com")` returns `true` (currently returns `false` due to regex rejecting `@`)
  - Test that in `quick_add_user_to_group`, when called with `{ email: "ping.wang@verycloud.cn", group_name: "aws-dev" }` without explicit username, the `resolvedUsername` equals `"ping.wang@verycloud.cn"` (currently equals `"ping.wang"`)
  - Test that in `bulk_quick_add_users_to_group`, when called with `{ email: "li.wei@verycloud.cn" }` without explicit username, the `resolvedUsername` equals `"li.wei@verycloud.cn"` (currently equals `"li.wei"`)
  - Generate random valid email addresses and verify `validateUsername` accepts them (from Bug Condition in design: `isBugCondition(input)` where `input.username` is undefined and `input.email` is valid)
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS (this is correct - it proves the bug exists)
  - Document counterexamples found (e.g., `validateUsername("test@example.com")` returns `false`, `resolvedUsername` resolves to email prefix instead of full email)
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Explicit Username and Traditional Validation Unchanged
  - **IMPORTANT**: Follow observation-first methodology
  - Observe: `validateUsername("ping.wang")` returns `true` on unfixed code (traditional username)
  - Observe: `validateUsername("john_doe.123")` returns `true` on unfixed code (traditional username with all allowed chars)
  - Observe: `validateUsername("ab")` returns `false` on unfixed code (too short)
  - Observe: `validateUsername("")` returns `false` on unfixed code (empty)
  - Observe: `validateUsername("has space")` returns `false` on unfixed code (disallowed char)
  - Observe: `validateUsername("has#hash")` returns `false` on unfixed code (disallowed char)
  - Observe: when `quick_add_user_to_group` is called with explicit `username: "custom_user"`, the `resolvedUsername` is `"custom_user"` regardless of email
  - Observe: when `bulk_quick_add_users_to_group` is called with explicit `username: "custom_user"`, the `resolvedUsername` is `"custom_user"` regardless of email
  - Observe: display name (`resolvedName`) defaults to `emailPrefix` (e.g., `"ping.wang"` from `"ping.wang@verycloud.cn"`)
  - Write property-based test: for all traditional usernames matching `/^[a-zA-Z0-9_.-]{3,64}$/`, `validateUsername` returns `true` (from Preservation Requirements in design)
  - Write property-based test: for all strings with disallowed characters (spaces, `#`, `!`, etc.) or too short (<3 chars), `validateUsername` returns `false` (from Preservation Requirements in design)
  - Write property-based test: for all calls with explicit `username` parameter, the explicit username is used as-is
  - Write property-based test: for all calls, `resolvedName` defaults to `emailPrefix` when no explicit `name` provided
  - Verify tests pass on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 3. Fix for username defaulting to email prefix instead of full email

  - [x] 3.1 Modify `validateUsername` to accept email-format usernames
    - Add email validation branch: if traditional regex fails, check if input is a valid email (up to 254 chars)
    - Use existing `validateEmail` function for the email check
    - Keep traditional regex `/^[a-zA-Z0-9_.-]{3,64}$/` as first check (preserves existing behavior)
    - Add fallback: `if (username.length <= 254 && validateEmail(username)) return true`
    - _Bug_Condition: isValidationBugCondition(input) where input.username contains '@' and is a valid email_
    - _Expected_Behavior: validateUsername shall return true for valid email addresses_
    - _Preservation: Traditional usernames (no @) must continue to be validated by original regex only_
    - _Requirements: 1.3, 2.3, 3.3, 3.4_

  - [x] 3.2 Change default username in `quick_add_user_to_group` from `emailPrefix` to full `email`
    - Change `const resolvedUsername = username || emailPrefix` to `const resolvedUsername = username || email`
    - Keep `const resolvedName = name || emailPrefix` unchanged (display name still uses email prefix)
    - _Bug_Condition: isBugCondition(input) where input.tool = 'quick_add_user_to_group' AND input.username is undefined_
    - _Expected_Behavior: resolvedUsername shall equal input.email when no explicit username provided_
    - _Preservation: Explicit username parameter must still override; resolvedName must still use emailPrefix_
    - _Requirements: 1.1, 2.1, 3.1, 3.5_

  - [x] 3.3 Change default username in `bulk_quick_add_users_to_group` from `emailPrefix` to full `email`
    - Change `const resolvedUsername = item.username || emailPrefix` to `const resolvedUsername = item.username || email`
    - Keep `const resolvedName = item.name || emailPrefix` unchanged (display name still uses email prefix)
    - _Bug_Condition: isBugCondition(input) where input.tool = 'bulk_quick_add_users_to_group' AND item.username is undefined_
    - _Expected_Behavior: resolvedUsername shall equal item.email when no explicit username provided_
    - _Preservation: Explicit username parameter must still override; resolvedName must still use emailPrefix_
    - _Requirements: 1.2, 2.2, 3.2, 3.5_

  - [x] 3.4 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Default Username Uses Full Email
    - **IMPORTANT**: Re-run the SAME test from task 1 - do NOT write a new test
    - The test from task 1 encodes the expected behavior
    - When this test passes, it confirms the expected behavior is satisfied
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 3.5 Verify preservation tests still pass
    - **Property 2: Preservation** - Explicit Username and Traditional Validation Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - Run preservation property tests from step 2
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm all tests still pass after fix (no regressions)

- [x] 4. Checkpoint - Ensure all tests pass
  - Run the full test suite to confirm both bug condition tests pass and preservation tests pass
  - Verify `validateUsername` accepts both traditional usernames and valid email addresses
  - Verify `quick_add_user_to_group` defaults username to full email when not provided
  - Verify `bulk_quick_add_users_to_group` defaults username to full email when not provided
  - Verify explicit username parameters still override the default in both tools
  - Verify display name still defaults to email prefix in both tools
  - Ensure all tests pass, ask the user if questions arise.
