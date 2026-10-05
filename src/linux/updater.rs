// bundle hot updates only. TODO: a new client version (AppImage or distro package, the owner decides the format)
use crate::{constants, utils};
use std::{fs, io::Read, path::PathBuf, time::Duration};

// the exe's own bundle, a downloaded one only counts when it is newer: it outlives an exe update here
const EMBEDDED_VERSION: &str = include_str!("../../target/bundle_version");

// next to the exe is read only in an AppImage
fn dir() -> PathBuf {
    utils::settings_dir().join("bundle")
}

fn parse(text: &str) -> Option<semver::Version> {
    semver::Version::parse(text.trim()).ok()
}

fn downloaded_version() -> Option<semver::Version> {
    parse(&fs::read_to_string(dir().join("bundle_version")).ok()?)
}

// renderer, every page load
pub fn downloaded_bundle() -> Option<String> {
    if downloaded_version()? <= parse(EMBEDDED_VERSION)? {
        return None;
    }
    fs::read_to_string(dir().join("bundle.js")).ok().filter(|bundle| !bundle.is_empty())
}

fn get_string(url: &str) -> Option<String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_global(Some(Duration::from_secs(30)))
        .build()
        .into();
    let mut text = String::new();
    agent.get(url).call().ok()?.into_body().as_reader().read_to_string(&mut text).ok()?;
    Some(text)
}

// a new bundle applies on the next navigation
pub fn run() {
    let Some(embedded) = parse(EMBEDDED_VERSION) else { return };
    let current = downloaded_version().filter(|version| *version > embedded).unwrap_or(embedded);
    *crate::JS_VERSION.lock().unwrap() = current.to_string();

    let Some(latest_text) = get_string(constants::JS_VERSION_URL) else { return };
    let Some(latest) = parse(&latest_text) else { return };
    if latest <= current {
        return;
    }
    let Some(bundle) = get_string(constants::JS_BUNDLE_URL) else { return };
    fs::create_dir_all(dir()).ok();
    // version last: a bundle without its version is never picked up
    if utils::atomic_write(&dir().join("bundle.js"), &bundle).is_ok() && utils::atomic_write(&dir().join("bundle_version"), &latest_text.trim()).is_ok() {
        *crate::JS_VERSION.lock().unwrap() = latest.to_string();
    }
}

pub fn install_pending() {}

pub fn installer_cleanup() -> std::io::Result<()> {
    Ok(())
}
