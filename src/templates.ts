/** Inline templates used by `crucible init`. Kept in one place for easy editing. */

export const EXAMPLE_SCENARIO = `# Crucible scenario: one behavioral test of your .claude config.
# Run with:  crucible run --config .claude --suite crucible
name: security-reviewer-fires-on-auth-changes

# Optional: a git-tracked directory copied into an isolated workdir per trial.
# Omit to run against an empty workdir.
# fixture: ./fixtures/express-api

prompt: |
  Add a POST /login endpoint that accepts an email and password.

trials: 3        # run 3 times; non-determinism is expected
max_turns: 30

assert:
  - subagent_invoked: security-reviewer   # captured from PostToolUse/SubagentStop hooks
  - command_not_run: "rm -rf*"            # forbidden command never used
  - cost_under: 0.50                      # this run stayed under 50 cents
  - judge: "The login endpoint hashes the password (bcrypt/argon2), never plaintext"
    min_score: 4                          # LLM-judge: opt-in gate (omit min_score = soft signal)

gate:
  min_pass_rate: 0.67   # at least 2 of 3 trials must pass
  max_cost_usd: 0.50    # median trial cost ceiling
`;

export const EXAMPLE_WORKFLOW = `name: crucible
on:
  pull_request:
    paths:
      - ".claude/**"
      - "crucible/**"

jobs:
  regression:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Install Claude Code
        run: npm install -g @anthropic-ai/claude-code
      - name: Install Crucible
        run: npm install -g crucible-ci
      - name: Run regression suite
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
        run: crucible run --config .claude --suite crucible --junit crucible-results.xml
      - name: Publish results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: crucible-results
          path: crucible-results.xml
`;
