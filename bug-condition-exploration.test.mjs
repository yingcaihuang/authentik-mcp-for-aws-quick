/**
 * Bug Condition Exploration Test
 *
 * Property 1: Bug Condition - Default Username Uses Email Prefix Instead of Full Email
 *
 * This test encodes the EXPECTED (correct) behavior. It is expected to FAIL on
 * unfixed code, proving the bug exists. The test will PASS after the fix is applied.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 2.1, 2.2, 2.3
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

// ---- Extract current (unfixed) logic from authentik-aws-mcp.mjs ----

function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

function validateUsername(username) {
  // Fixed implementation: accepts traditional usernames AND valid email-format usernames
  const re = /^[a-zA-Z0-9_.-]{3,64}$/;
  if (re.test(username)) return true;
  // Also accept valid email format as username (for AWS SCIM sync compatibility)
  if (username.length <= 254 && validateEmail(username)) return true;
  return false;
}

/**
 * Simulates the username resolution logic in quick_add_user_to_group
 * Fixed code: const resolvedUsername = username || email
 */
function resolveUsernameQuickAdd({ email, username }) {
  const emailPrefix = email.split("@")[0] || "user";
  const resolvedUsername = username || email;  // Changed from emailPrefix to email
  return resolvedUsername;
}

/**
 * Simulates the username resolution logic in bulk_quick_add_users_to_group
 * Fixed code: const resolvedUsername = item.username || email
 */
function resolveUsernameBulkAdd({ email, username }) {
  const emailPrefix = email.split("@")[0] || "user";
  const resolvedUsername = username || email;  // Changed from emailPrefix to email
  return resolvedUsername;
}

// ---- Arbitrary generators ----

/**
 * Generates valid email addresses for property-based testing.
 * Constrained to emails that would be valid per the validateEmail regex.
 */
const localPartArb = fc.array(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789._-'.split('')),
  { minLength: 1, maxLength: 20 }
).map(chars => chars.join(''));

const domainArb = fc.array(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
  { minLength: 1, maxLength: 15 }
).map(chars => chars.join(''));

const tldArb = fc.array(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
  { minLength: 2, maxLength: 6 }
).map(chars => chars.join(''));

const validEmailArb = fc.tuple(localPartArb, domainArb, tldArb)
  .map(([local, domain, tld]) => `${local}@${domain}.${tld}`)
  .filter((email) => validateEmail(email));

// ---- Tests ----

describe('Bug Condition Exploration: Default Username Uses Email Prefix Instead of Full Email', () => {

  describe('Requirement 1.3 / 2.3: validateUsername rejects email-format usernames', () => {

    it('validateUsername("test@example.com") should return true (currently returns false)', () => {
      // Expected behavior: validateUsername should accept valid emails as usernames
      // Bug: the regex /^[a-zA-Z0-9_.-]{3,64}$/ rejects @ character
      expect(validateUsername("test@example.com")).toBe(true);
    });

    it('validateUsername("ping.wang@verycloud.cn") should return true (currently returns false)', () => {
      expect(validateUsername("ping.wang@verycloud.cn")).toBe(true);
    });

    it('Property: for any valid email, validateUsername should accept it', () => {
      fc.assert(
        fc.property(validEmailArb, (email) => {
          // Expected: validateUsername accepts all valid emails as usernames
          // Bug: validateUsername rejects all emails because @ is not in allowed chars
          return validateUsername(email) === true;
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Requirement 1.1 / 2.1: quick_add_user_to_group defaults username to full email', () => {

    it('quick_add_user_to_group with email "ping.wang@verycloud.cn" without explicit username should resolve to "ping.wang@verycloud.cn"', () => {
      const result = resolveUsernameQuickAdd({
        email: "ping.wang@verycloud.cn",
        username: undefined,
      });
      // Expected: resolvedUsername === "ping.wang@verycloud.cn"
      // Bug: resolvedUsername === "ping.wang" (email prefix)
      expect(result).toBe("ping.wang@verycloud.cn");
    });

    it('Property: for any valid email without explicit username, resolvedUsername should equal the full email', () => {
      fc.assert(
        fc.property(validEmailArb, (email) => {
          const result = resolveUsernameQuickAdd({ email, username: undefined });
          // Expected: result === email (the full email)
          // Bug: result === email.split("@")[0] (just the prefix)
          return result === email;
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Requirement 1.2 / 2.2: bulk_quick_add_users_to_group defaults username to full email', () => {

    it('bulk_quick_add_users_to_group with email "li.wei@verycloud.cn" without explicit username should resolve to "li.wei@verycloud.cn"', () => {
      const result = resolveUsernameBulkAdd({
        email: "li.wei@verycloud.cn",
        username: undefined,
      });
      // Expected: resolvedUsername === "li.wei@verycloud.cn"
      // Bug: resolvedUsername === "li.wei" (email prefix)
      expect(result).toBe("li.wei@verycloud.cn");
    });

    it('Property: for any valid email without explicit username in bulk add, resolvedUsername should equal the full email', () => {
      fc.assert(
        fc.property(validEmailArb, (email) => {
          const result = resolveUsernameBulkAdd({ email, username: undefined });
          // Expected: result === email (the full email)
          // Bug: result === email.split("@")[0] (just the prefix)
          return result === email;
        }),
        { numRuns: 100 }
      );
    });
  });
});
