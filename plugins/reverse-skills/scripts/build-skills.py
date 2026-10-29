#!/usr/bin/env python3
"""从 repo/skills 的上游技能生成 DSH 可独立发现的技能目录。

默认与上游对齐：repo/skills 下每个 SKILL.md 都生成一个 DSH 技能（含模块内的嵌套子技能）。
生成结果 skills/<name>/SKILL.md = 上游 frontmatter + DSH 适配头 + 上游正文（逐字）。
不复制配套文件，它们统一留在 repo/ 快照里，避免双份漂移。

用法：
  python3 scripts/build-skills.py                  # 生成/刷新（默认全量：含嵌套子技能）
  python3 scripts/build-skills.py --top-level-only # 只生成一级模块（不含嵌套子技能）
  python3 scripts/build-skills.py --verify         # 校验已生成技能与上游一致
"""

import sys
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
CORE = PLUGIN_ROOT / "repo"
SKILLS_SRC = CORE / "skills"
SKILLS_OUT = PLUGIN_ROOT / "skills"
ROUTER_NAME = "reverse-skill-router"

# repo/skills 下非技能目录（配置、脚本、契约、测试等）。
SKIP_TOP = {"config", "scripts", "tests", "references", "ops", "field-journal"}

HEADER = [
    "> **DSH 适配说明（本插件生成，非上游原文）**",
    "> - `<CORE>` 解析：优先 `<插件根>/repo`；从 `.dsh/skills` 符号链接加载时，先跑 `for p in \"$HOME/Documents/hackerking/plugins/reverse-skills/repo\" \"$HOME/.dsh/profiles\"/*/node_modules/reverse-skills/repo; do [ -f \"$p/RULES.md\" ] && CORE=\"$p\" && break; done`。",
    "> - 本技能的配套文件（`scripts/`、`references/` 等）位于 `<CORE>/skills/{module}/`，正文里的相对路径都以此为准。",
    "> - 对目标动手前先过 scope 门禁：`bash <CORE>/skills/scripts/case-init.sh --hint \"<任务>\" --case-name \"<case>\" --project-root \"<项目根>\"`，再用 `case-guard.sh` 校验；未 granted 不得 ACT。工作区已有 `scripts/new-case.sh` 时可直接用它建档。",
    "> - 工具可用性以 tool-index 为准（`<CORE>/skills/scripts/refresh-tool-index.sh` 生成）；缺工具先报告，不自动安装、不自动注册 MCP。",
    "> - 跨模块流程或不确定走哪条路时，先用 `reverse-skill-router` 路由。",
    "> - DSH 工具映射：shell=`bash`，读=`read`，写=`write`/`edit`，检索=`grep`/`glob`，子代理=`subagent`，技能加载=`skill`。",
    "> - 上游正文逐字未改；重新生成：`python3 scripts/build-skills.py`。",
    "",
]


def split_frontmatter(text: str):
    """返回 (frontmatter含闭合线, 其余正文)；解析失败返回 (None, text)。"""
    if not text.startswith("---\n"):
        return None, text
    end = text.find("\n---", 4)
    if end == -1:
        return None, text
    fm_end = end + len("\n---")
    return text[:fm_end], text[fm_end:]


def header_for(module: str) -> str:
    return "\n".join(line.replace("{module}", module) for line in HEADER)


def collect(top_level_only: bool):
    """返回 [(module_key, src_path)]，module_key 是 repo/skills 下的相对目录路径。"""
    items = []
    if not SKILLS_SRC.is_dir():
        return items
    for src in sorted(SKILLS_SRC.glob("*/SKILL.md")):
        if src.parent.name in SKIP_TOP:
            continue
        items.append((src.parent.name, src))
        if top_level_only:
            continue
        for nested in sorted(src.parent.glob("*/SKILL.md")):
            items.append((str(nested.parent.relative_to(SKILLS_SRC)), nested))
    return items


def skill_name(module_key: str) -> str:
    return module_key.split("/")[-1]


def verify(top_level_only: bool) -> int:
    problems = []
    checked = 0
    for module_key, src in collect(top_level_only):
        name = skill_name(module_key)
        dest = SKILLS_OUT / name / "SKILL.md"
        if not dest.is_file():
            problems.append(name + ": 生成文件缺失")
            continue
        up_fm, up_body = split_frontmatter(src.read_text(encoding="utf-8"))
        gen_fm, gen_body = split_frontmatter(dest.read_text(encoding="utf-8"))
        if up_fm is None or gen_fm is None:
            problems.append(name + ": frontmatter 解析失败")
            continue
        if up_fm != gen_fm:
            problems.append(name + ": frontmatter 与上游不一致")
            continue
        head = header_for(module_key) + "\n"
        body = gen_body.lstrip("\n")
        if not body.startswith(head):
            problems.append(name + ": 适配头缺失或位置不对")
            continue
        rest = body[len(head):]
        if rest.rstrip("\n") != up_body.lstrip("\n").rstrip("\n"):
            problems.append(name + ": 正文与上游不一致（适配头之外有改动）")
            continue
        checked += 1
    if problems:
        print("VERIFY FAILED:")
        for item in problems:
            print(" - " + item)
        return 1
    print(f"VERIFY OK: {checked} 个技能 = 上游 frontmatter + 适配头 + 上游正文")
    return 0


def main() -> int:
    if not SKILLS_SRC.is_dir():
        print("缺少 repo/skills 快照，先运行 scripts/sync-upstream.sh", file=sys.stderr)
        return 2
    top_level_only = "--top-level-only" in sys.argv
    if "--verify" in sys.argv:
        return verify(top_level_only)
    generated = []
    skipped = []
    for module_key, src in collect(top_level_only):
        fm, body = split_frontmatter(src.read_text(encoding="utf-8"))
        if fm is None:
            skipped.append(module_key)
            continue
        dest_dir = SKILLS_OUT / skill_name(module_key)
        dest_dir.mkdir(parents=True, exist_ok=True)
        out = fm + "\n\n" + header_for(module_key) + "\n" + body.lstrip("\n")
        if not out.endswith("\n"):
            out += "\n"
        (dest_dir / "SKILL.md").write_text(out, encoding="utf-8")
        generated.append(module_key)
    print(f"generated {len(generated)} skills -> {SKILLS_OUT}")
    if skipped:
        print("skipped (no frontmatter): " + ", ".join(skipped), file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
