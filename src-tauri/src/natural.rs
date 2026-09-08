use std::cmp::Ordering;

/// Natural (digit-aware) filename comparison so "2.jpg" < "10.jpg".
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut ab, mut bb) = (a.as_bytes(), b.as_bytes());
    loop {
        match (ab.first(), bb.first()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(&ca), Some(&cb)) => {
                if ca.is_ascii_digit() && cb.is_ascii_digit() {
                    let (na, ra) = take_num(ab);
                    let (nb, rb) = take_num(bb);
                    let ta = na.trim_start_matches('0');
                    let tb = nb.trim_start_matches('0');
                    let ord = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
                    if ord != Ordering::Equal {
                        return ord;
                    }
                    ab = ra;
                    bb = rb;
                } else {
                    let (la, lb) = (ca.to_ascii_lowercase(), cb.to_ascii_lowercase());
                    if la != lb {
                        return la.cmp(&lb);
                    }
                    ab = &ab[1..];
                    bb = &bb[1..];
                }
            }
        }
    }
}

fn take_num(b: &[u8]) -> (&str, &[u8]) {
    let end = b.iter().position(|c| !c.is_ascii_digit()).unwrap_or(b.len());
    (std::str::from_utf8(&b[..end]).unwrap_or(""), &b[end..])
}
