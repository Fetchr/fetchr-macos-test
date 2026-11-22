use image::RgbaImage;

/// Straight-alpha "source over" of `src` onto `dst` at (`x`, `y`), clipped to `dst`.
///
/// `imageops::overlay` runs an f32 blend with a generic pixel trait for every pixel; chat
/// frames are mostly transparent or fully opaque, so integer fast paths for those and a
/// row-wise clip make compositing several times cheaper.
pub fn overlay_fast(dst: &mut RgbaImage, src: &RgbaImage, x: i64, y: i64) {
    let (dw, dh) = (dst.width() as i64, dst.height() as i64);
    let (sw, sh) = (src.width() as i64, src.height() as i64);
    let x0 = x.max(0);
    let y0 = y.max(0);
    let x1 = (x + sw).min(dw);
    let y1 = (y + sh).min(dh);
    if x0 >= x1 || y0 >= y1 {
        return;
    }
    let span = (x1 - x0) as usize;
    let dst_stride = dst.width() as usize * 4;
    let src_stride = src.width() as usize * 4;
    let dst_raw: &mut [u8] = dst;
    let src_raw: &[u8] = src;
    for row in y0..y1 {
        let d_off = row as usize * dst_stride + x0 as usize * 4;
        let s_off = (row - y) as usize * src_stride + (x0 - x) as usize * 4;
        let d_row = &mut dst_raw[d_off..d_off + span * 4];
        let s_row = &src_raw[s_off..s_off + span * 4];
        for (d, s) in d_row.chunks_exact_mut(4).zip(s_row.chunks_exact(4)) {
            blend_over(d, s);
        }
    }
}

/// [`overlay_fast`] with the whole source faded by `alpha` (0..=255) and shifted by `x`.
pub fn overlay_fast_alpha(dst: &mut RgbaImage, src: &RgbaImage, x: i64, y: i64, alpha: u8) {
    if alpha == 255 {
        overlay_fast(dst, src, x, y);
        return;
    }
    if alpha == 0 {
        return;
    }
    let (dw, dh) = (dst.width() as i64, dst.height() as i64);
    let (sw, sh) = (src.width() as i64, src.height() as i64);
    let x0 = x.max(0);
    let y0 = y.max(0);
    let x1 = (x + sw).min(dw);
    let y1 = (y + sh).min(dh);
    if x0 >= x1 || y0 >= y1 {
        return;
    }
    let span = (x1 - x0) as usize;
    let dst_stride = dst.width() as usize * 4;
    let src_stride = src.width() as usize * 4;
    let dst_raw: &mut [u8] = dst;
    let src_raw: &[u8] = src;
    let a = alpha as u32;
    for row in y0..y1 {
        let d_off = row as usize * dst_stride + x0 as usize * 4;
        let s_off = (row - y) as usize * src_stride + (x0 - x) as usize * 4;
        let d_row = &mut dst_raw[d_off..d_off + span * 4];
        let s_row = &src_raw[s_off..s_off + span * 4];
        for (d, s) in d_row.chunks_exact_mut(4).zip(s_row.chunks_exact(4)) {
            let faded = [s[0], s[1], s[2], ((s[3] as u32 * a + 127) / 255) as u8];
            blend_over(d, &faded);
        }
    }
}

#[inline(always)]
fn blend_over(d: &mut [u8], s: &[u8]) {
    let sa = s[3] as u32;
    if sa == 0 {
        return;
    }
    let da = d[3] as u32;
    if sa == 255 || da == 0 {
        d.copy_from_slice(s);
        return;
    }
    // out_a = sa + da*(1-sa); out_c = (sc*sa + dc*da*(1-sa)) / out_a, in 0..=255 fixed point.
    let inv = 255 - sa;
    let dw = da * inv; // weight of dst, scaled by 255
    let sw = sa * 255; // weight of src, scaled by 255
    let total = sw + dw;
    let out_a = (total + 127) / 255;
    for i in 0..3 {
        d[i] = ((s[i] as u32 * sw + d[i] as u32 * dw + total / 2) / total) as u8;
    }
    d[3] = out_a as u8;
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{imageops, Rgba};

    #[test]
    fn matches_imageops_within_rounding() {
        let mut a = RgbaImage::from_fn(17, 9, |x, y| {
            Rgba([(x * 13) as u8, (y * 29) as u8, 90, ((x + y) * 11 % 256) as u8])
        });
        let src = RgbaImage::from_fn(11, 7, |x, y| {
            Rgba([200, (x * 20) as u8, (y * 30) as u8, ((x * y * 17) % 256) as u8])
        });
        let mut b = a.clone();
        overlay_fast(&mut a, &src, 3, -2);
        imageops::overlay(&mut b, &src, 3, -2);
        for (p, q) in a.pixels().zip(b.pixels()) {
            for i in 0..4 {
                assert!((p.0[i] as i32 - q.0[i] as i32).abs() <= 2, "{p:?} vs {q:?}");
            }
        }
    }

    #[test]
    fn fully_off_canvas_is_noop() {
        let mut a = RgbaImage::from_pixel(4, 4, Rgba([1, 2, 3, 4]));
        let src = RgbaImage::from_pixel(2, 2, Rgba([9, 9, 9, 255]));
        overlay_fast(&mut a, &src, 10, 10);
        overlay_fast(&mut a, &src, -5, 0);
        assert_eq!(a.get_pixel(0, 0), &Rgba([1, 2, 3, 4]));
    }
}
