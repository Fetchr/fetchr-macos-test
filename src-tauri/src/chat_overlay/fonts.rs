//! Font fallback for the chat overlay.
//!
//! No single font covers what chat throws at it — Braille art, box drawing, arrows, CJK. A
//! character the chosen font lacks maps to glyph 0 (.notdef), which draws as an empty box: the
//! "tofu" squares viewers see instead of the text.

use ab_glyph::{Font, FontArc, PxScale, ScaleFont};

/// Families to fall back on, in order, for characters the chosen font has no glyph for.
///
/// Windows ships all of these; the ones missing on a given machine are skipped at load time.
pub const FALLBACK_FAMILIES: &[&str] = &[
    // Latin/Cyrillic/Greek gap-filler for narrow display fonts.
    "Segoe UI",
    // Braille patterns, box drawing, arrows, dingbats — chat ASCII art lives here.
    "Segoe UI Symbol",
    "Segoe UI Emoji",
    "Segoe UI Historic",
    "Microsoft YaHei",
    "Yu Gothic UI",
    "Malgun Gothic",
    "Nirmala UI",
    "Arial Unicode MS",
    "DejaVu Sans",
];

/// A font plus the fallbacks used for the characters it has no glyph for.
#[derive(Clone)]
pub struct FontStack {
    primary: FontArc,
    fallbacks: Vec<FontArc>,
}

impl FontStack {
    pub fn new(primary: FontArc, fallbacks: Vec<FontArc>) -> Self {
        Self { primary, fallbacks }
    }

    /// The chosen font, which sets the line metrics for the whole run.
    pub fn primary(&self) -> &FontArc {
        &self.primary
    }

    /// The font that actually draws `ch`: the first one with a real glyph for it. Falls back to
    /// the chosen font when nothing has the character, so the box keeps its metrics.
    pub fn font_for(&self, ch: char) -> &FontArc {
        if self.primary.glyph_id(ch).0 != 0 {
            return &self.primary;
        }
        self.fallbacks
            .iter()
            .find(|font| font.glyph_id(ch).0 != 0)
            .unwrap_or(&self.primary)
    }

    /// Advance width of `ch` in the font that draws it — measuring in the chosen font would
    /// misplace every character after a fallback one.
    pub fn h_advance(&self, scale: PxScale, ch: char) -> f32 {
        let font = self.font_for(ch);
        font.as_scaled(scale).h_advance(font.glyph_id(ch))
    }

    pub fn measure(&self, scale: PxScale, text: &str) -> f32 {
        text.chars().map(|ch| self.h_advance(scale, ch)).sum()
    }

    pub fn ascent(&self, scale: PxScale) -> f32 {
        self.primary.as_scaled(scale).ascent()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stack_of(primary: FontArc, fallback: FontArc) -> FontStack {
        FontStack::new(primary, vec![fallback])
    }

    /// Only characters the chosen font is missing go to a fallback.
    #[test]
    fn primary_font_keeps_the_characters_it_has() {
        let Some(primary) = crate::chat_overlay::renderer::load_font_for_tests("Segoe UI") else {
            return; // No system fonts in this environment — nothing to assert.
        };
        let Some(fallback) = crate::chat_overlay::renderer::load_font_for_tests("Segoe UI Symbol")
        else {
            return;
        };
        let stack = stack_of(primary.clone(), fallback);
        assert!(
            std::ptr::eq(stack.font_for('a'), stack.primary()),
            "a plain letter must not be pushed to a fallback"
        );
    }

    /// Chat ASCII art is drawn with Braille characters, which display fonts do not carry — this
    /// is the tofu the overlay used to render. At least one installed fallback must cover it.
    #[test]
    fn braille_art_resolves_to_an_installed_font() {
        let Some(primary) = crate::chat_overlay::renderer::load_font_for_tests("Segoe UI") else {
            return;
        };
        let fallbacks = FALLBACK_FAMILIES
            .iter()
            .filter_map(|family| crate::chat_overlay::renderer::load_font_for_tests(family))
            .collect::<Vec<_>>();
        let stack = FontStack::new(primary, fallbacks);
        for ch in ['\u{28FF}', '\u{2801}', '\u{2550}'] {
            assert!(
                stack.font_for(ch).glyph_id(ch).0 != 0,
                "no installed font draws {ch:?} — it renders as an empty box"
            );
        }
    }

    /// The tofu case: the chosen font has no Braille, so the character has to come from a
    /// fallback or it draws as an empty box.
    #[test]
    fn missing_character_comes_from_a_fallback() {
        let Some(primary) = crate::chat_overlay::renderer::load_font_for_tests("Segoe UI") else {
            return;
        };
        let Some(fallback) = crate::chat_overlay::renderer::load_font_for_tests("Segoe UI Symbol")
        else {
            return;
        };
        let braille = '⣿';
        if primary.glyph_id(braille).0 != 0 || fallback.glyph_id(braille).0 == 0 {
            return; // This machine's fonts do not exercise the case.
        }
        let stack = stack_of(primary, fallback);
        assert!(
            stack.font_for(braille).glyph_id(braille).0 != 0,
            "the fallback with the glyph must be picked"
        );
    }
}
