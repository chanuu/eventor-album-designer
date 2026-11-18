//! Blurs that cost the same whatever their radius.
//!
//! Both passes read memory in order and run on every core: rows are blurred one per
//! task, and columns in strips of neighbouring columns, so a pass over a photo touches
//! each cache line once rather than once per pixel.

use rayon::prelude::*;

/// Columns blurred together by one task.
const STRIP: usize = 64;

/// Box blur by running sums, horizontally then vertically. Near an edge it averages
/// only the pixels that exist, so edges do not darken.
pub fn box_blur(src: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    if r == 0 || w == 0 || h == 0 {
        return src.to_vec();
    }
    let mut across = vec![0.0f32; w * h];
    across
        .par_chunks_mut(w)
        .zip(src.par_chunks(w))
        .for_each(|(out, row)| mean_line(row, out, r));

    // Down: each strip keeps one running sum per column and walks the rows in order.
    let strips: Vec<(usize, Vec<f32>)> = (0..w)
        .step_by(STRIP)
        .collect::<Vec<_>>()
        .into_par_iter()
        .map(|x0| {
            let sw = STRIP.min(w - x0);
            let mut sums = vec![0.0f64; sw];
            let mut strip = vec![0.0f32; sw * h];
            let first = r.min(h - 1);
            for y in 0..=first {
                for (c, s) in sums.iter_mut().enumerate() {
                    *s += f64::from(across[y * w + x0 + c]);
                }
            }
            let mut count = first + 1;
            for y in 0..h {
                let inverse = 1.0 / count as f64;
                for (c, s) in sums.iter().enumerate() {
                    strip[y * sw + c] = (s * inverse) as f32;
                }
                let entering = y + r + 1;
                if entering < h {
                    for (c, s) in sums.iter_mut().enumerate() {
                        *s += f64::from(across[entering * w + x0 + c]);
                    }
                    count += 1;
                }
                if y >= r {
                    for (c, s) in sums.iter_mut().enumerate() {
                        *s -= f64::from(across[(y - r) * w + x0 + c]);
                    }
                    count -= 1;
                }
            }
            (x0, strip)
        })
        .collect();
    let mut out = vec![0.0f32; w * h];
    for (x0, strip) in strips {
        let sw = strip.len() / h;
        for y in 0..h {
            out[y * w + x0..y * w + x0 + sw].copy_from_slice(&strip[y * sw..(y + 1) * sw]);
        }
    }
    out
}

/// The running mean of one line, `r` either side.
fn mean_line(values: &[f32], out: &mut [f32], r: usize) {
    let n = values.len();
    let mut sum = 0.0f64;
    let mut count = 0usize;
    for v in values.iter().take(r.min(n - 1) + 1) {
        sum += f64::from(*v);
        count += 1;
    }
    for i in 0..n {
        out[i] = (sum / count as f64) as f32;
        let entering = i + r + 1;
        if entering < n {
            sum += f64::from(values[entering]);
            count += 1;
        }
        if i >= r {
            sum -= f64::from(values[i - r]);
            count -= 1;
        }
    }
}

/// A guided filter with the image as its own guide: smooths areas whose variation is
/// below `eps` and keeps edges stronger than that.
pub fn guided(i: &[f32], w: usize, h: usize, r: usize, eps: f32) -> Vec<f32> {
    let (mean, mean_sq) = rayon::join(
        || box_blur(i, w, h, r),
        || {
            let squares: Vec<f32> = i.par_iter().map(|v| v * v).collect();
            box_blur(&squares, w, h, r)
        },
    );
    let a: Vec<f32> = mean
        .par_iter()
        .zip(&mean_sq)
        .map(|(m, s)| {
            let var = (s - m * m).max(0.0);
            var / (var + eps)
        })
        .collect();
    let b: Vec<f32> = mean.par_iter().zip(&a).map(|(m, a)| m - a * m).collect();
    let (mean_a, mean_b) = rayon::join(|| box_blur(&a, w, h, r), || box_blur(&b, w, h, r));
    i.par_iter()
        .zip(mean_a.par_iter().zip(&mean_b))
        .map(|(v, (a, b))| a * v + b)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_box_blur_keeps_a_flat_image_flat_up_to_the_edges() {
        let flat = vec![0.4f32; 30 * 20];
        for v in box_blur(&flat, 30, 20, 6) {
            assert!((v - 0.4).abs() < 1e-6);
        }
    }

    #[test]
    fn a_box_blur_averages_its_neighbours() {
        let mut spike = vec![0.0f32; 9];
        spike[4] = 9.0;
        let out = box_blur(&spike, 9, 1, 1);
        assert!((out[4] - 3.0).abs() < 1e-5 && (out[3] - 3.0).abs() < 1e-5 && out[1] == 0.0);
    }

    #[test]
    fn the_guided_filter_smooths_noise_but_keeps_a_step() {
        let w = 40;
        let src: Vec<f32> = (0..w)
            .map(|x| if x < 20 { 0.2 } else { 0.8 } + if x % 2 == 0 { 0.01 } else { -0.01 })
            .collect();
        let out = guided(&src, w, 1, 3, 0.001);
        assert!((out[5] - 0.2).abs() < 0.006, "noise kept: {}", out[5]);
        assert!(out[17] < 0.3 && out[22] > 0.7, "the step was blurred");
    }
}
