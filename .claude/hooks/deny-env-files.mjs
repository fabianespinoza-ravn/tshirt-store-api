#!/usr/bin/env node
// PreToolUse hook: keeps the secret env files out of the conversation.
//
// Secrets never enter a prompt. `.env` and `.env.<anything>` hold them, so
// the file tools are denied on those paths, and so is a Bash or PowerShell
// command that would print or rewrite one of them. `.env.example` is the
// tracked template and stays reachable.
//
// Reads the hook input JSON on stdin and prints the documented PreToolUse
// deny decision when one applies; prints nothing otherwise.
// https://code.claude.com/docs/en/hooks#pretooluse-decision-control

import { readFileSync } from 'node:fs';

const FILE_TOOLS = new Set([
  'Read',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
]);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

// Commands that put a file's content on the terminal, or rewrite it in
// place. `cp .env.example .env` is not one of them, on purpose.
const READERS =
  /(^|[\s;&|(`$])(cat|type|Get-Content|gc|head|tail|less|more|grep|egrep|fgrep|rg|sed|awk|cut|nl|tac|strings|xxd|od|bat|read|source|Select-String|sls)(\s|$)/;

function isSecretEnv(name) {
  return /^\.env(\..+)?$/.test(name) && name !== '.env.example';
}

function basename(path) {
  return path.replace(/^.*[\\/]/, '');
}

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

const input = JSON.parse(readFileSync(0, 'utf8'));
const tool = String(input.tool_name ?? '');
const toolInput = input.tool_input ?? {};

if (FILE_TOOLS.has(tool)) {
  const name = basename(
    String(toolInput.file_path ?? toolInput.notebook_path ?? ''),
  );
  if (isSecretEnv(name)) {
    deny(
      `${name} holds secrets and stays out of the conversation. .env.example lists the variable names; ask the user for a value if one is needed.`,
    );
  }
} else if (SHELL_TOOLS.has(tool)) {
  const command = String(toolInput.command ?? '');
  const mentioned = command
    .split(/[\s;&|()<>"'`=]+/)
    .map(basename)
    .filter(isSecretEnv);
  if (mentioned.length > 0 && READERS.test(command)) {
    deny(
      `This command would print or rewrite ${mentioned[0]}, which holds secrets. .env.example lists the variable names; ask the user for a value if one is needed.`,
    );
  }
}
