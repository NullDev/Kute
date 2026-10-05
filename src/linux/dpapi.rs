// TODO: secret service (libsecret) in place of DPAPI. until then nothing gets stored, accounts.rs refuses to save
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn protect(_text: &str, _entropy: &[u8], _description: &str) -> Option<String> {
    None
}

pub fn unprotect(_text: &str, _entropy: &[u8]) -> Option<String> {
    None
}
