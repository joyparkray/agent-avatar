"""详情那一行：白名单挑什么、截多长、什么时候不写。"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bridge"))

from state_machine import ACTIVITY_LIMIT, activity_allowed, activity_from, options_path  # noqa: E402


def field(**tool_input):
    return activity_from({"tool_input": tool_input})


def test_description_wins_because_the_agent_wrote_it_for_a_human():
    assert field(description="Run the test suite", command="npm test") == "Run the test suite"


def test_file_path_is_reduced_to_a_name():
    # 桌宠上放不下一条绝对路径，而路径里唯一有信息量的就是最后一段
    assert field(file_path="C:/Agent Avatar/desktop/src/main.ts") == "main.ts"
    assert field(file_path="/Users/x/p/connectors.rs") == "connectors.rs"


def test_url_is_reduced_to_a_host():
    # 完整 URL 大半是查询串，而链接里能认出人的部分正好在那儿
    assert field(url="https://learn.microsoft.com/en-us/windows/win32/coreaudio/x") == "learn.microsoft.com"


def test_long_values_are_cut_here_not_by_the_window():
    long_query = "Rust Windows system audio loopback capture crate WASAPI 2026 cpal vs wasapi vs miniaudio benchmarks"
    out = field(query=long_query)
    assert len(out) == ACTIVITY_LIMIT and out.endswith("\u2026")


def test_newlines_never_reach_the_one_line_pill():
    assert field(description="first\nsecond   third") == "first second third"


# 🔴 这三条是这个功能的边界，不是补充测试。
def test_the_command_line_is_not_shown():
    """命令行里可能有 token —— 那是用户最不会想到会显示在屏幕上的东西。"""
    assert field(command='curl -H "Authorization: Bearer sk-secret" https://x') is None


def test_file_contents_are_not_shown():
    assert field(content="the whole file body") is None
    assert field(new_string="the replacement text", old_string="x") is None


def test_nothing_usable_means_nothing_shown():
    assert field() is None
    assert activity_from({"tool_input": None}) is None
    assert activity_from({}) is None
    # 空白不算「有值」，要落到下一个字段
    assert field(description="   ", file_path="/tmp/a/b.py") == "b.py"


def test_on_is_a_choice_the_app_writes_down(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_AVATAR_STATE_PATH", str(tmp_path / "state.json"))
    # 🔴 没有那个文件 = 关。默认开的话，对一个从没要过这功能的用户，工具名和文件名照样
    # 会被写进磁盘 —— 一个关着的开关，底下的东西还在跑。
    assert not activity_allowed()
    with open(options_path(), "w", encoding="utf-8") as handle:
        json.dump({"activity": False}, handle)
    assert not activity_allowed()
    with open(options_path(), "w", encoding="utf-8") as handle:
        json.dump({"activity": True}, handle)
    assert activity_allowed()


def test_hermes_names_its_path_fields_differently():
    """🔴 白名单原来只有 Claude Code 的字段名，于是 Hermes 几乎什么都显示不出来。

    实测 2026-09-03，`hermes-agent/tools/` 里的参数名频次：
    `path` 6 次、`filename` 2 次，而 `file_path` 只有 2 次。
    用户报的是「Hermes 只有一级状态」；`query`/`url`/`pattern` 是命中的，
    所以看起来像是时灵时不灵，而不是彻底不工作。

    三个都是「磁盘上的一个名字」，同样的隐私档次，同样只留最后一段。
    """
    assert field(path="/Users/x/notes/report.md") == "report.md"
    assert field(filename="/tmp/build/out.log") == "out.log"
    assert field(path="C:/Agent Avatar/src/main.ts") == "main.ts"
    # description 仍然优先 —— 那是 agent 专门写给人看的
    assert field(path="/tmp/a/b.py", description="整理今天的记录") == "整理今天的记录"


def test_command_stays_out_even_next_to_the_new_path_fields():
    # 新加字段不能顺手把 command 带进来：命令行可能含 token
    assert field(command="curl -H 'Authorization: Bearer sk-xxx' https://x") is None
