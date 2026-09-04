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


# 🔴 这几条是这个功能的边界，不是补充测试。
def test_the_command_line_is_shown():
    """命令行**现在显示**，包括参数。

    🔴 它曾经被排除，理由是「命令行里可能有 token，那是用户最不会想到会显示在屏幕上的
    东西」。代价在 2026-09-04 的实机测量里显出来了：

        executing    doing=None          5250 ms   ← terminal，唯一跑得够久的，却没详情
        researching  doing='README.md'     62 ms   ← 有详情，但太短看不见

    两头正好错开 —— 看得见的不描述，能描述的看不见。定案（晓，2026-09-04）：这是本机
    工具，命令可见可接受。**文件内容仍然排除**（见下一条），那是量级完全不同的东西。
    """
    assert field(command='curl -H "Authorization: Bearer sk" https://x') \
        == 'curl -H "Authorization: Bearer sk" https://x'
    # description 仍然优先 —— 那是 agent 专门写给人看的
    assert field(command="npm test", description="跑一遍测试") == "跑一遍测试"


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


def test_file_contents_stay_out_even_though_command_came_in():
    # 放行 command 不等于放行一切：文件正文、替换文本仍然排除 —— 那是量级完全不同的东西，
    # 一整个文件塞进状态栏既没用又危险。
    assert field(content="the whole file body") is None
    assert field(new_string="the replacement text") is None
    # 白名单是有优先级的：path 在场时挑 path，不会因为多了 command 就乱序
    assert field(command="cat x", path="/tmp/a/b.md") == "b.md"


def test_the_arguments_envelope_is_unwrapped():
    """🔴 有些调用把真参数又包了一层 `arguments`。

    实机抓到（2026-09-04，Hermes，只记字段名不记值）：

        pre_tool_call tool=read_file tool_input_keys=['path']       ← 扁平
        pre_tool_call tool=read_file tool_input_keys=['arguments']  ← 包了一层

    **同一个工具两种形状都出现过**，所以用户看到的是「时灵时不灵」。
    """
    assert field(arguments='{"path": "/tmp/x/report.md"}') == "report.md"
    assert field(arguments={"description": "整理今天的记录"}) == "整理今天的记录"
    # 坏 JSON / 不是对象 → 没详情，但不能炸
    assert field(arguments="{not json") is None
    assert field(arguments=["a", "b"]) is None
    # 信封里的 command 同样显示（和扁平形状一致）
    assert field(arguments='{"command": "npm run build"}') == "npm run build"


def test_arguments_is_only_an_envelope_when_it_is_alone():
    # 真有工具的参数就叫 arguments、且还带别的键时，不能当信封拆
    assert field(arguments="whatever", path="/tmp/a/b.md") == "b.md"



def test_the_detail_outlives_the_tool_that_produced_it(tmp_path, monkeypatch):
    """🔴 详情必须比状态活得久，否则**根本来不及被看见**。

    工具跑完状态立刻回 idle，而快照是「当前值」、皮肤 200 ms 采一次。
    2026-09-04 实机高频采样（5 ms）量到的窗口：62 / 91 / 184 ms —— 命中率
    31% / 46% / 92%，用户的原话是「看到一次一闪而过」。

    所以状态照实回落（不撒谎），详情带一个明写的过期时刻继续挂着。
    """
    import json, time
    from state_machine import update, DOING_HOLD_SECONDS

    state = tmp_path / "agent-avatar-state.json"
    monkeypatch.setenv("AGENT_AVATAR_STATE_PATH", str(state))
    (tmp_path / "agent-avatar-options.json").write_text('{"activity": true}', encoding="utf-8")

    def ev(name, **kw):
        update({"hook_event_name": name, "session_id": "s", "tool_name": kw.get("tool_name"),
                "tool_input": kw.get("tool_input"), "extra": {}}, "Hermes")

    ev("on_session_start")
    ev("pre_tool_call", tool_name="read_file", tool_input={"path": "/a/b/README.md"})
    busy = json.loads(state.read_text(encoding="utf-8"))
    assert busy["state"] == "researching" and busy["doing"] == "README.md"
    assert busy["doing_until"] > time.time()

    ev("post_tool_call", tool_name="read_file", tool_input={"path": "/a/b/README.md"})
    after = json.loads(state.read_text(encoding="utf-8"))
    # 状态照实回落，详情还在 —— 这一条正是修复的核心
    assert after["state"] == "idle", after
    assert after["doing"] == "README.md", "工具一结束详情就没了，短工具永远看不见"
    assert after["doing_until"] == busy["doing_until"], "过期时刻应当沿用，不该被续命"

    # 过期之后不再沿用。只挪 `time.time`，别整个换掉 time 模块 ——
    # 锁那一段用的是 `time.monotonic`，换掉会连锁一起弄坏。
    import state_machine
    monkeypatch.setattr(state_machine.time, "time", lambda: busy["doing_until"] + 1)
    ev("pre_llm_call")
    expired = json.loads(state.read_text(encoding="utf-8"))
    assert "doing" not in expired, f"过期了还挂着：{expired}"
    assert DOING_HOLD_SECONDS >= 1.0
