//! Plain text → PDF with no browser and no dependency: the layout the
//! platform's `FILE(content, "pdf")` once got from Chromium (a `<pre>` of
//! sans-serif text on A4 with 30pt margins, wrapped at the page edge), written
//! as the PDF's own text operators in Helvetica.
//!
//! The platform has the same renderer in TypeScript
//! (apps/api/.../movement/plain_text_pdf.ts); the two are kept byte-identical
//! by the golden files under tests/plain_pdf_golden, which both sides render.
//! Every measure is an integer, so no rounding can differ.
//!
//! Text is Helvetica in WinAnsi: a character outside Latin-1 and the
//! Windows-1252 punctuation prints as "?".

/// Helvetica advance widths (1/1000 em) for WinAnsi bytes 32..=255; 0 marks a byte WinAnsi leaves undefined.
const WIDTHS: [u32; 224] = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015,
    667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333,
    556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 0,
    556, 0, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0, 0, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 0, 500, 667,
    278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611,
    667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
    556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 222, 222, 222, 222, 556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500,
];

/// Windows-1252's 0x80..0x9F, which Unicode places elsewhere.
const CP1252_HIGH: [(u32, u8); 27] = [
    (0x20ac, 0x80), (0x201a, 0x82), (0x0192, 0x83), (0x201e, 0x84), (0x2026, 0x85), (0x2020, 0x86), (0x2021, 0x87), (0x02c6, 0x88),
    (0x2030, 0x89), (0x0160, 0x8a), (0x2039, 0x8b), (0x0152, 0x8c), (0x017d, 0x8e), (0x2018, 0x91), (0x2019, 0x92), (0x201c, 0x93),
    (0x201d, 0x94), (0x2022, 0x95), (0x2013, 0x96), (0x2014, 0x97), (0x02dc, 0x98), (0x2122, 0x99), (0x0161, 0x9a), (0x203a, 0x9b),
    (0x0153, 0x9c), (0x017e, 0x9e), (0x0178, 0x9f),
];

// 1/100 pt. A4, 30pt margins, 10.5pt type on a 15.75pt line, the baseline
// 11.51pt under its line's top.
const PAGE_WIDTH: u32 = 59528;
const PAGE_HEIGHT: u32 = 84189;
const MARGIN: u32 = 3000;
const LINE: u32 = 1575;
const BASELINE: u32 = 1151;
const LINES_PER_PAGE: usize = ((PAGE_HEIGHT - 2 * MARGIN) / LINE) as usize;
const FONT_SIZE: u32 = 1050;
/// The text column, in 1/1000 em at the font size.
const COLUMN: u32 = (PAGE_WIDTH - 2 * MARGIN) * 1000 / FONT_SIZE;
const TAB_COLUMNS: usize = 8;
const SPACE: u8 = 0x20;
const NEWLINE: u8 = 0x0a;

fn win_ansi(code_point: u32) -> Option<u8> {
    match code_point {
        0x20..=0x7e | 0xa0..=0xff => Some(code_point as u8),
        0x2212 => Some(0x2d),
        _ => CP1252_HIGH.iter().find(|(unicode, _)| *unicode == code_point).map(|(_, byte)| *byte),
    }
}

fn is_invisible(code_point: u32) -> bool {
    (0x200b..=0x200f).contains(&code_point) || code_point == 0xfeff || code_point == 0xfe0f
}

fn advance(byte: u8) -> u32 {
    WIDTHS.get(usize::from(byte).wrapping_sub(32)).copied().unwrap_or(0)
}

/// One WinAnsi byte per printed character; a newline stays 0x0a.
fn to_bytes(text: &str) -> Vec<u8> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut bytes = Vec::with_capacity(normalized.len());
    let mut column = 0;
    for ch in normalized.chars() {
        let code_point = u32::from(ch);
        if code_point == 0x0a {
            bytes.push(NEWLINE);
            column = 0;
        } else if code_point == 0x09 {
            let fill = TAB_COLUMNS - column % TAB_COLUMNS;
            bytes.extend(std::iter::repeat(SPACE).take(fill));
            column += fill;
        } else if code_point < 0x20 || is_invisible(code_point) {
            continue;
        } else {
            bytes.push(win_ansi(code_point).filter(|byte| advance(*byte) != 0).unwrap_or(b'?'));
            column += 1;
        }
    }
    bytes
}

/// `white-space: pre-wrap; overflow-wrap: break-word`: spaces are kept, a run
/// of them that crosses the edge hangs there, a word that does not fit moves
/// to a new line, and a word longer than a line is broken at the edge.
fn wrap(bytes: &[u8]) -> Vec<Vec<u8>> {
    let body = bytes.strip_suffix(&[NEWLINE]).unwrap_or(bytes);
    let mut lines = Vec::new();
    for paragraph in body.split(|byte| *byte == NEWLINE) {
        wrap_paragraph(paragraph, &mut lines);
    }
    lines
}

fn wrap_paragraph(paragraph: &[u8], lines: &mut Vec<Vec<u8>>) {
    let mut line: Vec<u8> = Vec::new();
    let mut used = 0;
    let mut i = 0;
    while i < paragraph.len() {
        let spaces = paragraph[i] == SPACE;
        let mut j = i;
        while j < paragraph.len() && (paragraph[j] == SPACE) == spaces {
            j += 1;
        }
        let run = &paragraph[i..j];
        let width: u32 = run.iter().map(|byte| advance(*byte)).sum();
        i = j;
        if spaces {
            line.extend_from_slice(run);
            used += width;
            continue;
        }
        if used + width > COLUMN && line.iter().any(|byte| *byte != SPACE) {
            lines.push(std::mem::take(&mut line));
            used = 0;
        }
        if width <= COLUMN {
            line.extend_from_slice(run);
            used += width;
            continue;
        }
        for byte in run {
            let w = advance(*byte);
            if used + w > COLUMN && !line.is_empty() {
                lines.push(std::mem::take(&mut line));
                used = 0;
            }
            line.push(*byte);
            used += w;
        }
    }
    lines.push(line);
}

fn hundredths(value: u32) -> String {
    format!("{}.{:02}", value / 100, value % 100)
}

fn escape_string(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len());
    for byte in bytes {
        match byte {
            0x28 | 0x29 | 0x5c => {
                out.push('\\');
                out.push(char::from(*byte));
            }
            0..=0x7e => out.push(char::from(*byte)),
            _ => out.push_str(&format!("\\{byte:03o}")),
        }
    }
    out
}

fn page_content(lines: &[Vec<u8>]) -> String {
    let mut operations = vec!["BT".to_string(), "/F1 10.5 Tf".into(), "0.133 g".into()];
    for (index, line) in lines.iter().enumerate() {
        if line.is_empty() {
            continue;
        }
        let y = PAGE_HEIGHT - MARGIN - BASELINE - index as u32 * LINE;
        operations.push(format!("1 0 0 1 {} {} Tm ({}) Tj", hundredths(MARGIN), hundredths(y), escape_string(line)));
    }
    operations.push("ET".into());
    operations.join("\n")
}

/// The PDF for `content`, deterministic: the same text gives the same bytes.
pub fn render(content: &str) -> Vec<u8> {
    let lines = wrap(&to_bytes(content));
    let mut pages: Vec<&[Vec<u8>]> = lines.chunks(LINES_PER_PAGE).collect();
    if pages.is_empty() {
        pages.push(&[]);
    }

    // Objects: 1 catalog, 2 page tree, 3 font, then a page and its content per page.
    let kids: Vec<String> = (0..pages.len()).map(|i| format!("{} 0 R", 4 + 2 * i)).collect();
    let mut objects = vec![
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        format!("<< /Type /Pages /Kids [{}] /Count {} >>", kids.join(" "), pages.len()),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".into(),
    ];
    for (i, page_lines) in pages.iter().enumerate() {
        let content = page_content(page_lines);
        objects.push(format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {} {}] /Resources << /Font << /F1 3 0 R >> >> /Contents {} 0 R >>",
            hundredths(PAGE_WIDTH),
            hundredths(PAGE_HEIGHT),
            5 + 2 * i
        ));
        objects.push(format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()));
    }

    let mut out = String::from("%PDF-1.4\n");
    let mut offsets = Vec::new();
    for (i, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.push_str(&format!("{} 0 obj\n{body}\nendobj\n", i + 1));
    }
    let xref = out.len();
    out.push_str(&format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1));
    for offset in offsets {
        out.push_str(&format!("{offset:010} 00000 n \n"));
    }
    out.push_str(&format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1));
    out.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::render;
    use std::fs;
    use std::path::PathBuf;

    fn fixtures() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/plain_pdf_golden")
    }

    /// The goldens are the TypeScript renderer's bytes; this side must match them.
    #[test]
    fn renders_the_goldens_the_platform_renders() {
        let mut checked = 0;
        for entry in fs::read_dir(fixtures()).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("txt") {
                continue;
            }
            let text = fs::read_to_string(&path).unwrap();
            let golden = fs::read(path.with_extension("pdf")).unwrap();
            assert_eq!(render(&text), golden, "{} differs from its golden", path.display());
            checked += 1;
        }
        assert!(checked >= 8, "the fixtures are missing");
    }

    #[test]
    fn a_fiftieth_line_starts_a_second_page() {
        let forty_nine = (0..49).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n");
        let pages = |text: &str| String::from_utf8(render(text)).unwrap().matches("/Type /Page ").count();
        assert_eq!(pages(&forty_nine), 1);
        assert_eq!(pages(&format!("{forty_nine}\nmore")), 2);
    }
}
