//! Locates the SubjectPublicKeyInfo inside a DER certificate.
//!
//! Pinning the public key instead of the whole certificate survives renewals:
//! the server renews with the same key, so the pin never has to change. Only
//! the few DER fields in front of the key are walked; nothing is validated
//! here, the TLS stack has already done that.

const SEQUENCE: u8 = 0x30;
const VERSION_TAG: u8 = 0xA0;

/// One DER element: its tag, the whole encoding and the contents.
struct Element<'a> {
    tag: u8,
    whole: &'a [u8],
    contents: &'a [u8],
}

fn read_element(input: &[u8]) -> Option<(Element<'_>, &[u8])> {
    let tag = *input.first()?;
    let first = *input.get(1)?;
    let (length, header) = if first < 0x80 {
        (usize::from(first), 2)
    } else {
        let count = usize::from(first & 0x7f);
        if count == 0 || count > 4 {
            return None;
        }
        let bytes = input.get(2..2 + count)?;
        let length = bytes.iter().fold(0usize, |acc, byte| (acc << 8) | usize::from(*byte));
        (length, 2 + count)
    };
    let end = header.checked_add(length)?;
    let whole = input.get(..end)?;
    Some((
        Element {
            tag,
            whole,
            contents: &whole[header..],
        },
        &input[end..],
    ))
}

/// The DER-encoded SubjectPublicKeyInfo of `certificate`, or `None` when the
/// bytes are not a certificate laid out as X.509 says.
pub fn spki_der(certificate: &[u8]) -> Option<&[u8]> {
    let (cert, _) = read_element(certificate)?;
    if cert.tag != SEQUENCE {
        return None;
    }
    let (tbs, _) = read_element(cert.contents)?;
    if tbs.tag != SEQUENCE {
        return None;
    }
    let mut rest = tbs.contents;
    let (first, after_first) = read_element(rest)?;
    if first.tag == VERSION_TAG {
        rest = after_first;
    }
    // serial, signature algorithm, issuer, validity, subject
    for _ in 0..5 {
        rest = read_element(rest)?.1;
    }
    let (spki, _) = read_element(rest)?;
    (spki.tag == SEQUENCE).then_some(spki.whole)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// fetchr.fun's certificate as served since August 2026 (public data).
    const FETCHR_FUN: &[u8] = include_bytes!("../tests/fixtures/fetchr-fun-2026-08.der");

    #[test]
    fn finds_the_public_key_of_a_real_certificate() {
        let spki = spki_der(FETCHR_FUN).expect("spki");
        assert_eq!(spki[0], SEQUENCE);
        // An EC P-256 key: 91 bytes of SubjectPublicKeyInfo.
        assert_eq!(spki.len(), 91);
        let windows = FETCHR_FUN.windows(spki.len()).filter(|w| *w == spki).count();
        assert_eq!(windows, 1);
    }

    #[test]
    fn rejects_garbage_and_truncated_input() {
        assert!(spki_der(&[]).is_none());
        assert!(spki_der(&[0x30]).is_none());
        assert!(spki_der(&[0x02, 0x01, 0x00]).is_none());
        assert!(spki_der(&FETCHR_FUN[..FETCHR_FUN.len() / 3]).is_none());
        assert!(spki_der(&[0x30, 0x85, 0, 0, 0, 0, 0]).is_none());
    }
}
