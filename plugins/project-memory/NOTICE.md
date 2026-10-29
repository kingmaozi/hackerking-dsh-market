# NOTICE

`project-memory` is part of the hackerking DSH plugin workspace.

- Project memory layout (`<project>/.dsh/memory/<basename>-<hash16>.md`) is
  modelled on ZCode's per-project memory directories
  (`~/.zcode/cli/memories/projects/<name>-<hash>/memory/`). No ZCode code is
  copied; only the naming/isolation convention is reproduced.
- The plugin registers a skill provider and plain tool definitions against the
  public DeepSeek Harness `skills` / `tools` services; it imports no
  `@deepseek-ai/*` packages and contains no host patches.
- License: MIT (same as the rest of this workspace's plugins).
