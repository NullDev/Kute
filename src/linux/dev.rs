// the dev token lives in a DPAPI blob, which has no linux counterpart yet (see dpapi.rs)
pub fn has_token() -> bool {
    false
}

pub fn handle_cli_flags() -> bool {
    false
}

pub fn proof(_nonce: &str, _game: &str, _hash: &str) -> Option<(String, String)> {
    None
}
