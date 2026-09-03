// The history has followed Conventional Commits since the first commit. This
// only makes it mandatory, and it runs in CI rather than a local hook:
// `core.hooksPath` on this machine points outside the repo, and a hook here
// would be shadowed by it.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // A body carries links, and a link doesn't split in half. Dependabot
    // signs every commit with the changelog URLs, all past the preset's
    // 100-character limit, so the rule would reject every dependency update.
    // What actually matters — the type, scope and subject, which are what
    // make the history readable — stays mandatory.
    'body-max-line-length': [0, 'always'],
  },
};
