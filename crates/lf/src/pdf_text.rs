//! A PDF's own text layer, read before the ocr slot is asked, by the
//! platform's rule (packages/file-text/pdf.ts): the text counts only when it
//! is dense enough page for page. A flat total would accept a sixty-page
//! scan whose only text is the page numbers a stamping tool wrote, and that
//! file is exactly the one that still needs OCR.

/// Non-whitespace characters a page must average for the layer to count:
/// well under any real page of prose, well over a scan's headers and page numbers.
pub const TEXT_LAYER_CHARS_PER_PAGE: usize = 50;

#[derive(Debug, PartialEq)]
pub enum Layer {
    /// The pages' text, page after page.
    Text(String),
    /// No usable text layer: OCR's to read. `pages` is how many it holds,
    /// when the file could be read that far.
    Scanned { pages: Option<u32> },
}

/// The file's text layer, judged per page.
pub fn text_layer(bytes: &[u8]) -> Layer {
    let Ok(document) = lopdf::Document::load_mem(bytes) else { return Layer::Scanned { pages: None } };
    let numbers: Vec<u32> = document.get_pages().keys().copied().collect();
    let pages = u32::try_from(numbers.len()).ok();
    // A page whose fonts lopdf cannot decode adds nothing, as a scan's would.
    let text: Vec<String> = numbers.iter().map(|n| document.extract_text_chunks(&[*n]).into_iter().filter_map(Result::ok).collect::<String>()).collect();
    let dense = text.iter().flat_map(|page| page.chars()).filter(|c| !c.is_whitespace()).count();
    if !numbers.is_empty() && dense / numbers.len() > TEXT_LAYER_CHARS_PER_PAGE {
        // A font map with no glyph for a character leaves U+0000 where a
        // separator usually stood (packages/file-text's rule).
        Layer::Text(text.join("\n").replace('\u{0}', " "))
    } else {
        Layer::Scanned { pages }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A one-font PDF whose pages draw `pages`' lines as text, and nothing else.
    pub fn text_pdf(pages: &[&str]) -> Vec<u8> {
        let mut objects: Vec<String> = vec![String::new(), String::new(), "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".into()];
        let mut kids = Vec::new();
        for text in pages {
            let stream = format!("BT /F1 12 Tf 72 720 Td ({text}) Tj ET");
            objects.push(format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()));
            let contents = objects.len();
            objects.push(format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {contents} 0 R >>"));
            kids.push(format!("{} 0 R", objects.len()));
        }
        objects[0] = "<< /Type /Catalog /Pages 2 0 R >>".into();
        objects[1] = format!("<< /Type /Pages /Kids [{}] /Count {} >>", kids.join(" "), kids.len());
        let mut out = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (i, body) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend(format!("{} 0 obj\n{body}\nendobj\n", i + 1).bytes());
        }
        let xref = out.len();
        out.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).bytes());
        for offset in offsets {
            out.extend(format!("{offset:010} 00000 n \n").bytes());
        }
        out.extend(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).bytes());
        out
    }

    const PROSE: &str = "Acme Robotics builds warehouse arms; it raised a seed round in 2025 and is raising its Series A now.";

    #[test]
    fn a_born_digital_pdf_is_read_from_its_own_text() {
        let Layer::Text(text) = text_layer(&text_pdf(&[PROSE, PROSE])) else { panic!("expected the text layer") };
        assert!(text.contains("Acme Robotics builds warehouse arms"), "{text}");
    }

    #[test]
    fn a_stamped_page_number_on_every_page_is_no_text_layer() {
        assert_eq!(text_layer(&text_pdf(&["Page 1", "Page 2", "Page 3"])), Layer::Scanned { pages: Some(3) });
    }

    #[test]
    fn a_layer_dense_on_one_page_of_many_is_judged_per_page() {
        // 98 characters over three pages averages under fifty.
        assert_eq!(text_layer(&text_pdf(&[PROSE, "2", "3"])), Layer::Scanned { pages: Some(3) });
    }

    #[test]
    fn bytes_that_are_no_pdf_lf_can_read_are_left_to_ocr() {
        assert_eq!(text_layer(b"%PDF-1.4 truncated"), Layer::Scanned { pages: None });
    }
}
