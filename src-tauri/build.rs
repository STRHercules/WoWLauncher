use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::fs;
use std::path::Path;

fn main() {
    let icon_path = Path::new("icons/icon.ico");
    if !icon_path.exists() {
        fs::create_dir_all("icons").expect("failed to create icons directory");
        let encoded = fs::read_to_string("icon.b64").expect("failed to read embedded icon data");
        let mut encoded = encoded.trim().to_string();
        while encoded.len() % 4 != 0 {
            encoded.push('=');
        }
        let bytes = STANDARD
            .decode(encoded)
            .expect("failed to decode embedded icon data");
        fs::write(icon_path, bytes).expect("failed to write Windows icon");
    }

    println!("cargo:rerun-if-changed=icon.b64");
    tauri_build::build()
}
