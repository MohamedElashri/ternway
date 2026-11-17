//! Native compatibility for the image protocols supported before the Ghostty migration.
//! Ghostty owns placement, scrollback and eviction through its Kitty graphics store.
use base64::Engine as _;
const MAX_ENCODED: usize = 24 * 1024 * 1024;
const MAX_PIXELS: usize = 16 * 1024 * 1024;
pub(super) fn iterm(data: &[u8], limit: usize) -> Option<(Vec<u8>, u32, u32)> {
    if limit == 0 || data.len() > MAX_ENCODED {
        return None;
    }
    let data = data.strip_prefix(b"1337;File=")?;
    let split = data.iter().position(|&b| b == b':')?;
    let header = std::str::from_utf8(&data[..split]).ok()?;
    if !header.split(';').any(|field| field == "inline=1") {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data[split + 1..])
        .ok()?;
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some((limit.min(64) * 1_000_000) as u64);
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    reader.limits(limits);
    let image = reader.decode().ok()?.into_rgba8();
    if image.as_raw().len() > limit.min(64) * 1_000_000 {
        return None;
    }
    Some((image.as_raw().clone(), image.width(), image.height()))
}
pub(super) fn sixel(data: &[u8], limit: usize) -> Option<(Vec<u8>, u32, u32)> {
    if limit == 0 || data.len() > MAX_ENCODED {
        return None;
    }
    let image = icy_sixel::SixelImage::decode(data).ok()?;
    if image.width.checked_mul(image.height)? > MAX_PIXELS
        || image.pixels.len() > limit.min(64) * 1_000_000
    {
        return None;
    }
    Some((image.pixels, image.width as u32, image.height as u32))
}
pub(super) fn kitty(pixels: &[u8], width: u32, height: u32) -> Vec<u8> {
    let data = base64::engine::general_purpose::STANDARD.encode(pixels);
    let chunks: Vec<_> = data.as_bytes().chunks(4096).collect();
    let mut out = Vec::new();
    for (i, chunk) in chunks.iter().enumerate() {
        let more = u8::from(i + 1 < chunks.len());
        let header = if i == 0 {
            format!("\x1b_Ga=T,f=32,s={width},v={height},q=2,m={more};")
        } else {
            format!("\x1b_Gm={more};")
        };
        out.extend(header.as_bytes());
        out.extend(*chunk);
        out.extend(b"\x1b\\");
    }
    out
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn image_compatibility_is_bounded_and_never_writes_files() {
        assert!(iterm(b"1337;File=inline=0:aGVsbG8=", 16).is_none());
        assert!(iterm(b"1337;File=inline=1:invalid", 16).is_none());
        assert!(sixel(b"\x1bPq#0;2;100;0;0#0~\x1b\\", 0).is_none());
        let (pixels, w, h) = sixel(b"\x1bPq#0;2;100;0;0#0~\x1b\\", 16).unwrap();
        assert_eq!((w, h), (1, 6));
        assert_eq!(&pixels[..4], &[255, 0, 0, 255]);
        assert!(kitty(&pixels, w, h).starts_with(b"\x1b_Ga=T,f=32,s=1,v=6,"));
    }
}
