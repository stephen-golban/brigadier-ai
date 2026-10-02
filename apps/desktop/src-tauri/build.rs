fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("src/overnight_notifications.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .compile("brigadier_run_notifications");
        println!("cargo:rustc-link-lib=framework=UserNotifications");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rerun-if-changed=src/overnight_notifications.m");
    }
    tauri_build::build();
}
