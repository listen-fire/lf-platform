//! A PDF's own text layer, read before the ocr slot is asked, by the
//! platform's rule (packages/file-text/pdf.ts): the text counts only when it
//! is dense enough page for page. A flat total would accept a sixty-page
//! scan whose only text is the page numbers a stamping tool wrote, and that
//! file is exactly the one that still needs OCR.

/// Non-whitespace characters a page must average for the layer to count:
/// well under any real page of prose, well over a scan's headers and page numbers.
pub const TEXT_LAYER_CHARS_PER_PAGE: usize = 50;

#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Layer {
    /// The pages' text, page after page.
    Text(String),
    /// No usable text layer: OCR's to read. `pages` is how many it holds,
    /// when the file could be read that far.
    Scanned { pages: Option<u32> },
}

/// The file's text layer, judged per page. Runs only in the child process
/// (`read`): the file is the sender's, and a parser panic under the release
/// profile's `panic = "abort"` would end the whole host.
fn text_layer(bytes: &[u8]) -> Layer {
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

/// The largest PDF lf parses; a bigger one is refused rather than handed to the parser.
const MAX_BYTES: usize = 64 << 20;
/// The child's wall clock: a hostile file may send the parser into a loop.
const TIME_LIMIT: std::time::Duration = std::time::Duration::from_secs(30);
/// The child's address space: a hostile file may ask the parser for gigabytes.
#[cfg(unix)]
const MEMORY_LIMIT_BYTES: u64 = 2 << 30;
/// The most JSON the child may answer with (the text of a 64 MiB PDF, with room for escapes).
const MAX_ANSWER_BYTES: u64 = 256 << 20;

/// The hidden `lf --pdf-text` mode: the PDF on stdin, its `Layer` as JSON on stdout.
pub fn child_main() -> i32 {
    use std::io::{Read, Write};
    let mut bytes = Vec::new();
    if std::io::stdin().take(MAX_BYTES as u64 + 1).read_to_end(&mut bytes).is_err() || bytes.len() > MAX_BYTES {
        return 2;
    }
    // Only a debug build reads this: a way to prove the parent survives its child dying.
    #[cfg(debug_assertions)]
    match std::env::var("LF_PDF_TEXT_FAULT").as_deref() {
        Ok("panic") => panic!("injected fault"),
        Ok("hang") => loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
        },
        _ => {}
    }
    let Ok(answer) = serde_json::to_vec(&text_layer(&bytes)) else { return 2 };
    if std::io::stdout().write_all(&answer).is_err() {
        return 2;
    }
    0
}

/// The file's text layer, read by a short-lived child of this binary, so a
/// parser that panics, hangs or balloons ends only the child. Err says why
/// the file could not be read; that is not "no text layer" (the caller must
/// not send a file that crashed the parser on to a paid OCR read).
pub async fn read(bytes: &[u8]) -> Result<Layer, String> {
    let exe = std::env::current_exe().map_err(|e| format!("lf cannot find its own binary to read the PDF in a child process: {e}"))?;
    let mut command = tokio::process::Command::new(exe);
    command.arg("--pdf-text");
    read_with(command, bytes).await
}

async fn read_with(mut command: tokio::process::Command, bytes: &[u8]) -> Result<Layer, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    if bytes.len() > MAX_BYTES {
        return Err(format!("the PDF is {} MiB, over the {} MiB lf reads", bytes.len() >> 20, MAX_BYTES >> 20));
    }
    command.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).kill_on_drop(true);
    #[cfg(unix)]
    // SAFETY: setrlimit is async-signal-safe and touches no memory of ours.
    unsafe {
        command.pre_exec(|| {
            let limit = libc::rlimit { rlim_cur: MEMORY_LIMIT_BYTES as libc::rlim_t, rlim_max: MEMORY_LIMIT_BYTES as libc::rlim_t };
            // Refused on platforms that do not bound address space (macOS): the time limit still holds.
            libc::setrlimit(libc::RLIMIT_AS, &limit);
            Ok(())
        });
    }
    let unreadable = |why: String| format!("the PDF's text layer could not be read safely ({why})");
    let mut child = command.spawn().map_err(|e| unreadable(format!("its reader process did not start: {e}")))?;
    let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else { return Err(unreadable("its reader process had no pipes".into())) };
    let exchange = async {
        let feed = async {
            // A child that dies early closes the pipe: its exit status says why.
            let _ = stdin.write_all(bytes).await;
            drop(stdin);
        };
        let drain = async {
            let mut answer = Vec::new();
            stdout.take(MAX_ANSWER_BYTES + 1).read_to_end(&mut answer).await.map(|_| answer)
        };
        let (_, answer) = tokio::join!(feed, drain);
        let status = child.wait().await;
        (answer, status)
    };
    let Ok((answer, status)) = tokio::time::timeout(TIME_LIMIT, exchange).await else {
        return Err(unreadable(format!("its reader process was stopped after {} seconds", TIME_LIMIT.as_secs())));
    };
    let status = status.map_err(|e| unreadable(format!("its reader process was lost: {e}")))?;
    if !status.success() {
        return Err(unreadable(format!("its reader process failed: {status}")));
    }
    let answer = answer.map_err(|e| unreadable(format!("its answer was unreadable: {e}")))?;
    if answer.len() as u64 > MAX_ANSWER_BYTES {
        return Err(unreadable("its answer was over the size limit".into()));
    }
    serde_json::from_slice(&answer).map_err(|e| unreadable(format!("its answer was malformed: {e}")))
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

    fn shell(script: &str) -> tokio::process::Command {
        let mut command = tokio::process::Command::new("sh");
        command.arg("-c").arg(script);
        command
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_child_that_dies_is_reported_and_the_parent_lives() {
        let why = read_with(shell("kill -ABRT $$"), b"%PDF-1.4").await.unwrap_err();
        assert!(why.contains("could not be read safely") && why.contains("failed"), "{why}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_child_that_exits_zero_with_junk_is_reported() {
        let why = read_with(shell("echo nonsense"), b"%PDF-1.4").await.unwrap_err();
        assert!(why.contains("malformed"), "{why}");
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn a_child_that_hangs_is_stopped_at_the_time_limit() {
        let why = read_with(shell("sleep 600"), b"%PDF-1.4").await.unwrap_err();
        assert!(why.contains("stopped after 30 seconds"), "{why}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_pdf_over_the_size_limit_is_refused_unparsed() {
        let why = read_with(shell("cat >/dev/null"), &vec![0; MAX_BYTES + 1]).await.unwrap_err();
        assert!(why.contains("over the 64 MiB"), "{why}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_layer_survives_the_trip_through_a_child() {
        let json = serde_json::to_string(&Layer::Scanned { pages: Some(3) }).unwrap();
        assert_eq!(read_with(shell(&format!("cat >/dev/null; printf '%s' '{json}'")), b"x").await, Ok(Layer::Scanned { pages: Some(3) }));
    }
}
