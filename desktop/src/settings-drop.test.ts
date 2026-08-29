import { describe, expect, it } from "vitest";
import { droppedPath } from "./drop";

// 回归：`enter` 与 `drop` 的载荷同形（都带 paths）。原来用「不是 over/leave 就当作放下」
// 判断，文件夹刚飘进窗口就装一次、松手再装一次，第二次报「已经装过」——
// 用户看到的是「拖完立刻提示已安装」。
describe("拖放安装只认 drop", () => {
  const paths = ["/Users/x/Downloads/tororo_hijiki_ja"];

  it("放下时给出路径", () => expect(droppedPath({ type: "drop", paths })).toBe(paths[0]));

  it.each(["enter", "over", "leave"])("%s 一律不安装", type => {
    // enter 也带 paths —— 正是这一条曾经被当成放下
    expect(droppedPath({ type, paths })).toBeNull();
  });

  it("drop 但没有路径时不动作", () => {
    expect(droppedPath({ type: "drop", paths: [] })).toBeNull();
    expect(droppedPath({ type: "drop" })).toBeNull();
  });
});
