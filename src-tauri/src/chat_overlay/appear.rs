//! How a new chat message enters the overlay.
//!
//! Every effect is a pure function of the time since the message appeared, so
//! a frame stays reproducible and the renderer can still cache identical
//! frames: once the effect is over, the message is drawn exactly as before.

use crate::jobs::types::ChatMessageAnimation;

/// Where and how one message is drawn on a given frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AppearState {
    /// 0..1 progress of the effect; 1 means "settled", drawn as without effects.
    pub progress: f32,
    /// Share of its own height (plus gap) the message occupies in the stack.
    /// Below 1 the rest of the chat has not been pushed out of the way yet.
    pub push: f32,
    pub dx: i32,
    pub dy: i32,
    /// 0..=255 overall opacity of the message.
    pub alpha: u8,
}

pub const SETTLED: AppearState = AppearState {
    progress: 1.0,
    push: 1.0,
    dx: 0,
    dy: 0,
    alpha: 255,
};

impl AppearState {
    pub fn is_settled(&self) -> bool {
        self.progress >= 1.0
    }

    /// Short stable token for frame signatures; equal tokens draw equal pixels.
    pub fn signature(&self) -> String {
        format!("{}:{}:{}:{}", (self.push * 1000.0).round() as i32, self.dx, self.dy, self.alpha)
    }
}

/// State of a message `elapsed` seconds after it appeared.
pub fn appear_state(
    animation: ChatMessageAnimation,
    duration_ms: u32,
    elapsed: f64,
    chat_width: u32,
) -> AppearState {
    if matches!(animation, ChatMessageAnimation::None) || duration_ms == 0 {
        return SETTLED;
    }
    let p = (elapsed * 1000.0 / duration_ms as f64).clamp(0.0, 1.0) as f32;
    if p >= 1.0 {
        return SETTLED;
    }
    let eased = ease_out_cubic(p);
    let fade = to_alpha(ease_out_quad((p * 1.4).min(1.0)));
    let slide = (chat_width as f32 * 0.12).clamp(24.0, 90.0);
    let state = |push: f32, dx: f32, dy: f32, alpha: u8| AppearState {
        progress: p,
        push,
        dx: dx.round() as i32,
        dy: dy.round() as i32,
        alpha,
    };
    match animation {
        ChatMessageAnimation::None => SETTLED,
        ChatMessageAnimation::Fade => state(1.0, 0.0, 0.0, to_alpha(ease_out_quad(p))),
        ChatMessageAnimation::SlideUp => state(eased, 0.0, (1.0 - eased) * 14.0, fade),
        ChatMessageAnimation::SlideLeft => state(eased, -(1.0 - eased) * slide, 0.0, fade),
        // A small overshoot sells the "pop" without scaling the bitmap.
        ChatMessageAnimation::Pop => {
            let back = ease_out_back(p);
            state(back.max(0.0), 0.0, (1.0 - back) * 10.0, to_alpha((p * 2.2).min(1.0)))
        }
    }
}

fn to_alpha(value: f32) -> u8 {
    (value.clamp(0.0, 1.0) * 255.0).round() as u8
}

fn ease_out_quad(t: f32) -> f32 {
    1.0 - (1.0 - t) * (1.0 - t)
}

fn ease_out_cubic(t: f32) -> f32 {
    1.0 - (1.0 - t).powi(3)
}

fn ease_out_back(t: f32) -> f32 {
    const C1: f32 = 1.70158;
    const C3: f32 = C1 + 1.0;
    1.0 + C3 * (t - 1.0).powi(3) + C1 * (t - 1.0).powi(2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn none_and_finished_messages_are_settled() {
        assert_eq!(appear_state(ChatMessageAnimation::None, 300, 0.0, 400), SETTLED);
        assert_eq!(appear_state(ChatMessageAnimation::SlideUp, 300, 0.3, 400), SETTLED);
        assert_eq!(appear_state(ChatMessageAnimation::Pop, 300, 5.0, 400), SETTLED);
    }

    #[test]
    fn slide_starts_hidden_and_takes_no_room() {
        let start = appear_state(ChatMessageAnimation::SlideUp, 300, 0.0, 400);
        assert_eq!(start.alpha, 0);
        assert_eq!(start.push, 0.0);
        let mid = appear_state(ChatMessageAnimation::SlideUp, 300, 0.15, 400);
        assert!(mid.push > 0.0 && mid.push < 1.0);
    }

    #[test]
    fn fade_keeps_the_stack_still() {
        let start = appear_state(ChatMessageAnimation::Fade, 300, 0.05, 400);
        assert_eq!(start.push, 1.0);
        assert!(start.alpha < 255);
    }

    #[test]
    fn slide_left_comes_from_the_left() {
        let start = appear_state(ChatMessageAnimation::SlideLeft, 300, 0.0, 400);
        assert!(start.dx < 0);
    }
}
