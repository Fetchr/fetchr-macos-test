//! Built-in role badges for chats whose API names a role but ships no image
//! (Kick `identity.badges`, W.TV tags). Drawn in code, addressed by the
//! pseudo-URL `fetchr-badge:<provider>:<id>`, so the badge cache treats them
//! like any downloaded badge.

use image::{DynamicImage, Rgba, RgbaImage};
use imageproc::drawing::{draw_filled_circle_mut, draw_filled_rect_mut, draw_polygon_mut};
use imageproc::point::Point;
use imageproc::rect::Rect;

use crate::chat_overlay::model::ChatBadge;

pub const SCHEME: &str = "fetchr-badge:";
const SIZE: u32 = 72;

#[derive(Clone, Copy)]
enum Glyph {
    Check,
    Sword,
    Crown,
    Star,
    Diamond,
    Camera,
    Gift,
    Ring,
    LetterK,
}

/// The image URL a badge renders with: its own, or a built-in one for a known role.
pub fn badge_render_url(badge: &ChatBadge) -> Option<String> {
    if let Some(url) = badge.url.as_deref().filter(|url| !url.is_empty()) {
        return Some(url.to_string());
    }
    style_for(&badge.provider, &badge.id)?;
    Some(format!("{SCHEME}{}:{}", badge.provider, badge.id))
}

pub fn is_builtin(url: &str) -> bool {
    url.starts_with(SCHEME)
}

pub fn render(url: &str) -> Option<DynamicImage> {
    let rest = url.strip_prefix(SCHEME)?;
    let (provider, id) = rest.split_once(':')?;
    let (background, glyph) = style_for(provider, id)?;
    Some(DynamicImage::ImageRgba8(draw_badge(background, glyph)))
}

fn style_for(provider: &str, id: &str) -> Option<([u8; 3], Glyph)> {
    let id = id.to_ascii_lowercase();
    match provider {
        "kick" => Some(match id.as_str() {
            "broadcaster" => ([0x53, 0xFC, 0x18], Glyph::Camera),
            "moderator" => ([0x00, 0xC7, 0xFF], Glyph::Sword),
            "vip" => ([0xFF, 0xC8, 0x00], Glyph::Crown),
            "og" => ([0x00, 0xFF, 0xF2], Glyph::Ring),
            "founder" => ([0xFF, 0x9D, 0x00], Glyph::Star),
            "verified" => ([0x1E, 0xFF, 0x00], Glyph::Check),
            "sub_gifter" | "subgifter" => ([0x9B, 0x4D, 0xFF], Glyph::Gift),
            "staff" => ([0x53, 0xFC, 0x18], Glyph::LetterK),
            "subscriber" => ([0x53, 0xFC, 0x18], Glyph::Star),
            "bot" => ([0x8B, 0x94, 0xA3], Glyph::Diamond),
            _ => return None,
        }),
        "wtv" => Some(match id.as_str() {
            "owner" => ([0xB1, 0x73, 0xFF], Glyph::Crown),
            "moderator" => ([0x26, 0xFF, 0x81], Glyph::Sword),
            "verified" => ([0xB1, 0x73, 0xFF], Glyph::Check),
            _ => return None,
        }),
        _ => None,
    }
}

fn draw_badge(background: [u8; 3], glyph: Glyph) -> RgbaImage {
    let mut image = RgbaImage::from_pixel(SIZE, SIZE, Rgba([0, 0, 0, 0]));
    let fill = Rgba([background[0], background[1], background[2], 255]);
    rounded_square(&mut image, fill, 14);
    // Dark glyph on light backgrounds, white on dark ones.
    let luma = 0.299 * background[0] as f32 + 0.587 * background[1] as f32
        + 0.114 * background[2] as f32;
    let ink = if luma > 140.0 {
        Rgba([16, 18, 20, 255])
    } else {
        Rgba([255, 255, 255, 255])
    };
    draw_glyph(&mut image, glyph, ink, fill);
    image
}

fn rounded_square(image: &mut RgbaImage, color: Rgba<u8>, radius: i32) {
    let size = SIZE as i32;
    draw_filled_rect_mut(
        image,
        Rect::at(radius, 0).of_size((size - 2 * radius) as u32, SIZE),
        color,
    );
    draw_filled_rect_mut(
        image,
        Rect::at(0, radius).of_size(SIZE, (size - 2 * radius) as u32),
        color,
    );
    for (cx, cy) in [
        (radius, radius),
        (size - radius - 1, radius),
        (radius, size - radius - 1),
        (size - radius - 1, size - radius - 1),
    ] {
        draw_filled_circle_mut(image, (cx, cy), radius, color);
    }
}

fn poly(image: &mut RgbaImage, points: &[(i32, i32)], color: Rgba<u8>) {
    let points: Vec<Point<i32>> = points.iter().map(|&(x, y)| Point::new(x, y)).collect();
    draw_polygon_mut(image, &points, color);
}

fn draw_glyph(image: &mut RgbaImage, glyph: Glyph, ink: Rgba<u8>, fill: Rgba<u8>) {
    match glyph {
        Glyph::Check => poly(
            image,
            &[(16, 36), (24, 28), (32, 36), (50, 18), (58, 26), (32, 52)],
            ink,
        ),
        Glyph::Sword => {
            poly(image, &[(50, 14), (58, 14), (58, 22), (30, 50), (22, 42)], ink);
            poly(image, &[(16, 40), (22, 34), (38, 50), (32, 56)], ink);
            poly(image, &[(14, 50), (22, 50), (22, 58), (14, 58)], ink);
        }
        Glyph::Crown => poly(
            image,
            &[
                (14, 52),
                (14, 22),
                (26, 34),
                (36, 16),
                (46, 34),
                (58, 22),
                (58, 52),
            ],
            ink,
        ),
        Glyph::Star => poly(
            image,
            &[
                (36, 12),
                (42, 29),
                (60, 29),
                (46, 40),
                (51, 58),
                (36, 47),
                (21, 58),
                (26, 40),
                (12, 29),
                (30, 29),
            ],
            ink,
        ),
        Glyph::Diamond => poly(image, &[(36, 12), (58, 36), (36, 60), (14, 36)], ink),
        Glyph::Camera => {
            draw_filled_rect_mut(image, Rect::at(12, 22).of_size(34, 28), ink);
            poly(image, &[(46, 36), (60, 24), (60, 48)], ink);
        }
        Glyph::Gift => {
            draw_filled_rect_mut(image, Rect::at(14, 30).of_size(44, 28), ink);
            draw_filled_rect_mut(image, Rect::at(12, 22).of_size(48, 8), ink);
            draw_filled_rect_mut(image, Rect::at(33, 22).of_size(6, 36), fill);
            poly(image, &[(36, 22), (24, 12), (20, 20)], ink);
            poly(image, &[(36, 22), (48, 12), (52, 20)], ink);
        }
        Glyph::Ring => {
            draw_filled_circle_mut(image, (36, 36), 22, ink);
            draw_filled_circle_mut(image, (36, 36), 12, fill);
        }
        Glyph::LetterK => {
            draw_filled_rect_mut(image, Rect::at(16, 14).of_size(12, 44), ink);
            poly(image, &[(28, 32), (46, 14), (58, 14), (36, 36)], ink);
            poly(image, &[(28, 40), (36, 34), (58, 58), (46, 58)], ink);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn badge(provider: &str, id: &str, url: Option<&str>) -> ChatBadge {
        ChatBadge {
            provider: provider.to_string(),
            id: id.to_string(),
            version: None,
            url: url.map(str::to_string),
            title: None,
        }
    }

    #[test]
    fn own_url_wins_over_builtin() {
        let url = badge_render_url(&badge("kick", "moderator", Some("https://x/y.png")));
        assert_eq!(url.as_deref(), Some("https://x/y.png"));
    }

    #[test]
    fn known_roles_get_a_drawn_badge() {
        let url = badge_render_url(&badge("kick", "moderator", None)).expect("builtin");
        assert!(is_builtin(&url));
        let image = render(&url).expect("rendered").to_rgba8();
        assert_eq!(image.dimensions(), (SIZE, SIZE));
        assert_eq!(image.get_pixel(0, 0)[3], 0, "corners stay transparent");
        assert_eq!(image.get_pixel(36, 4)[3], 255);
    }

    #[test]
    fn unknown_badges_and_twitch_keep_no_url() {
        assert!(badge_render_url(&badge("kick", "mystery", None)).is_none());
        assert!(badge_render_url(&badge("twitch", "moderator", None)).is_none());
    }
}
