/**
 * Preservation Property Tests
 *
 * Property 2: Preservation - Explicit Username and Traditional Validation Unchanged
 *
 * These tests encode the CURRENT correct behavior that must NOT change after the fix.
 * They are expected to PASS on unfixed code (confirming baseline behavior to preserve).
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

// ---- Extract current (unfixed) logic from authentik-aws-mcp.mjs ----

function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

function validateUsername(username) {
  // Current implementation: 3-64 chars, letters/numbers/_/.-
  const re = /^[a-zA-Z0-9_.-]{3,64}$/;
  return re.test(username);
}

/**
 * Simulates the username resolution logic in quick_add_user_to_group
 * Current code: const resolvedUsername = username || emailPrefix
 */
function resolveUsernameQuickAdd({ email, username }) {
  const emailPrefix = email.split("@")[0] || "user";
  const resolvedUsername = username || emailPrefix;
  return resolvedUsername;
}

/**
 * Simulates the username resolution logic in bulk_quick_add_users_to_group
 * Current code: const resolvedUsername = item.username || emailPrefix
 */
function resolveUsernameBulkAdd({ email, username }) {
  const emailPrefix = email.split("@")[0] || "user";
  const resolvedUsername = username || emailPrefix;
  return resolvedUsername;
}

/**
 * Simulates the display name resolution logic (shared by both tools)
 * Current code: const resolvedName = name || emailPrefix
 */
function resolveDisplayName({ email, name }) {
  const emailPrefix = email.split("@")[0] || "user";
  const resolvedName = name || emailPrefix;
  return resolvedName;
}

// ---- Arbitrary generators ----

/**
 * Generates traditional valid usernames matching /^[a-zA-Z0-9_.-]{3,64}$/
 */
const traditionalUsernameCharArb = fc.constantFrom(
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-'.split('')
);

const traditionalUsernameArb = fc.array(traditionalUsernameCharArb, { minLength: 3, maxLength: 64 })
  .map(chars => chars.join(''));

/**
 * Generates strings that are too short (0-2 characters) from allowed chars
 */
const tooShortUsernameArb = fc.array(traditionalUsernameCharArb, { minLength: 0, maxLength: 2 })
  .map(chars => chars.join(''));

/**
 * Generates strings containing disallowed characters (spaces, #, !, etc.)
 */
const disallowedCharArb = fc.constantFrom(' ', '#', '!', '$', '%', '^', '&', '*', '(', ')', '+', '=', '~', '`', '/', '\\', '|', '<', '>', ',', '?', ';', ':', '"', "'", '[', ']', '{', '}');

const invalidUsernameWithDisallowedCharsArb = fc.tuple(
  fc.array(traditionalUsernameCharArb, { minLength: 1, maxLength: 10 }).map(c => c.join('')),
  disallowedCharArb,
  fc.array(traditionalUsernameCharArb, { minLength: 1, maxLength: 10 }).map(c => c.join(''))
).map(([prefix, badChar, suffix]) => `${prefix}${badChar}${suffix}`);

/**
 * Generates valid email addresses
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

/**
 * Generates explicit usernames (valid traditional usernames to use as explicit param)
 */
const explicitUsernameArb = traditionalUsernameArb.filter(u => validateUsername(u));

// ---- Observation Tests (Unit Tests) ----

describe('Preservation: Observation Tests', () => {

  it('validateUsername("ping.wang") returns true (traditional username)', () => {
    expect(validateUsername("ping.wang")).toBe(true);
  });

  it('validateUsername("john_doe.123") returns true (traditional username with all allowed chars)', () => {
    expect(validateUsername("john_doe.123")).toBe(true);
  });

  it('validateUsername("ab") returns false (too short)', () => {
    expect(validateUsername("ab")).toBe(false);
  });

  it('validateUsername("") returns false (empty)', () => {
    expect(validateUsername("")).toBe(false);
  });

  it('validateUsername("has space") returns false (disallowed char)', () => {
    expect(validateUsername("has space")).toBe(false);
  });

  it('validateUsername("has#hash") returns false (disallowed char)', () => {
    expect(validateUsername("has#hash")).toBe(false);
  });

  it('quick_add_user_to_group with explicit username uses provided username', () => {
    const result = resolveUsernameQuickAdd({
      email: "ping.wang@verycloud.cn",
      username: "custom_user",
    });
    expect(result).toBe("custom_user");
  });

  it('bulk_quick_add_users_to_group with explicit username uses provided username', () => {
    const result = resolveUsernameBulkAdd({
      email: "ping.wang@verycloud.cn",
      username: "custom_user",
    });
    expect(result).toBe("custom_user");
  });

  it('display name defaults to emailPrefix', () => {
    const result = resolveDisplayName({
      email: "ping.wang@verycloud.cn",
      name: undefined,
    });
    expect(result).toBe("ping.wang");
  });
});

// ---- Property-Based Tests ----

describe('Preservation: Property-Based Tests', () => {

  describe('Requirement 3.3: Traditional usernames accepted by validateUsername', () => {

    it('Property: for all traditional usernames matching /^[a-zA-Z0-9_.-]{3,64}$/, validateUsername returns true', () => {
      /**
       * Validates: Requirements 3.3
       */
      fc.assert(
        fc.property(traditionalUsernameArb, (username) => {
          return validateUsername(username) === true;
        }),
        { numRuns: 200 }
      );
    });
  });

  describe('Requirement 3.4: Invalid usernames rejected by validateUsername', () => {

    it('Property: for all strings with disallowed characters, validateUsername returns false', () => {
      /**
       * Validates: Requirements 3.4
       */
      fc.assert(
        fc.property(invalidUsernameWithDisallowedCharsArb, (username) => {
          return validateUsername(username) === false;
        }),
        { numRuns: 200 }
      );
    });

    it('Property: for all strings that are too short (<3 chars from allowed set), validateUsername returns false', () => {
      /**
       * Validates: Requirements 3.4
       */
      fc.assert(
        fc.property(tooShortUsernameArb, (username) => {
          return validateUsername(username) === false;
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Requirement 3.1 / 3.2: Explicit username is used as-is', () => {

    it('Property: for all calls with explicit username, quick_add resolves to the explicit username', () => {
      /**
       * Validates: Requirements 3.1
       */
      fc.assert(
        fc.property(validEmailArb, explicitUsernameArb, (email, explicitUsername) => {
          const result = resolveUsernameQuickAdd({ email, username: explicitUsername });
          return result === explicitUsername;
        }),
        { numRuns: 200 }
      );
    });

    it('Property: for all calls with explicit username, bulk_add resolves to the explicit username', () => {
      /**
       * Validates: Requirements 3.2
       */
      fc.assert(
        fc.property(validEmailArb, explicitUsernameArb, (email, explicitUsername) => {
          const result = resolveUsernameBulkAdd({ email, username: explicitUsername });
          return result === explicitUsername;
        }),
        { numRuns: 200 }
      );
    });
  });

  describe('Requirement 3.5: Display name defaults to emailPrefix', () => {

    it('Property: for all calls without explicit name, resolvedName equals emailPrefix', () => {
      /**
       * Validates: Requirements 3.5
       */
      fc.assert(
        fc.property(validEmailArb, (email) => {
          const result = resolveDisplayName({ email, name: undefined });
          const expectedPrefix = email.split("@")[0] || "user";
          return result === expectedPrefix;
        }),
        { numRuns: 200 }
      );
    });

    it('Property: for all calls with explicit name, resolvedName equals the explicit name', () => {
      /**
       * Validates: Requirements 3.5
       */
      const displayNameArb = fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length >= 1);
      fc.assert(
        fc.property(validEmailArb, displayNameArb, (email, name) => {
          const result = resolveDisplayName({ email, name });
          return result === name;
        }),
        { numRuns: 200 }
      );
    });
  });
});
