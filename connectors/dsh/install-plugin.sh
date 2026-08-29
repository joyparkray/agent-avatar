#!/bin/sh
# 把 Agent Avatar 装进 DeepSeek Harness。
#
# dsh 没有「插件市场」式的安装命令给本地目录用，装法是**用户 patch 层**：
# `$DSH_HOME/cordis.patch.yml`（home 级，对所有 profile 生效，且排在每个 profile 的
# patch 之后）里 insert 一条指向插件目录的 entry。官方文档：patch 文件是一个顶层 YAML
# 数组，`insert` 往组合后的 entry 列表里加条目，bare 包名锚到 dsh 安装目录、
# **相对名相对配置文件**，所以这里写绝对路径。
#
# 这个文件被 dsh 的 HMR 监视着（`watchUserPatches`）—— 已经在跑的 dsh 会**热加载**，
# 不需要重启。
#
# 卸载：从 $DSH_HOME/cordis.patch.yml 里删掉 agent-avatar 那条，再删掉插件目录。
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
dsh_home="${DSH_HOME:-$HOME/.dsh}"
target="$dsh_home/plugins/agent-avatar"
patch="$dsh_home/cordis.patch.yml"

# 组装（拷 bridge core 进插件目录 + 冒烟自检）五家共用，见 ../assemble.sh
"$here/../assemble.sh" dsh "$target"

mkdir -p "$dsh_home"
python3 - "$patch" "$target" <<'PY'
import os, shutil, sys
patch_path, plugin_dir = sys.argv[1], sys.argv[2]
entry_path = os.path.join(plugin_dir, "index.mjs")

# YAML 只写不读：dsh 的 patch 文件允许 `!!js` 表达式，用普通 YAML 解析器读会**丢掉**
# 用户已有的那些行（甚至报错）。所以按行处理 —— 只认自己那一段，其余原样保留。
BEGIN, END = "# >>> agent-avatar (managed) >>>", "# <<< agent-avatar (managed) <<<"
block = "\n".join([
    BEGIN,
    "- insert:",
    "    - id: agent-avatar",
    "      name: %s" % entry_path,
    END,
])

lines = []
if os.path.exists(patch_path):
    shutil.copyfile(patch_path, patch_path + ".bak-agent-avatar")   # 用户文件，先备份
    keep, skipping = [], False
    for line in open(patch_path, encoding="utf-8").read().splitlines():
        if line.strip() == BEGIN: skipping = True; continue
        if line.strip() == END: skipping = False; continue
        if not skipping: keep.append(line)
    # 模板文件里的 `[]` 是「空数组」。留着它，后面再跟条目就成了非法 YAML。
    lines = [line for line in keep if line.strip() != "[]"]

with open(patch_path, "w", encoding="utf-8") as out:
    body = "\n".join(lines).rstrip()
    out.write((body + "\n" if body else "") + block + "\n")
print("patched -> %s" % patch_path)
PY

echo "files -> $target"
echo
echo "dsh 的 HMR 监视着这个 patch 文件 —— 正在跑的 dsh 会自动加载，不用重启。"
echo "新开一个会话就能看到形象跟着动；没反应时先看 $dsh_home/cordis.patch.yml 里那一段还在不在。"
