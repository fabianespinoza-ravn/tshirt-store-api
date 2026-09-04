#!/usr/bin/env node
// PreToolUse hook: keeps credential-shaped strings out of the repository.
//
// `deny-env-files.mjs` guards the file that holds the secrets. This one
// guards the other direction: writing a secret into a file that is not
// `.env`. The moment that matters is week 4's payment work, where a webhook
// signing secret pasted into a test fixture so the signature verifies is a
// natural thing to reach for and lands in the history.
//
// Patterns require real key material after the prefix, so the placeholders
// in `.env.example` and in documentation stay writable.
//
// Reads the hook input JSON on stdin and prints the documented PreToolUse
// deny decision when one applies; prints nothing otherwise.
// https://code.claude.com/docs/en/hooks#pretooluse-decision-control

import { readFileSync } from 'node:fs';

const SECRETS = [
  {
    label: 'a Stripe secret or restricted key',
    pattern: /\b[sr]k_(live|test)_[A-Za-z0-9]{20,}/,
  },
  {
    label: 'a Stripe webhook signing secret',
    pattern: /\bwhsec_[A-Za-z0-9]{20,}/,
  },
  {
    label: 'a GitHub token',
    pattern: /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/,
  },
  { label: 'an AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    // An AWS secret access key, and most others, carry no prefix to match:
    // 40 characters of base64 look like any other token. What identifies
    // them is the name they are assigned to. The two lookaheads require the
    // value to hold an upper-case letter and a digit, which real key
    // material does and the placeholders in .env.example
    // (`tshirt-local-dev`, `change-me`) do not.
    // Case-sensitive on purpose, and it was not at first. The `i` flag made
    // the `[A-Z]` lookahead — there to require the upper case real key
    // material has and a placeholder usually does not — match lower case as
    // well, so the entropy check did nothing. The rule then fired on an
    // ordinary lower-case local variable holding a printable fixture value,
    // which is how this was found. Without the flag the name has to be the
    // SCREAMING_SNAKE that configuration actually uses, which is where a
    // pasted credential lands.
    label: 'a secret assigned to a credential-named variable',
    pattern:
      /(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY)[A-Z_]*\s*[:=]\s*["']?(?=[A-Za-z0-9/+=_-]{20,})(?=[A-Za-z0-9/+=_-]*[A-Z])(?=[A-Za-z0-9/+=_-]*[0-9])[A-Za-z0-9/+=_-]{20,}/,
  },
  {
    label: 'a private key block',
    pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
  },
  {
    label: 'a signed JWT',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
  {
    // The exemption is on the password, not on the host: a real secret
    // pointed at localhost is still a real secret, and a URI is often
    // edited before its host is. A lower-case word of at most eight letters
    // is the placeholder convention every connection string committed here
    // follows — `ci:ci`, `tshirt:tshirt`, `user:pass` — and no key material
    // looks like that.
    label: 'a connection string carrying a password',
    pattern:
      /\b(postgres(?:ql)?|redis|rediss|mongodb(?:\+srv)?|amqp|mysql):\/\/[^\s:/@]+:(?![a-z]{1,8}@)[^\s:/@]+@/,
  },
];

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
}

// Everything the tool would put on disk or run, as one string to scan.
function payloadOf(tool, toolInput) {
  switch (tool) {
    case 'Write':
      return String(toolInput.content ?? '');
    case 'Edit':
      return String(toolInput.new_string ?? '');
    case 'MultiEdit':
      return (Array.isArray(toolInput.edits) ? toolInput.edits : [])
        .map((edit) => String(edit?.new_string ?? ''))
        .join('\n');
    case 'NotebookEdit':
      return String(toolInput.new_source ?? '');
    case 'Bash':
    case 'PowerShell':
      return String(toolInput.command ?? '');
    default:
      return '';
  }
}

const input = JSON.parse(readFileSync(0, 'utf8'));
const payload = payloadOf(
  String(input.tool_name ?? ''),
  input.tool_input ?? {},
);

if (payload) {
  const found = SECRETS.find(({ pattern }) => pattern.test(payload));
  if (found) {
    deny(
      `This would write ${found.label} into the repository. Secrets belong in .env and are read from the configuration at runtime; a test that needs one should build it from an environment variable or a fixture value that is not a real key.`,
    );
  }
}
