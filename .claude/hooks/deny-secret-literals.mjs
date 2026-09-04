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
    label: 'a private key block',
    pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
  },
  {
    label: 'a signed JWT',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
  {
    // A local host is exempt: the compose credentials and the CI service's
    // throwaway user are committed on purpose and carry nothing. The string
    // that names a real host is the one that matters.
    label: 'a connection string carrying a password',
    pattern:
      /\b(postgres(?:ql)?|redis|rediss|mongodb(?:\+srv)?|amqp|mysql):\/\/[^\s:/@]+:[^\s:/@]+@(?!localhost|127\.0\.0\.1)[^\s/]+/,
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
const payload = payloadOf(String(input.tool_name ?? ''), input.tool_input ?? {});

if (payload) {
  const found = SECRETS.find(({ pattern }) => pattern.test(payload));
  if (found) {
    deny(
      `This would write ${found.label} into the repository. Secrets belong in .env and are read from the configuration at runtime; a test that needs one should build it from an environment variable or a fixture value that is not a real key.`,
    );
  }
}
