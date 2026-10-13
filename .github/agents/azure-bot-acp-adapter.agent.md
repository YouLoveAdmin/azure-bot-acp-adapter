---
name: azure-bot-acp-adapter
description: "Develop, debug, and maintain azure-bot-acp-adapter. For meaningful verified code changes, use GitHub CLI to push the current branch and open or update a non-draft PR to main."
argument-hint: The inputs this agent expects, e.g., "a task to implement" or "a question to answer".
# tools: ['vscode', 'execute', 'read', 'agent', 'edit', 'search', 'web', 'todo'] # specify the tools this agent can use. If not set, all enabled tools are allowed.
---

<!-- Tip: Use /create-agent in chat to generate content with agent assistance -->

For any task that makes intended, meaningful repository changes, complete and verify the work, then commit it and create or update a non-draft pull request to `cliffzhu/azure-bot-acp-adapter:main` from the current branch in the `YouLoveAdmin` fork. Do not use a Compare URL or ask the user to click one.

## GitHub push and pull request workflow

Use the authenticated GitHub CLI (`gh`) for GitHub authentication and PR operations. Do not use the GitKraken push/PR integration for this workflow: its Git HTTPS prompt may fail in the non-interactive terminal even when GitHub CLI credentials are available.

1. Check the repository status and current branch. Review the diff and stage only the intended files; do not include unrelated or sensitive files.
2. Run the relevant tests and checks, then commit the verified changes.
3. Check authentication with `gh auth status`. If authenticated, configure Git to use the CLI's credential with `gh auth setup-git`, then push the current branch to the `origin` remote (the `YouLoveAdmin` fork), for example `git push origin HEAD`.
4. Create the PR directly through GitHub CLI/API, not a Compare URL. Use repository `cliffzhu/azure-bot-acp-adapter`, base `main`, head owner `YouLoveAdmin`, head branch equal to the current branch, and `draft=false`. Example: `gh pr create --repo cliffzhu/azure-bot-acp-adapter --base main --head YouLoveAdmin:<current-branch> --title "<change summary>" --body "<summary and validation>"`.
5. If a PR already exists for the branch, inspect and report that PR instead of creating a duplicate. Verify the result with `gh pr view` and confirm it is open, non-draft, and has the expected base and head.

If `gh auth status` shows no active authentication, do not retry through another push tool or expose/request a token. Ask the user to authenticate GitHub CLI in their environment, then resume the push and PR steps. Never print credentials or tokens.