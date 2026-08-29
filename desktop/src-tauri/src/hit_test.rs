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

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Region { pub x: f64, pub y: f64, pub width: f64, pub height: f64 }

impl Region {
    pub fn contains(&self, x: f64, y: f64) -> bool {
        self.width > 0.0 && self.height > 0.0
            && x >= self.x && y >= self.y
            && x < self.x + self.width && y < self.y + self.height
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

    #[test]
    fn region_contains_is_half_open() {
        let region = Region { x: 10.0, y: 20.0, width: 100.0, height: 50.0 };
        assert!(region.contains(10.0, 20.0));
        assert!(region.contains(109.9, 69.9));
        assert!(!region.contains(110.0, 40.0));
        assert!(!region.contains(9.9, 40.0));
    }

    #[test]
    fn empty_region_never_contains() {
        assert!(!Region::default().contains(0.0, 0.0));
        assert!(!Region { x: 0.0, y: 0.0, width: 0.0, height: 10.0 }.contains(0.0, 5.0));
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
