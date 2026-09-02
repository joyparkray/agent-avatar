//! 光标命中判定。窗口是透明悬浮窗，`set_ignore_cursor_events` 是窗口级开关，
//! 网页层在穿透期间收不到任何事件，故由 Rust 轮询全局光标位置来决定开关。

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Mode {
    /// 默认：人物可点，其余区域穿透。
    #[default]
    Normal,
    /// 穿透：全部穿透，直到光标在人物上停留够久。
    ClickThrough,
}

impl Mode {
    pub fn from_label(label: &str) -> Self {
        if label == "through" { Mode::ClickThrough } else { Mode::Normal }
    }
}

/// 人物在包围盒内的**占位网格**。
///
/// 为什么需要它：Live2D 作者普遍在人物四周留出大片透明边距（给头发与衣摆的摆动留空间），
/// 于是「包围盒」远大于人物 —— 实测 CandyBoy 的命中矩形占了窗口 **91.7%**，而人物真正的
/// 不透明像素只有 **31.5%**。表现就是人物旁边的空白点上去仍然命中桌宠，穿不到下层程序。
///
/// 做法是把包围盒均分成 cols×rows 格，每格一位（行主序，低位在前），1 = 该格有人物像素。
/// 前端每隔几百毫秒抽一张低分辨率图重算一次。**判定仍然全在 Rust 侧、仍然是查表**，
/// 没有为此增加任何 IPC 往返，故不影响首击延迟；代价只是网格比画面滞后一拍
/// （挥手时边缘略滞后），桌宠可以接受。
#[derive(Clone, Debug, PartialEq)]
pub struct Mask { cols: usize, rows: usize, bits: Vec<u8> }

impl Mask {
    /// 尺寸对不上就返回 `None` —— 调用方会退回「整个包围盒都算命中」，也就是加网格之前的行为。
    ///
    /// **失败方向是刻意选的**：网格短一截时按位查表会把缺的格子当成空，
    /// 结果是桌宠整个点不动；宁可命中松一点，也不要一只点不动的桌宠。
    pub fn new(cols: usize, rows: usize, bits: Vec<u8>) -> Option<Self> {
        (cols > 0 && rows > 0 && bits.len() == (cols * rows).div_ceil(8)).then_some(Self { cols, rows, bits })
    }

    /// 入参是相对包围盒左上角的比例，故与窗口尺寸、DPI 缩放无关。
    fn hit(&self, fx: f64, fy: f64) -> bool {
        let col = ((fx * self.cols as f64) as usize).min(self.cols - 1);
        let row = ((fy * self.rows as f64) as usize).min(self.rows - 1);
        let index = row * self.cols + col;
        self.bits[index / 8] & (1 << (index % 8)) != 0
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Region {
    pub x: f64, pub y: f64, pub width: f64, pub height: f64,
    /// `None` = 整个矩形都算命中。向导页要整窗放行（卡片上的按钮得能点），
    /// 前端还没送出第一张网格时也走这条。
    pub mask: Option<Mask>,
}

impl Region {
    pub fn contains(&self, x: f64, y: f64) -> bool {
        if !(self.width > 0.0 && self.height > 0.0) { return false; }
        if x < self.x || y < self.y || x >= self.x + self.width || y >= self.y + self.height { return false; }
        // 先比四条边再查格：矩形之外的点占绝大多数，这样最常见的那条路只做四次比较。
        self.mask.as_ref().is_none_or(|mask| mask.hit((x - self.x) / self.width, (y - self.y) / self.height))
    }
}

/// 是否应忽略鼠标事件（true = 穿透）。
pub fn should_ignore(mode: Mode, inside: bool, dwell_ms: u128, threshold_ms: u128) -> bool {
    match mode {
        Mode::Normal => !inside,
        Mode::ClickThrough => !(inside && dwell_ms >= threshold_ms),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const T: u128 = 3000;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Region {
        Region { x, y, width, height, mask: None }
    }

    #[test]
    fn region_contains_is_half_open() {
        let region = rect(10.0, 20.0, 100.0, 50.0);
        assert!(region.contains(10.0, 20.0));
        assert!(region.contains(109.9, 69.9));
        assert!(!region.contains(110.0, 40.0));
        assert!(!region.contains(9.9, 40.0));
    }

    #[test]
    fn empty_region_never_contains() {
        assert!(!Region::default().contains(0.0, 0.0));
        assert!(!rect(0.0, 0.0, 0.0, 10.0).contains(0.0, 5.0));
    }

    /// 位序：行主序、每字节低位在前。前端按同一套打包，改一边就得改另一边。
    #[test]
    fn mask_reads_row_major_with_the_low_bit_first() {
        // 2x2，只有右上角(col1,row0)与左下角(col0,row1)有人物 → 位 1 与位 2 → 0b0000_0110
        let region = Region { mask: Mask::new(2, 2, vec![0b0000_0110]), ..rect(0.0, 0.0, 100.0, 100.0) };
        assert!(!region.contains(25.0, 25.0));
        assert!(region.contains(75.0, 25.0));
        assert!(region.contains(25.0, 75.0));
        assert!(!region.contains(75.0, 75.0));
    }

    /// 这才是这个功能存在的意义：包围盒里的空白（腋下、两腿之间、发缝）要能穿透。
    #[test]
    fn a_hole_inside_the_bounding_box_falls_through() {
        // 3x1，中间一格是空的
        let region = Region { mask: Mask::new(3, 1, vec![0b0000_0101]), ..rect(0.0, 0.0, 30.0, 10.0) };
        assert!(region.contains(5.0, 5.0));
        assert!(!region.contains(15.0, 5.0), "包围盒内的空洞应当穿透");
        assert!(region.contains(25.0, 5.0));
    }

    /// 右/下边界上的点因浮点比例正好取到 1.0 时，不能算到网格外去。
    #[test]
    fn the_far_edge_clamps_into_the_last_cell() {
        let region = Region { mask: Mask::new(2, 2, vec![0b0000_1000]), ..rect(0.0, 0.0, 10.0, 10.0) };
        assert!(region.contains(9.999, 9.999));
    }

    /// 尺寸对不上时**失败方向必须是「整盒命中」**，不能是「整只点不动」。
    #[test]
    fn a_malformed_mask_is_rejected_so_the_region_stays_clickable() {
        assert_eq!(Mask::new(48, 62, vec![0; 100]), None, "位数不够就该拒绝");
        assert_eq!(Mask::new(0, 62, vec![]), None);
        assert_eq!(Mask::new(48, 0, vec![]), None);
        assert!(Mask::new(48, 62, vec![0; (48 * 62usize).div_ceil(8)]).is_some());
        // 被拒之后调用方拿到 None，于是整个包围盒照旧可点
        assert!(Region { mask: None, ..rect(0.0, 0.0, 10.0, 10.0) }.contains(5.0, 5.0));
    }

    /// 全空的网格 = 人物没渲染出来。此时整盒不可点是对的（不该凭空拦住下层程序）。
    #[test]
    fn an_all_empty_mask_never_hits() {
        let region = Region { mask: Mask::new(2, 2, vec![0]), ..rect(0.0, 0.0, 10.0, 10.0) };
        assert!(!region.contains(5.0, 5.0));
    }

    #[test]
    fn normal_mode_makes_only_the_character_clickable() {
        assert!(!should_ignore(Mode::Normal, true, 0, T));
        assert!(should_ignore(Mode::Normal, false, 0, T));
    }

    #[test]
    fn click_through_needs_a_dwell_on_the_character_to_become_interactive() {
        assert!(should_ignore(Mode::ClickThrough, false, 0, T));
        assert!(should_ignore(Mode::ClickThrough, true, 0, T));
        assert!(should_ignore(Mode::ClickThrough, true, T - 1, T));
        assert!(!should_ignore(Mode::ClickThrough, true, T, T));
        // 离开人物立刻恢复穿透，即使刚才已经停留够久
        assert!(should_ignore(Mode::ClickThrough, false, T * 2, T));
    }

    #[test]
    fn mode_label_defaults_to_normal() {
        assert_eq!(Mode::from_label("through"), Mode::ClickThrough);
        assert_eq!(Mode::from_label("normal"), Mode::Normal);
        assert_eq!(Mode::from_label("nonsense"), Mode::Normal);
    }
}
