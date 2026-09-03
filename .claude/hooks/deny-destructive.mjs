#!/usr/bin/env node
// PreToolUse hook: refuses the few commands that destroy work the
// repository can't get back. With prompts on they would at least be asked
// about; in bypass-permissions mode nothing else stands in the way.
//
// Reads the hook input JSON on stdin and prints the documented PreToolUse
// deny decision when one applies; prints nothing otherwise.
// https://code.claude.com/docs/en/hooks#pretooluse-decision-control

import { readFileSync } from 'node:fs';

// Build output and dependencies: deleting them costs a re-run, not work.
const DISPOSABLE = /^(\.\/)?(dist|coverage|node_modules)(\/\*?)?$/;
const GIT_SUBCOMMANDS = new Set([
  'push',
  'reset',
  'checkout',
  'restore',
  'clean',
]);
const POWERSHELL_REMOVERS = ['remove-item', 'ri', 'rmdir', 'rd', 'del', 'erase'];

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

function unquote(token) {
  return token.replace(/^["']|["']$/g, '');
}

// One token list per subcommand of a shell line, without the leading
// VAR=value assignments that never change what the command does.
function subcommands(command) {
  return command
    .split(/\r?\n|&&|\|\||;|\|/)
    .map((part) => part.trim().split(/\s+/).map(unquote).filter(Boolean))
    .map((tokens) => {
      while (tokens.length > 0 && /^[A-Za-z_]\w*=/.test(tokens[0])) {
        tokens.shift();
      }
      return tokens;
    })
    .filter((tokens) => tokens.length > 0);
}

// Short flags travel in clusters (`-rf`, `-fd`): true when any of them
// carries the letter.
function hasShortFlag(tokens, letter) {
  return tokens.some((t) => /^-[A-Za-z]+$/.test(t) && t.includes(letter));
}

function gitViolation(tokens) {
  const at = tokens.findIndex((t) => GIT_SUBCOMMANDS.has(t));
  if (at === -1) return null;
  const sub = tokens[at];
  const args = tokens.slice(at + 1);
  if (
    sub === 'push' &&
    (args.includes('--force') || hasShortFlag(args, 'f'))
  ) {
    return 'git push --force rewrites the remote branch; use --force-with-lease, and only after saying so.';
  }
  if (sub === 'reset' && args.includes('--hard')) {
    return 'git reset --hard discards uncommitted work; stash or commit it instead.';
  }
  if ((sub === 'checkout' || sub === 'restore') && args.includes('.')) {
    return `git ${sub} on the whole tree discards every uncommitted change; name the file instead.`;
  }
  if (
    sub === 'clean' &&
    (args.includes('--force') || hasShortFlag(args, 'f'))
  ) {
    return 'git clean -f deletes untracked files, which no git command brings back.';
  }
  return null;
}

function rmViolation(tokens) {
  const program = tokens[0].replace(/^.*[\\/]/, '').toLowerCase();
  const args = tokens.slice(1);
  const recursive =
    (program === 'rm' &&
      (args.includes('--recursive') ||
        hasShortFlag(args, 'r') ||
        hasShortFlag(args, 'R'))) ||
    (POWERSHELL_REMOVERS.includes(program) &&
      args.some((t) => /^-r(ecurse)?(:\$true)?$/i.test(t)));
  if (!recursive) return null;
  const targets = args.filter((t) => !t.startsWith('-'));
  const kept = targets.filter((t) => !DISPOSABLE.test(t));
  if (targets.length === 0 || kept.length === 0) return null;
  return `Recursive delete of ${kept[0]} is refused; only dist, coverage and node_modules are disposable.`;
}

function prismaViolation(tokens) {
  const line = tokens.join(' ');
  if (/\bprisma\s+migrate\s+reset\b/.test(line)) {
    return 'prisma migrate reset drops the database; ask the user to run it.';
  }
  if (
    /\bprisma\s+db\s+push\b/.test(line) &&
    /--(accept-data-loss|force-reset)\b/.test(line)
  ) {
    return 'prisma db push with --accept-data-loss or --force-reset destroys rows; ask the user to run it.';
  }
  return null;
}

const input = JSON.parse(readFileSync(0, 'utf8'));
const tool = String(input.tool_name ?? '');

if (/migrate[-_]reset/.test(tool)) {
  deny(
    'The Prisma migrate-reset tool drops the database; ask the user to run it.',
  );
} else if (tool === 'Bash' || tool === 'PowerShell') {
  const command = String(input.tool_input?.command ?? '');
  for (const tokens of subcommands(command)) {
    const reason =
      (tokens[0] === 'git' && gitViolation(tokens)) ||
      rmViolation(tokens) ||
      prismaViolation(tokens);
    if (reason) {
      deny(reason);
      break;
    }
  }
}
