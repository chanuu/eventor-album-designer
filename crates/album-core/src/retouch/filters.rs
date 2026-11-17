//! Blurs that cost the same whatever their radius.

/// Box blur by running sums, horizontally then vertically. Near an edge it averages
/// only the pixels that exist, so edges do not darken.
pub fn box_blur(src: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    if r == 0 || w == 0 || h == 0 {
        return src.to_vec();
    }
    let mut tmp = vec![0.0f32; w * h];
    for y in 0..h {
        let row = &src[y * w..(y + 1) * w];
        let out = &mut tmp[y * w..(y + 1) * w];
        running_mean(row.iter().copied(), w, r, |x, v| out[x] = v);
    }
    let mut out = vec![0.0f32; w * h];
    for x in 0..w {
        let column = (0..h).map(|y| tmp[y * w + x]);
        running_mean(column, h, r, |y, v| out[y * w + x] = v);
    }
    out
}

fn running_mean(
    values: impl Iterator<Item = f32>,
    n: usize,
    r: usize,
    mut put: impl FnMut(usize, f32),
) {
    let values: Vec<f32> = values.collect();
    let mut sum = 0.0f64;
    let mut count = 0usize;
    for v in values.iter().take(r.min(n - 1) + 1) {
        sum += f64::from(*v);
        count += 1;
    }
    for i in 0..n {
        put(i, (sum / count as f64) as f32);
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
    let mean = box_blur(i, w, h, r);
    let squares: Vec<f32> = i.iter().map(|v| v * v).collect();
    let mean_sq = box_blur(&squares, w, h, r);
    let a: Vec<f32> = mean
        .iter()
        .zip(&mean_sq)
        .map(|(m, s)| {
            let var = (s - m * m).max(0.0);
            var / (var + eps)
        })
        .collect();
    let b: Vec<f32> = mean.iter().zip(&a).map(|(m, a)| m - a * m).collect();
    let mean_a = box_blur(&a, w, h, r);
    let mean_b = box_blur(&b, w, h, r);
    i.iter()
        .zip(mean_a.iter().zip(&mean_b))
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
