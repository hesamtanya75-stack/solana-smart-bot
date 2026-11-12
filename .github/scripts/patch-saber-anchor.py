#!/usr/bin/env python3
"""Apply the pinned Anchor 0.24.2 installer patch to Saber v1.8.1's flake."""

from pathlib import Path
import re

flake = Path("flake.nix")
source = flake.read_text()
pattern = re.compile(
    r"(?m)^(\\s*)pkgs = import nixpkgs \\{ inherit system; \\}\\s*\\n"
    r"\\s*// saber-overlay\\.packages\\.\\$\\{system\\};"
)


def replace(match):
    indent = match.group(1)
    inner = indent + "  "
    return (
        f"{indent}pkgs = (import nixpkgs {{ inherit system; }})\n"
        f"{inner}// saber-overlay.packages.${{system}}\n"
        f"{inner}// {{\n"
        f"{inner}  anchor-0_24_2 = saber-overlay.packages.${{system}}.anchor-0_24_2.overrideAttrs (old: {{\n"
        f"{inner}    patches = (old.patches or []) ++ [ ./anchor-0.24.2-solana-installer.patch ];\n"
        f"{inner}  }});\n"
        f"{inner}}};"
    )


source, count = pattern.subn(replace, source)
if count != 1:
    raise SystemExit(
        f"Expected one pinned Saber pkgs/overlay expression; found {count}"
    )

flake.write_text(source)
print("Applied the Anchor 0.24.2 installer patch to the pinned Saber flake.")
